/**
 * Tests for the voxel volumetric renderer's pure-TS reference math
 * (specs/volumetric_rendering.md §6), plus a source-parity check on the GLSL
 * fragment shader that mirrors it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slabChord,
  pathTerm,
  voxelAlpha,
  compositeMax,
  compositeOverScene,
  VERTEX_SHADER,
  FRAGMENT_SHADER,
  type Vec3,
} from '../src/scene/volumetric.ts';

// Unit cube centered at the origin: [-0.5, 0.5]^3.
const BOX_MIN: Vec3 = [-0.5, -0.5, -0.5];
const BOX_MAX: Vec3 = [0.5, 0.5, 0.5];

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

test('ray straight through the cube center travels ~size', () => {
  // Along +x through the center: enters at x=-0.5, exits at x=0.5 → chord 1.0.
  const chord = slabChord([-5, 0, 0], [1, 0, 0], BOX_MIN, BOX_MAX);
  assert.ok(Math.abs(chord - 1.0) < 1e-9, `chord=${chord}`);
});

test('edge-grazing ray travels less than a center ray', () => {
  // Diagonal ray on the line x - y = 0.7, which only clips the cube's corner
  // near (0.5, -0.3): a short chord versus the full traversal of a center ray.
  const dir = norm([1, 1, 0]);
  const grazing = slabChord([-10, -10.7, 0], dir, BOX_MIN, BOX_MAX);
  const center = slabChord([-5, 0, 0], [1, 0, 0], BOX_MIN, BOX_MAX);
  assert.ok(grazing > 0, `grazing=${grazing}`);
  assert.ok(grazing < center, `grazing=${grazing} center=${center}`);
});

test('a ray that misses the cube returns 0', () => {
  const chord = slabChord([-5, 5, 0], [1, 0, 0], BOX_MIN, BOX_MAX);
  assert.equal(chord, 0);
});

test('a ray parallel to a slab but outside it misses', () => {
  // Parallel to x, but y is outside [-0.5, 0.5] → miss.
  const chord = slabChord([-5, 2, 0], [1, 0, 0], BOX_MIN, BOX_MAX);
  assert.equal(chord, 0);
});

test('ray origin inside the cube: chord runs from origin to the exit face', () => {
  // Origin at center, +x: exits at x=0.5, t_enter clamped to 0 → chord 0.5.
  const chord = slabChord([0, 0, 0], [1, 0, 0], BOX_MIN, BOX_MAX);
  assert.ok(Math.abs(chord - 0.5) < 1e-9, `chord=${chord}`);
});

test('a bigger cube gives a proportionally longer chord', () => {
  const small = slabChord([-5, 0, 0], [1, 0, 0], [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  const big = slabChord([-5, 0, 0], [1, 0, 0], [-1, -1, -1], [1, 1, 1]);
  assert.ok(Math.abs(big - 2 * small) < 1e-9, `small=${small} big=${big}`);
});

// --- Path term (specs/volumetric_rendering.md §3, §6) ------------------------

test("'flat' ignores the chord entirely", () => {
  // Every fragment of a voxel is equally opaque, which is what makes an individual
  // voxel's coverage legible as a hard-edged cube.
  assert.equal(pathTerm('flat', 0.01, 1), 1);
  assert.equal(pathTerm('flat', 1, 1), 1);
  assert.equal(pathTerm('flat', 0, 1), 1);
});

test("'soft' returns the fraction of the cube the ray crossed", () => {
  assert.equal(pathTerm('soft', 0, 1), 0, 'a miss fades to nothing');
  assert.equal(pathTerm('soft', 1, 1), 1, 'straight through the centre is full');
  assert.equal(pathTerm('soft', 0.25, 1), 0.25);
});

test("'soft' never exceeds 1, whatever the chord", () => {
  // A diagonal ray crosses more than one edge length. Un-clamped that is an alpha
  // above 1, which is the bug this clamp exists for.
  assert.equal(pathTerm('soft', Math.sqrt(3), 1), 1);
  assert.equal(pathTerm('soft', 5, 1), 1);
});

test('the path term is a fraction, so alpha never depends on voxel size', () => {
  // The property that keeps `intensityScale` stable when the grid is refined: two
  // voxels of different size crossed through their centres are equally opaque.
  const small = pathTerm('soft', 0.5, 0.5);
  const big = pathTerm('soft', 4, 4);
  assert.equal(small, big);
  assert.equal(voxelAlpha(0.4, small, 1), voxelAlpha(0.4, big, 1));
});

// --- Voxel alpha (specs/volumetric_rendering.md §3, §6) ----------------------

test('a zero-intensity voxel is fully transparent', () => {
  assert.equal(voxelAlpha(0, 1, 1), 0);
});

test('alpha is monotonic in intensity and in intensityScale', () => {
  assert.ok(voxelAlpha(0.75, 1, 1) > voxelAlpha(0.25, 1, 1));
  assert.ok(voxelAlpha(0.5, 1, 0.6) > voxelAlpha(0.5, 1, 0.2));
});

test('alpha clamps at 1 so an over-driven scale cannot exceed it', () => {
  // The intensity-scale slider runs to 2 and intensity is normally 0..1, so this
  // is reachable in the UI rather than theoretical.
  assert.equal(voxelAlpha(1, 1, 2), 1);
  assert.equal(voxelAlpha(0.9, 1, 10), 1);
});

// --- Max compositing among the fog (specs/volumetric_rendering.md §4, §6) ----
//
// The two-target arrangement exists to keep *both* of these true at once, and the
// two blocks below pin one property each. Collapsing them into a single blend
// against the main framebuffer breaks whichever one it does not pick — that is the
// bug this design is the fix for.

test('an empty set is fully transparent', () => {
  const out = compositeMax([]);
  assert.equal(out.alpha, 0);
  assert.deepEqual(out.color, [0, 0, 0]);
});

test('the strongest voxel wins, and stacking never accumulates', () => {
  // The property the user sees: a deep column of fog reads as its strongest voxel,
  // not as a wall. Twenty voxels at 0.3 stay at 0.3.
  const layers = Array.from({ length: 20 }, () => ({ color: [1, 1, 1] as Vec3, alpha: 0.3 }));
  assert.equal(compositeMax(layers).alpha, 0.3);
  layers.push({ color: [1, 1, 1] as Vec3, alpha: 0.55 });
  assert.equal(compositeMax(layers).alpha, 0.55, 'one stronger voxel raises it, to itself');
});

test('max compositing is order-independent', () => {
  // Unlike source-over. This is what lets the fog draw in arbitrary instance order
  // with no depth sort and no OIT.
  const layers = [
    { color: [1, 1, 1] as Vec3, alpha: 0.4 },
    { color: [1, 1, 1] as Vec3, alpha: 0.9 },
    { color: [1, 1, 1] as Vec3, alpha: 0.2 },
  ];
  const forward = compositeMax(layers);
  const back = compositeMax([...layers].reverse());
  assert.equal(forward.alpha, back.alpha);
  assert.deepEqual(forward.color, back.color);
});

test('the accumulated colour stays premultiplied by the winning alpha', () => {
  // Single hue, so a per-channel max over premultiplied colour is exactly "the
  // colour of the strongest voxel" — which is why the shader can emit color*alpha.
  const red: Vec3 = [1, 0, 0];
  const out = compositeMax([
    { color: red, alpha: 0.25 },
    { color: red, alpha: 0.8 },
  ]);
  assert.equal(out.alpha, 0.8);
  assert.ok(Math.abs(out.color[0] - 0.8) < 1e-12);
  assert.equal(out.color[1], 0);
});

// --- Compositing the fog over the scene (specs/volumetric_rendering.md §4, §6) -

test('a transparent fog leaves the scene untouched', () => {
  const scene: Vec3 = [0.75, 0.75, 0.75];
  assert.deepEqual(compositeOverScene(scene, { color: [0, 0, 0], alpha: 0 }), scene);
});

test('an opaque fog fully replaces the scene', () => {
  const out = compositeOverScene([0.75, 0.75, 0.75], { color: [1, 0, 0], alpha: 1 });
  assert.deepEqual(out, [1, 0, 0]);
});

test('a dim fog is visible over a BRIGHT scene — the whole point', () => {
  // The regression this replaced: under per-channel max, a 9% red voxel over a
  // 0.75 grey floor produced exactly the floor, on every channel, and the overlay
  // was invisible on any large scene. Source-over cannot do that.
  const floor: Vec3 = [0.75, 0.75, 0.75];
  const dimRed = { color: [0.09, 0, 0] as Vec3, alpha: 0.09 };
  const out = compositeOverScene(floor, dimRed);
  assert.ok(out[0] > floor[0], 'red must rise above the floor');
  assert.ok(out[1] < floor[1], 'green and blue must fall — the fog tints, it does not just add');
  assert.ok(Math.abs(out[1] - 0.75 * 0.91) < 1e-12);
});

// --- Shader source parity (specs/volumetric_rendering.md §6) ------------------
//
// A shader cannot execute under `node --test`, so nothing here proves the GLSL
// is *right*. What it catches is a term silently dropped or a name silently
// renamed in an edit — the failure mode that produced no error and no wrong
// number back when this was a TSL node graph. Deliberately a weak test, kept
// because without it the port from the reference above has no automated link at
// all.

test('the fragment shader still carries every term of the reference', () => {
  const src = FRAGMENT_SHADER;
  // slabChord: per-component slab, entry clamped to 0, chord clamped to 0.
  assert.match(src, /vec3 tmin = min\(t1, t2\)/, 'slab min');
  assert.match(src, /vec3 tmax = max\(t1, t2\)/, 'slab max');
  assert.match(src, /float tEnter = max\(max\(max\(tmin\.x, tmin\.y\), tmin\.z\), 0\.0\)/);
  assert.match(src, /float tExit = min\(min\(tmax\.x, tmax\.y\), tmax\.z\)/);
  assert.match(src, /float chord = max\(tExit - tEnter, 0\.0\)/, 'chord must clamp at 0');
  // The per-component reciprocal: a scalar collapse here breaks the ray in some
  // view quadrants, which is why the reference and the shader both spell it out.
  assert.match(src, /vec3 invDir = 1\.0 \/ rd/);
  // The path term, selected by the mode uniform (`pathTerm`).
  // The chord must reach the shader as a *fraction of the edge*, not a length —
  // a raw chord makes alpha scale with voxel size (§3).
  assert.match(src, /float edge = max\(2\.0 \* vHalf, 1e-6\)/);
  assert.match(src, /mix\(clamp\(chord \/ edge, 0\.0, 1\.0\), 1\.0, uFlatMode\)/, 'flat drops the chord');
  // Intensity drives alpha and the colour goes out undimmed. If those two ever
  // swap back, the overlay silently vanishes over bright geometry (§4).
  assert.match(src, /float alpha = clamp\(vIntensity \* pathTerm \* uIntensityScale, 0\.0, 1\.0\)/);
  // Premultiplied: the fog target is max-blended, so colour and alpha must move
  // together or the winning fragment's hue desaturates (§4).
  assert.match(src, /gl_FragColor = vec4\(vColor \* alpha, alpha\)/);
});

test('the two shader stages agree on the varyings and attribute names they share', () => {
  // The names are the whole contract between the stages, and between the shader
  // and `allocate()`'s `setAttribute` calls. A mismatch fails at shader compile
  // in the browser and nowhere else.
  for (const varying of ['vCenter', 'vHalf', 'vIntensity', 'vColor', 'vWorldPos']) {
    assert.match(VERTEX_SHADER, new RegExp(`varying \\w+ ${varying};`), `vertex ${varying}`);
    assert.match(FRAGMENT_SHADER, new RegExp(`varying \\w+ ${varying};`), `fragment ${varying}`);
  }
  // `color` is Three.js's own vertex-colour attribute and `half` is a reserved
  // word in GLSL ES; both collide at compile time, hence the `a` prefix.
  for (const attr of ['aCenter', 'aHalf', 'aIntensity', 'aColor']) {
    assert.match(VERTEX_SHADER, new RegExp(`attribute \\w+ ${attr};`), `vertex ${attr}`);
  }
  assert.doesNotMatch(VERTEX_SHADER, /attribute \w+ (color|half);/, 'reserved/colliding name');
});
