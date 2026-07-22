/**
 * Tests for the geometry render build (spec §14.6), focused on the
 * force-double-sided invariant: every renderable mesh material — floor/box/wall
 * primitives and glTF meshes alike — must render `THREE.DoubleSide` so back-faces
 * never cull. `forceDoubleSided` is the single source of truth and is unit-tested
 * directly (glTF materials only exist after loading a real GLB); the sync build
 * path is asserted end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildStaticGeometrySync, forceDoubleSided } from '../src/scene/sceneGeometryBuild.ts';
import { defaultGeometry } from '../src/scene/buildRoom.ts';

/** Every mesh material's `side` under a root, flattened across material arrays. */
function allSides(root: THREE.Object3D): number[] {
  const sides: number[] = [];
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) sides.push(m.side);
  });
  return sides;
}

test('forceDoubleSided flips a mesh with a single material', () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ side: THREE.FrontSide }));
  forceDoubleSided(mesh);
  assert.equal((mesh.material as THREE.Material).side, THREE.DoubleSide);
});

test('forceDoubleSided flips every material of a material-array mesh', () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [
    new THREE.MeshStandardMaterial({ side: THREE.FrontSide }),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide }),
  ]);
  forceDoubleSided(mesh);
  for (const m of mesh.material as THREE.Material[]) assert.equal(m.side, THREE.DoubleSide);
});

test('forceDoubleSided descends into nested children and ignores non-mesh nodes', () => {
  const group = new THREE.Group();
  group.add(new THREE.Object3D()); // non-mesh: must be skipped, not throw
  const child = new THREE.Group();
  child.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ side: THREE.FrontSide })));
  group.add(child);
  forceDoubleSided(group);
  const sides = allSides(group);
  assert.equal(sides.length, 1);
  assert.equal(sides[0], THREE.DoubleSide);
});

test('buildStaticGeometrySync renders all primitive geometry double-sided', () => {
  const build = buildStaticGeometrySync(defaultGeometry());
  const sides = allSides(build.group);
  assert.ok(sides.length > 0, 'default geometry should produce renderable meshes');
  for (const side of sides) assert.equal(side, THREE.DoubleSide);
});
