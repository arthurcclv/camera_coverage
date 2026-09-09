/**
 * Voxel volumetric renderer (see specs/volumetric_rendering.md) — a
 * visualization-agnostic primitive that draws a set of voxels as translucent
 * volumetric fog. Callers supply, per voxel, a {center, size, intensity, color};
 * one global `intensityScale` knob controls overall density.
 *
 * A single GPU-instanced unit cube (proxy geometry) is drawn with a GLSL
 * `ShaderMaterial` whose fragment shader slab-tests the view ray against each
 * instance's world-space AABB and emits the voxel's `color` at an **alpha** of
 * `intensity * pathTerm * intensityScale`, composited **over** the scene with
 * ordinary source-over blending.
 *
 * The compositing is **not** in-scene blending: this material max-blends into a
 * target of the fog's own, which is then composited over the scene with alpha.
 * `scene/fogCompositor.ts` owns that pass and specs/volumetric_rendering.md §4 owns
 * the reason a single blend rule cannot do both jobs.
 *
 * The slab/chord math is authored as the pure-TS reference below (unit-tested in
 * test/volumetric.test.ts); the fragment shader mirrors it, echoing the SDK's
 * "CPU reference is the tested truth" discipline. That mirroring carries the whole
 * verification burden: a shader cannot run under `node --test`, so the reference is
 * what is tested and the shader is held to it by review plus the source-parity
 * assertion in that same test file (specs/volumetric_rendering.md §6).
 *
 * WebGL2 is the only render backend (spec.md §2.3), so there is one shader
 * language and no cross-backend compilation step.
 */
import * as THREE from 'three';

export type Vec3 = [number, number, number];

/**
 * How a voxel's alpha varies across its own silhouette
 * (specs/volumetric_rendering.md §1, §3). It selects the **path term** only —
 * both modes composite identically, as alpha over the scene (§4):
 *  - 'flat' — the chord is dropped, so every fragment of a voxel is equally
 *             opaque and cubes read hard-edged (default).
 *  - 'soft' — alpha scales with the fraction of the cube the ray crossed, fading
 *             each voxel out at its silhouette edges.
 *
 * These were `'max'` and `'additive'` back when the mode picked a **blend
 * equation**. It no longer does, so the names now say what they actually control.
 */
export type CompositeMode = 'flat' | 'soft';

export interface Voxel {
  /** Cube center, world space. */
  center: Vec3;
  /** Cube edge length, world space. */
  size: number;
  /** Scalar ≥ 0 (normally 0..1): how strongly the voxel contributes. */
  intensity: number;
  /** RGB glow color, components 0..1. */
  color: Vec3;
}

/** Default overall density multiplier (specs/volumetric_rendering.md §1). */
export const DEFAULT_INTENSITY_SCALE = 1;

/** Default composite mode (specs/volumetric_rendering.md §1, §3). */
export const DEFAULT_COMPOSITE_MODE: CompositeMode = 'flat';

const EPS = 1e-6;
const INITIAL_CAPACITY = 1024;

/**
 * Hard ceiling on drawn instances (`camera-coverage-sdk` §16.2 uses the same
 * order for filtered instancing).
 *
 * `InstancedMesh` allocates a 64-byte `instanceMatrix` per instance on top of
 * this module's own ~32 bytes of attributes, and a WebGPU device's *default*
 * `maxBufferSize` is 256 MiB — so ~4.2M instances is where the renderer's device
 * is lost, not merely slowed. The cap turns that into a visibly truncated
 * overlay, which the caller can report.
 */
export const MAX_INSTANCES = 2_000_000;

// --- Pure-TS reference math (the tested truth the fragment shader mirrors) ---

/**
 * Slab test of a ray against an axis-aligned box, returning the **chord length**
 * — the distance the ray travels inside the box (0 on a miss). `dir` is assumed
 * normalized, so the returned chord is in the same world units as the box.
 * `t_enter` is clamped to 0 so a ray origin inside the box is handled (the chord
 * then runs from the origin to the exit face).
 */
export function slabChord(origin: Vec3, dir: Vec3, boxMin: Vec3, boxMax: Vec3): number {
  let tEnter = -Infinity;
  let tExit = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < EPS) {
      // Ray parallel to this slab: a miss unless the origin is already between
      // the slab planes.
      if (origin[a] < boxMin[a] || origin[a] > boxMax[a]) return 0;
      continue;
    }
    const inv = 1 / dir[a];
    let t1 = (boxMin[a] - origin[a]) * inv;
    let t2 = (boxMax[a] - origin[a]) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tEnter) tEnter = t1;
    if (t2 < tExit) tExit = t2;
  }
  if (tEnter < 0) tEnter = 0;
  return Math.max(0, tExit - tEnter);
}

/**
 * The **path term** for a voxel (specs/volumetric_rendering.md §3): the 0..1
 * fraction of the cube the view ray crossed.
 *
 * `flat` drops the chord entirely and returns 1, so every fragment of a voxel is
 * equally opaque (hard-edged cubes). `soft` returns `chord / size`, fading a voxel
 * out towards its silhouette where the ray only clips a corner.
 *
 * It is a **fraction, never a length** — that is what keeps a voxel's alpha
 * independent of `size`, so `intensityScale` need not be re-tuned when the grid is
 * refined (§3).
 */
export function pathTerm(mode: CompositeMode, chord: number, size: number): number {
  if (mode === 'flat') return 1;
  if (size <= EPS) return 0;
  return Math.min(1, Math.max(0, chord / size));
}

/**
 * A voxel's **alpha** — its opacity, which is what `intensity` now drives
 * (specs/volumetric_rendering.md §3). The voxel's `color` reaches the framebuffer
 * undimmed; only this varies.
 *
 * Clamped to 0..1 so an over-driven `intensityScale` cannot produce an alpha the
 * blender would treat as garbage.
 */
export function voxelAlpha(intensity: number, path: number, intensityScale: number): number {
  return Math.min(1, Math.max(0, intensity * path * intensityScale));
}

/**
 * Composite a ray's voxels the way the fog pass does (specs/volumetric_rendering.md
 * §4): the **strongest** voxel wins, and stacking never accumulates.
 *
 * Returns the premultiplied `{color, alpha}` the fog target ends up holding. The
 * overlay is a single hue, so a per-channel max over premultiplied colour is the
 * same thing as "the colour of the voxel with the highest alpha" — which is why
 * the shader may emit `color * alpha` and let the blender sort it out.
 *
 * Order-independent by construction: max is commutative, so the result is
 * invariant under any permutation of `layers`. That is the property the whole
 * two-target arrangement exists to keep — compositing this into the main
 * framebuffer directly would have to give it up.
 */
export function compositeMax(layers: { color: Vec3; alpha: number }[]): { color: Vec3; alpha: number } {
  const color: Vec3 = [0, 0, 0];
  let alpha = 0;
  for (const layer of layers) {
    for (let i = 0; i < 3; i++) color[i] = Math.max(color[i], layer.color[i] * layer.alpha);
    alpha = Math.max(alpha, layer.alpha);
  }
  return { color, alpha };
}

/**
 * The final pixel: the fog target composited **over** the scene colour
 * (specs/volumetric_rendering.md §4). `fog` is premultiplied, so source-over needs
 * no divide — and a fog pixel of alpha 0 leaves the scene exactly as it was,
 * whatever its colour.
 *
 * This is the step that has no per-channel floor: the fog contributes in
 * proportion to its alpha rather than having to out-brighten what is behind it.
 */
export function compositeOverScene(scene: Vec3, fog: { color: Vec3; alpha: number }): Vec3 {
  return [
    scene[0] * (1 - fog.alpha) + fog.color[0],
    scene[1] * (1 - fog.alpha) + fog.color[1],
    scene[2] * (1 - fog.alpha) + fog.color[2],
  ];
}

// --- Shaders -----------------------------------------------------------------

/**
 * The proxy cube's vertex stage. Per-instance data is passed straight through
 * as varyings and the world position is formed exactly as TSL's `positionWorld`
 * did — `modelMatrix * instanceMatrix * position` — so the fragment stage sees
 * the same ray it saw before the port.
 *
 * The attribute names are prefixed `a…` deliberately: `color` is a name Three.js
 * already uses for its own vertex-color attribute, and `half` is a **reserved
 * word** in GLSL ES. Either collision fails at shader compile, not at runtime.
 */
export const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aCenter;
  attribute float aHalf;
  attribute float aIntensity;
  attribute vec3 aColor;

  varying vec3 vCenter;
  varying float vHalf;
  varying float vIntensity;
  varying vec3 vColor;
  varying vec3 vWorldPos;

  void main() {
    vCenter = aCenter;
    vHalf = aHalf;
    vIntensity = aIntensity;
    vColor = aColor;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * Fragment stage mirroring `slabChord` + `pathTerm` + `voxelAlpha`: slab-test the view
 * ray against the instance's world AABB, then accumulate the chord-scaled colour.
 *
 * `cameraPosition` is a uniform Three.js injects into every `ShaderMaterial`.
 * Note it is the camera's world *position*, which makes the ray exact for a
 * perspective camera and an approximation under the orthographic elevations —
 * the same approximation the TSL version made, kept deliberately so the port
 * changes nothing about what is drawn.
 */
export const FRAGMENT_SHADER = /* glsl */ `
  uniform float uIntensityScale;
  uniform float uFlatMode;

  varying vec3 vCenter;
  varying float vHalf;
  varying float vIntensity;
  varying vec3 vColor;
  varying vec3 vWorldPos;

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - ro);

    vec3 boxMin = vCenter - vec3(vHalf);
    vec3 boxMax = vCenter + vec3(vHalf);

    // Per-component inverse direction. \`rd\` is normalized and, for a perspective
    // camera, its components are essentially never exactly zero, so a plain
    // reciprocal is safe; the min/max slab formulation below stays robust for
    // near-axis-parallel rays. (Must stay per-component — a scalar-collapsing
    // op here breaks the ray in some view quadrants.)
    vec3 invDir = 1.0 / rd;

    vec3 t1 = (boxMin - ro) * invDir;
    vec3 t2 = (boxMax - ro) * invDir;
    vec3 tmin = min(t1, t2);
    vec3 tmax = max(t1, t2);
    float tEnter = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
    float tExit = min(min(tmax.x, tmax.y), tmax.z);
    float chord = max(tExit - tEnter, 0.0);

    // 'soft' uses the chord as a **fraction of the cube edge** (0..1, so alpha
    // never depends on voxel size); 'flat' drops it to 1.0 so every fragment of a
    // voxel is equally opaque (§3). uFlatMode is 0 in soft, 1 in flat.
    float edge = max(2.0 * vHalf, 1e-6);
    float pathTerm = mix(clamp(chord / edge, 0.0, 1.0), 1.0, uFlatMode);

    // Intensity is **alpha** — how opaque this voxel is, not how bright.
    float alpha = clamp(vIntensity * pathTerm * uIntensityScale, 0.0, 1.0);

    // **Premultiplied**, because this target is max-blended (§4): the overlay is a
    // single hue, so max(C * a_i) == C * max(a_i) and the winning fragment's colour
    // and alpha stay consistent. Emitting straight colour here would max the hue
    // independently of the alpha and desaturate the result.
    gl_FragColor = vec4(vColor * alpha, alpha);
  }
`;

// --- Renderer ----------------------------------------------------------------

export class VoxelVolumetricRenderer {
  readonly object = new THREE.Group();
  /**
   * The fog's **own scene**, holding `object` and nothing else. It is not part of
   * the viewport scene: the fog draws in its own pass, into its own target
   * (`fogCompositor.ts`). Exposed so the viewport can render it; callers never add
   * `object` to the main scene.
   */
  readonly scene = new THREE.Scene();

  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly intensityScaleUniform = { value: DEFAULT_INTENSITY_SCALE };
  // Selects the path term in the fragment shader: 0 → the chord fraction ('soft'
  // falloff), 1 → a flat 1.0 ('flat' mode). Mirrors §3.
  private readonly flatModeUniform = { value: DEFAULT_COMPOSITE_MODE === 'flat' ? 1 : 0 };
  private readonly matrix = new THREE.Matrix4();

  private capacity = 0;
  private count = 0;

  private mesh: THREE.InstancedMesh | null = null;
  /**
   * Built **once**, in the constructor, and reused across every reallocation.
   * A GLSL `ShaderMaterial` binds its instanced attributes **by name** off the
   * geometry, so growing the buffers no longer has to rebuild the shader — which
   * the TSL node graph did, because its nodes closed over the attribute *objects*.
   */
  private readonly material: THREE.ShaderMaterial;
  private centerArr = new Float32Array(0);
  private halfArr = new Float32Array(0);
  private intensityArr = new Float32Array(0);
  private colorArr = new Float32Array(0);
  private centerAttr: THREE.InstancedBufferAttribute | null = null;
  private halfAttr: THREE.InstancedBufferAttribute | null = null;
  private intensityAttr: THREE.InstancedBufferAttribute | null = null;
  private colorAttr: THREE.InstancedBufferAttribute | null = null;

  constructor() {
    this.material = this.buildMaterial();
    this.scene.add(this.object);
    this.allocate(INITIAL_CAPACITY);
  }

  /** Clear all voxels before starting a fresh incremental build. */
  reset(): void {
    this.count = 0;
    if (this.mesh) this.mesh.count = 0;
  }

  /** Append voxels to the current build (grows the instance buffers as needed). */
  addVoxels(voxels: Voxel[]): void {
    if (voxels.length === 0) return;
    this.ensureCapacity(this.count + voxels.length);
    for (const v of voxels) {
      this.writeVoxel(this.count, v);
      this.count++;
    }
    this.commit();
  }

  /**
   * Bulk append merged voxel cubes, writing straight into the instance buffers.
   *
   * Each entry is a cube of `edge` voxels a side whose voxels all share one
   * key — for the coverage overlay, the camera count (`spec.md` §9, §3.3). The
   * per-entry value is looked up through two 256-entry tables: `draw` says
   * whether a key is rendered at all, `intensity` gives its value. A table
   * rather than a callback because this loop can run over hundreds of thousands
   * of entries per rebuild, and the array-of-objects form this replaces spent
   * more time allocating `{center, size, ...}` than the upload it was preparing.
   *
   * Beyond {@link MAX_INSTANCES} the append stops and reports how many it
   * dropped. An `InstancedMesh` carries a 64-byte matrix per instance on top of
   * these attributes, so an unbounded count walks into a GPU device's buffer
   * limit and takes the device down with it — a truncated overlay is a far
   * better failure than a lost renderer.
   */
  addVoxelLeaves(g: {
    origin: readonly [number, number, number];
    dims: readonly [number, number, number];
    voxelSize: number;
    /** Per entry: linear index of its minimum corner, chunk-local order. */
    index: Uint32Array;
    /** Per entry: cube edge in voxels. */
    edge: Uint16Array;
    /** Per entry: the lookup key shared by every voxel it covers. */
    keys: Uint8Array;
    /** 256 entries: whether a key is drawn. */
    draw: Uint8Array;
    /** 256 entries: the intensity for a key. */
    intensity: Float32Array;
    color: readonly [number, number, number];
  }): { dropped: number } {
    const total = g.index.length;
    if (total === 0) return { dropped: 0 };

    // One pass to count, one to write: growing mid-loop would reallocate the
    // very buffers being written into.
    let drawn = 0;
    for (let n = 0; n < total; n++) if (g.draw[g.keys[n]]) drawn++;
    if (drawn === 0) return { dropped: 0 };

    const room = Math.max(0, MAX_INSTANCES - this.count);
    const dropped = Math.max(0, drawn - room);
    drawn = Math.min(drawn, room);
    if (drawn === 0) return { dropped };
    this.ensureCapacity(this.count + drawn);

    const [ox, oy, oz] = g.origin;
    const [nx, ny] = g.dims;
    const vs = g.voxelSize;
    const [r, gg, b] = g.color;
    const mesh = this.mesh!;
    let i = this.count;
    const limit = this.count + drawn;
    for (let n = 0; n < total && i < limit; n++) {
      const key = g.keys[n];
      if (!g.draw[key]) continue;
      const li = g.index[n];
      const e = g.edge[n];
      const world = e * vs;
      // The cube spans `e` voxels from its minimum corner, so its center is half
      // an edge in, not half a voxel.
      const cx = ox + ((li % nx) + e / 2) * vs;
      const cy = oy + ((Math.floor(li / nx) % ny) + e / 2) * vs;
      const cz = oz + (Math.floor(li / (nx * ny)) + e / 2) * vs;
      this.centerArr[i * 3] = cx;
      this.centerArr[i * 3 + 1] = cy;
      this.centerArr[i * 3 + 2] = cz;
      this.halfArr[i] = world / 2;
      this.intensityArr[i] = g.intensity[key];
      this.colorArr[i * 3] = r;
      this.colorArr[i * 3 + 1] = gg;
      this.colorArr[i * 3 + 2] = b;
      this.matrix.makeScale(world, world, world);
      this.matrix.setPosition(cx, cy, cz);
      mesh.setMatrixAt(i, this.matrix);
      i++;
    }
    this.count = i;
    this.commit();
    return { dropped };
  }

  /** Overall brightness multiplier applied to every voxel's contribution. */
  setIntensityScale(scale: number): void {
    this.intensityScaleUniform.value = scale;
  }

  /**
   * Select how a voxel's alpha varies across its silhouette
   * (specs/volumetric_rendering.md §3): 'flat' drops the chord so every fragment
   * is equally opaque, 'soft' fades a voxel out towards its edges. Flips one
   * uniform on the live material — compositing is the same either way (§4), so
   * there is no blend-state change and no rebuild.
   */
  setCompositeMode(mode: CompositeMode): void {
    this.flatModeUniform.value = mode === 'flat' ? 1 : 0;
    // Only a uniform changes now that the blend state is mode-independent, so no
    // `needsUpdate` and no pipeline rebuild.
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh?.dispose();
    this.material.dispose();
  }

  private writeVoxel(i: number, v: Voxel): void {
    const [cx, cy, cz] = v.center;
    this.centerArr[i * 3] = cx;
    this.centerArr[i * 3 + 1] = cy;
    this.centerArr[i * 3 + 2] = cz;
    this.halfArr[i] = v.size / 2;
    this.intensityArr[i] = v.intensity;
    this.colorArr[i * 3] = v.color[0];
    this.colorArr[i * 3 + 1] = v.color[1];
    this.colorArr[i * 3 + 2] = v.color[2];
    // Proxy cube placement: unit cube scaled to `size`, centered on the voxel.
    this.matrix.makeScale(v.size, v.size, v.size);
    this.matrix.setPosition(cx, cy, cz);
    this.mesh!.setMatrixAt(i, this.matrix);
  }

  private commit(): void {
    const mesh = this.mesh!;
    mesh.count = this.count;
    mesh.instanceMatrix.needsUpdate = true;
    this.centerAttr!.needsUpdate = true;
    this.halfAttr!.needsUpdate = true;
    this.intensityAttr!.needsUpdate = true;
    this.colorAttr!.needsUpdate = true;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let next = Math.max(this.capacity * 2, INITIAL_CAPACITY);
    while (next < needed) next *= 2;
    this.allocate(next);
  }

  /**
   * (Re)build the instanced mesh at `capacity` instances, preserving any voxels
   * already written. The material is **not** rebuilt: the shader binds its
   * instanced attributes by name off the geometry, so re-pointing those attributes
   * is enough.
   */
  private allocate(capacity: number): void {
    const centerArr = new Float32Array(capacity * 3);
    const halfArr = new Float32Array(capacity);
    const intensityArr = new Float32Array(capacity);
    const colorArr = new Float32Array(capacity * 3);
    centerArr.set(this.centerArr.subarray(0, this.count * 3));
    halfArr.set(this.halfArr.subarray(0, this.count));
    intensityArr.set(this.intensityArr.subarray(0, this.count));
    colorArr.set(this.colorArr.subarray(0, this.count * 3));

    const centerAttr = new THREE.InstancedBufferAttribute(centerArr, 3);
    const halfAttr = new THREE.InstancedBufferAttribute(halfArr, 1);
    const intensityAttr = new THREE.InstancedBufferAttribute(intensityArr, 1);
    const colorAttr = new THREE.InstancedBufferAttribute(colorArr, 3);
    for (const a of [centerAttr, halfAttr, intensityAttr, colorAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }

    // The instanced attributes live on the **shared** proxy geometry, bound by the
    // names the shader declares. Only one mesh exists at a time (the outgoing one
    // is retired below in the same call), so overwriting them here is safe and
    // saves rebuilding the cube for every growth step.
    this.geometry.setAttribute('aCenter', centerAttr);
    this.geometry.setAttribute('aHalf', halfAttr);
    this.geometry.setAttribute('aIntensity', intensityAttr);
    this.geometry.setAttribute('aColor', colorAttr);

    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.frustumCulled = false; // one draw call spanning the whole workspace

    // Re-establish proxy transforms for voxels carried over from the old mesh.
    for (let i = 0; i < this.count; i++) {
      const size = halfArr[i] * 2;
      this.matrix.makeScale(size, size, size);
      this.matrix.setPosition(centerArr[i * 3], centerArr[i * 3 + 1], centerArr[i * 3 + 2]);
      mesh.setMatrixAt(i, this.matrix);
    }
    mesh.count = this.count;
    mesh.instanceMatrix.needsUpdate = true;

    // Swap in the new mesh and retire the old one. The material is not rebuilt
    // and must not be disposed — it is shared across every allocation.
    const old = this.mesh;
    if (old) this.object.remove(old);
    this.object.add(mesh);
    old?.dispose();

    this.capacity = capacity;
    this.mesh = mesh;
    this.centerArr = centerArr;
    this.halfArr = halfArr;
    this.intensityArr = intensityArr;
    this.colorArr = colorArr;
    this.centerAttr = centerAttr;
    this.halfAttr = halfAttr;
    this.intensityAttr = intensityAttr;
    this.colorAttr = colorAttr;
  }

  /**
   * Build the one shared `ShaderMaterial`: per-channel **max** blending,
   * `depthWrite:false`, `depthTest:true` (specs/volumetric_rendering.md §4).
   *
   * Max blending is safe here — and was catastrophic against the main framebuffer —
   * because the fog draws into a target holding *only fog*, cleared to `(0,0,0,0)`.
   * There is no scene colour to lose a max against, so a pixel ends up at the single
   * strongest voxel along the ray and stacking never accumulates. The composite mode
   * does not touch the blend state; it picks only the path term, in the shader.
   */
  private buildMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uIntensityScale: this.intensityScaleUniform,
        uFlatMode: this.flatModeUniform,
      },
    });
    material.transparent = true;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.MaxEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendEquationAlpha = THREE.MaxEquation;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneFactor;
    material.depthWrite = false;
    material.depthTest = true;
    // Rasterize the proxy cube's *back* faces. The slab/chord is analytic (ray
    // vs AABB, t_enter clamped to 0), so it is identical whichever face spawns
    // the fragment — but back faces sit on the far side of the cube along the
    // view ray, so they survive near-plane clipping and the camera being inside
    // the fog volume, where front faces would be clipped/culled and the fog
    // would look cropped as the viewpoint moves.
    material.side = THREE.BackSide;
    return material;
  }
}
