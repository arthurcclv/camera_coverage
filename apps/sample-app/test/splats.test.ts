/**
 * The splat entity's pure decisions (`gaussian_splats.md` §2.3, §5.4, §6.2, §7).
 *
 * Spark itself cannot run under `node --test` — it needs a WebGL2 context,
 * workers and wasm — so the boundary sits where the codebase already draws it:
 * every judgement lives here, and `scene/splatLayer.ts` stays thin and is
 * verified by running the app (§11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

import {
  basename,
  clipBandToSdfBox,
  decodedSplatCount,
  defaultSplat,
  FLIP_Z_ROTATION,
  identityRegistration,
  isFlippedZ,
  isSplatFileName,
  needsSplatDepthPass,
  splatBadge,
  splatDecodeFailure,
  splatLabel,
} from '../src/scene/splats.ts';
import { eulerToQuat, quatToEuler } from '../src/cameras/math.ts';
import type { ClipBand } from '../src/scene/sectionHeatmap.ts';

// --- labels (§2.3) ---------------------------------------------------------
// A splat is the **one** entity kind whose blank-name fallback is not an
// ordinal. Its identity is its file, and `spec.md` §14.2 already treats a
// filename as authoritative for exactly that reason.

test('a non-blank name wins over the filename', () => {
  assert.equal(splatLabel({ name: 'North dock', src: 'assets/site.spz' }), 'North dock');
});

test('a blank name falls back to the src basename, never to an ordinal', () => {
  assert.equal(splatLabel({ name: '', src: 'assets/site.spz' }), 'site.spz');
  // Two unnamed rows on two different captures stay distinguishable, which
  // `Splat 1` / `Splat 2` would not.
  assert.equal(splatLabel({ name: '', src: 'assets/yard-scan.ply' }), 'yard-scan.ply');
});

test('a whitespace-only name counts as blank', () => {
  assert.equal(splatLabel({ name: '   ', src: 'assets/site.spz' }), 'site.spz');
  assert.equal(splatLabel({ name: '\t\n', src: 'assets/site.spz' }), 'site.spz');
});

test('a name is trimmed rather than shown with its padding', () => {
  assert.equal(splatLabel({ name: '  North dock  ', src: 'assets/site.spz' }), 'North dock');
});

test('basename handles nested and bare srcs alike', () => {
  assert.equal(basename('assets/site.spz'), 'site.spz');
  assert.equal(basename('assets/site/level-1/scan.sog'), 'scan.sog');
  assert.equal(basename('site.spz'), 'site.spz');
});

test('a duplicated row is labelled identically, so it reads as a duplicate (§6.4)', () => {
  const a = defaultSplat('splat-1', 'assets/site.spz');
  const b = { ...a, id: 'splat-2' };
  assert.equal(splatLabel(a), splatLabel(b));
});

// --- accepted extensions (§3.1) --------------------------------------------

test('only the single-file capture formats are accepted', () => {
  for (const name of ['site.spz', 'site.sog', 'site.ply', 'site.splat', 'site.ksplat']) {
    assert.equal(isSplatFileName(name), true, name);
  }
  for (const name of ['site.glb', 'scene.json', 'meta.json', 'site.webp', 'notes.txt', 'site']) {
    assert.equal(isSplatFileName(name), false, name);
  }
});

test('the extension match is case-insensitive but needs a stem', () => {
  assert.equal(isSplatFileName('SITE.SPZ'), true);
  assert.equal(isSplatFileName('Site.Ply'), true);
  // A bare extension is not a file name.
  assert.equal(isSplatFileName('.spz'), false);
});

// --- the row badge (§6.2) --------------------------------------------------
// `loaded` means **decoded**; the capture draws a few frames later (§4.4), and
// the badge is deliberately not a claim about what is on screen.

test('loading reports a percentage, or `loading…` when the length is unknown', () => {
  assert.equal(splatBadge({ status: 'loading', progress: 0.412 }), '41%');
  assert.equal(splatBadge({ status: 'loading', progress: 0 }), '0%');
  assert.equal(splatBadge({ status: 'loading', progress: null }), 'loading…');
});

test('a loaded capture reports its splat count, which is what costs frames (§4.6)', () => {
  assert.equal(splatBadge({ status: 'loaded', splatCount: 4_200_000 }), '4.2M splats');
  assert.equal(splatBadge({ status: 'loaded', splatCount: 820_000 }), '820k splats');
  assert.equal(splatBadge({ status: 'loaded', splatCount: 12 }), '12 splats');
});

test('each failure names itself, so a row explains its own absence (§9)', () => {
  assert.equal(splatBadge({ status: 'error', failure: 'missing' }), '⚠ missing from assets/');
  assert.equal(splatBadge({ status: 'error', failure: 'undecodable' }), '⚠ could not be decoded');
});

test('a row the layer has not reported on yet shows no badge', () => {
  assert.equal(splatBadge(undefined), null);
});

// --- Euler ⇄ quaternion, and the Flip 180° Z preset (§7) --------------------
// The panel types Euler degrees over a stored quaternion, through the app's own
// shared pair rather than a hand-rolled one — the same reasoning
// `apps/splat-camera-export`'s `alignment.ts` records: a mismatched convention
// round-trips 180° about X to 0°.

function assertSameRotation(a: Quat, b: Quat, message: string): void {
  // A quaternion and its negation are the same rotation, so compare up to sign.
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-9, `${message}: |dot| was ${Math.abs(dot)}`);
}

test('Euler degrees round-trip through the quaternion', () => {
  for (const angles of [
    { yaw: 0, pitch: 0, roll: 0 },
    { yaw: 90, pitch: 0, roll: 0 },
    { yaw: -37, pitch: 12, roll: 5 },
    { yaw: 180, pitch: 0, roll: 0 },
    { yaw: 0, pitch: 0, roll: 180 },
    // The canonical registration of a Z-up capture into the Y-up scene, and the
    // reason the panel's X field is bounded at ±90 rather than the camera
    // panel's ±89: at 89 this rotation is untypeable (§7).
    { yaw: 0, pitch: -90, roll: 0 },
    { yaw: 0, pitch: 90, roll: 0 },
    { yaw: 45, pitch: -90, roll: 0 },
  ]) {
    const q = eulerToQuat(angles);
    const back = eulerToQuat(quatToEuler(q));
    assertSameRotation(q, back, JSON.stringify(angles));
  }
});

test('the Flip 180° Z rotation is 180° about Z, and survives the panel round-trip', () => {
  assert.deepEqual(FLIP_Z_ROTATION, [0, 0, 1, 0]);
  // Yaw/pitch/roll is 'YXZ'; a 180° roll is the same rotation, which is what the
  // panel shows for this preset.
  assertSameRotation(FLIP_Z_ROTATION, eulerToQuat({ yaw: 0, pitch: 0, roll: 180 }), 'flip');
  assertSameRotation(FLIP_Z_ROTATION, eulerToQuat(quatToEuler(FLIP_Z_ROTATION)), 'round-trip');
});

test('isFlippedZ drives the preset button and ignores quaternion sign', () => {
  assert.equal(isFlippedZ(FLIP_Z_ROTATION), true);
  assert.equal(isFlippedZ([0, 0, -1, 0]), true);
  assert.equal(isFlippedZ([0, 0, 0, 1]), false);
  assert.equal(isFlippedZ([0, 0.707, 0, 0.707]), false);
});

// --- the clip band → SDF box mapping (§5.4) --------------------------------
// `spec.md` §13.9 clips geometry with two world planes on each mesh's material.
// A Gaussian has no rasterized surface for a plane to cut, so here the band is
// one inverted BOX SDF at `opacity: 0` instead. The mapping is a pure function of the
// band and the workspace AABB **alone** — no capture's registration enters it,
// which is also why the clip imposes no uniform-scale requirement of its own.

const WORLD_MIN: Vec3 = [-10, 0, -20];
const WORLD_MAX: Vec3 = [10, 6, 20];
const band = (axis: 0 | 1 | 2, min: number, max: number): ClipBand => ({ axis, min, max });

test('the box centres on the band midpoint along its axis and on the AABB elsewhere', () => {
  const box = clipBandToSdfBox(band(1, 1, 3), WORLD_MIN, WORLD_MAX);
  assert.deepEqual(box.position, [0, 2, 0]);
});

test('the half-extent along the band axis is half the band thickness', () => {
  const box = clipBandToSdfBox(band(1, 1, 3), WORLD_MIN, WORLD_MAX);
  assert.equal(box.halfExtents[1], 1);
});

test('the other two half-extents span the workspace AABB, so the cut is unbounded in-plane', () => {
  const box = clipBandToSdfBox(band(1, 1, 3), WORLD_MIN, WORLD_MAX);
  assert.equal(box.halfExtents[0], 10);
  assert.equal(box.halfExtents[2], 20);
});

test('each of the three axes maps the same way', () => {
  const x = clipBandToSdfBox(band(0, -4, -2), WORLD_MIN, WORLD_MAX);
  assert.deepEqual(x.position, [-3, 3, 0]);
  assert.deepEqual(x.halfExtents, [1, 3, 20]);

  const z = clipBandToSdfBox(band(2, 8, 12), WORLD_MIN, WORLD_MAX);
  assert.deepEqual(z.position, [0, 3, 10]);
  assert.deepEqual(z.halfExtents, [10, 3, 2]);
});

test('a band clamped to the full extent encloses the whole workspace, erasing nothing', () => {
  const box = clipBandToSdfBox(band(1, WORLD_MIN[1], WORLD_MAX[1]), WORLD_MIN, WORLD_MAX);
  assert.deepEqual(box.position, [0, 3, 0]);
  assert.deepEqual(box.halfExtents, [10, 3, 20]);
  for (const axis of [0, 1, 2] as const) {
    assert.equal(box.position[axis] - box.halfExtents[axis], WORLD_MIN[axis]);
    assert.equal(box.position[axis] + box.halfExtents[axis], WORLD_MAX[axis]);
  }
});

test('a degenerate band yields a zero half-extent rather than a negative one', () => {
  const box = clipBandToSdfBox(band(1, 3, 3), WORLD_MIN, WORLD_MAX);
  assert.equal(box.halfExtents[1], 0);
  // Defensive against a transient min > max mid-drag, as `axisIndexRange` is.
  assert.equal(clipBandToSdfBox(band(1, 4, 2), WORLD_MIN, WORLD_MAX).halfExtents[1], 0);
});

test('no capture transform enters the mapping — it is world space throughout', () => {
  // There is deliberately no splat argument to pass: two rows at wildly
  // different registrations are clipped by the one box (§5.4).
  const a = clipBandToSdfBox(band(1, 1, 3), WORLD_MIN, WORLD_MAX);
  const b = clipBandToSdfBox(band(1, 1, 3), WORLD_MIN, WORLD_MAX);
  assert.deepEqual(a, b);
  assert.equal(clipBandToSdfBox.length, 3);
});

// --- the decoded splat count (§4.4, §6.2) ----------------------------------
// The bug this pins: every capture badged `0 splats`. Loading with `lod: true`
// sends Spark's worker down its LOD branch, which returns the payload under
// `lodSplats` **alone** — no top-level `packedArray` — so `PackedSplats`
// initialises with `numSplats` at 0 while rendering perfectly, since
// `SplatMesh.update` looks for `lodSplats` itself.

test('the count comes from lodSplats when the top-level count is empty', () => {
  assert.equal(decodedSplatCount({ numSplats: 0, lodSplats: { numSplats: 4_200_000 } }), 4_200_000);
  assert.equal(splatBadge({ status: 'loaded', splatCount: decodedSplatCount({ numSplats: 0, lodSplats: { numSplats: 4_200_000 } }) }), '4.2M splats');
});

test('a non-LOD decode still reports its own count', () => {
  assert.equal(decodedSplatCount({ numSplats: 20_000 }), 20_000);
  // A populated top level wins, so a pyramid alongside it cannot shadow it.
  assert.equal(decodedSplatCount({ numSplats: 20_000, lodSplats: { numSplats: 9 } }), 20_000);
});

test('a genuinely empty decode is 0, not a crash', () => {
  assert.equal(decodedSplatCount({ numSplats: 0 }), 0);
  assert.equal(decodedSplatCount({ numSplats: 0, lodSplats: undefined }), 0);
});

// --- the registration (§2.1, §3.2, §7) -------------------------------------

test('an identity registration is position [0,0,0], no rotation, scale 1', () => {
  assert.deepEqual(identityRegistration(), { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 });
});

test('each identity registration is its own object, so one drag cannot move two splats', () => {
  // `Vec3`/`Quat` are mutable tuples: a shared constant would be aliased into
  // every splat added, and the layer writes the anchor from these arrays.
  const a = identityRegistration();
  const b = identityRegistration();
  assert.notEqual(a.position, b.position);
  assert.notEqual(a.rotation, b.rotation);
  a.position[0] = 5;
  assert.deepEqual(b.position, [0, 0, 0]);

  const one = defaultSplat('splat-1', 'assets/site.spz');
  const two = defaultSplat('splat-2', 'assets/site.spz');
  one.position[1] = 3;
  assert.deepEqual(two.position, [0, 0, 0]);
});

test('a reset registration is what a freshly added splat carries', () => {
  const fresh = defaultSplat('splat-1', 'assets/site.spz');
  const identity = identityRegistration();
  assert.deepEqual(
    { position: fresh.position, rotation: fresh.rotation, scale: fresh.scale },
    identity,
  );
});

// --- why a capture would not decode (§3.1, §9) -----------------------------
// The Add dialog never offers a `meta.json` (§3.1), but a hand-edited scene file
// can reference one — and then the remedy is a different file rather than a
// repair, so §9 gives that row its own reason instead of the bare badge.

test('a hand-referenced PCSOGS manifest names its .sog zip rather than badging bare', () => {
  assert.equal(splatDecodeFailure('assets/meta.json'), 'sogBundle');
  assert.equal(splatBadge({ status: 'error', failure: 'sogBundle' }), '⚠ SOG bundle — use its .sog zip');
});

test('the manifest is recognised by its basename, at any depth and in any case', () => {
  assert.equal(splatDecodeFailure('assets/site/capture/META.JSON'), 'sogBundle');
  assert.equal(splatDecodeFailure('meta.json'), 'sogBundle');
});

test('every other unreadable or undecodable file is plainly undecodable', () => {
  // One badge for unreadable bytes, a corrupt capture, and a failed Spark
  // import alike: the remedy is the same (§9).
  assert.equal(splatDecodeFailure('assets/site.spz'), 'undecodable');
  assert.equal(splatDecodeFailure('assets/truncated.ply'), 'undecodable');
  // Not a *sibling* of the manifest, either — only the manifest itself.
  assert.equal(splatDecodeFailure('assets/meta.json.spz'), 'undecodable');
});

// --- the coverage fog's depth pass (§4.5) ----------------------------------
// The pass exists only to give the fog an occluder where a capture stands. Its
// gate is a judgement, so it lives here; the render calls it gates cannot run
// under `node --test`.

test('a loaded, visible capture wants the depth pass', () => {
  assert.equal(needsSplatDepthPass({ sparkReady: true, meshCount: 1, visible: true }), true);
});

test('no decoded capture means no depth pass', () => {
  // A scene without captures must pay nothing, and the fog must behave exactly
  // as it did before captures existed.
  assert.equal(needsSplatDepthPass({ sparkReady: true, meshCount: 0, visible: true }), false);
});

test('a hidden splat layer writes no depth', () => {
  // Turning Splats off in the eye menu (§5.2) must not leave an invisible
  // occluder behind, punching capture-shaped holes in the fog.
  assert.equal(needsSplatDepthPass({ sparkReady: true, meshCount: 3, visible: false }), false);
});

test('before Spark loads there is nothing to draw', () => {
  // `SparkRenderer` arrives with the first capture load (§4.2); until then the
  // pass has no material to flip and no splats to rasterize.
  assert.equal(needsSplatDepthPass({ sparkReady: false, meshCount: 0, visible: true }), false);
});
