/**
 * Tests for the polyline draw mode's hover plane (`camera_placement.md` §6.2).
 *
 * Pure arithmetic, no raycaster: the point of the plane is that a hover never
 * touches the scene mesh, so nothing here needs one. What the cases pin is the
 * two guards (a ray that skims the plane, a plane behind the camera) and the fact
 * that the plane is honoured in its **own** orientation — the mistake a
 * `y = const` shortcut would make and a horizontal-only test would miss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  MIN_RAY_COS,
  WORLD_UP,
  planeFromHit,
  planeHit,
  seedPlane,
  type HoverPlane,
} from '../../src/scene/sceneView/hoverPlane.ts';

const unit = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};
const close = (a: Vec3, b: Vec3, eps = 1e-9) => {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < eps, `${a} ≈ ${b} (component ${i})`);
};

const FLOOR: HoverPlane = { point: [0, 0, 0], normal: [0, 1, 0] };
/** The east wall's inner face in the default room: x = 10, normal along -X. */
const WALL: HoverPlane = { point: [10, 0, 0], normal: [-1, 0, 0] };

test('a ray meeting the plane square returns the exact intersection', () => {
  // Straight down from 5 m up: the floor plane at y = 0.
  close(planeHit([2, 5, -3], [0, -1, 0], FLOOR)!, [2, 0, -3]);
});

test('the plane is honoured in its own orientation, not as a height', () => {
  // Due east at eye height: a `y = const` implementation would find nothing here
  // (the ray never changes y) or return the origin's own height as the hit.
  close(planeHit([0, 2, 0], [1, 0, 0], WALL)!, [10, 2, 0]);
  // And an oblique ray at the same wall keeps its y and z as it travels.
  close(planeHit([0, 2, 0], unit([1, 0, 1]), WALL)!, [10, 2, 10]);
});

test('a ray parallel to the plane draws no band', () => {
  assert.equal(planeHit([0, 3, 0], [1, 0, 0], FLOOR), null);
  assert.equal(planeHit([0, 3, 0], [0, 0, -1], FLOOR), null);
  assert.equal(planeHit([0, 2, 0], [0, 1, 0], WALL), null);
});

test('a near-parallel ray inside the guard draws no band either', () => {
  // A ray tilted just under the guard: the intersection would sit hundreds of
  // kilometres away, which is worse than no band at all.
  const cos = MIN_RAY_COS / 2;
  const dir = unit([Math.sqrt(1 - cos * cos), -cos, 0]);
  assert.equal(planeHit([0, 3, 0], dir, FLOOR), null);
});

test('a ray just outside the guard still resolves', () => {
  const cos = MIN_RAY_COS * 10;
  const dir = unit([Math.sqrt(1 - cos * cos), -cos, 0]);
  const hit = planeHit([0, 3, 0], dir, FLOOR);
  assert.ok(hit, 'expected a hit just outside the parallel guard');
  assert.ok(Math.abs(hit[1]) < 1e-9, `lands on the plane (y ${hit[1]} ≈ 0)`);
});

test('a plane behind the camera is a miss, not a negative-t point', () => {
  // Looking up, away from the floor: the algebra alone would happily report the
  // point below and behind the viewer.
  assert.equal(planeHit([0, 3, 0], [0, 1, 0], FLOOR), null);
  // Looking west with the wall to the east.
  assert.equal(planeHit([0, 2, 0], [-1, 0, 0], WALL), null);
});

test('a ray whose origin lies on the plane is a miss (t = 0), not a zero-length band', () => {
  assert.equal(planeHit([1, 0, 1], [0, -1, 0], FLOOR), null);
});

test('no plane is a miss — the state a fresh draft is armed in', () => {
  assert.equal(planeHit([0, 5, 0], [0, -1, 0], null), null);
});

// --- seeding (§6.2) ----------------------------------------------------------

test("a click's hit becomes the plane, surface and all", () => {
  const plane = planeFromHit({ point: [1, 2, 3], normal: [0, 0, -1] });
  assert.deepEqual(plane, { point: [1, 2, 3], normal: [0, 0, -1] });
  // Copied, not aliased: the caller's hit must not be able to move the plane.
  const source: { point: Vec3; normal: Vec3 } = { point: [1, 2, 3], normal: [0, 0, -1] };
  const copied = planeFromHit(source);
  source.point[0] = 99;
  assert.equal(copied.point[0], 1);
});

test('a hit with no face normal falls back to world up', () => {
  assert.deepEqual(planeFromHit({ point: [4, 5, 6], normal: null }), { point: [4, 5, 6], normal: WORLD_UP });
});

test("Extend's pre-click plane is world up through the anchor (§6.2)", () => {
  const anchor: Vec3 = [7, 1.5, -2];
  const plane = seedPlane(anchor);
  assert.deepEqual(plane, { point: [7, 1.5, -2], normal: [0, 1, 0] });
  // A hover against it stays at the anchor's height, which is the point: the band
  // continues along the level the rail was drawn at until the first click lands.
  close(planeHit([7, 10, -20], unit([0, -1, 1]), plane)!, [7, 1.5, -11.5]);
});

test('the seeded plane copies the anchor rather than aliasing it', () => {
  const anchor: Vec3 = [1, 2, 3];
  const plane = seedPlane(anchor);
  anchor[1] = 99;
  assert.equal(plane.point[1], 2);
});
