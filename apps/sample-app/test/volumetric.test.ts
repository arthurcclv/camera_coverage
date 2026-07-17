/**
 * Tests for the voxel volumetric renderer's pure-TS reference math
 * (specs/volumetric_rendering.md §6). The TSL fragment node mirrors these.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slabChord,
  voxelContribution,
  maxContribution,
  compositeContributions,
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

test('contribution is zero when intensity is zero', () => {
  assert.deepEqual(voxelContribution([1, 1, 1], 0, 1, 1), [0, 0, 0]);
});

test('contribution is monotonic in intensity and in intensityScale', () => {
  const white: Vec3 = [1, 1, 1];
  const low = voxelContribution(white, 0.25, 1, 1)[0];
  const high = voxelContribution(white, 0.75, 1, 1)[0];
  assert.ok(high > low);

  const dim = voxelContribution(white, 0.5, 1, 0.2)[0];
  const bright = voxelContribution(white, 0.5, 1, 0.6)[0];
  assert.ok(bright > dim);
});

test('per-channel scaling by color is correct', () => {
  // rgb = color * intensity * chord * intensityScale.
  const rgb = voxelContribution([1, 0.15, 0.15], 1, 0.5, 0.25);
  const k = 1 * 0.5 * 0.25;
  assert.ok(Math.abs(rgb[0] - 1 * k) < 1e-12);
  assert.ok(Math.abs(rgb[1] - 0.15 * k) < 1e-12);
  assert.ok(Math.abs(rgb[2] - 0.15 * k) < 1e-12);
});

// --- Max mode (specs/volumetric_rendering.md §3, §4) -------------------------

test('max-mode contribution is independent of chord', () => {
  // Same voxel, grazing vs full-chord ray: additive differs, max does not.
  const color: Vec3 = [1, 0.15, 0.15];
  const grazing = maxContribution(color, 0.8, 0.25);
  const full = maxContribution(color, 0.8, 0.25);
  assert.deepEqual(grazing, full);
  // And it equals color * intensity * intensityScale (no chord factor).
  const k = 0.8 * 0.25;
  assert.ok(Math.abs(grazing[0] - 1 * k) < 1e-12);
  assert.ok(Math.abs(grazing[1] - 0.15 * k) < 1e-12);
  assert.ok(Math.abs(grazing[2] - 0.15 * k) < 1e-12);
});

test('additive composite sums contributions; max keeps the per-channel maximum', () => {
  const a: Vec3 = [0.2, 0.6, 0.1];
  const b: Vec3 = [0.5, 0.3, 0.4];
  const sum = compositeContributions('additive', [a, b]);
  const expectedSum = [0.7, 0.9, 0.5];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(sum[i] - expectedSum[i]) < 1e-12, `sum[${i}]=${sum[i]}`);
  // Max is a straight comparison, so no rounding — exact equality holds.
  assert.deepEqual(compositeContributions('max', [a, b]), [0.5, 0.6, 0.4]);
});

test('both composite modes are order-independent', () => {
  const contribs: Vec3[] = [
    [0.2, 0.6, 0.1],
    [0.5, 0.3, 0.4],
    [0.1, 0.1, 0.9],
  ];
  const reversed = [...contribs].reverse();
  for (const mode of ['additive', 'max'] as const) {
    const forward = compositeContributions(mode, contribs);
    const back = compositeContributions(mode, reversed);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(forward[i] - back[i]) < 1e-12);
  }
});

test('max composite of a set equals its brightest element per channel', () => {
  // Single-hue (white) voxels: max is exactly the highest-intensity one.
  const white: Vec3 = [1, 1, 1];
  const contribs = [0.3, 0.9, 0.5, 0.1].map(
    (i) => maxContribution(white, i, 1) as Vec3,
  );
  assert.deepEqual(compositeContributions('max', contribs), [0.9, 0.9, 0.9]);
});

test('empty contribution set composites to black in both modes', () => {
  assert.deepEqual(compositeContributions('additive', []), [0, 0, 0]);
  assert.deepEqual(compositeContributions('max', []), [0, 0, 0]);
});
