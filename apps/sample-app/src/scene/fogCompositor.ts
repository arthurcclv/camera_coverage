/**
 * The coverage fog's two-target render pass — the mechanism specified in
 * specs/volumetric_rendering.md §4, which is where the *why* lives.
 *
 * In one paragraph: the fog needs a per-channel **max** among its own voxels (so a
 * pixel shows the single strongest voxel along the ray and a deep column does not
 * pile up) *and* **alpha over** the scene (so it stays legible on a bright floor or
 * a photographic capture). One draw call has one blend rule, and blending straight
 * into the main framebuffer loses whichever of the two it does not pick. So the fog
 * gets its own colour target, cleared to `(0,0,0,0)` — max against that is max among
 * fog only — and a full-screen triangle composites it over the scene with alpha.
 *
 * The fog target is handed `sceneTarget`'s `DepthTexture` rather than one of its own,
 * so it depth-tests against exactly the depth the main pass wrote: geometry occludes
 * voxels with no re-traversal of the scene and no list of what counts as an occluder.
 * The fog never writes depth, and the fog pass never clears it.
 *
 * The one exception is the 3DGS captures, which write no depth of their own — see
 * {@link SplatDepthWriter} — so their depth is added by a redraw of the splat group
 * alone, between the scene pass and the fog pass.
 */
import * as THREE from 'three';

/**
 * Something that can leave its depth in the scene target without drawing colour —
 * in practice the 3DGS captures (`splatLayer.ts`).
 *
 * Splats are alpha-blended and deliberately do **not** write depth in the pass you
 * see: a Gaussian is a soft blob with no surface, and letting them depth-reject one
 * another breaks their own blending into hard-edged plates. But that leaves nothing
 * in the depth buffer for the fog to test against, so the fog paints over captures
 * standing in front of it. Drawing them a second time, invisibly, gives the fog an
 * occluder while the visible pass keeps its clean blending.
 */
export interface SplatDepthWriter {
  /** Draw depth only. A no-op when there is no capture to draw. */
  writeDepth(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
}

/**
 * Composites `uScene` and the premultiplied `uFog` in one full-screen pass.
 *
 * `uFog` arrives **premultiplied** (the fog shader emits `color * alpha`), so the
 * source-over reduces to `scene * (1 - a) + fogRgb` with no divide — which also
 * means a fog texel of alpha 0 contributes exactly nothing, whatever its RGB.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uFog;
  varying vec2 vUv;

  void main() {
    vec4 scene = texture2D(uScene, vUv);
    vec4 fog = texture2D(uFog, vUv);
    gl_FragColor = vec4(scene.rgb * (1.0 - fog.a) + fog.rgb, scene.a);

    // **Required, and easy to miss.** Three.js applies its output colour-space
    // transform only when rendering to the canvas; a render target receives raw
    // **linear** values. Both targets are therefore linear, this composite mixes
    // them in linear (which is the correct space for it), and the conversion to
    // sRGB has to happen here — at the one point that does write the canvas.
    // Without it every pixel ships linear values to an sRGB display and the whole
    // scene renders visibly **darker**.
    #include <colorspace_fragment>
  }
`;

const COMPOSITE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class FogCompositor {
  /** Where the main scene draws. Its depth is what the fog tests against. */
  private sceneTarget: THREE.WebGLRenderTarget;
  /** Colour-only fog accumulation; shares `sceneTarget`'s depth attachment. */
  private fogTarget: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  /**
   * The composite draws a full-screen triangle in clip space, so the camera is
   * never actually consulted — but `render` requires one.
   */
  private readonly quadCamera = new THREE.Camera();
  private readonly compositeMaterial: THREE.ShaderMaterial;
  /** Scratch for `getDrawingBufferSize`, so resizing allocates nothing. */
  private readonly bufferSize = new THREE.Vector2();
  /** Scratch for `getClearColor`, so the per-frame save/restore allocates nothing. */
  private readonly prevClear = new THREE.Color();

  constructor() {
    const depth = new THREE.DepthTexture(1, 1);
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: depth });
    // The same `depthTexture` instance, so the fog target attaches the scene's depth
    // rather than allocating one of its own. Three.js binds the texture in place of
    // the default renderbuffer, which is what makes the two passes share depth.
    this.fogTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: depth });

    this.compositeMaterial = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: {
        uScene: { value: this.sceneTarget.texture },
        uFog: { value: this.fogTarget.texture },
      },
      depthTest: false,
      depthWrite: false,
    });
    // One oversized triangle rather than a quad: no diagonal seam, one fewer
    // vertex, and every pixel is covered exactly once.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.quad = new THREE.Mesh(geometry, this.compositeMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Size both targets to the renderer's **drawing buffer**, read off the renderer
   * itself rather than recomputed from the CSS size and the device pixel ratio —
   * so the targets cannot drift from the canvas they are composited onto. Called
   * from the viewport's single `ResizeObserver`, after `renderer.setSize`.
   */
  setSize(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.bufferSize);
    const w = Math.max(1, Math.floor(this.bufferSize.x));
    const h = Math.max(1, Math.floor(this.bufferSize.y));
    this.sceneTarget.setSize(w, h);
    this.fogTarget.setSize(w, h);
  }

  /**
   * Draw the main scene into the offscreen target instead of the canvas. Depth
   * lands in the shared `DepthTexture`, which is the whole point.
   */
  renderScene(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    splatDepth: SplatDepthWriter | null,
  ): void {
    renderer.setRenderTarget(this.sceneTarget);
    // `render` clears for us here (autoClear is on), which is what lays down the
    // depth the fog pass then reads.
    renderer.render(scene, camera);
    // Then the captures' depth, into the same target. **After** the scene, not
    // before: Spark generates its splats on the frame's first render, so a pass
    // ahead of that lays no depth at all and silently does nothing.
    splatDepth?.writeDepth(renderer, camera);
  }

  /**
   * Accumulate `fogScene` into the fog target with max blending, then composite
   * scene + fog to the canvas.
   *
   * The fog target is cleared **colour-only**: its depth attachment is the scene's,
   * already written by {@link renderScene}, and clearing it would let every voxel
   * through regardless of what stands in front of it.
   */
  composite(renderer: THREE.WebGLRenderer, fogScene: THREE.Scene | null, camera: THREE.Camera): void {
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(this.prevClear).getHex();
    const prevClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.fogTarget);
    renderer.setClearColor(0x000000, 0);
    // Colour only. The depth attachment is `sceneTarget`'s, already written by
    // `renderScene`, and it is what makes geometry occlude a voxel.
    renderer.clear(true, false, false);
    // **`autoClear` off is load-bearing**, not tidiness: `render` clears the bound
    // target when it is on, so it would wipe the depth we just went out of our way
    // to preserve — and the fog would draw over everything, through walls
    // included. That was the first version of this method, and it looked exactly
    // like "geometry does not block fog".
    renderer.autoClear = false;
    // Null before a run has produced any fog: the cleared target then composites to
    // exactly the scene, so the frame still takes one path either way.
    if (fogScene) renderer.render(fogScene, camera);

    renderer.setRenderTarget(null);
    // The triangle covers every pixel, so nothing needs clearing here either.
    renderer.render(this.quadScene, this.quadCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClearColor, prevClearAlpha);
  }

  dispose(): void {
    // The depth texture is shared, so it is disposed once here rather than by each
    // target's own `dispose` (which does not own it).
    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
    this.fogTarget.dispose();
    this.quad.geometry.dispose();
    this.compositeMaterial.dispose();
  }
}
