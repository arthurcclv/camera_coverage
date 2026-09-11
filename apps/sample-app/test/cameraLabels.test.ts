/**
 * Camera name labels (spec §5.3): the ellipsis rule, the shared visibility
 * predicate, and the layer's reconcile/dispose behaviour.
 *
 * The layer takes its rasteriser as an argument precisely so this file can run
 * under bare `node --test`, where there is no `document` to make a canvas from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { SceneCamera } from '../src/cameras/camera.ts';
import {
  CAMERA_BODY_RADIUS,
  SELECTED_BODY_SCALE,
  cameraBodyVisible,
  type CameraFocus,
} from '../src/scene/cameraGizmos.ts';
import {
  CameraLabelLayer,
  FADE_MAX_STEP_MS,
  FADE_TAU_MS,
  LABEL_FRAGMENT_SHADER,
  LABEL_VERTEX_SHADER,
  PROBE_FRAGMENT_SHADER,
  PROBE_VERTEX_SHADER,
  MAX_BODY_RADIUS,
  fadeStep,
  labelOcclusionToleranceM,
  paintLabelText,
  type LabelTextContext,
  type LabelPassContext,
  type LabelRasterizer,
} from '../src/scene/cameraLabels.ts';
import {
  LABEL_PAD_X,
  LABEL_PAD_Y,
  LABEL_LINE_PX,
  LABEL_OFFSET_PX,
  LABEL_STROKE_PX,
  LABEL_FONT,
  LABEL_QUAD_OFFSET_PX,
  ellipsise,
  labelBoxPx,
} from '../src/scene/cameraLabelText.ts';

/** Neither selected nor rendered-through — the ordinary case. */
const UNFOCUSED: CameraFocus = { selectedId: null, suppressedId: null };
const selectedFocus = (id: string): CameraFocus => ({ selectedId: id, suppressedId: null });

/** A monospace-ish measure: 6 px per character, so widths are predictable. */
const measure = (t: string) => t.length * 6;

function cam(over: Partial<SceneCamera> = {}): SceneCamera {
  return {
    id: 'cam-1',
    name: '',
    enabled: true,
    position: [1, 2, 3],
    rotation: [0, 0, 0, 1],
    fov: 60,
    ...over,
  };
}

/**
 * A renderer stand-in for the pass-4a state render. It records what the layer asks of
 * it, which is how the "never cleared after init" and "restores the bound target"
 * contracts get tested without a GL context.
 */
function fakeRenderer() {
  const calls: string[] = [];
  const renderer = {
    autoClear: true,
    target: null as THREE.WebGLRenderTarget | null,
    getRenderTarget(): THREE.WebGLRenderTarget | null {
      return renderer.target;
    },
    setRenderTarget(t: THREE.WebGLRenderTarget | null): void {
      renderer.target = t;
      calls.push(t === null ? 'unbind' : 'bind');
    },
    getClearColor(c: THREE.Color): THREE.Color {
      return c.setHex(0x123456);
    },
    getClearAlpha(): number {
      return 1;
    },
    setClearColor(): void {},
    clear(): void {
      calls.push('clear');
    },
    render(scene: THREE.Scene): void {
      // The layer names its three scenes, so the recorded sequence says which pass ran.
      calls.push(`render:${scene.name}:autoClear=${renderer.autoClear}`);
    },
  };
  return Object.assign(renderer, { calls });
}

function ctx(over: Partial<LabelPassContext> = {}): LabelPassContext {
  return {
    renderer: fakeRenderer() as unknown as THREE.WebGLRenderer,
    depth: new THREE.DepthTexture(4, 4),
    width: 800,
    height: 600,
    camera: new THREE.PerspectiveCamera(),
    nowMs: 0,
    ...over,
  };
}

/** The pass-4a probe material — private to the layer, reached here for parity checks. */
function probeMaterialOf(labels: CameraLabelLayer): THREE.ShaderMaterial {
  return (labels as unknown as { probeMaterial: THREE.ShaderMaterial }).probeMaterial;
}

/** The scale the state-copy pass was set to — private, reached here for the growth test. */
function copyScaleOf(labels: CameraLabelLayer): number {
  return (labels as unknown as { copyMaterial: THREE.ShaderMaterial }).copyMaterial.uniforms.uScale
    .value as number;
}

/** The slots the reset pass will zero, as a comma-joined string. */
function resetSlotsOf(labels: CameraLabelLayer): string {
  const geometry = (labels as unknown as { resetGeometry: THREE.BufferGeometry }).resetGeometry;
  const slots = geometry.getAttribute('position').array as Float32Array;
  return Array.from(slots.slice(0, geometry.drawRange.count * 3))
    .filter((_, i) => i % 3 === 0)
    .toString();
}

/** Records every text it is asked for, so a re-rasterise is observable. */
function stubRasterizer(): LabelRasterizer & { calls: string[] } {
  const calls: string[] = [];
  const fn = (text: string) => {
    calls.push(text);
    return { texture: new THREE.Texture(), widthPx: text.length * 6, heightPx: 18 };
  };
  return Object.assign(fn, { calls });
}

// --- the ellipsis rule (§5.3) ------------------------------------------------

test('a name that fits is drawn in full (spec §5.3)', () => {
  assert.equal(ellipsise('Camera 7', measure, 140), 'Camera 7');
});

test('a name past the max width is ellipsised to fit (spec §5.3)', () => {
  const long = 'Loading bay north-east corner overview';
  const shown = ellipsise(long, measure, 60);
  assert.ok(shown.length < long.length);
  assert.ok(shown.endsWith('…'));
  assert.ok(measure(shown) <= 60);
});

test('the ellipsis alone is the floor — a label is never blank (spec §5.3)', () => {
  assert.equal(ellipsise('Camera 7', measure, 1), '…');
});

test('the box keeps a margin around the measured text', () => {
  const box = labelBoxPx(100);
  assert.equal(box.width, 100 + 2 * LABEL_PAD_X);
  assert.equal(box.height, LABEL_LINE_PX + 2 * LABEL_PAD_Y);
});

test('the margin clears the outline on every side (spec §5.3)', () => {
  // Canvas strokes straddle the path, so half the line width falls outside the glyph.
  // With no plate behind it that overhang is the outermost thing the label draws, and
  // anything less than it here would shave the outline off at the texture's edge.
  const overhangPx = LABEL_STROKE_PX / 2;
  assert.ok(LABEL_PAD_X >= overhangPx, 'the horizontal margin clears the outline');
  assert.ok(LABEL_PAD_Y >= overhangPx, 'the vertical margin clears the outline');

  // Vertically the glyphs fill the line box, so the outline starts from its edge —
  // horizontally they start at the margin, so it has the whole margin to itself.
  const box = labelBoxPx(100);
  assert.equal(box.height, LABEL_LINE_PX + 2 * LABEL_PAD_Y);
  assert.ok(
    (box.height - LABEL_LINE_PX) / 2 >= overhangPx,
    'the line box plus its margin clears the outline above and below',
  );
});

test('the gap is measured to the first glyph, not to the quad (spec §5.3)', () => {
  // The quad's left margin is transparent, so pushing the quad out by the full gap
  // would put LABEL_PAD_X of empty texture between the body and the name on top of it.
  // What the spec fixes is where the *glyph* lands: quad offset + margin = the 4 px gap.
  assert.equal(LABEL_OFFSET_PX, 4, 'the gap §5.3 specifies');
  assert.equal(LABEL_QUAD_OFFSET_PX + LABEL_PAD_X, LABEL_OFFSET_PX);
  // Which is 0 at today's numbers: the margin alone happens to be the whole gap.
  assert.equal(LABEL_QUAD_OFFSET_PX, 0);
});

test('the outline is stroked before the fill, so the weight survives (spec §5.3)', () => {
  // The stroke straddles the glyph outline, so a fill drawn afterwards covers the inner
  // half of it. Stroke *after* the fill would eat 2 px into an 11 px/600 letterform.
  const calls: string[] = [];
  const ctx = {
    set lineWidth(px: number) {
      calls.push(`lineWidth=${px}`);
    },
    set strokeStyle(v: string) {
      calls.push(`strokeStyle=${v}`);
    },
    set fillStyle(v: string) {
      calls.push(`fillStyle=${v}`);
    },
    strokeText: (t: string, x: number, y: number) => calls.push(`strokeText(${t},${x},${y})`),
    fillText: (t: string, x: number, y: number) => calls.push(`fillText(${t},${x},${y})`),
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    lineJoin: 'miter' as CanvasLineJoin,
    lineCap: 'butt' as CanvasLineCap,
  };
  paintLabelText(ctx as unknown as LabelTextContext, 'Cam 7');

  const baseline = LABEL_PAD_Y + LABEL_LINE_PX / 2;
  assert.deepEqual(calls, [
    `lineWidth=${LABEL_STROKE_PX}`,
    'strokeStyle=#000000',
    `strokeText(Cam 7,${LABEL_PAD_X},${baseline})`,
    'fillStyle=#ffffff',
    `fillText(Cam 7,${LABEL_PAD_X},${baseline})`,
  ]);
  // Both draws start at the margin, so the outline has room on every side.
  assert.equal(ctx.font, LABEL_FONT);
  assert.equal(ctx.textBaseline, 'middle');
  assert.equal(ctx.lineJoin, 'round', 'a miter spikes past the line width on a tight corner');
  assert.equal(ctx.lineCap, 'round');
});

// --- the shared visibility predicate (§5.3, §2.4.3) --------------------------

test('an enabled camera draws; a disabled one does not (spec §2.4.3)', () => {
  assert.equal(cameraBodyVisible(cam(), UNFOCUSED), true);
  assert.equal(cameraBodyVisible(cam({ enabled: false }), UNFOCUSED), false);
});

test('a disabled camera still draws as the selection (spec §2.4.3)', () => {
  assert.equal(cameraBodyVisible(cam({ enabled: false }), selectedFocus('cam-1')), true);
});

test('the camera being rendered through draws nothing, selected or not (spec §2.4.1)', () => {
  assert.equal(cameraBodyVisible(cam(), { selectedId: 'cam-1', suppressedId: 'cam-1' }), false);
  assert.equal(cameraBodyVisible(cam(), { selectedId: null, suppressedId: 'cam-1' }), false);
});

// --- the layer ---------------------------------------------------------------

test('one label per camera, anchored at the camera position (spec §5.3)', () => {
  const rasterize = stubRasterizer();
  const labels = new CameraLabelLayer(rasterize);

  labels.update([cam(), cam({ id: 'cam-2', position: [4, 5, 6] })], UNFOCUSED, true);

  assert.equal(labels.scene.children.length, 2);
  const second = labels.scene.children[1] as THREE.Mesh;
  assert.deepEqual(second.position.toArray(), [4, 5, 6]);
  // The quad is placed entirely in the shader, so three's culling test would be
  // wrong about it.
  assert.equal(second.frustumCulled, false);
  labels.dispose();
});

test('the label text is the camera label, falling back to Camera N (spec §5.6)', () => {
  const rasterize = stubRasterizer();
  const labels = new CameraLabelLayer(rasterize);

  labels.update([cam(), cam({ id: 'cam-2', name: '  Dock  ' })], UNFOCUSED, true);

  assert.deepEqual(rasterize.calls, ['Camera 1', 'Dock']);
  labels.dispose();
});

test('a rename re-rasterises exactly that label, and nothing else does (spec §5.3)', () => {
  const rasterize = stubRasterizer();
  const labels = new CameraLabelLayer(rasterize);

  labels.update([cam()], UNFOCUSED, true);
  labels.update([cam({ position: [9, 9, 9] })], UNFOCUSED, true);
  assert.deepEqual(rasterize.calls, ['Camera 1'], 'a move must not re-rasterise');

  labels.update([cam({ name: 'Dock' })], UNFOCUSED, true);
  assert.deepEqual(rasterize.calls, ['Camera 1', 'Dock']);
  labels.dispose();
});

test('a label hides exactly when its body does (spec §5.3)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  const disabled = cam({ enabled: false });

  labels.update([disabled], UNFOCUSED, true);
  assert.equal(labels.scene.children[0].visible, false);

  labels.update([disabled], selectedFocus('cam-1'), true);
  assert.equal(labels.scene.children[0].visible, true, 'a selected disabled camera is drawn');

  labels.update([cam()], { selectedId: null, suppressedId: 'cam-1' }, true);
  assert.equal(labels.scene.children[0].visible, false, 'rendering through it hides it');
  labels.dispose();
});

test('the Camera names toggle hides every label (spec §2.4)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam(), cam({ id: 'cam-2' })], UNFOCUSED, false);
  assert.deepEqual(labels.scene.children.map((c) => c.visible), [false, false]);
  labels.dispose();
});

test('a removed camera takes its label with it', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam(), cam({ id: 'cam-2' })], UNFOCUSED, true);
  labels.update([cam()], UNFOCUSED, true);
  assert.equal(labels.scene.children.length, 1);
  labels.dispose();
  assert.equal(labels.scene.children.length, 0);
});

test('renderProbePass() branches the depth maths on the projection in use (§4.1)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam()], UNFOCUSED, true);
  const probe = probeMaterialOf(labels);

  const depth = new THREE.DepthTexture(4, 4);
  labels.renderProbePass(ctx({ depth, camera: new THREE.PerspectiveCamera(60, 1, 0.25, 900) }));
  assert.equal(probe.uniforms.uOcclude.value, true);
  assert.equal(probe.uniforms.uOrtho.value, false);
  assert.equal(probe.uniforms.uNear.value, 0.25);
  assert.equal(probe.uniforms.uFar.value, 900);
  assert.deepEqual((probe.uniforms.uResolution.value as THREE.Vector2).toArray(), [800, 600]);

  labels.renderProbePass(ctx({ depth, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 50) }));
  assert.equal(probe.uniforms.uOrtho.value, true);

  // No depth texture (before the first composite) reads as unoccluded rather than
  // sampling a texture that is not there.
  labels.renderProbePass(ctx({ depth: null }));
  assert.equal(probe.uniforms.uOcclude.value, false);
  labels.dispose();
});

// --- the fade (spec §5.3) ----------------------------------------------------

test('the fade is a function of elapsed time, not of frames drawn (spec §5.3)', () => {
  // One 32 ms frame must move the value as far as two 16 ms frames, so the curve is
  // the same at 30 fps as at 60.
  const oneLongFrame = fadeStep(32, FADE_TAU_MS);
  const k = fadeStep(16, FADE_TAU_MS);
  const twoShortFrames = 1 - (1 - k) * (1 - k);
  assert.ok(Math.abs(oneLongFrame - twoShortFrames) < 1e-12);
});

test('the fade step matches the documented time constant (spec §5.3)', () => {
  // The curve is 1 - exp(-dt / tau) for any frame inside the cap.
  for (const dt of [1, 8, 16, 33, FADE_MAX_STEP_MS]) {
    assert.ok(Math.abs(fadeStep(dt, FADE_TAU_MS) - (1 - Math.exp(-dt / FADE_TAU_MS))) < 1e-12);
  }
  // The per-frame cap sits *below* tau on purpose — it bounds a stall, so a whole tau
  // can never elapse in one step and no single frame can cover 63% of the distance.
  assert.ok(FADE_MAX_STEP_MS < FADE_TAU_MS);
  assert.ok(fadeStep(FADE_MAX_STEP_MS, FADE_TAU_MS) < 1 - Math.exp(-1));
  // A zero-length frame moves nothing; a clock that goes backwards is treated the same
  // rather than un-fading.
  assert.equal(fadeStep(0, FADE_TAU_MS), 0);
  assert.equal(fadeStep(-100, FADE_TAU_MS), 0);
});

test('a long stall resumes with a bounded step, not a jump (spec §5.3)', () => {
  // A backgrounded tab can hand back a multi-second frame. Honouring it would snap the
  // opacity, which is the one thing this fade exists to prevent.
  assert.equal(fadeStep(5000, FADE_TAU_MS), fadeStep(FADE_MAX_STEP_MS, FADE_TAU_MS));
  assert.ok(fadeStep(5000, FADE_TAU_MS) < 1);
});

test('the first frame has no elapsed time, so labels fade in from hidden (spec §5.3)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam()], UNFOCUSED, true);
  const probe = probeMaterialOf(labels);

  labels.renderProbePass(ctx({ nowMs: 1000 }));
  assert.equal(probe.blendAlpha, 0, 'nothing to ease over yet');

  labels.renderProbePass(ctx({ nowMs: 1016 }));
  assert.ok(Math.abs(probe.blendAlpha - fadeStep(16, FADE_TAU_MS)) < 1e-12);
  labels.dispose();
});

test('the state pass eases by blending, so it needs no ping-pong pair (§4.1)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  const probe = probeMaterialOf(labels);

  // dst = k * src + (1 - k) * dst, with k the blend unit's constant alpha — an
  // exponential moving average accumulated in the target itself.
  assert.equal(probe.blending, THREE.CustomBlending);
  assert.equal(probe.blendSrc, THREE.ConstantAlphaFactor);
  assert.equal(probe.blendDst, THREE.OneMinusConstantAlphaFactor);
  assert.equal(probe.blendSrcAlpha, THREE.ConstantAlphaFactor);
  assert.equal(probe.blendDstAlpha, THREE.OneMinusConstantAlphaFactor);
  labels.dispose();
});

// --- shader source parity (§4.1) --------------------------------------------

test('the label shaders carry the terms this design depends on (§4.1)', () => {
  // A shader cannot execute under `node --test`, so — exactly as `volumetric.test.ts`
  // does with the fog's `FRAGMENT_SHADER` — the exported source is asserted against
  // the terms the design rests on. Deliberately weak: it catches a term silently
  // dropped in an edit, never a wrong one.
  const vs = LABEL_VERTEX_SHADER;
  // Constant pixel size: the NDC step is multiplied by clip.w, which cancels the
  // perspective divide and leaves the orthographic case (w = 1) already correct.
  assert.match(vs, /clip\.xy \+= px \* 2\.0 \/ uResolution \* clip\.w/);
  // Sized and offset from the anchor, so every corner shares one depth.
  assert.match(vs, /modelViewMatrix \* vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/);
  assert.match(vs, /position\.xy \* uSizePx \+ uOffsetPx/);

  const fs = LABEL_FRAGMENT_SHADER;
  // Opacity is this label's own texel of the state target — one value for the whole
  // quad, which is what makes the label fade as a unit.
  assert.match(fs, /texture2D\(uState, vec2\(\(uSlot \+ 0\.5\) \/ uCapacity, 0\.5\)\)/);
  assert.match(fs, /gl_FragColor = vec4\(texel\.rgb, texel\.a \* visibility\)/);
  // The pass draws to the canvas, so it owns its own output conversion.
  assert.match(fs, /#include <colorspace_fragment>/);
  // The label pass does no depth work of its own — that is pass 4a's job now.
  assert.doesNotMatch(fs, /uDepth/);
});

test('the label clears the body it sits beside, not the body\'s centre (spec §5.3)', () => {
  // The gap is 4 px from the body, and the body is world-sized: a fixed offset from
  // the anchor would put the label on top of a body a couple of metres from the eye.
  // The radius is projected in the shader, where clip.w is known.
  assert.match(LABEL_VERTEX_SHADER, /uniform float uBodyRadius/);
  assert.match(
    LABEL_VERTEX_SHADER,
    /uBodyRadius \* projectionMatrix\[0\]\[0\] \* 0\.5 \* uResolution\.x \/ max\(clip\.w, 1e-4\)/,
  );
  assert.match(LABEL_VERTEX_SHADER, /vec2 px = position\.xy \* uSizePx \+ uOffsetPx \+ vec2\(bodyPx, 0\.0\)/);
});

test('the label material is transparent and does no depth test of its own (§4.1)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam()], UNFOCUSED, true);
  const material = (labels.scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
  assert.equal(material.depthTest, false);
  assert.equal(material.transparent, true);
  labels.dispose();
});

test('the body radius follows the selection, which scales the body up (spec §5.3)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  const radiusOf = () =>
    (((labels.scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uBodyRadius
      .value as number);

  labels.update([cam()], UNFOCUSED, true);
  assert.equal(radiusOf(), CAMERA_BODY_RADIUS);

  labels.update([cam()], selectedFocus('cam-1'), true);
  assert.equal(radiusOf(), CAMERA_BODY_RADIUS * SELECTED_BODY_SCALE, 'the selected body is bigger');
  labels.dispose();
});

test('the probe shader spreads the occlusion test spatially (spec §5.3)', () => {
  const vs = PROBE_VERTEX_SHADER;
  // Sampled at the anchor, drawn at the slot: the two are deliberately different.
  assert.match(vs, /vAnchorUv = \(clip\.xy \/ clip\.w\) \* 0\.5 \+ 0\.5/);
  assert.match(vs, /gl_Position = vec4\(\(\(aSlot \+ 0\.5\) \/ uCapacity\) \* 2\.0 - 1\.0/);

  const fs = PROBE_FRAGMENT_SHADER;
  assert.match(fs, /#include <packing>/);
  assert.match(fs, /orthographicDepthToViewZ\(d, uNear, uFar\)/);
  assert.match(fs, /perspectiveDepthToViewZ\(d, uNear, uFar\)/);
  // A ring of taps, each ramped over a depth band — the spatial half of the damping.
  assert.match(fs, /const float TAP_RADIUS_PX/);
  assert.match(fs, /for \(int y = -1; y <= 1; y\+\+\)/);
  assert.match(fs, /for \(int x = -1; x <= 1; x\+\+\)/);
  assert.match(fs, /smoothstep\(anchorDist - 2\.0 \* tol, anchorDist - tol, sceneDist\)/);
  assert.match(fs, /smoothstep\(0\.25, 0\.75, sum \/ 9\.0\)/);
  // Nothing in here is per-pixel-of-the-label: it is one fragment per label.
  assert.doesNotMatch(fs, /gl_FragCoord/);
  // An anchor behind the eye reads as hidden, so a returning label fades in.
  assert.match(fs, /vAnchorW > 0\.0 \? anchorVisibility\(\) : 0\.0/);
});

test('the occlusion tolerance is the body plus depth precision, and nothing else (spec §5.3)', () => {
  const fs = PROBE_FRAGMENT_SHADER;
  // The body's own sphere sits at the anchor, so its front face has to read as clear.
  assert.match(fs, /uniform float uMaxBodyRadius/);
  assert.match(fs, /float tol = uMaxBodyRadius \+ depthPrecisionAt\(anchorDist\)/);

  // Precision is branched on the projection: a perspective buffer stores a reciprocal,
  // so its world-space step grows as z²; an orthographic one is linear and constant.
  assert.match(fs, /dist \* dist \* \(1\.0 \/ uNear - 1\.0 \/ uFar\)/);
  assert.match(fs, /uOrtho\s*\?\s*\(uFar - uNear\)/);

  // Built from the TS constants, so the shader cannot drift from the reference the
  // magnitudes below are asserted against.
  assert.match(fs, /const float DEPTH_STEPS = 16777216\.0;/);
  assert.match(fs, /const float DEPTH_SAFETY = 8\.0;/);

  // The regression this replaced: a tolerance that grew as a fraction of the eye
  // distance is a metres-wide blind spot around every body at site scale, and a wall
  // stops hiding the camera mounted on it (spec §5.3).
  assert.doesNotMatch(fs, /[0-9.]+\s*\*\s*anchorDist/);
});

test('the tolerance stays under a metre across the real site (spec §5.3)', () => {
  // The magnitude, not the expression: the syntax guard above passes for a `dist * dist`
  // term that is itself metres wide at site scale. The site is 1120 m on its long axis
  // (DESIGN.md), and the app's perspective camera is near 0.1 / far 10000.
  const persp = (dist: number) => labelOcclusionToleranceM(dist, 0.1, 10000, false);

  // Close up the body's own radius is the whole of it.
  assert.ok(persp(5) < MAX_BODY_RADIUS + 0.01, `${persp(5)} m at 5 m`);
  // At the distance the whole site is framed from, an occluder a metre in front of a
  // camera still hides its label — the 17 m band this pass replaced did not.
  assert.ok(persp(400) < 1.1, `${persp(400)} m at 400 m`);
  assert.ok(2 * persp(400) < 2.2, `${2 * persp(400)} m to fully hide at 400 m`);
  // And it never runs away: the far corner of the site is still single-figure metres.
  assert.ok(persp(1120) < 6.5, `${persp(1120)} m at 1120 m`);

  // Nothing is a fraction of the eye distance, so doubling the distance must not double
  // the tolerance — it is quantisation-shaped, and dominated by the body when near.
  assert.ok(persp(10) < 2 * persp(5), 'sub-linear near the eye');

  // An orthographic buffer is linear, so its term is the same at every distance.
  const ortho = (dist: number) => labelOcclusionToleranceM(dist, 0.1, 1000, true);
  assert.equal(ortho(5), ortho(900));
  assert.ok(ortho(5) < MAX_BODY_RADIUS + 0.001, `${ortho(5)} m`);
});

test('the probe clears the larger of the two body sizes (spec §5.3)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  const uniforms = (labels as unknown as { probeUniforms: Record<string, { value: number }> })
    .probeUniforms;
  // One uniform for every anchor, so it has to be the selected body's radius — the
  // unselected one is smaller and is cleared by the same tolerance.
  assert.equal(uniforms.uMaxBodyRadius.value, CAMERA_BODY_RADIUS * SELECTED_BODY_SCALE);
  assert.equal(MAX_BODY_RADIUS, CAMERA_BODY_RADIUS * SELECTED_BODY_SCALE);
  labels.dispose();
});

test('a recycled slot is zeroed one texel at a time, not by re-clearing the target (§4.1)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam(), cam({ id: 'cam-2' })], UNFOCUSED, true);

  const first = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: first as unknown as THREE.WebGLRenderer, nowMs: 0 }));

  // cam-2 leaves and cam-3 takes its slot. The texel still holds cam-2's fade, so
  // cam-3 would appear at that opacity instead of fading in.
  labels.update([cam()], UNFOCUSED, true);
  labels.update([cam(), cam({ id: 'cam-3' })], UNFOCUSED, true);

  const slots = labels.scene.children.map(
    (c) => (((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uSlot.value as number),
  );
  assert.deepEqual(slots, [0, 1], 'the freed slot is reused rather than growing the target');

  assert.equal(resetSlotsOf(labels), '1', 'the reset pass is queued for exactly the freed slot');

  const next = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: next as unknown as THREE.WebGLRenderer, nowMs: 16 }));
  // One texel is zeroed — slot 1, by a one-point draw — and cam-1's average in slot 0
  // is untouched. No `clear` anywhere: the target keeps its state (§4.1).
  assert.deepEqual(next.calls, [
    'bind',
    'render:cameraLabelStateReset:autoClear=false',
    'render:cameraLabelProbe:autoClear=false',
    'unbind',
  ]);
  assert.equal(resetSlotsOf(labels), '', 'and the queue is emptied by the pass that ran it');

  // And it happens once: the frame after is a plain probe again.
  const after = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: after as unknown as THREE.WebGLRenderer, nowMs: 32 }));
  assert.deepEqual(after.calls, ['bind', 'render:cameraLabelProbe:autoClear=false', 'unbind']);
  labels.dispose();
});

test('growing the state target carries the averages across (§4.1)', () => {
  // ~96 cameras is the real site, so the first growth step fires during a normal load.
  // Re-initialising the target there would restart every label's fade-in, which §4.1
  // says never happens — so the old row is copied into the new one instead.
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam()], UNFOCUSED, true);
  labels.renderProbePass(ctx({ nowMs: 0 }));

  const many = Array.from({ length: 65 }, (_, i) => cam({ id: `cam-${i + 1}` }));
  labels.update(many, UNFOCUSED, true);

  const grown = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: grown as unknown as THREE.WebGLRenderer, nowMs: 16 }));
  // No `clear`: the old row is drawn into the new one, every texel written by the copy
  // triangle, so no label loses its average.
  assert.deepEqual(grown.calls, [
    'bind',
    'render:cameraLabelStateCopy:autoClear=false',
    'render:cameraLabelProbe:autoClear=false',
    'unbind',
  ]);
  assert.equal(copyScaleOf(labels), 2, 'new capacity 128 over old 64 — the whole mapping');

  // And the copy happens once: the next frame is a plain probe again.
  const after = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: after as unknown as THREE.WebGLRenderer, nowMs: 32 }));
  assert.deepEqual(after.calls, ['bind', 'render:cameraLabelProbe:autoClear=false', 'unbind']);
  labels.dispose();
});

test('the state target is cleared once and never again, and the target is restored (§4.1)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  labels.update([cam()], UNFOCUSED, true);

  const first = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: first as unknown as THREE.WebGLRenderer, nowMs: 0 }));
  assert.deepEqual(first.calls, ['bind', 'clear', 'render:cameraLabelProbe:autoClear=false', 'unbind']);
  assert.equal(first.target, null, 'the bound target is put back');
  assert.equal(first.autoClear, true, 'autoClear is put back');

  // The target *is* the state: clearing it again would throw away the moving average.
  const second = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: second as unknown as THREE.WebGLRenderer, nowMs: 16 }));
  assert.deepEqual(second.calls, ['bind', 'render:cameraLabelProbe:autoClear=false', 'unbind']);
  labels.dispose();
});

test('with no labels there is nothing to probe (§4.1)', () => {
  const labels = new CameraLabelLayer(stubRasterizer());
  const renderer = fakeRenderer();
  labels.renderProbePass(ctx({ renderer: renderer as unknown as THREE.WebGLRenderer }));
  assert.deepEqual(renderer.calls, []);
  labels.dispose();
});
