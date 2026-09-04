/**
 * Tests for surface-hit resolution behind "Place on surface" (spec §2.4.2).
 *
 * Three parts. The clip-band rule is unit-tested directly against synthetic
 * intersections — no raycaster needed, which is why it is a pure module. Then the
 * **normal** the hit carries for `camera_placement.md` §6.2's hover plane, which
 * has two traps of its own (shading vs geometric, local vs world). Then
 * end-to-end cases that raycast the *real* default-room build, because the unit
 * tests cannot catch the two mistakes that matter most in the wiring: pointing
 * the ray at the wrong group, or omitting the recursive flag so nested meshes
 * never hit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import { surfaceHit, type SurfaceIntersection } from '../../src/scene/sceneView/surfaceHit.ts';
import { buildStaticGeometrySync } from '../../src/scene/sceneGeometryBuild.ts';
import { defaultGeometry } from '../../src/scene/buildRoom.ts';
import type { ClipBand } from '../../src/scene/sectionHeatmap.ts';

const at = (x: number, y: number, z: number): SurfaceIntersection => ({ point: { x, y, z } });
/** The hit point alone — what most of these cases are about (spec §2.4.2). */
const pointOf = (hit: { point: Vec3 } | null): Vec3 | null => (hit ? hit.point : null);

test('no intersections → null, a miss (spec §2.4.2)', () => {
  assert.equal(surfaceHit([], null), null);
  assert.equal(surfaceHit([], { axis: 1, min: 0, max: 3 }), null);
});

test('with no clip band the nearest intersection wins', () => {
  // Raycaster order is near→far, so the first entry is the nearest.
  assert.deepEqual(pointOf(surfaceHit([at(1, 2, 3), at(4, 5, 6)], null)), [1, 2, 3]);
});

test('the raw point is returned, with no normal offset (spec §2.4.2)', () => {
  assert.deepEqual(pointOf(surfaceHit([at(-0.5, 0, 7.25)], null)), [-0.5, 0, 7.25]);
});

test('a clip band discards hits outside it and takes the nearest survivor (spec §13.9)', () => {
  const band: ClipBand = { axis: 1, min: 1, max: 3 };
  // First hit is above the band, second inside it: the second is placed on.
  assert.deepEqual(pointOf(surfaceHit([at(0, 5, 0), at(0, 2, 0), at(0, 1.5, 0)], band)), [0, 2, 0]);
});

test('a ray whose every hit is clipped away is a miss, not a fallback (spec §2.4.2)', () => {
  const band: ClipBand = { axis: 1, min: 1, max: 3 };
  assert.equal(surfaceHit([at(0, 5, 0), at(0, 0.5, 0)], band), null);
});

test('the clip band is inclusive of both bounds', () => {
  const band: ClipBand = { axis: 1, min: 1, max: 3 };
  assert.deepEqual(pointOf(surfaceHit([at(0, 3, 0)], band)), [0, 3, 0]);
  assert.deepEqual(pointOf(surfaceHit([at(0, 1, 0)], band)), [0, 1, 0]);
});

test('only the band axis is tested — other axes are unconstrained', () => {
  const band: ClipBand = { axis: 0, min: -1, max: 1 };
  // Wildly out of range on Y and Z, but in-band on X: eligible.
  assert.deepEqual(pointOf(surfaceHit([at(0.5, 99, -99)], band)), [0.5, 99, -99]);
  // In range on Y and Z, out of band on X: rejected.
  assert.equal(surfaceHit([at(5, 0, 0)], band), null);
});

test('the band axis can be Z as well as X/Y', () => {
  const band: ClipBand = { axis: 2, min: -2, max: 2 };
  assert.deepEqual(pointOf(surfaceHit([at(0, 0, 8), at(0, 0, 1)], band)), [0, 0, 1]);
});

// --- the normal the hover plane is seeded from (`camera_placement.md` §6.2) ---

test('a hit with no face carries no normal — the tool that only places is unaffected', () => {
  assert.equal(surfaceHit([at(1, 2, 3)], null)!.normal, null);
});

test('with no object transform the face normal passes through as world space', () => {
  // Room and box primitives are built world-space with identity transforms, so
  // their local face normals are already the world ones.
  const hit = surfaceHit([{ ...at(0, 0, 0), face: { normal: { x: 0, y: 1, z: 0 } } }], null);
  assert.deepEqual(hit!.normal, [0, 1, 0]);
});

test('a rotated object pushes its face normal into world space (the glTF case)', () => {
  // A glTF object carries its own transform (`sceneGeometryBuild.ts`), so a local
  // +Y normal under a 90° rotation about Z is world -X. Leaving the normal in
  // local space would plant the hover plane on the wrong surface entirely.
  const object = new THREE.Object3D();
  object.rotation.set(0, 0, Math.PI / 2);
  object.updateMatrixWorld(true);
  const hit = surfaceHit([{ ...at(0, 0, 0), face: { normal: { x: 0, y: 1, z: 0 } }, object }], null);
  const n = hit!.normal!;
  assert.ok(Math.abs(n[0] - -1) < 1e-9 && Math.abs(n[1]) < 1e-9 && Math.abs(n[2]) < 1e-9, `${n} ≈ [-1,0,0]`);
});

test('a non-uniform scale still yields a unit normal, and the right one', () => {
  // The inverse-transpose matters here: scaling a plane's normal by the object
  // matrix directly would tilt it. A 45° face under a 1:4 X-scale must stay
  // perpendicular to the scaled surface, and must come back normalized.
  const object = new THREE.Object3D();
  object.scale.set(1, 4, 1);
  object.updateMatrixWorld(true);
  const s = Math.SQRT1_2;
  const hit = surfaceHit([{ ...at(0, 0, 0), face: { normal: { x: s, y: s, z: 0 } }, object }], null);
  const n = hit!.normal!;
  assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-9, `unit length, got ${Math.hypot(...n)}`);
  // Normal (1,1,0) under scale (1,4,1) → inverse-transpose gives (1, 1/4, 0).
  assert.ok(Math.abs(n[0] / n[1] - 4) < 1e-9, `x:y ratio 4, got ${n[0] / n[1]}`);
});

test('the normal comes from the same intersection the clip band selected', () => {
  const band: ClipBand = { axis: 1, min: 1, max: 3 };
  const hit = surfaceHit(
    [
      { ...at(0, 5, 0), face: { normal: { x: 1, y: 0, z: 0 } } },
      { ...at(0, 2, 0), face: { normal: { x: 0, y: 0, z: 1 } } },
    ],
    band,
  );
  assert.deepEqual(hit!.point, [0, 2, 0]);
  assert.deepEqual(hit!.normal, [0, 0, 1]);
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
  assert.deepEqual([floor.point[0], floor.point[2]], [0, 0]);
  assert.ok(Math.abs(floor.point[1]) < 1e-6, `floor y ${floor.point[1]} ≈ 0`);

  // Straight down over the first box obstacle (min [-7,0,-7], max [-4,2.5,-4]):
  // the box top wins over the floor beneath it, proving nearest-hit ordering
  // holds through a real raycast and that box meshes are inside the group.
  raycaster.set(new THREE.Vector3(-5.5, 5, -5.5), down);
  const box = surfaceHit(raycaster.intersectObject(build.group, true), null);
  assert.ok(box, 'expected a box hit');
  assert.ok(Math.abs(box.point[1] - 2.5) < 1e-6, `box top y ${box.point[1]} ≈ 2.5`);
});

test('a real ray at a wall lands on the inner face, and the clip band can reject it', () => {
  const build = buildStaticGeometrySync(defaultGeometry());
  const raycaster = new THREE.Raycaster();
  // Due east from the room centre: the east wall's inner face sits at x = +10.
  raycaster.set(new THREE.Vector3(0, 2, 0), new THREE.Vector3(1, 0, 0));
  const intersections = raycaster.intersectObject(build.group, true);

  const wall = surfaceHit(intersections, null);
  assert.ok(wall, 'expected a wall hit');
  assert.ok(Math.abs(wall.point[0] - 10) < 1e-6, `wall x ${wall.point[0]} ≈ 10`);

  // A clip band that hides the wall makes the same ray a miss: what cannot be
  // seen cannot be placed on (spec §2.4.2).
  assert.equal(surfaceHit(intersections, { axis: 0, min: -5, max: 5 }), null);
});

test("a real ray's normal is the geometric face's, not a smoothed vertex average (§6.2)", () => {
  // The trap this pins: `meshFromTris` runs `computeVertexNormals()` over indexed
  // geometry, so at a box corner the *shading* normal (`Intersection.normal`) is
  // the average of the meeting faces and is perpendicular to none of them. The
  // hover plane needs the flat face, so the resolution must read `face.normal`.
  const build = buildStaticGeometrySync(defaultGeometry());
  const raycaster = new THREE.Raycaster();

  // Straight down onto the floor: the face is horizontal, so the normal is ±Y.
  raycaster.set(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0));
  const floor = surfaceHit(raycaster.intersectObject(build.group, true), null);
  const fn = floor!.normal!;
  assert.ok(Math.abs(Math.abs(fn[1]) - 1) < 1e-6, `floor normal ${fn} is vertical`);

  // Hard against the top edge of a box, where the top and side faces meet and an
  // averaged vertex normal would come back diagonal. Sampled just inside the top
  // face (box 1 spans x -7..-4, z -7..-4, top y = 2.5).
  raycaster.set(new THREE.Vector3(-4.001, 5, -4.001), new THREE.Vector3(0, -1, 0));
  const edge = surfaceHit(raycaster.intersectObject(build.group, true), null);
  const en = edge!.normal!;
  assert.ok(Math.abs(en[1] - 1) < 1e-6, `box top normal ${en} is +Y, not a corner average`);
  assert.ok(Math.abs(en[0]) < 1e-6 && Math.abs(en[2]) < 1e-6, `box top normal ${en} has no lateral tilt`);
});
