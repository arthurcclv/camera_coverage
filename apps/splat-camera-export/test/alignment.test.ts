/** Tests for `align/alignment.ts` (spec §7, §12). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Quat as PcQuat, Vec3 as PcVec3 } from 'playcanvas';
import {
  ALIGNMENT_STORAGE_PREFIX,
  alignmentStorageKey,
  defaultAlignment,
  eulerToQuat,
  FLIP_Z_ROTATION,
  flipZPreset,
  IDENTITY_ALIGNMENT,
  isFlippedZ,
  parseAlignment,
  quatToEuler,
  serializeAlignment,
} from '../src/align/alignment.ts';

function closeTo(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test('identity Euler maps to the identity quaternion', () => {
  assert.deepEqual(eulerToQuat({ x: 0, y: 0, z: 0 }), [0, 0, 0, 1]);
});

/**
 * Whether two quaternions denote the same rotation. `q` and `-q` are the same
 * rotation, so the magnitude of the dot product is the invariant, not equality.
 */
function sameRotation(a: readonly number[], b: readonly number[]): boolean {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return Math.abs(Math.abs(dot) - 1) < 1e-6;
}

test('Euler → quaternion → Euler preserves digits within the canonical range', () => {
  // One axis of an Euler triple is confined to ±90 by the decomposition, so only
  // angles inside that range are guaranteed to come back spelled identically.
  for (const axis of ['x', 'y', 'z'] as const) {
    for (const angle of [-89, -45, -1, 0, 12.5, 45, 89]) {
      const euler = { x: 0, y: 0, z: 0, [axis]: angle };
      const back = quatToEuler(eulerToQuat(euler));
      closeTo(back[axis], angle, 1e-4);
    }
  }
});

test('Euler → quaternion → Euler preserves the rotation past the canonical range', () => {
  // Y = -135 legitimately respells as (180, -45, 180): a different spelling of the
  // same rotation. The rotation is the invariant that must hold, not the digits.
  for (const axis of ['x', 'y', 'z'] as const) {
    for (const angle of [-179, -135, 135, 170]) {
      const euler = { x: 0, y: 0, z: 0, [axis]: angle };
      const quat = eulerToQuat(euler);
      const reencoded = eulerToQuat(quatToEuler(quat));
      assert.ok(
        sameRotation(quat, reencoded),
        `${axis}=${angle} did not survive the round-trip as the same rotation`,
      );
    }
  }
});

test('Euler → quaternion → Euler round-trips a combined rotation', () => {
  const euler = { x: 20, y: -35, z: 70 };
  const back = quatToEuler(eulerToQuat(euler));
  closeTo(back.x, euler.x, 1e-4);
  closeTo(back.y, euler.y, 1e-4);
  closeTo(back.z, euler.z, 1e-4);
});

test('the produced quaternion is unit length', () => {
  const [x, y, z, w] = eulerToQuat({ x: 33, y: -71, z: 12 });
  closeTo(Math.hypot(x, y, z, w), 1);
});

test('the gimbal-lock pole yields finite angles rather than NaN', () => {
  const euler = quatToEuler(eulerToQuat({ x: 90, y: 0, z: 0 }));
  assert.ok(Number.isFinite(euler.x) && Number.isFinite(euler.y) && Number.isFinite(euler.z));
  closeTo(euler.x, 90, 1e-3);
});

test('a quaternion carrying float noise past 1 does not produce NaN', () => {
  const euler = quatToEuler([0.7071068 * 1.0000001, 0, 0, 0.7071068 * 1.0000001]);
  assert.ok(Number.isFinite(euler.x));
});

test('the flip preset is a 180° Z rotation and is idempotent (§7.2)', () => {
  const once = flipZPreset(IDENTITY_ALIGNMENT);
  assert.deepEqual(once.rotation, [0, 0, 1, 0]);
  assert.deepEqual(flipZPreset(once).rotation, [0, 0, 1, 0]);
  closeTo(Math.abs(quatToEuler(once.rotation).z), 180, 1e-3);
});

test('the 180° Z rotation negates X and Y but not Z', () => {
  // What makes it the right correction: it un-flips Y (fixing upside-down) while
  // leaving Z alone — unlike a 180° X rotation, which negates Y and Z instead.
  // Uses the engine's own transform rather than hand-rolled quaternion algebra.
  const [x, y, z, w] = FLIP_Z_ROTATION;
  const q = new PcQuat(x, y, z, w);
  const rotate = (v: [number, number, number]) => {
    const out = q.transformVector(new PcVec3(v[0], v[1], v[2]), new PcVec3());
    return [out.x, out.y, out.z].map((n) => Number(n.toFixed(6)));
  };
  assert.deepEqual(rotate([1, 0, 0]), [-1, 0, 0]);
  assert.deepEqual(rotate([0, 1, 0]), [0, -1, 0]);
  assert.deepEqual(rotate([0, 0, 1]), [0, 0, 1]);
});

test('the flip preset preserves position and scale', () => {
  const start = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 2.5 };
  const flipped = flipZPreset(start);
  assert.deepEqual(flipped.position, [1, 2, 3]);
  assert.equal(flipped.scale, 2.5);
});

test('isFlippedZ distinguishes flipped from identity', () => {
  assert.equal(isFlippedZ(IDENTITY_ALIGNMENT), false);
  assert.equal(isFlippedZ(flipZPreset(IDENTITY_ALIGNMENT)), true);
});

test('a fresh capture defaults to the 180° Z correction, rotation only (§7.3)', () => {
  const a = defaultAlignment();
  assert.deepEqual(a.rotation, [0, 0, 1, 0]);
  assert.deepEqual(a.position, [0, 0, 0]);
  assert.equal(a.scale, 1);
  // The preset button must read as pressed on load.
  assert.equal(isFlippedZ(a), true);
});

test('parses a valid alignment and normalizes its rotation', () => {
  const result = parseAlignment({ position: [1, 2, 3], rotation: [0, 0, 0, 2], scale: 0.5 });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.alignment.position, [1, 2, 3]);
  assert.deepEqual(result.alignment.rotation, [0, 0, 0, 1]);
  assert.equal(result.alignment.scale, 0.5);
});

test('rejects an invalid alignment with a specific message', () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
    [{ rotation: [0, 0, 0, 1], scale: 1 }, /position must be 3 finite numbers/],
    [{ position: [1, 2], rotation: [0, 0, 0, 1], scale: 1 }, /position must be 3 finite numbers/],
    [{ position: [0, 0, 0], rotation: [0, 0, 1], scale: 1 }, /rotation must be 4 finite numbers/],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 0], scale: 1 }, /non-zero quaternion/],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 1] }, /scale must be a positive number/],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 0 }, /scale must be a positive number/],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: -2 }, /scale must be a positive number/],
    [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: NaN }, /scale must be a positive number/],
  ];
  for (const [input, pattern] of cases) {
    const result = parseAlignment(input);
    assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to fail`);
    if (result.ok) throw new Error('unreachable');
    assert.match(result.error, pattern);
  }
});

test('serialize → parse round-trips an alignment', () => {
  const alignment = { position: [1.5, -2, 0.25] as [number, number, number], rotation: [1, 0, 0, 0] as [number, number, number, number], scale: 3 };
  const result = parseAlignment(JSON.parse(serializeAlignment(alignment)));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.alignment, alignment);
});

test('the storage key separates captures by name and size (§7.4)', () => {
  assert.notEqual(alignmentStorageKey('site.ply', 100), alignmentStorageKey('site.ply', 200));
  assert.notEqual(alignmentStorageKey('a.ply', 100), alignmentStorageKey('b.ply', 100));
  assert.equal(alignmentStorageKey('site.ply', 100), alignmentStorageKey('site.ply', 100));
});

test('the storage key is versioned, so superseded entries are orphaned (§7.4)', () => {
  const key = alignmentStorageKey('site.ply', 100);
  assert.ok(key.startsWith(ALIGNMENT_STORAGE_PREFIX), `${key} should carry the version prefix`);
  // A v1-era entry must not be readable under the current prefix — that generation
  // persisted auto-applied defaults as though they were user choices.
  assert.notEqual(key, `splat-camera-export:alignment:site.ply:100`);
});
