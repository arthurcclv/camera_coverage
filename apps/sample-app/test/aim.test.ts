import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PITCH_DEG, aimDelta, clampPitch, horizontalFov } from '../src/cameras/aim.ts';
import { eulerToQuat, quatToEuler } from '../src/cameras/math.ts';

const IMAGE = { width: 1600, height: 900 };
const FOV = 60;
const ASPECT = 16 / 9;
const LEVEL = { yaw: 0, pitch: 0, roll: 0 };

test('horizontalFov widens the vertical FOV by the aspect (and is not a naive multiply)', () => {
  const h = horizontalFov(FOV, ASPECT);
  assert.ok(h > FOV, 'a 16:9 frame is wider than it is tall');
  // The correct relation is on the tangents, not the angles.
  assert.ok(Math.abs(Math.tan((h * Math.PI) / 360) - Math.tan((FOV * Math.PI) / 360) * ASPECT) < 1e-12);
  assert.notEqual(h, FOV * ASPECT);
  // A square frame has equal FOVs.
  assert.ok(Math.abs(horizontalFov(FOV, 1) - FOV) < 1e-12);
  // Degenerate aspect falls back to square rather than NaN.
  assert.ok(Number.isFinite(horizontalFov(FOV, 0)));
});

test('a drag spanning the image sweeps exactly one field of view (spec §5.2)', () => {
  const next = aimDelta(LEVEL, IMAGE.width, 0, FOV, ASPECT, IMAGE);
  assert.ok(Math.abs(next.yaw + horizontalFov(FOV, ASPECT)) < 1e-12, 'full width = one horizontal FOV, rightward');
  // Vertically the guide's height spans the vertical FOV. Use half so the
  // 60° sweep can't be swallowed by the ±89° clamp.
  const down = aimDelta(LEVEL, 0, IMAGE.height / 2, FOV, ASPECT, IMAGE);
  assert.ok(Math.abs(down.pitch + FOV / 2) < 1e-12, 'half height = half the vertical FOV, downward');
});

test('drag direction is mouselook: the aim follows the pointer (spec §5.2)', () => {
  // Positive yaw turns toward −X from the −Z forward, i.e. *left* (cameras/math.ts),
  // so steering right must decrease it.
  assert.ok(aimDelta(LEVEL, 100, 0, FOV, ASPECT, IMAGE).yaw < 0, 'drag right → turns right');
  assert.ok(aimDelta(LEVEL, -100, 0, FOV, ASPECT, IMAGE).yaw > 0, 'drag left → turns left');
  // Positive pitch looks up (the defaults use −28 for "angled downward").
  assert.ok(aimDelta(LEVEL, 0, 100, FOV, ASPECT, IMAGE).pitch < 0, 'drag down → tilts down');
  assert.ok(aimDelta(LEVEL, 0, -100, FOV, ASPECT, IMAGE).pitch > 0, 'drag up → tilts up');
});

test('sensitivity scales with the lens: a narrow FOV gives finer control', () => {
  const narrow = aimDelta(LEVEL, 100, 100, 20, ASPECT, IMAGE);
  const wide = aimDelta(LEVEL, 100, 100, 120, ASPECT, IMAGE);
  // Compare magnitudes — both sweeps are negative under mouselook.
  assert.ok(Math.abs(narrow.yaw) < Math.abs(wide.yaw), 'same drag turns less on a long lens');
  assert.ok(Math.abs(narrow.pitch) < Math.abs(wide.pitch));
});

test('pitch is clamped to ±89° so the drag can never gimbal-flip (spec §5.1, §5.2)', () => {
  assert.equal(MAX_PITCH_DEG, 89);
  assert.equal(clampPitch(200), 89);
  assert.equal(clampPitch(-200), -89);
  assert.equal(clampPitch(12.5), 12.5);

  // A huge drag saturates rather than passing the pole. Under mouselook a
  // *downward* drag tilts down, so it saturates at −89 — and since the default
  // rig already sits at −28°, this is the routine case, not the exotic one.
  const down = aimDelta(LEVEL, 0, 100_000, FOV, ASPECT, IMAGE);
  assert.equal(down.pitch, -89);
  const up = aimDelta(LEVEL, 0, -100_000, FOV, ASPECT, IMAGE);
  assert.equal(up.pitch, 89);
  // Yaw stays unbounded — it wraps naturally through the quaternion.
  assert.ok(Math.abs(aimDelta(LEVEL, 100_000, 0, FOV, ASPECT, IMAGE).yaw) > 360);
});

test('roll passes through untouched, so the horizon stays level (spec §5.2)', () => {
  const tilted = { yaw: 30, pitch: -20, roll: 14 };
  const next = aimDelta(tilted, 250, -80, FOV, ASPECT, IMAGE);
  assert.equal(next.roll, 14);
  assert.notEqual(next.yaw, tilted.yaw);
  assert.notEqual(next.pitch, tilted.pitch);
  // Even when the pitch clamp engages, roll is not touched.
  assert.equal(aimDelta(tilted, 0, 100_000, FOV, ASPECT, IMAGE).roll, 14);
});

test('incremental drags accumulate the same as one combined drag', () => {
  const once = aimDelta(LEVEL, 120, 60, FOV, ASPECT, IMAGE);
  let step = LEVEL;
  for (let i = 0; i < 4; i += 1) step = aimDelta(step, 30, 15, FOV, ASPECT, IMAGE);
  assert.ok(Math.abs(step.yaw - once.yaw) < 1e-12, 'yaw accumulates linearly');
  assert.ok(Math.abs(step.pitch - once.pitch) < 1e-12, 'pitch accumulates linearly');
});

test('a degenerate image size cannot produce NaN (guide not yet published)', () => {
  for (const image of [{ width: 0, height: 0 }, { width: -5, height: 900 }]) {
    const next = aimDelta(LEVEL, 10, 10, FOV, ASPECT, image);
    assert.ok(Number.isFinite(next.yaw) && Number.isFinite(next.pitch), `finite for ${JSON.stringify(image)}`);
  }
});

test('the result round-trips through the quaternion the scene camera stores (§5.1)', () => {
  // The drag emits eulerToQuat(result); the panel re-derives Euler from it.
  const aimed = aimDelta({ yaw: 180, pitch: -28, roll: 0 }, 200, 50, FOV, ASPECT, IMAGE);
  const back = quatToEuler(eulerToQuat(aimed));
  assert.ok(Math.abs(back.pitch - aimed.pitch) < 1e-9, 'pitch survives the round-trip');
  assert.ok(Math.abs(back.roll - aimed.roll) < 1e-9, 'roll stays zero');
  // Yaw is equal modulo 360 (the quaternion carries no winding).
  const dYaw = Math.abs(((back.yaw - aimed.yaw) % 360 + 540) % 360 - 180);
  assert.ok(dYaw < 1e-9, `yaw survives modulo 360 (got ${back.yaw} vs ${aimed.yaw})`);
});
