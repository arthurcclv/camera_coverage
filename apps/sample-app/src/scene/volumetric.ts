/**
 * Voxel volumetric renderer (see specs/volumetric_rendering.md) — a
 * visualization-agnostic primitive that draws a set of voxels as additive
 * volumetric fog. Callers supply, per voxel, a {center, size, intensity, color};
 * one global `intensityScale` knob controls overall brightness.
 *
 * A single GPU-instanced unit cube (proxy geometry) is drawn with a TSL node
 * material whose fragment node slab-tests the view ray against each instance's
 * world-space AABB and accumulates `color * intensity * chord * intensityScale`
 * with additive, order-independent blending. The chord-length term gives soft
 * volumetric falloff at cube edges instead of hard cube silhouettes.
 *
 * The slab/chord math is authored as the pure-TS reference below (unit-tested in
 * test/volumetric.test.ts); the TSL fragment node mirrors it, echoing the SDK's
 * "CPU reference is the tested truth" discipline. Because it is TSL, the same
 * shader compiles to WGSL on the WebGPU backend and GLSL on the WebGL2 fallback
 * (spec.md §2.3).
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  positionWorld,
  instancedBufferAttribute,
  uniform,
  mix,
  float,
  vec3,
  vec4,
} from 'three/tsl';

export type Vec3 = [number, number, number];

/**
 * How per-voxel contributions combine along a view ray
 * (specs/volumetric_rendering.md §1, §4):
 *  - 'max'      — the pixel keeps the largest single voxel contribution
 *                 (per-channel max); chord is dropped, so cubes read hard-edged
 *                 (default).
 *  - 'additive' — contributions sum; chord-modulated soft fog.
 */
export type CompositeMode = 'additive' | 'max';

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

/** Default overall brightness multiplier (specs/volumetric_rendering.md §1). */
export const DEFAULT_INTENSITY_SCALE = 1;

/** Default composite mode (specs/volumetric_rendering.md §1, §4). */
export const DEFAULT_COMPOSITE_MODE: CompositeMode = 'max';

const EPS = 1e-6;
const INITIAL_CAPACITY = 1024;

// --- Pure-TS reference math (the tested truth the TSL node graph mirrors) ----

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
 * Per-voxel **additive** contribution: `rgb = color * intensity * chord *
 * intensityScale` (specs/volumetric_rendering.md §3). The chord term gives the
 * soft volumetric falloff at cube edges.
 */
export function voxelContribution(
  color: Vec3,
  intensity: number,
  chord: number,
  intensityScale: number,
): Vec3 {
  const k = intensity * chord * intensityScale;
  return [color[0] * k, color[1] * k, color[2] * k];
}

/**
 * Per-voxel **max-mode** contribution: `rgb = color * intensity * intensityScale`
 * (specs/volumetric_rendering.md §3). The chord term is dropped, so a grazing ray
 * and a full-chord ray of the same voxel emit the same flat value — the hard-edged
 * cube look — and compositing (§4) keeps the largest.
 */
export function maxContribution(color: Vec3, intensity: number, intensityScale: number): Vec3 {
  const k = intensity * intensityScale;
  return [color[0] * k, color[1] * k, color[2] * k];
}

/**
 * Combine per-voxel contributions along a ray for the given `mode`
 * (specs/volumetric_rendering.md §4): `additive` sums them, `max` takes the
 * per-channel maximum. Both are order-independent, so the result is invariant
 * under permutation of `contribs`. An empty set composites to black.
 */
export function compositeContributions(mode: CompositeMode, contribs: Vec3[]): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (const c of contribs) {
    for (let i = 0; i < 3; i++) {
      out[i] = mode === 'max' ? Math.max(out[i], c[i]) : out[i] + c[i];
    }
  }
  return out;
}

// --- Renderer ----------------------------------------------------------------

export class VoxelVolumetricRenderer {
  readonly object = new THREE.Group();

  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly intensityScaleUniform = uniform(DEFAULT_INTENSITY_SCALE);
  // Selects the chord term in the fragment node: 0 → use chord (additive soft
  // falloff), 1 → use 1.0 (max mode, flat per-instance value). Mirrors §3.
  private readonly maxModeUniform = uniform(DEFAULT_COMPOSITE_MODE === 'max' ? 1 : 0);
  private compositeMode: CompositeMode = DEFAULT_COMPOSITE_MODE;
  private readonly matrix = new THREE.Matrix4();

  private capacity = 0;
  private count = 0;

  private mesh: THREE.InstancedMesh | null = null;
  private material: THREE.NodeMaterial | null = null;
  private centerArr = new Float32Array(0);
  private halfArr = new Float32Array(0);
  private intensityArr = new Float32Array(0);
  private colorArr = new Float32Array(0);
  private centerAttr: THREE.InstancedBufferAttribute | null = null;
  private halfAttr: THREE.InstancedBufferAttribute | null = null;
  private intensityAttr: THREE.InstancedBufferAttribute | null = null;
  private colorAttr: THREE.InstancedBufferAttribute | null = null;

  constructor() {
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

  /** Overall brightness multiplier applied to every voxel's contribution. */
  setIntensityScale(scale: number): void {
    this.intensityScaleUniform.value = scale;
  }

  /**
   * Select how contributions combine along a ray (specs/volumetric_rendering.md
   * §4): 'additive' sums (soft chord-modulated fog), 'max' keeps the brightest
   * single voxel (per-channel max blend, chord dropped). Switches the blend state
   * and the chord toggle on the live material; no rebuild needed.
   */
  setCompositeMode(mode: CompositeMode): void {
    this.compositeMode = mode;
    this.maxModeUniform.value = mode === 'max' ? 1 : 0;
    if (this.material) {
      this.applyBlend(this.material);
      this.material.needsUpdate = true; // force the render pipeline to pick up the blend change
    }
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.mesh?.dispose();
    this.material?.dispose();
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
   * (Re)build the instanced mesh + node material at `capacity` instances,
   * preserving any voxels already written. The TSL node graph binds to the
   * freshly-created instanced attributes, so it is rebuilt alongside them.
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

    const material = this.buildMaterial(centerAttr, halfAttr, intensityAttr, colorAttr);
    const mesh = new THREE.InstancedMesh(this.geometry, material, capacity);
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

    // Swap in the new mesh/material and retire the old ones.
    const old = this.mesh;
    const oldMaterial = this.material;
    if (old) this.object.remove(old);
    this.object.add(mesh);
    old?.dispose();
    oldMaterial?.dispose();

    this.capacity = capacity;
    this.mesh = mesh;
    this.material = material;
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
   * Apply the blend state for the current composite mode (§4). Additive uses the
   * `AdditiveBlending` preset; max uses `CustomBlending` with a per-channel
   * `MaxEquation` (One/One factors, which the max equation ignores), so the
   * framebuffer keeps `max(src, dst)`.
   */
  private applyBlend(material: THREE.NodeMaterial): void {
    if (this.compositeMode === 'max') {
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.MaxEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneFactor;
      material.blendEquationAlpha = THREE.MaxEquation;
      material.blendSrcAlpha = THREE.OneFactor;
      material.blendDstAlpha = THREE.OneFactor;
    } else {
      material.blending = THREE.AdditiveBlending;
    }
  }

  /**
   * TSL fragment node mirroring `slabChord` + `voxelContribution`: slab-test the
   * view ray against the instance's world AABB, then accumulate the chord-scaled
   * color. Additive, depthWrite:false, depthTest:true (spec/volumetric §4).
   */
  private buildMaterial(
    centerAttr: THREE.InstancedBufferAttribute,
    halfAttr: THREE.InstancedBufferAttribute,
    intensityAttr: THREE.InstancedBufferAttribute,
    colorAttr: THREE.InstancedBufferAttribute,
  ): THREE.NodeMaterial {
    const center = instancedBufferAttribute(centerAttr);
    const half = instancedBufferAttribute(halfAttr);
    const intensity = instancedBufferAttribute(intensityAttr);
    const color = instancedBufferAttribute(colorAttr);

    const ro = cameraPosition;
    const rd = positionWorld.sub(ro).normalize();

    const boxMin = center.sub(vec3(half));
    const boxMax = center.add(vec3(half));

    // Per-component inverse direction. `rd` is normalized and, for a perspective
    // camera, its components are essentially never exactly zero, so a plain
    // reciprocal is safe; the min/max slab formulation below stays robust for
    // near-axis-parallel rays. (Must stay per-component — a scalar-collapsing
    // op here breaks the ray in some view quadrants.)
    const invDir = rd.reciprocal();

    const t1 = boxMin.sub(ro).mul(invDir);
    const t2 = boxMax.sub(ro).mul(invDir);
    const tmin = t1.min(t2);
    const tmax = t1.max(t2);
    const tEnter = tmin.x.max(tmin.y).max(tmin.z).max(0.0);
    const tExit = tmax.x.min(tmax.y).min(tmax.z);
    const chord = tExit.sub(tEnter).max(0.0);

    // Additive uses the chord (soft edges); max mode drops it to a flat 1.0 so the
    // fragment value is the per-instance `color*intensity*scale` (§3). maxMode is 0
    // in additive, 1 in max → mix picks chord vs 1.0.
    const pathTerm = mix(chord, float(1.0), this.maxModeUniform);
    const rgb = color.mul(intensity).mul(pathTerm).mul(this.intensityScaleUniform);

    const material = new THREE.NodeMaterial();
    material.fragmentNode = vec4(rgb, 1.0);
    material.transparent = true;
    this.applyBlend(material);
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
