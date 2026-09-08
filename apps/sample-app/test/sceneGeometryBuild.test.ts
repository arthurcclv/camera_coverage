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
import { buildStaticGeometrySync, forceDoubleSided, swapGeometry } from '../src/scene/sceneGeometryBuild.ts';
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

// --- Geometry swap ordering (spec §14.4) -------------------------------------
// `swapGeometry` exists for its *order*: detach, then dispose, then attach. A
// build disposed while still parented leaves the animation loop drawing released
// GPU resources — `useEffect` runs after paint, so that frame is guaranteed — and
// under a clip band the renderer draws garbage rather than nothing. These pin the
// order itself, not just the end state, since the end state is identical either
// way.

/** Records each mesh's `parent` at the instant its geometry is disposed. */
function parentsAtDisposal(build: ReturnType<typeof buildStaticGeometrySync>): (THREE.Object3D | null)[] {
  const seen: (THREE.Object3D | null)[] = [];
  build.group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const real = obj.geometry.dispose.bind(obj.geometry);
    obj.geometry.dispose = () => {
      // The group, not the mesh: `swapGeometry` detaches the group as a whole.
      seen.push(build.group.parent);
      real();
    };
  });
  return seen;
}

test('swapGeometry detaches the outgoing build before disposing it (spec §14.4)', () => {
  const scene = new THREE.Scene();
  const outgoing = buildStaticGeometrySync(defaultGeometry());
  const incoming = buildStaticGeometrySync(defaultGeometry());
  scene.add(outgoing.group);

  const parents = parentsAtDisposal(outgoing);
  swapGeometry(scene, outgoing, incoming);

  assert.ok(parents.length > 0, 'the outgoing build should have meshes to dispose');
  // The regression: every disposal must happen with the group already detached.
  for (const parent of parents) {
    assert.equal(parent, null, 'disposed a mesh while its group was still in the scene');
  }
});

test('swapGeometry leaves only the incoming build in the scene (spec §14.4)', () => {
  const scene = new THREE.Scene();
  const outgoing = buildStaticGeometrySync(defaultGeometry());
  const incoming = buildStaticGeometrySync(defaultGeometry());
  scene.add(outgoing.group);
  swapGeometry(scene, outgoing, incoming);

  assert.equal(outgoing.group.parent, null);
  assert.equal(incoming.group.parent, scene);
  assert.equal(scene.children.filter((c) => c === outgoing.group).length, 0, 'no ghost of the outgoing build');
  assert.equal(scene.children.filter((c) => c === incoming.group).length, 1);
});

test('the first swap has nothing to detach and simply attaches (spec §14.4)', () => {
  const scene = new THREE.Scene();
  const first = buildStaticGeometrySync(defaultGeometry());
  swapGeometry(scene, null, first);
  assert.equal(first.group.parent, scene);
});
