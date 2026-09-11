/**
 * Camera name labels (spec §5.3) — one textured quad per camera, drawn after the fog
 * composite (`volumetric_rendering.md` §4.1) with a damped, per-label opacity.
 *
 * Four things about this layer are deliberate, and each is a decision recorded in
 * ai/DECISIONS.md:
 *
 * - **Not a `THREE.Sprite`.** The label holds a constant *pixel* size and a constant
 *   *pixel* gap from the body at every distance, in five views across two projections.
 *   That is a
 *   vertex-shader offset in NDC (`px * 2 / resolution * clipW`), exact under both
 *   perspective and orthographic cameras and free of per-frame JS — and a custom
 *   shader is something a `Sprite` cannot carry, its billboarding living inside
 *   `SpriteMaterial`'s own program.
 * - **Not in the viewport scene.** A label hazed by the coverage fog is unreadable
 *   exactly when the fog is densest, which defeats the point of a label. This layer
 *   owns its own `THREE.Scene` and is rendered over the composited canvas.
 * - **Occlusion decided at the anchor.** After the composite the canvas depth no longer
 *   describes the scene, so the same `DepthTexture` the fog tests against is sampled at
 *   the **body's** screen position — once per label, not per fragment. A camera behind a
 *   wall does not announce itself through the wall; a camera whose body is visible draws
 *   its whole label on top of everything, never cut in half by something crossing it.
 * - **Opacity is eased, never switched** (spec §5.3). The raw test is smoothed
 *   spatially (a ring of depth taps, each ramped over a depth band) and then
 *   temporally: one texel of state per label, eased toward the raw result by the blend
 *   unit's constant alpha, which is an exponential moving average with no ping-pong
 *   pair and no readback. That state pass is
 *   {@link CameraLabelLayer.renderProbePass}'s job — pass 4a of
 *   `volumetric_rendering.md` §4.1.
 *
 * Two things are **not** re-derived here: `cameraBodyVisible` (cameraGizmos.ts) is the
 * one predicate deciding whether a label draws, so a label cannot outlive the body it
 * names; and the create/update/sweep loop is `reconcileKeyed` (gizmoSet.ts), the same
 * loop the four gizmo sets run.
 */
import * as THREE from 'three';
import { cameraLabel, type SceneCamera } from '../cameras/camera.ts';
import {
  CAMERA_BODY_RADIUS,
  SELECTED_BODY_SCALE,
  cameraBodyRadius,
  cameraBodyVisible,
  type CameraFocus,
} from './cameraGizmos.ts';
import { reconcileKeyed } from './gizmoSet.ts';
import {
  LABEL_FONT,
  LABEL_LINE_PX,
  LABEL_MAX_TEXT_PX,
  LABEL_PAD_X,
  LABEL_PAD_Y,
  LABEL_STROKE_PX,
  ellipsise,
  LABEL_QUAD_OFFSET_PX,
  labelBoxPx,
} from './cameraLabelText.ts';

/**
 * Label colours (VISUAL_DESIGN.md). Uniform — camera state is the body's job.
 *
 * White glyphs inside a black outline, and **no plate**: a plate per name is a grid of
 * opaque rectangles over the fog and the capture at ~100 cameras (spec §5.3). The text is
 * white rather than the palette's `#e6e8eb` because its contrast now rests on the
 * outline rather than on a dark ground.
 */
const TEXT_FILL = '#ffffff';
const OUTLINE_STROKE = '#000000';

/**
 * Time constant of the opacity fade, in ms (spec §5.3): a transition is ~63% done
 * after this long and visually complete in about three times it.
 */
export const FADE_TAU_MS = 150;

/**
 * Longest frame the fade will honour, in ms. A backgrounded tab resumes with one
 * bounded step rather than a jump straight to the raw value, which is the same reason
 * the fade is written against elapsed time in the first place.
 *
 * Deliberately **below** {@link FADE_TAU_MS}: the cap exists to bound a stall, so no
 * single frame may cover a whole time constant however long the gap was.
 */
export const FADE_MAX_STEP_MS = 100;

/** Labels per state-target growth step, so capacity changes are rare. */
const SLOT_STEP = 64;

/**
 * The blend weight for one frame of the opacity fade: `1 - exp(-dt / tau)`.
 *
 * This is what makes the fade **frame-rate independent** — twice the elapsed time
 * moves the value more, so 30 fps and 120 fps produce the same curve in seconds. It is
 * fed to the blend unit as its constant alpha, and the state target accumulates
 * `k * raw + (1 - k) * previous`.
 */
export function fadeStep(dtMs: number, tauMs: number): number {
  const dt = Math.min(Math.max(dtMs, 0), FADE_MAX_STEP_MS);
  return 1 - Math.exp(-dt / tauMs);
}

/**
 * A rasterised label: the texture to sample and its size in **device** pixels, which
 * is also the quad's on-screen size. Device rather than CSS pixels so the texture is
 * sampled 1:1 at the drawing buffer's scale.
 */
export interface RasterizedLabel {
  texture: THREE.Texture;
  widthPx: number;
  heightPx: number;
}

/** Draws a label's text onto a texture. Injected so the layer constructs without a DOM. */
export type LabelRasterizer = (text: string) => RasterizedLabel;

/**
 * The 2D-context calls a label's text needs — a protocol, not the whole context, so the
 * painter can be driven by a recording stub under `node --test` (CONVENTIONS.md). The
 * order of the two draws is the load-bearing part, which is what there is to test.
 */
export type LabelTextContext = {
  font: string;
  textBaseline: CanvasTextBaseline;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
};

/**
 * Draws one label's already-ellipsised text into `ctx`, at the margin's origin.
 *
 * Outline first, then the fill on top: the stroke straddles the glyph outline, so
 * filling afterwards keeps the inner half of it off the letterforms and leaves the full
 * 11 px/600 weight intact (§5.3). Round joins because a miter on a tight corner — the
 * crotch of a 'W', an 'x' — spikes out well past the line width.
 */
export function paintLabelText(ctx: LabelTextContext, shown: string): void {
  const baseline = LABEL_PAD_Y + LABEL_LINE_PX / 2;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = LABEL_STROKE_PX;
  ctx.strokeStyle = OUTLINE_STROKE;
  ctx.strokeText(shown, LABEL_PAD_X, baseline);
  ctx.fillStyle = TEXT_FILL;
  ctx.fillText(shown, LABEL_PAD_X, baseline);
}

/**
 * The default rasteriser: a 2D canvas at the renderer's pixel ratio, so text is crisp
 * on a HiDPI display. The ratio is read once, like the renderer's own
 * (`viewport.ts` sets it at construction and never tracks changes).
 */
export function canvasLabelRasterizer(pixelRatio = 1): LabelRasterizer {
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d')!;
  measureCtx.font = LABEL_FONT;

  return (text: string): RasterizedLabel => {
    const shown = ellipsise(text, (t) => measureCtx.measureText(t).width, LABEL_MAX_TEXT_PX);
    const box = labelBoxPx(measureCtx.measureText(shown).width);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(box.width * pixelRatio));
    canvas.height = Math.max(1, Math.ceil(box.height * pixelRatio));
    const ctx = canvas.getContext('2d')!;
    ctx.scale(pixelRatio, pixelRatio);

    paintLabelText(ctx, shown);

    const texture = new THREE.CanvasTexture(canvas);
    // The canvas holds sRGB values; WebGL2 decodes them on sample, and the shader's
    // colorspace_fragment encodes back for the canvas — the same round trip
    // fogCompositor.ts documents.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return { texture, widthPx: canvas.width, heightPx: canvas.height };
  };
}

// --- pass 4a: the occlusion probe (volumetric_rendering.md §4.1) --------------
//
// The shader sources are exported so the suite can assert on them directly, the way
// `volumetric.test.ts` asserts on the fog's `FRAGMENT_SHADER` — a weak source-parity
// check that catches a term silently dropped in an edit (CONVENTIONS.md).

export const PROBE_VERTEX_SHADER = /* glsl */ `
  attribute float aSlot;
  uniform float uCapacity;
  varying vec2 vAnchorUv;
  varying float vAnchorViewZ;
  varying float vAnchorW;

  void main() {
    // The anchor is the camera body; its projection is what gets *sampled*, not what
    // this point is drawn at.
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vAnchorViewZ = view.z;
    vec4 clip = projectionMatrix * view;
    vAnchorW = clip.w;
    vAnchorUv = (clip.xy / clip.w) * 0.5 + 0.5;

    // One pixel of the state target per label: the slot picks the texel. The target is
    // one row, so y sits at its centre.
    gl_Position = vec4(((aSlot + 0.5) / uCapacity) * 2.0 - 1.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
  }
`;

/**
 * The tolerance's numbers, and the CPU reference that mirrors the shader's use of them
 * (`volumetric_rendering.md` §4.1). The shader is built from these constants rather
 * than repeating them, so the two cannot drift, and the *magnitude* the tolerance comes
 * to at a given distance is testable without a GPU — which is the part the spec is
 * making a claim about.
 */

/** Steps a 24-bit depth buffer resolves. */
export const DEPTH_STEPS = 16777216;

/**
 * Safety factor on the quantisation step. Eight rather than one because quantisation is
 * only the first of the errors between a depth texel and the surface it stands for: the
 * interpolation across the fragment and the linearisation back to view space each add
 * their own, and a capture's pass-1b depth is noisier still (§4.1).
 */
export const DEPTH_SAFETY = 8;

/**
 * The body radius the probe clears: the **larger** of the two body sizes, so a selected
 * body is cleared too (§5.3). One uniform rather than a per-anchor attribute — the two
 * differ by 0.09 m, well under the depth precision the tolerance also carries.
 */
export const MAX_BODY_RADIUS = CAMERA_BODY_RADIUS * SELECTED_BODY_SCALE;

/**
 * How much nearer than the anchor an occluder must be before it starts to count, in
 * metres — the body's radius plus what the depth buffer cannot resolve there, and
 * nothing else (§4.1). The ramp is one further tolerance wide, so an occluder counts
 * fully at twice this.
 *
 * Neither term scales with the eye distance, which is the failure this pass exists to
 * avoid: a fraction of the distance is a metres-wide blind spot around every body at
 * site scale, and a wall stops hiding the camera mounted on it.
 */
export function labelOcclusionToleranceM(
  dist: number,
  near: number,
  far: number,
  ortho: boolean,
): number {
  // A perspective buffer stores a reciprocal, so its world-space step grows with the
  // square of the distance; an orthographic one is linear, so its step is constant.
  const step = ortho ? far - near : dist * dist * (1 / near - 1 / far);
  return MAX_BODY_RADIUS + (step * DEPTH_SAFETY) / DEPTH_STEPS;
}

export const PROBE_FRAGMENT_SHADER = /* glsl */ `
  #include <packing>

  uniform sampler2D uDepth;
  uniform vec2 uResolution;
  uniform float uNear;
  uniform float uFar;
  uniform bool uOrtho;
  uniform bool uOcclude;
  uniform float uMaxBodyRadius;
  varying vec2 vAnchorUv;
  varying float vAnchorViewZ;
  varying float vAnchorW;

  // Spatial half of the damping (spec §5.3): a single texel against a single threshold
  // is a knife edge in two directions at once — the anchor's pixel drifts sub-pixel as
  // the view moves, and the depth written there is unstable where the body is
  // near-coplanar with a surface or in front of a capture's pass-1b depth. So the taps
  // are spread over a ring and each ramps over a depth band.
  const float TAP_RADIUS_PX = 3.0;

  // From the TS constants above, so the shader and {@link labelOcclusionToleranceM}
  // cannot disagree about what the tolerance comes to.
  const float DEPTH_STEPS = ${DEPTH_STEPS}.0;
  const float DEPTH_SAFETY = ${DEPTH_SAFETY}.0;

  /** What the depth buffer cannot resolve at that distance, in metres. */
  float depthPrecisionAt(float dist) {
    // A perspective buffer stores a reciprocal, so its world-space step grows with the
    // square of the distance; an orthographic one is linear, so its step is constant.
    float step = uOrtho
      ? (uFar - uNear)
      : dist * dist * (1.0 / uNear - 1.0 / uFar);
    return step * DEPTH_SAFETY / DEPTH_STEPS;
  }

  /** Distance from the eye to whatever the scene wrote at uv, in metres. */
  float sceneDistAt(vec2 uv) {
    float d = texture2D(uDepth, clamp(uv, 0.0, 1.0)).x;
    // Window-space z is crushed toward the far plane, so both sides of the comparison
    // go to view-space distance first — which means branching on the projection, the
    // app having three orthographic views as well as two perspective ones.
    float viewZ = uOrtho
      ? orthographicDepthToViewZ(d, uNear, uFar)
      : perspectiveDepthToViewZ(d, uNear, uFar);
    return -viewZ;
  }

  /** 0 = the body is buried, 1 = clear, with a ramp between. */
  float anchorVisibility() {
    float anchorDist = -vAnchorViewZ;
    // Two terms, both sized from something real — see {@link labelOcclusionToleranceM},
    // which this mirrors. The body's own sphere sits at the anchor and is usually what
    // the depth texture holds there, so its front face — one radius nearer — has to read
    // as clear. The rest is what the buffer itself cannot resolve.
    float tol = uMaxBodyRadius + depthPrecisionAt(anchorDist);
    vec2 tap = TAP_RADIUS_PX / uResolution;

    float sum = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        float sceneDist = sceneDistAt(vAnchorUv + vec2(float(x), float(y)) * tap);
        // The ramp is one further tolerance wide, so an occluder counts fully at twice it.
        sum += smoothstep(anchorDist - 2.0 * tol, anchorDist - tol, sceneDist);
      }
    }

    // Shaped so a mostly-clear anchor reads fully visible and a mostly-buried one fully
    // hidden: a label near an edge must not settle at a permanent half.
    return smoothstep(0.25, 0.75, sum / 9.0);
  }

  void main() {
    // An anchor behind the eye has a negative w and a meaningless projection. It reads
    // as hidden rather than being skipped, so a label coming back into view fades in
    // instead of reappearing at whatever opacity it left with.
    float raw = !uOcclude ? 1.0 : (vAnchorW > 0.0 ? anchorVisibility() : 0.0);
    // The easing is the blend unit's: this value is weighted by the constant alpha and
    // added to what the texel already holds (volumetric_rendering.md §4.1).
    gl_FragColor = vec4(raw, raw, raw, 1.0);
  }
`;

// --- pass 4: the labels themselves -------------------------------------------

export const LABEL_VERTEX_SHADER = /* glsl */ `
  uniform vec2 uSizePx;
  uniform vec2 uOffsetPx;
  uniform vec2 uResolution;
  uniform float uBodyRadius;
  varying vec2 vUv;

  void main() {
    // The quad is positioned from its *anchor* (the camera body), not per-vertex: every
    // corner shares one depth, which is what makes the pixel offset a pure screen-space
    // translation rather than a perspective-warped one.
    vec4 anchorView = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 clip = projectionMatrix * anchorView;

    // The gap is measured from the body's **edge**, not its centre (spec §5.3), and
    // the body is world-sized — so how wide it draws depends entirely on the framing.
    // A fixed offset from the centre puts the label *on top of* a body a couple of
    // metres from the eye, which is exactly the close-up the Perspective view is for.
    // A world offset r along view-x lands at P[0][0] * r in clip space with clip.w
    // unchanged, so this is the body's radius in pixels under either projection
    // (clip.w is 1 under an orthographic camera). Clamped because an anchor behind the
    // eye has a w near zero, and its label is faded out by pass 4a anyway.
    float bodyPx = min(
      uBodyRadius * projectionMatrix[0][0] * 0.5 * uResolution.x / max(clip.w, 1e-4),
      uResolution.x
    );

    // PlaneGeometry(1,1) spans -0.5..0.5, so position.xy * uSizePx is the label in
    // pixels. Multiplying the NDC step by clip.w cancels the perspective divide, so the
    // result is the same pixel size at any distance — and under an orthographic camera,
    // where clip.w is 1, the same expression is already correct.
    vec2 px = position.xy * uSizePx + uOffsetPx + vec2(bodyPx, 0.0);
    clip.xy += px * 2.0 / uResolution * clip.w;

    gl_Position = clip;
    vUv = uv;
  }
`;

export const LABEL_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uState;
  uniform float uSlot;
  uniform float uCapacity;
  varying vec2 vUv;

  void main() {
    // This label's own texel of the state target: the damped occlusion written by pass
    // 4a. One value for the whole quad, so the label fades as a unit.
    float visibility = texture2D(uState, vec2((uSlot + 0.5) / uCapacity, 0.5)).r;
    // Early-outs, not the test: the eased value below is what decides opacity, and both
    // thresholds sit far enough under anything visible to be a cost saving only — a
    // label already faded out, and the label's transparent margin (§4.1).
    if (visibility <= 0.004) discard;

    vec4 texel = texture2D(uMap, vUv);
    if (texel.a <= 0.001) discard;
    gl_FragColor = vec4(texel.rgb, texel.a * visibility);

    // This pass draws straight to the canvas, so it owns its output conversion the same
    // way the fog composite does.
    #include <colorspace_fragment>
  }
`;

// --- carrying the state across a capacity change ------------------------------

const COPY_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Maps the grown row back onto the old one: new texel i sits at uv.x = (i + 0.5) /
 * newCapacity, and the same label's old texel is at (i + 0.5) / oldCapacity — so one
 * scale factor is the whole mapping, exact under `NearestFilter`.
 *
 * Done in the shader rather than by drawing through a narrower **viewport**, which is
 * the obvious alternative and is wrong: `WebGLRenderer` multiplies a viewport (and a
 * scissor) by its pixel ratio, so on a HiDPI display the copy would land at twice the
 * width of the row it is copying.
 */
const COPY_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uSource;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    float u = vUv.x * uScale;
    // Past the old capacity there is no average to carry, and zero is what a texel no
    // label has been probed into holds anyway — so those labels fade in.
    gl_FragColor = u > 1.0 ? vec4(0.0) : texture2D(uSource, vec2(u, 0.5));
  }
`;

/**
 * Zeroes the texels of recycled slots — one point each, `position.x` carrying the slot,
 * the same slot-to-NDC mapping the probe uses. A draw rather than a scissored clear for
 * the pixel-ratio reason above.
 */
const RESET_VERTEX_SHADER = /* glsl */ `
  uniform float uCapacity;
  void main() {
    gl_Position = vec4(((position.x + 0.5) / uCapacity) * 2.0 - 1.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
  }
`;

const RESET_FRAGMENT_SHADER = /* glsl */ `
  void main() {
    gl_FragColor = vec4(0.0);
  }
`;

/** Per-frame state the passes need, supplied by the viewport that owns the render loop. */
export interface LabelPassContext {
  /**
   * The renderer, because {@link LabelOverlay.renderProbePass} runs a pass of its own
   * (4a) into an offscreen target. It restores the previously bound target before
   * returning.
   */
  renderer: THREE.WebGLRenderer;
  /** The scene depth the labels test against, or null to draw them unoccluded. */
  depth: THREE.Texture | null;
  /** Drawing-buffer size in device pixels. */
  width: number;
  height: number;
  camera: THREE.Camera;
  /** The frame's timestamp in ms. The viewport's loop owns the clock, so it supplies it. */
  nowMs: number;
}

/** What `Viewport` needs from an overlay drawn after the fog composite (§4.1). */
export interface LabelOverlay {
  scene: THREE.Scene;
  /** Pass 4a: resolve this frame's per-label occlusion into the overlay's own target. */
  renderProbePass(ctx: LabelPassContext): void;
}

interface LabelEntry {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  texture: THREE.Texture;
  /** The text currently rasterised, so a rename re-rasterises and nothing else does. */
  text: string;
  /** Which texel of the state target holds this label's damped opacity. */
  slot: number;
}

export class CameraLabelLayer implements LabelOverlay {
  /** Its own scene — labels are never added to the viewport's (see the file header). */
  readonly scene = new THREE.Scene();
  private readonly entries = new Map<string, LabelEntry>();
  /** One unit quad shared by every label, disposed with the layer. */
  private readonly geometry = new THREE.PlaneGeometry(1, 1);

  /** Uniforms shared by every label material, so a capacity change is one write. */
  private readonly labelShared = {
    uState: { value: null as THREE.Texture | null },
    uCapacity: { value: SLOT_STEP },
  };

  private readonly probeUniforms = {
    uDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
    uOrtho: { value: false },
    uOcclude: { value: false },
    uMaxBodyRadius: { value: MAX_BODY_RADIUS },
    uCapacity: { value: SLOT_STEP },
  };

  /**
   * The damped opacities, one texel per label. **Half float, and never cleared** after
   * its one-time initialisation: an 8-bit texel quantises the moving average's
   * increments so it stalls short of its limit, and clearing it would restart every
   * label's fade (`volumetric_rendering.md` §4.1). The two things that would otherwise
   * force a clear are handled without one: a recycled slot has *its own texel* zeroed
   * ({@link flushSlotResets}), and a capacity change **copies** the old averages across
   * ({@link flushPendingCopy}).
   */
  private stateTarget: THREE.WebGLRenderTarget;
  private stateInitialised = false;
  private capacity = SLOT_STEP;

  /**
   * The pre-growth state target, waiting to be copied into the grown one. The copy is a
   * draw and `update` has no renderer, hence the queue; the recycled-slot resets are
   * queued for the same reason, in {@link resetGeometry}'s draw range.
   */
  private pendingCopyFrom: THREE.WebGLRenderTarget | null = null;
  private pendingCopyCapacity = 0;

  private readonly probeScene = new THREE.Scene();
  private readonly probeGeometry = new THREE.BufferGeometry();
  private readonly probeMaterial: THREE.ShaderMaterial;
  private probeAnchors = new Float32Array(SLOT_STEP * 3);
  private probeSlots = new Float32Array(SLOT_STEP);
  /** High-water mark of allocated slots — the probe pass's draw range. */
  private slotCount = 0;
  private readonly freeSlots: number[] = [];

  /** The state-copy pass: one oversized triangle, like `fogCompositor.ts`'s composite. */
  private readonly copyScene = new THREE.Scene();
  private readonly copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly copyGeometry = new THREE.BufferGeometry();
  private readonly copyMaterial: THREE.ShaderMaterial;

  /** The recycled-slot reset pass: one point per slot to zero. */
  private readonly resetScene = new THREE.Scene();
  private readonly resetGeometry = new THREE.BufferGeometry();
  private readonly resetMaterial: THREE.ShaderMaterial;
  private resetSlots = new Float32Array(SLOT_STEP * 3);

  private lastFrameMs: number | null = null;
  /** Scratch for the clear-colour save/restore, so the frame allocates nothing. */
  private readonly prevClear = new THREE.Color();

  private readonly rasterize: LabelRasterizer;

  // A plain field, not a parameter property: the test suite runs under Node's
  // strip-only type stripping, which rejects those (CONVENTIONS.md).
  constructor(rasterize: LabelRasterizer) {
    this.rasterize = rasterize;

    this.stateTarget = makeStateTarget(SLOT_STEP);
    this.labelShared.uState.value = this.stateTarget.texture;

    this.probeGeometry.setAttribute('position', new THREE.BufferAttribute(this.probeAnchors, 3));
    this.probeGeometry.setAttribute('aSlot', new THREE.BufferAttribute(this.probeSlots, 1));
    this.probeGeometry.setDrawRange(0, 0);

    this.probeMaterial = new THREE.ShaderMaterial({
      uniforms: this.probeUniforms,
      vertexShader: PROBE_VERTEX_SHADER,
      fragmentShader: PROBE_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      // The temporal half of the damping, done by the blend unit rather than in a
      // shader: dst = k * src + (1 - k) * dst, with k the constant alpha set each frame
      // from elapsed time. That is an exponential moving average of the raw test, with
      // no ping-pong pair and no read of the bound target (§4.1).
      blending: THREE.CustomBlending,
      blendSrc: THREE.ConstantAlphaFactor,
      blendDst: THREE.OneMinusConstantAlphaFactor,
      blendSrcAlpha: THREE.ConstantAlphaFactor,
      blendDstAlpha: THREE.OneMinusConstantAlphaFactor,
      blendAlpha: 1,
    });

    const points = new THREE.Points(this.probeGeometry, this.probeMaterial);
    // Drawn at slot positions, not at the anchors in the position attribute, so three's
    // frustum test would be asking the wrong question.
    points.frustumCulled = false;
    this.probeScene.add(points);

    // Named so a frame capture — and the suite's recording renderer stub — can tell the
    // three passes this layer runs apart.
    this.probeScene.name = 'cameraLabelProbe';

    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSource: { value: null as THREE.Texture | null },
        uScale: { value: 1 },
      },
      vertexShader: COPY_VERTEX_SHADER,
      fragmentShader: COPY_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.copyGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.copyGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const copyTriangle = new THREE.Mesh(this.copyGeometry, this.copyMaterial);
    copyTriangle.frustumCulled = false;
    this.copyScene.name = 'cameraLabelStateCopy';
    this.copyScene.add(copyTriangle);

    this.resetMaterial = new THREE.ShaderMaterial({
      uniforms: { uCapacity: this.probeUniforms.uCapacity },
      vertexShader: RESET_VERTEX_SHADER,
      fragmentShader: RESET_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.resetGeometry.setAttribute('position', new THREE.BufferAttribute(this.resetSlots, 3));
    this.resetGeometry.setDrawRange(0, 0);
    const resetPoints = new THREE.Points(this.resetGeometry, this.resetMaterial);
    resetPoints.frustumCulled = false;
    this.resetScene.name = 'cameraLabelStateReset';
    this.resetScene.add(resetPoints);
  }

  /**
   * Reconcile the labels against the current cameras (spec §5.3).
   *
   * `namesVisible` is the **Camera names** toggle (§2.4); everything else about whether
   * a label draws comes from `cameraBodyVisible`, the same predicate the gizmo set
   * uses, so the two layers cannot disagree. Those are deliberate user actions and
   * apply **instantly** — only occlusion is faded.
   */
  update(cameras: SceneCamera[], focus: CameraFocus, namesVisible: boolean): void {
    reconcileKeyed(this.entries, cameras, {
      create: (cam) => this.createEntry(cameraLabel(cam)),
      update: (entry, cam) => {
        // A rename re-rasterises; a move does not (spec §5.3).
        const text = cameraLabel(cam);
        if (entry.text !== text) this.retexture(entry, text);

        entry.mesh.position.set(...cam.position);
        entry.mesh.visible = namesVisible && cameraBodyVisible(cam, focus);
        // The label clears the body's *projected* edge, and the selected body is scaled
        // up, so the radius is part of the per-frame state (spec §5.3).
        entry.material.uniforms.uBodyRadius.value = cameraBodyRadius(cam.id, focus);

        // The probe pass reads anchors from its own attribute, so a moved camera has to
        // be written through here as well as onto the quad.
        this.probeAnchors[entry.slot * 3] = cam.position[0];
        this.probeAnchors[entry.slot * 3 + 1] = cam.position[1];
        this.probeAnchors[entry.slot * 3 + 2] = cam.position[2];
      },
      dispose: (entry) => this.disposeEntry(entry),
    });

    this.probeGeometry.getAttribute('position').needsUpdate = true;
    this.probeGeometry.getAttribute('aSlot').needsUpdate = true;
    this.probeGeometry.setDrawRange(0, this.slotCount);
  }

  /**
   * Run the occlusion probe for this frame (pass 4a) and point the label pass at its
   * result. Restores the render target, `autoClear`, clear colour and viewport it was
   * called with.
   */
  renderProbePass({ renderer, depth, width, height, camera, nowMs }: LabelPassContext): void {
    this.probeUniforms.uDepth.value = depth;
    this.probeUniforms.uOcclude.value = depth !== null;
    this.probeUniforms.uResolution.value.set(width, height);
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
    this.probeUniforms.uOrtho.value = ortho;
    const lens = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    this.probeUniforms.uNear.value = lens.near;
    this.probeUniforms.uFar.value = lens.far;

    // The very first frame has no elapsed time, so `k` is 0 and every label stays at
    // the target's initial zero — which is exactly the spec'd fade-in on load (§5.3).
    const dt = this.lastFrameMs === null ? 0 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    this.probeMaterial.blendAlpha = fadeStep(dt, FADE_TAU_MS);

    if (this.slotCount === 0) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this.stateTarget);
    // **`autoClear` off is load-bearing**, and it covers all three draws below: the
    // target *is* the state, so a clear by `render` would throw away the moving average
    // this pass exists to accumulate.
    renderer.autoClear = false;

    if (!this.stateInitialised) {
      // One clear, ever. Zero means "hidden", which is why a label the layer has not
      // probed yet fades in rather than popping (spec §5.3). It supersedes any queued
      // housekeeping — there is no state left to preserve.
      const prevClearColor = renderer.getClearColor(this.prevClear).getHex();
      const prevClearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      this.resetGeometry.setDrawRange(0, 0);
      this.releasePendingCopy();
      this.stateInitialised = true;
    } else {
      // Neither of these clears the *state*: one carries it into a grown target, the
      // other zeroes the single texel of a recycled slot (§4.1).
      this.flushPendingCopy(renderer);
      this.flushSlotResets(renderer);
    }

    renderer.render(this.probeScene, camera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.geometry.dispose();
    this.stateTarget.dispose();
    this.releasePendingCopy();
    this.probeGeometry.dispose();
    this.probeMaterial.dispose();
    this.copyGeometry.dispose();
    this.copyMaterial.dispose();
    this.resetGeometry.dispose();
    this.resetMaterial.dispose();
  }

  /**
   * Copy the pre-growth averages into the grown target, so a capacity change costs no
   * label its fade (`volumetric_rendering.md` §4.1). One triangle over the whole row —
   * every texel is written, so nothing needs clearing first.
   */
  private flushPendingCopy(renderer: THREE.WebGLRenderer): void {
    const source = this.pendingCopyFrom;
    if (!source) return;

    this.copyMaterial.uniforms.uSource.value = source.texture;
    this.copyMaterial.uniforms.uScale.value = this.capacity / this.pendingCopyCapacity;
    renderer.render(this.copyScene, this.copyCamera);
    this.releasePendingCopy();
  }

  /**
   * Zero the texels of slots handed on from a departed label — one point each, so no
   * other label's average is touched.
   */
  private flushSlotResets(renderer: THREE.WebGLRenderer): void {
    const count = this.resetGeometry.drawRange.count;
    if (count === 0) return;

    renderer.render(this.resetScene, this.copyCamera);
    this.resetGeometry.setDrawRange(0, 0);
  }

  /** Queue `slot`'s texel to be zeroed by the next {@link flushSlotResets}. */
  private queueSlotReset(slot: number): void {
    const count = this.resetGeometry.drawRange.count;
    if ((count + 1) * 3 > this.resetSlots.length) {
      const grown = new Float32Array(Math.max(this.resetSlots.length * 2, (count + 1) * 3));
      grown.set(this.resetSlots);
      this.resetSlots = grown;
      this.resetGeometry.setAttribute('position', new THREE.BufferAttribute(grown, 3));
    }
    this.resetSlots[count * 3] = slot;
    this.resetGeometry.getAttribute('position').needsUpdate = true;
    this.resetGeometry.setDrawRange(0, count + 1);
  }

  private releasePendingCopy(): void {
    this.pendingCopyFrom?.dispose();
    this.pendingCopyFrom = null;
    this.pendingCopyCapacity = 0;
  }

  private createEntry(text: string): LabelEntry {
    const slot = this.allocSlot();
    this.probeSlots[slot] = slot;

    const { texture, widthPx, heightPx } = this.rasterize(text);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uSizePx: { value: new THREE.Vector2(widthPx, heightPx) },
        uOffsetPx: { value: new THREE.Vector2(0, 0) },
        uBodyRadius: { value: 0 },
        uResolution: this.probeUniforms.uResolution,
        uSlot: { value: slot },
        ...this.labelShared,
      },
      vertexShader: LABEL_VERTEX_SHADER,
      fragmentShader: LABEL_FRAGMENT_SHADER,
      transparent: true,
      // The pass runs after the composite, where the canvas depth describes nothing
      // (§4.1); occlusion arrives as this label's texel of the state target instead.
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    // The quad is positioned entirely in the shader, so three's frustum culling — which
    // tests the unit plane at the anchor — would cull labels whose quad is on screen
    // while their anchor is just off it.
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    const entry: LabelEntry = { mesh, material, texture, text, slot };
    this.setOffset(entry, widthPx);
    return entry;
  }

  /**
   * A state-target texel for a new label.
   *
   * A freed slot is reused first, and the texel it hands on is queued to be **zeroed**
   * in the next probe pass — otherwise the new label would inherit the departed one's
   * fade and appear at that opacity instead of fading in. Zeroing one texel is what
   * lets this be a plain free list: the alternative, re-initialising the whole target,
   * would restart every *other* label's fade too (`volumetric_rendering.md` §4.1).
   */
  private allocSlot(): number {
    const reused = this.freeSlots.pop();
    if (reused !== undefined) {
      this.queueSlotReset(reused);
      return reused;
    }

    const slot = this.slotCount++;
    this.ensureCapacity(this.slotCount);
    return slot;
  }

  /**
   * Grow the state target to hold `slots` labels. Rare — capacity moves in steps of
   * {@link SLOT_STEP} — and the averages are **carried across** rather than reset, so
   * it costs no label its fade (see {@link flushPendingCopy}). That matters at site
   * scale: ~96 cameras cross the first step during a normal load.
   */
  private ensureCapacity(slots: number): void {
    const capacity = Math.max(SLOT_STEP, Math.ceil(slots / SLOT_STEP) * SLOT_STEP);
    if (capacity === this.capacity) return;

    const previous = this.stateTarget;
    const previousCapacity = this.capacity;
    this.stateTarget = makeStateTarget(capacity);
    this.capacity = capacity;
    this.labelShared.uState.value = this.stateTarget.texture;
    this.labelShared.uCapacity.value = capacity;
    this.probeUniforms.uCapacity.value = capacity;

    if (this.pendingCopyFrom) {
      // Two growths before a frame: `previous` was never rendered into, so the already
      // queued source is still the one holding the averages.
      previous.dispose();
    } else if (this.stateInitialised) {
      this.pendingCopyFrom = previous;
      this.pendingCopyCapacity = previousCapacity;
    } else {
      // Nothing probed yet, so there is nothing to carry — the new target takes the
      // one-time clear instead.
      previous.dispose();
    }

    const anchors = new Float32Array(capacity * 3);
    anchors.set(this.probeAnchors);
    this.probeAnchors = anchors;
    const slotIds = new Float32Array(capacity);
    slotIds.set(this.probeSlots);
    this.probeSlots = slotIds;
    this.probeGeometry.setAttribute('position', new THREE.BufferAttribute(anchors, 3));
    this.probeGeometry.setAttribute('aSlot', new THREE.BufferAttribute(slotIds, 1));
  }

  private retexture(entry: LabelEntry, text: string): void {
    const { texture, widthPx, heightPx } = this.rasterize(text);
    entry.texture.dispose();
    entry.texture = texture;
    entry.text = text;
    entry.material.uniforms.uMap.value = texture;
    (entry.material.uniforms.uSizePx.value as THREE.Vector2).set(widthPx, heightPx);
    this.setOffset(entry, widthPx);
  }

  /**
   * The framing-independent part of the label's offset: the gap plus half the label's
   * width, since the quad is centred on its own origin. The gap is
   * {@link LABEL_QUAD_OFFSET_PX}, not {@link LABEL_OFFSET_PX} — §5.3 measures to the first
   * glyph, and the quad carries a transparent margin to its left. The body's *projected*
   * radius is added in the vertex shader, where the framing is known — the gap is
   * measured from the body's **edge** (§5.3). Device pixels, like the size it is
   * derived from.
   */
  private setOffset(entry: LabelEntry, widthPx: number): void {
    const size = entry.material.uniforms.uSizePx.value as THREE.Vector2;
    const scale = size.y / (LABEL_LINE_PX + 2 * LABEL_PAD_Y);
    (entry.material.uniforms.uOffsetPx.value as THREE.Vector2).set(
      LABEL_QUAD_OFFSET_PX * scale + widthPx / 2,
      0,
    );
  }

  private disposeEntry(entry: LabelEntry): void {
    this.scene.remove(entry.mesh);
    entry.texture.dispose();
    entry.material.dispose();
    // The slot stays in the probe's draw range and keeps being written — one pixel,
    // and nothing samples it — until `allocSlot` hands it out again, which queues that
    // one texel to be zeroed so the next label cannot inherit this one's fade.
    this.probeAnchors[entry.slot * 3] = 0;
    this.probeAnchors[entry.slot * 3 + 1] = 0;
    this.probeAnchors[entry.slot * 3 + 2] = 0;
    this.freeSlots.push(entry.slot);
  }
}

/** One row of half-float texels, one per label slot (`volumetric_rendering.md` §4.1). */
function makeStateTarget(capacity: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(capacity, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    // Each label reads exactly its own texel; interpolating with its neighbour's would
    // bleed one camera's occlusion into another's.
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  return target;
}
