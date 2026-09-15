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
  positionFromNode,
  rebuildWithTransforms,
  clipBandPlanes,
  forceDoubleSided,
  setGeometryClippingPlanes,
  swapGeometry,
} from '../src/scene/sceneGeometryBuild.ts';
import { defaultGeometry } from '../src/scene/buildRoom.ts';
import { identityTransform, type GeometryObject } from '../src/scene/geometryModel.ts';

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

// --- editable geometry (`geometry_assets.md` §4.1, §4.3, §5.1, §5.3) ---------

function box(id: string, enabled = true, position: [number, number, number] = [0, 0, 0]): GeometryObject {
  return { kind: 'box', id, name: '', enabled, min: [0, 0, 0], max: [1, 1, 1], ...identityTransform(), position };
}

test('a disabled object contributes no triangles and no bounds, and is not drawn (§5.1)', () => {
  // The checkbox is membership, not visibility: an unticked rack must stop
  // blocking cameras, which is the whole point of asking "what if it weren't
  // here?".
  const build = buildStaticGeometrySync([box('geom-1'), box('geom-2', false, [50, 0, 0])]);
  // The disabled box sits at x=50; neither the bounds nor the mesh may reach it.
  assert.ok(build.worldMax[0] < 10);
  const xs = Array.from(build.sceneMesh.positions).filter((_, i) => i % 3 === 0);
  assert.ok(Math.max(...xs) < 10);
  // It keeps an invisible node, so its gizmo still attaches and it can be moved
  // into place before being switched back on.
  const node = build.objectNodes.get('geom-2');
  assert.ok(node);
  assert.equal(node.visible, false);
  assert.equal(build.objectNodes.get('geom-1')!.visible, true);
});

test('each object gets one render node, pivoted on its geometric centre (§4.1, §7)', () => {
  // The node is what TransformControls attaches to, so the transform rides on it
  // rather than being baked into the vertices — and it sits at the object's
  // **centre**, not its frame origin, or the gizmo for a default box (local
  // min/max at position [0,0,0]) would appear at the world origin.
  const build = buildStaticGeometrySync([box('geom-1', true, [2, 0, 3])]);
  const node = build.objectNodes.get('geom-1');
  assert.ok(node);
  // The unit box spans 0..1 on each axis, so its centre is +0.5 from the origin.
  assert.deepEqual([node.position.x, node.position.y, node.position.z], [2.5, 0.5, 3.5]);
  // …and the object's own position comes back out of it unchanged.
  assert.deepEqual(positionFromNode(node), [2, 0, 3]);
  assert.equal(node.parent, build.group);
});

test('the pivot offset round-trips under rotation and non-uniform scale (§7)', () => {
  // The two directions share `pivotOffset`, so a rotated, squashed object still
  // reports the position the panel shows.
  const rotated: GeometryObject = {
    ...box('geom-1', true, [1, 2, 3]),
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    scale: [3, 1, 2],
  };
  const build = buildStaticGeometrySync([rotated]);
  const node = build.objectNodes.get('geom-1')!;
  const back = positionFromNode(node);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - rotated.position[i]) < 1e-6, `axis ${i}`);
});

test('the collision mesh still bakes the transform into world space (spec §14.6)', () => {
  const build = buildStaticGeometrySync([box('geom-1', true, [10, 0, 0])]);
  const xs = Array.from(build.sceneMesh.positions).filter((_, i) => i % 3 === 0);
  assert.ok(Math.min(...xs) >= 10);
});

test('the merged mesh is computed on first read and memoized (§4.3)', () => {
  // A geometry edit rebuilds the render group immediately but must not re-merge
  // every triangle in the scene — that wait is what keeps a gizmo drag smooth on
  // a site model.
  const build = buildStaticGeometrySync([box('geom-1')]);
  assert.equal(build.sceneMesh, build.sceneMesh);
});

test('an empty geometry list builds an empty, finite workspace (§5.3)', () => {
  // Legal: a layout of cameras aimed at a splat capture needs no triangles. The
  // fallback box exists only so the viewport has something to frame; `runBlocker`
  // is what refuses to measure against it.
  const build = buildStaticGeometrySync([]);
  assert.equal(build.isEmpty, true);
  assert.equal(build.sceneMesh.positions.length, 0);
  assert.equal(build.worldMin.every(Number.isFinite), true);
  assert.equal(build.worldMax.every(Number.isFinite), true);
  const disabledOnly = buildStaticGeometrySync([box('geom-1', false)]);
  assert.equal(disabledOnly.isEmpty, true);
});

test('the default scene is not empty, and every object has a node', () => {
  const geometry = defaultGeometry();
  const build = buildStaticGeometrySync(geometry);
  assert.equal(build.isEmpty, false);
  assert.deepEqual([...build.objectNodes.keys()], geometry.map((o) => o.id));
});

test('a transform-only edit reuses the scene graph and re-bakes the collision mesh (§4.3)', () => {
  // `objectChange` fires per frame during a gizmo drag, so a rebuild that
  // replaced the nodes would dispose the very node under the gizmo and the drag
  // would die on its first pixel. The build identity is still new, so the engine
  // re-inits at the next run.
  const before = buildStaticGeometrySync([box('geom-1'), box('geom-2')]);
  const node = before.objectNodes.get('geom-1')!;
  const moved = rebuildWithTransforms(before, [box('geom-1', true, [10, 0, 0]), box('geom-2')])!;

  assert.ok(moved);
  assert.notEqual(moved, before); // new identity → the next run re-inits
  assert.equal(moved.group, before.group); // same scene graph → the drag survives
  assert.equal(moved.objectNodes.get('geom-1'), node);
  assert.deepEqual(positionFromNode(node), [10, 0, 0]);
  // The collision mesh follows the transform, not the node.
  const xs = Array.from(moved.sceneMesh.positions).filter((_, i) => i % 3 === 0);
  assert.ok(Math.max(...xs) >= 10);
  assert.ok(moved.worldMax[0] >= 10);
});

test('swapGeometry leaves a reused scene graph alone (§4.3)', () => {
  const scene = new THREE.Group();
  const before = buildStaticGeometrySync([box('geom-1')]);
  swapGeometry(scene, null, before);
  const moved = rebuildWithTransforms(before, [box('geom-1', true, [1, 0, 0])])!;
  swapGeometry(scene, before, moved);
  // Still attached, still alive: nothing was detached and nothing disposed.
  assert.equal(scene.children.includes(moved.group), true);
  assert.equal(scene.children.length, 1);
});

test('a structural change refuses the reuse path and asks for a full rebuild (§4.3)', () => {
  const before = buildStaticGeometrySync([box('geom-1')]);
  assert.equal(rebuildWithTransforms(before, []), null); // deleted
  assert.equal(rebuildWithTransforms(before, [box('geom-1'), box('geom-2')]), null); // added
  assert.equal(rebuildWithTransforms(before, [box('geom-2')]), null); // different object
});

test('toggling the checkbox takes the full rebuild path, not the reuse one (§5.1)', () => {
  // Unticking changes what is in the scene, and re-ticking a mesh has to re-read
  // an asset the disabled build never loaded — so it is structural, not a
  // transform.
  const before = buildStaticGeometrySync([box('geom-1')]);
  assert.equal(rebuildWithTransforms(before, [box('geom-1', false)]), null);
  const off = buildStaticGeometrySync([box('geom-1', false)]);
  assert.equal(off.isEmpty, true);
  assert.equal(off.objectNodes.get('geom-1')!.visible, false);
});
