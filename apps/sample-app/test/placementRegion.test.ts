/**
 * Camera-constraint geometry (`camera_placement.md` §3.2, §13).
 *
 * The region test is a distance to the primitive, not a box containment, so the
 * cases that matter are the ones a box test would get wrong: a polyline's
 * joints and caps, and a plane rectangle's corners.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  constraintLabel,
  constraintProblem,
  DEFAULT_TEMPLATE,
  defaultConstraintGroup,
  defaultConstraintName,
  defaultGroupName,
  distToPrimitive,
  groupLabel,
  groupProblem,
  inRegion,
  nearestOnPrimitive,
  pointOnPrimitive,
  primitiveMeasure,
  projectIntoRegion,
  type CameraConstraint,
  type ConstraintGroup,
} from '../src/placement/region.ts';

const IDENTITY: Quat = [0, 0, 0, 1];
// 90° about Y (xyzw): local X → world −Z, local Z → world X.
const YAW_90: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

function point(distance: number, position: Vec3 = [0, 0, 0]): CameraConstraint {
  return { id: 'con-1', groupId: 'cg-1', name: '', enabled: true, distance, kind: 'point', position };
}

function polyline(distance: number, points: Vec3[]): CameraConstraint {
  return { id: 'con-2', groupId: 'cg-1', name: '', enabled: true, distance, kind: 'polyline', points };
}

function plane(
  distance: number,
  size: [number, number],
  rotation: Quat = IDENTITY,
  position: Vec3 = [0, 0, 0],
): CameraConstraint {
  return { id: 'con-3', groupId: 'cg-1', name: '', enabled: true, distance, kind: 'plane', position, rotation, size };
}

function group(over: Partial<ConstraintGroup> = {}): ConstraintGroup {
  return {
    id: 'cg-1',
    name: '',
    enabled: true,
    fov: 60,
    far: 30,
    namePrefix: '',
    poolSize: 200,
    maxCount: 10,
    trials: 1000,
    epsilon: 1,
    seed: 1,
    ...over,
  };
}

// --- Membership (§3.2) -------------------------------------------------------

test('point: distance = 0 admits only the point itself; d > 0 gives a ball', () => {
  const fixed = point(0, [1, 2, 3]);
  assert.equal(inRegion([1, 2, 3], fixed), true);
  assert.equal(inRegion([1, 2, 3.001], fixed), false);

  const ball = point(1.5, [1, 2, 3]);
  assert.equal(inRegion([1, 2, 4.4], ball), true);
  assert.equal(inRegion([1, 2, 4.6], ball), false);
  assert.equal(distToPrimitive([1, 2, 4.5], ball), 1.5);
});

test('polyline: the dilation is a capsule chain with round joints and caps', () => {
  // An L along +Z then +X, with a 0.4 m tolerance.
  const rail = polyline(0.4, [
    [0, 5, 0],
    [0, 5, 10],
    [10, 5, 10],
  ]);
  // Beside the middle of the first leg.
  assert.equal(inRegion([0.3, 5, 4], rail), true);
  assert.equal(inRegion([0.5, 5, 4], rail), false);
  // Beside the middle of the second leg.
  assert.equal(inRegion([5, 5, 10.35], rail), true);
  // Round joint: diagonally outside the corner, within d of the vertex.
  assert.equal(inRegion([-0.2, 5, 10.2], rail), true);
  assert.equal(inRegion([-0.4, 5, 10.4], rail), false);
  // Round cap: past the last vertex, within d of it.
  assert.equal(inRegion([10.3, 5, 10], rail), true);
  assert.equal(inRegion([10.5, 5, 10], rail), false);
});

test('plane: the rectangle spans local X and Z, normal along local Y', () => {
  const wall = plane(0.3, [8, 4]);
  // Inside the rectangle, within the slab.
  assert.equal(inRegion([3, 0.2, 1], wall), true);
  assert.equal(inRegion([3, 0.4, 1], wall), false);
  // Past the rectangle's X edge, but within d of it (the rounded rim).
  assert.equal(inRegion([4.2, 0, 0], wall), true);
  assert.equal(inRegion([4.4, 0, 0], wall), false);
  // A corner: outside in both in-plane axes, so the distance is diagonal —
  // hypot(0.2, 0.2) = 0.283, which a box test on each axis would have accepted
  // at any d ≥ 0.2.
  assert.equal(inRegion([4.2, 0, 2.2], wall), true);
  assert.equal(inRegion([4.2, 0, 2.2], plane(0.28, [8, 4])), false);
});

test('plane: a rotated rectangle tests membership in its own frame', () => {
  // 8 m along local X becomes 8 m along world −Z under a 90° yaw.
  const wall = plane(0.3, [8, 4], YAW_90);
  assert.equal(inRegion([0, 0, 3.5], wall), true); // 8 m edge (local X) → world Z
  assert.equal(inRegion([0, 0, 4.5], wall), false);
  assert.equal(inRegion([1.5, 0, 0], wall), true); // 4 m edge (local Z) → world X
  assert.equal(inRegion([2.5, 0, 0], wall), false);
});

// --- Nearest point & measure (§3.2, §4.1) ------------------------------------

test('nearestOnPrimitive: a polyline takes the minimum over its segments', () => {
  const rail = polyline(0, [
    [0, 0, 0],
    [10, 0, 0],
    [10, 0, 10],
  ]);
  assert.deepEqual(nearestOnPrimitive([4, 3, 0], rail), [4, 0, 0]);
  assert.deepEqual(nearestOnPrimitive([12, 0, 5], rail), [10, 0, 5]);
  // Beyond an end, the nearest point is the endpoint itself (the cap).
  assert.deepEqual(nearestOnPrimitive([-5, 0, 0], rail), [0, 0, 0]);
});

test('primitiveMeasure ignores distance: 1, total length, area', () => {
  assert.equal(primitiveMeasure(point(0)), 1);
  assert.equal(primitiveMeasure(point(5)), 1);
  assert.equal(
    primitiveMeasure(
      polyline(0, [
        [0, 0, 0],
        [3, 0, 0],
        [3, 0, 4],
      ]),
    ),
    7,
  );
  assert.equal(primitiveMeasure(plane(0, [60, 40])), 2400);
  assert.equal(primitiveMeasure(plane(2, [60, 40])), 2400);
});

// --- Projection, the drag clamp (§3.2, §6.3) ---------------------------------

test('projectIntoRegion: identity inside, in-region outside, idempotent', () => {
  const rail = polyline(0.4, [
    [0, 5, 0],
    [0, 5, 10],
  ]);
  const inside: Vec3 = [0.2, 5, 4];
  assert.deepEqual(projectIntoRegion(inside, rail), inside);

  const far: Vec3 = [8, 5, 4];
  const p = projectIntoRegion(far, rail);
  assert.equal(inRegion(p, rail), true);
  assert.ok(Math.abs(distToPrimitive(p, rail) - 0.4) < 1e-12);
  // Idempotent: projecting a projected point changes nothing.
  assert.deepEqual(projectIntoRegion(p, rail), p);

  // Dragging past the rail's end slides along it and stops at the cap.
  const beyond = projectIntoRegion([0, 5, 40], rail);
  assert.equal(inRegion(beyond, rail), true);
  assert.ok(beyond[2] <= 10.4 + 1e-12);
});

test('projectIntoRegion: a d = 0 point constraint pins the position exactly', () => {
  const fixed = point(0, [1, 2, 3]);
  assert.deepEqual(projectIntoRegion([50, -10, 7], fixed), [1, 2, 3]);
});

// --- Parameterization (§4.1) -------------------------------------------------

test('pointOnPrimitive: a polyline is parameterized by arc length', () => {
  // Legs of 2 m and 8 m: u = 0.5 is 5 m along, i.e. 3 m into the long leg.
  const rail = polyline(0, [
    [0, 0, 0],
    [2, 0, 0],
    [2, 0, 8],
  ]);
  assert.deepEqual(pointOnPrimitive(rail, 0, 0), [0, 0, 0]);
  assert.deepEqual(pointOnPrimitive(rail, 0.2, 0), [2, 0, 0]);
  assert.deepEqual(pointOnPrimitive(rail, 0.5, 0), [2, 0, 3]);
});

test('pointOnPrimitive: a plane spans its rectangle in (u, v)', () => {
  const wall = plane(0, [8, 4]);
  assert.deepEqual(pointOnPrimitive(wall, 0.5, 0.5), [0, 0, 0]);
  assert.deepEqual(pointOnPrimitive(wall, 0, 0), [-4, 0, -2]);
  // A point constraint ignores both parameters.
  assert.deepEqual(pointOnPrimitive(point(0, [1, 2, 3]), 0.7, 0.9), [1, 2, 3]);
});

// --- Labels & validation (§3.1, §9) ------------------------------------------

test('labels fall back to the default derived from the id', () => {
  assert.equal(defaultGroupName('cg-4'), 'Group 4');
  assert.equal(defaultConstraintName('con-12'), 'Constraint 12');
  assert.equal(groupLabel(group({ name: '  ' })), 'Group 1');
  assert.equal(groupLabel(group({ name: ' Dock ' })), 'Dock');
  assert.equal(constraintLabel({ ...point(0), name: '' }), 'Constraint 1');
});

test('constraintProblem rejects exactly what §9 says it does', () => {
  assert.equal(constraintProblem(point(0)), null);
  assert.match(constraintProblem({ ...point(-1) })!, /≥ 0/);
  assert.match(constraintProblem({ ...point(Number.NaN) })!, /finite/);
  assert.match(constraintProblem(polyline(0, [[0, 0, 0]]))!, /at least 2 vertices/);
  assert.equal(
    constraintProblem(
      polyline(0, [
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ),
    null,
  );
  assert.match(constraintProblem(plane(0, [0, 4]))!, /size components/);
  assert.equal(constraintProblem(plane(0.3, [8, 4])), null);
});

test('a new group carries only the template fields it owns (§3.1.1)', () => {
  // `aspect` and `near` are placement-wide constants, not per-group state: a
  // group that carried them would persist two values nothing can edit and the
  // capture rig would read them from two places.
  const g = defaultConstraintGroup('cg-3');
  assert.equal(g.fov, DEFAULT_TEMPLATE.fov);
  assert.equal(g.far, DEFAULT_TEMPLATE.far);
  assert.equal('aspect' in g, false);
  assert.equal('near' in g, false);
  assert.equal(groupProblem(g), null);
});

test('groupProblem rejects an unusable template or strategy', () => {
  assert.equal(groupProblem(group()), null);
  assert.match(groupProblem(group({ fov: 0 }))!, /fov/);
  assert.match(groupProblem(group({ fov: 180 }))!, /fov/);
  assert.match(groupProblem(group({ far: 0 }))!, /far/);
  assert.match(groupProblem(group({ poolSize: 0 }))!, /poolSize/);
  assert.match(groupProblem(group({ maxCount: 0 }))!, /maxCount/);
  assert.match(groupProblem(group({ trials: 0 }))!, /trials/);
  assert.match(groupProblem(group({ epsilon: -1 }))!, /epsilon/);
  assert.match(groupProblem(group({ seed: 1.5 }))!, /seed/);
});
