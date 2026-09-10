import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SceneMesh, Vec3 } from '@linkervision/camera-coverage-sdk';

import { Quaternion, Vector3 } from 'three';

import { eulerToQuat } from '../src/cameras/math.ts';
import { cameraForward, centerRayHits, nearestHit } from '../src/cameras/centerRay.ts';

/** A single triangle from three corners. */
function tri(a: Vec3, b: Vec3, c: Vec3): SceneMesh {
  return { positions: new Float32Array([...a, ...b, ...c]), indices: new Uint32Array([0, 1, 2]) };
}

/**
 * An XY-plane wall at `z`, spanning ±10 in x and y — two triangles, wound so its
 * front faces +z.
 */
function wall(z: number): SceneMesh {
  return {
    positions: new Float32Array([-10, -10, z, 10, -10, z, 10, 10, z, -10, 10, z]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

/** Merge meshes into one soup, as `sceneGeometryBuild` does for the real scene. */
function merge(...meshes: SceneMesh[]): SceneMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of meshes) {
    const base = positions.length / 3;
    positions.push(...m.positions);
    for (const i of m.indices) indices.push(base + i);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function near(actual: Vec3 | null, expected: Vec3, tol = 1e-6): void {
  assert.ok(actual !== null, 'expected a hit');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) < tol, `${actual} ≉ ${expected}`);
}

test('forward is the quaternion applied to (0, 0, -1) (§5.1, §15.3)', () => {
  near(cameraForward([0, 0, 0, 1]), [0, 0, -1]);
  // A half turn about Y looks down +Z.
  near(cameraForward(eulerToQuat({ yaw: 180, pitch: 0, roll: 0 })), [0, 0, 1]);
  // The convention `cameras/math.ts` documents: yaw -90 looks down +X.
  near(cameraForward(eulerToQuat({ yaw: -90, pitch: 0, roll: 0 })), [1, 0, 0]);
  // Pitch -90 looks straight down.
  near(cameraForward(eulerToQuat({ yaw: 0, pitch: -90, roll: 0 })), [0, -1, 0]);
});

test("forward matches three's own applyQuaternion, for any orientation (§15.3)", () => {
  // The formula is hand-rolled so the worker carries no Three.js (§15.3). This is
  // what makes that safe: the same answer as the library, across orientations
  // including pitch and roll together, where a sign slip would otherwise hide.
  for (const pose of [
    { yaw: 0, pitch: 0, roll: 0 },
    { yaw: 37, pitch: -12, roll: 5 },
    { yaw: -143, pitch: 68, roll: -80 },
    { yaw: 180, pitch: -89, roll: 0 },
  ]) {
    const q = eulerToQuat(pose);
    const expected = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...q));
    near(cameraForward(q), [expected.x, expected.y, expected.z], 1e-9);
  }
});

test('forward is normalized even from a drifted quaternion (§15.3)', () => {
  // Repeated gizmo drags leave a quaternion slightly off unit length.
  const drifted = cameraForward([0, 0.7071 * 1.01, 0, 0.7071 * 1.01]);
  assert.ok(Math.abs(Math.hypot(...drifted) - 1) < 1e-9);
});

test('the nearest hit wins (§15.3)', () => {
  const mesh = merge(wall(-5), wall(-2), wall(-9));
  near(nearestHit(mesh, [0, 0, 0], [0, 0, -1]), [0, 0, -2]);
});

test('a ray pointing away from everything misses (§15.3)', () => {
  assert.equal(nearestHit(wall(-5), [0, 0, 0], [0, 0, 1]), null);
  // The room's open top: aimed straight up, nothing above.
  assert.equal(nearestHit(wall(-5), [0, 0, 0], [0, 1, 0]), null);
});

test('a mesh with no triangles misses everything — a splat-only scene (§15.3)', () => {
  const empty: SceneMesh = { positions: new Float32Array(), indices: new Uint32Array() };
  assert.equal(nearestHit(empty, [0, 0, 0], [0, 0, -1]), null);
});

test('backfaces are hit — geometry is double-sided (§14.6, §15.3)', () => {
  // The wall's winding faces +z; this ray arrives from -z, hitting its back. A
  // culled implementation would report a miss and the camera would look like it
  // faces open space.
  near(nearestHit(wall(0), [0, 0, -5], [0, 0, 1]), [0, 0, 0]);
});

test('a camera buried in geometry reports where its ray stops (§11, §15.3)', () => {
  // `CAMERA_INSIDE_GEOMETRY`: the origin sits between two faces of a solid. The
  // hit is the inside of the far one, not `null` and not the surface behind it.
  const mesh = merge(wall(-1), wall(1));
  near(nearestHit(mesh, [0, 0, 0], [0, 0, -1]), [0, 0, -1]);
});

test('the ray is unbounded — no `near`, no `far` (§15.3)', () => {
  // A wall 800 m out, well past any camera's default 50 m detection range: `far`
  // bounds coverage, never this ray.
  near(nearestHit(wall(-800), [0, 0, 0], [0, 0, -1]), [0, 0, -800]);
});

test('a surface at the ray origin is not its own hit (§15.3)', () => {
  // A camera mounted flush on a wall must see past it, not report itself.
  const mesh = merge(wall(0), wall(-4));
  near(nearestHit(mesh, [0, 0, 0], [0, 0, -1]), [0, 0, -4]);
});

test('a ray parallel to a triangle plane misses it (§15.3)', () => {
  assert.equal(nearestHit(wall(-5), [0, 0, -5], [1, 0, 0]), null);
});

test('a ray missing a triangle sideways is not a hit (§15.3)', () => {
  const small = tri([0, 0, -5], [1, 0, -5], [0, 1, -5]);
  near(nearestHit(small, [0.1, 0.1, 0], [0, 0, -1]), [0.1, 0.1, -5]);
  // Outside the triangle, still inside its plane's bounding square.
  assert.equal(nearestHit(small, [0.9, 0.9, 0], [0, 0, -1]), null);
});

test('centerRayHits answers per pose, in order, null for a miss (§15.3)', () => {
  const mesh = wall(-5);
  const hits = centerRayHits(mesh, [
    { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, // looks -Z, hits
    { position: [0, 0, 0], rotation: eulerToQuat({ yaw: 180, pitch: 0, roll: 0 }) }, // looks +Z, misses
    { position: [3, 2, 0], rotation: [0, 0, 0, 1] },
  ]);
  assert.equal(hits.length, 3);
  near(hits[0], [0, 0, -5]);
  assert.equal(hits[1], null);
  near(hits[2], [3, 2, -5]);
});
