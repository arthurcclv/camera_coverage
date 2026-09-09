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
import {
  buildStaticGeometrySync,
  clipBandPlanes,
  forceDoubleSided,
  setGeometryClippingPlanes,
  swapGeometry,
} from '../src/scene/sceneGeometryBuild.ts';
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

// --- Clip planes are per-material now (spec §13.9) ---------------------------
//
// This replaced a `ClippingGroup`, which clipped its whole subtree from one node.
// Per-material state does **not** propagate: a mesh whose material never had the
// planes written to it simply renders uncut — no error, no wrong number, just a
// cross-section that leaves part of the model standing. These pin the two paths
// that produce materials the planes have not reached yet.

/** Every mesh material's `clippingPlanes` under a root, flattened. */
function allClippingPlanes(root: THREE.Object3D): (THREE.Plane[] | null)[] {
  const planes: (THREE.Plane[] | null)[] = [];
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) planes.push(m.clippingPlanes);
  });
  return planes;
}

const BAND = { axis: 1 as const, min: 1, max: 2 };

test('a fresh build starts unclipped', () => {
  const build = buildStaticGeometrySync(defaultGeometry());
  for (const planes of allClippingPlanes(build.group)) {
    assert.ok(planes === null || planes.length === 0, 'nothing is cut until a clip is set');
  }
});

test('setting the clip writes the planes onto every mesh material, not just the group', () => {
  const build = buildStaticGeometrySync(defaultGeometry());
  const planes = clipBandPlanes(BAND);
  setGeometryClippingPlanes(build, planes);

  const applied = allClippingPlanes(build.group);
  assert.ok(applied.length > 1, 'the default room is several meshes — the point of the test');
  for (const p of applied) {
    assert.deepEqual(p, planes, 'a material the planes never reached renders uncut');
  }
});

test('clearing the clip removes the planes from every material', () => {
  const build = buildStaticGeometrySync(defaultGeometry());
  setGeometryClippingPlanes(build, clipBandPlanes(BAND));
  setGeometryClippingPlanes(build, []);
  for (const p of allClippingPlanes(build.group)) {
    assert.deepEqual(p, [], 'an empty array reads as "not clipped" in three');
  }
});

test('a swapped-in build does not inherit the outgoing build\'s clip', () => {
  // The regression this whole test block exists for. `ClippingGroup` clipped
  // whatever was under it, so an import/reset (spec §14.4) kept cutting for free.
  // Now the incoming build's materials have never seen the planes, and it is
  // `SceneView.sync` — keyed on the room identity, not only the band — that has
  // to re-apply them. If that key is ever narrowed to the band alone, this fails.
  const scene = new THREE.Scene();
  const first = buildStaticGeometrySync(defaultGeometry());
  swapGeometry(scene, null, first);
  setGeometryClippingPlanes(first, clipBandPlanes(BAND));

  const second = buildStaticGeometrySync(defaultGeometry());
  swapGeometry(scene, first, second);
  for (const p of allClippingPlanes(second.group)) {
    assert.ok(p === null || p.length === 0, 'the incoming build is uncut until re-applied');
  }

  // ...and re-applying reaches it.
  const planes = clipBandPlanes(BAND);
  setGeometryClippingPlanes(second, planes);
  for (const p of allClippingPlanes(second.group)) assert.deepEqual(p, planes);
});
