/**
 * Tests for surface-hit resolution behind "Place on surface" (spec §2.4.2).
 *
 * Two halves. The clip-band rule is unit-tested directly against synthetic
 * intersections — no raycaster needed, which is why it is a pure module. Then one
 * end-to-end case raycasts the *real* default-room build, because the unit tests
 * cannot catch the two mistakes that matter most in the wiring: pointing the ray
 * at the wrong group, or omitting the recursive flag so nested meshes never hit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { surfaceHit, type SurfaceIntersection } from '../../src/scene/sceneView/surfaceHit.ts';
import { buildStaticGeometrySync } from '../../src/scene/sceneGeometryBuild.ts';
import { defaultGeometry } from '../../src/scene/buildRoom.ts';
import type { ClipBand } from '../../src/scene/sectionHeatmap.ts';

const at = (x: number, y: number, z: number): SurfaceIntersection => ({ point: { x, y, z } });

test('no intersections → null, a miss (spec §2.4.2)', () => {
  assert.equal(surfaceHit([], null), null);
  assert.equal(surfaceHit([], { axis: 1, min: 0, max: 3 }), null);
});

test('with no clip band the nearest intersection wins', () => {
  // Raycaster order is near→far, so the first entry is the nearest.
  assert.deepEqual(surfaceHit([at(1, 2, 3), at(4, 5, 6)], null), [1, 2, 3]);
});

test('the raw point is returned, with no normal offset (spec §2.4.2)', () => {
  assert.deepEqual(surfaceHit([at(-0.5, 0, 7.25)], null), [-0.5, 0, 7.25]);
});

test('a clip band discards hits outside it and takes the nearest survivor (spec §13.9)', () => {
  const band: ClipBand = { axis: 1, min: 1, max: 3 };
  // First hit is above the band, second inside it: the second is placed on.
  assert.deepEqual(surfaceHit([at(0, 5, 0), at(0, 2, 0), at(0, 1.5, 0)], band), [0, 2, 0]);
});

test('a ray whose every hit is clipped away is a miss, not a fallback (spec §2.4.2)', () => {
  const band: ClipBand = { axis: 1, min: 1, max: 3 };
  assert.equal(surfaceHit([at(0, 5, 0), at(0, 0.5, 0)], band), null);
});

test('the clip band is inclusive of both bounds', () => {
  const band: ClipBand = { axis: 1, min: 1, max: 3 };
  assert.deepEqual(surfaceHit([at(0, 3, 0)], band), [0, 3, 0]);
  assert.deepEqual(surfaceHit([at(0, 1, 0)], band), [0, 1, 0]);
});

test('only the band axis is tested — other axes are unconstrained', () => {
  const band: ClipBand = { axis: 0, min: -1, max: 1 };
  // Wildly out of range on Y and Z, but in-band on X: eligible.
  assert.deepEqual(surfaceHit([at(0.5, 99, -99)], band), [0.5, 99, -99]);
  // In range on Y and Z, out of band on X: rejected.
  assert.equal(surfaceHit([at(5, 0, 0)], band), null);
});

test('the band axis can be Z as well as X/Y', () => {
  const band: ClipBand = { axis: 2, min: -2, max: 2 };
  assert.deepEqual(surfaceHit([at(0, 0, 8), at(0, 0, 1)], band), [0, 0, 1]);
});

// --- end-to-end against the real default room (spec §4.1, §14.6) -------------

test('a real ray into the default room resolves to the floor and to a box top', () => {
  const build = buildStaticGeometrySync(defaultGeometry());
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  // Straight down over open floor: the floor slab's top face is at y = 0.
  raycaster.set(new THREE.Vector3(0, 5, 0), down);
  const floor = surfaceHit(raycaster.intersectObject(build.group, true), null);
  assert.ok(floor, 'expected a floor hit');
  assert.deepEqual([floor[0], floor[2]], [0, 0]);
  assert.ok(Math.abs(floor[1]) < 1e-6, `floor y ${floor[1]} ≈ 0`);

  // Straight down over the first box obstacle (min [-7,0,-7], max [-4,2.5,-4]):
  // the box top wins over the floor beneath it, proving nearest-hit ordering
  // holds through a real raycast and that box meshes are inside the group.
  raycaster.set(new THREE.Vector3(-5.5, 5, -5.5), down);
  const box = surfaceHit(raycaster.intersectObject(build.group, true), null);
  assert.ok(box, 'expected a box hit');
  assert.ok(Math.abs(box[1] - 2.5) < 1e-6, `box top y ${box[1]} ≈ 2.5`);
});

test('a real ray at a wall lands on the inner face, and the clip band can reject it', () => {
  const build = buildStaticGeometrySync(defaultGeometry());
  const raycaster = new THREE.Raycaster();
  // Due east from the room centre: the east wall's inner face sits at x = +10.
  raycaster.set(new THREE.Vector3(0, 2, 0), new THREE.Vector3(1, 0, 0));
  const intersections = raycaster.intersectObject(build.group, true);

  const wall = surfaceHit(intersections, null);
  assert.ok(wall, 'expected a wall hit');
  assert.ok(Math.abs(wall[0] - 10) < 1e-6, `wall x ${wall[0]} ≈ 10`);

  // A clip band that hides the wall makes the same ray a miss: what cannot be
  // seen cannot be placed on (spec §2.4.2).
  assert.equal(surfaceHit(intersections, { axis: 0, min: -5, max: 5 }), null);
});
