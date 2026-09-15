import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  basename,
  boxTris,
  centerOfTris,
  computeAabb,
  computeWorkspaceBounds,
  geometryLabel,
  geometryLabels,
  identityTransform,
  isMeshFileName,
  mergeTris,
  pivotOffset,
  roomTris,
  transformTriMesh,
  type GeometryObject,
  type TriMesh,
} from '../src/scene/geometryModel.ts';
import { ROOM_HALF_X, ROOM_HALF_Z, ROOM_HEIGHT, WALL_THICKNESS } from '../src/scene/buildRoom.ts';

/** Float32-precision-safe vector comparison. */
function assertVec3Close(actual: readonly number[], expected: readonly number[], eps = 1e-4) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < eps, `index ${i}: ${actual[i]} !~ ${expected[i]}`);
  }
}

test('boxTris produces 6 faces of 4 verts / 2 tris each', () => {
  const box = boxTris([0, 0, 0], [1, 1, 1]);
  assert.equal(box.positions.length, 6 * 4 * 3);
  assert.equal(box.indices.length, 6 * 6);
});

test('mergeTris concatenates positions and offsets indices by running vertex count', () => {
  const a = boxTris([0, 0, 0], [1, 1, 1]);
  const b = boxTris([2, 0, 0], [3, 1, 1]);
  const merged = mergeTris([a, b]);
  assert.equal(merged.positions.length, a.positions.length + b.positions.length);
  assert.equal(merged.indices.length, a.indices.length + b.indices.length);
  const bVertexCount = b.positions.length / 3;
  const aVertexCount = a.positions.length / 3;
  // Every index from b's piece is offset by a's vertex count.
  for (let i = 0; i < b.indices.length; i++) {
    assert.equal(merged.indices[a.indices.length + i], b.indices[i] + aVertexCount);
  }
  assert.ok(Math.max(...merged.indices) < aVertexCount + bVertexCount);
});

test('roomTris builds floor + 4 walls, open top', () => {
  const pieces = roomTris(10, 10, 6, 0.3);
  assert.equal(pieces.length, 5);
  const merged = mergeTris(pieces);
  const aabb = computeAabb(merged);
  assertVec3Close(aabb.min, [-10.3, -0.3, -10.3]);
  assertVec3Close(aabb.max, [10.3, 6, 10.3]);
});

test('transformTriMesh translates a point', () => {
  const box = boxTris([0, 0, 0], [1, 1, 1]);
  const moved = transformTriMesh(box, [5, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  const aabb = computeAabb(moved);
  assertVec3Close(aabb.min, [5, 0, 0]);
  assertVec3Close(aabb.max, [6, 1, 1]);
});

test('transformTriMesh scales before rotating/translating', () => {
  const box = boxTris([0, 0, 0], [1, 1, 1]);
  const scaled = transformTriMesh(box, [0, 0, 0], [0, 0, 0, 1], [2, 1, 1]);
  const aabb = computeAabb(scaled);
  assertVec3Close(aabb.min, [0, 0, 0]);
  assertVec3Close(aabb.max, [2, 1, 1]);
});

test('transformTriMesh matches three.js Vector3/Quaternion math, vertex-by-vertex', () => {
  const box = boxTris([-1, -0.5, 2], [3, 1.5, 4]);
  const position: [number, number, number] = [5, -2, 1];
  // 37° about Y, 12° about X, composed as three.js would (quaternion product).
  const q = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler((12 * Math.PI) / 180, (37 * Math.PI) / 180, 0, 'YXZ'));
  const rotation: [number, number, number, number] = [q.x, q.y, q.z, q.w];
  const scale: [number, number, number] = [2, 0.5, 1.5];

  const transformed = transformTriMesh(box, position, rotation, scale);

  for (let i = 0; i < box.positions.length; i += 3) {
    const v = new THREE.Vector3(box.positions[i], box.positions[i + 1], box.positions[i + 2]);
    v.multiply(new THREE.Vector3(...scale)).applyQuaternion(q).add(new THREE.Vector3(...position));
    assertVec3Close(
      [transformed.positions[i], transformed.positions[i + 1], transformed.positions[i + 2]],
      [v.x, v.y, v.z],
    );
  }
});

test('computeWorkspaceBounds reproduces the default room+obstacles workspace AABB (spec §4.2, §14.6)', () => {
  const roomPieces = roomTris(ROOM_HALF_X, ROOM_HALF_Z, ROOM_HEIGHT, WALL_THICKNESS);
  const boxes = [
    boxTris([-7, 0, -7], [-4, 2.5, -4]),
    boxTris([3, 0, -8], [6, 4, -5]),
    boxTris([-2, 0, 1], [1, 1.8, 4]),
    boxTris([4, 0, 3], [7, 3, 6]),
    boxTris([-8, 0, 4], [-5.5, 3.5, 6.5]),
  ];
  const merged = mergeTris([...roomPieces, ...boxes]);
  const { worldMin, worldMax } = computeWorkspaceBounds(merged);
  // Matches the app's former hardcoded WORKSPACE_MIN/WORKSPACE_MAX constants:
  // room footprint (half extents + wall thickness) + a flat 0.5 m margin.
  assertVec3Close(worldMin, [-10.8, -0.8, -10.8]);
  assertVec3Close(worldMax, [10.8, 6.5, 10.8]);
});

test('computeAabb reports no bounds for an empty mesh (`geometry_assets.md` §5.3)', () => {
  // Reachable now that geometry is authored in the app: deleting or unticking
  // the last object leaves nothing to bound. A legal scene — cameras aimed at a
  // capture need no triangles — so it reports null rather than throwing, and the
  // Run gate is what refuses to measure against nothing.
  assert.equal(computeAabb({ positions: new Float32Array(0), indices: new Uint32Array(0) }), null);
});

// --- labels (`geometry_assets.md` §2.4) ---------------------------------------

function obj(kind: 'room' | 'box' | 'mesh', id: string, name = '', src = 'assets/rack.obj'): GeometryObject {
  const base = { id, name, enabled: true, ...identityTransform() };
  if (kind === 'room') return { ...base, kind, halfX: 1, halfZ: 1, height: 1, thickness: 0.1 };
  if (kind === 'box') return { ...base, kind, min: [0, 0, 0], max: [1, 1, 1] };
  return { ...base, kind, src };
}

test('a mesh row falls back to its file basename, never an ordinal (§2.4)', () => {
  // The splat rule, for the splat reason: an asset-backed object's identity is
  // its file, so two unnamed rows on two files stay distinguishable.
  assert.equal(geometryLabel(obj('mesh', 'geom-1', '', 'assets/site/rack.obj'), 1), 'rack.obj');
  assert.equal(geometryLabel(obj('mesh', 'geom-2', '  ', 'assets/shelf.glb'), 2), 'shelf.glb');
});

test('a named object shows its own name, whatever its kind (§2.4)', () => {
  assert.equal(geometryLabel(obj('mesh', 'geom-1', ' Rack row A '), 1), 'Rack row A');
  assert.equal(geometryLabel(obj('box', 'geom-2', 'Pallet'), 2), 'Pallet');
});

test('a primitive falls back to an ordinal within its own kind (§2.4)', () => {
  // `Geometry 4` would say nothing about what the row is; the kinds are visually
  // distinct, so they number separately.
  const labels = geometryLabels([
    obj('room', 'geom-1'),
    obj('box', 'geom-2'),
    obj('box', 'geom-3'),
    obj('mesh', 'geom-4', '', 'assets/rack.obj'),
    obj('box', 'geom-5'),
  ]);
  assert.deepEqual(labels, ['Room 1', 'Box 1', 'Box 2', 'rack.obj', 'Box 3']);
});

test('basename handles nested and bare srcs alike', () => {
  assert.equal(basename('assets/site/level-1/rack.obj'), 'rack.obj');
  assert.equal(basename('rack.obj'), 'rack.obj');
});

test('isMeshFileName accepts the four formats, case-insensitively, and nothing else (§3.1)', () => {
  for (const name of ['a.glb', 'a.gltf', 'a.ply', 'a.obj', 'A.GLB', 'a.OBJ']) {
    assert.equal(isMeshFileName(name), true, name);
  }
  // A dependency is reached through the file that references it, never picked
  // directly (§3.1) — and a bare extension is a file called ".obj", not a model.
  for (const name of ['a.mtl', 'a.bin', 'a.png', 'a.spz', 'scene.json', '.obj']) {
    assert.equal(isMeshFileName(name), false, name);
  }
});

test('transformTriMesh composes a non-uniform scale with a rotation (§7)', () => {
  // Geometry is the one entity that can carry a non-uniform scale, so the order
  // (scale in the object's own frame, then rotate) has to be pinned.
  const tri: TriMesh = { positions: new Float32Array([1, 0, 0]), indices: new Uint32Array([0]) };
  // 90° about Y maps +X to −Z.
  const q: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const out = transformTriMesh(tri, [0, 0, 0], q, [3, 1, 1]);
  assert.ok(Math.abs(out.positions[0]) < 1e-6);
  assert.ok(Math.abs(out.positions[1]) < 1e-6);
  assert.ok(Math.abs(out.positions[2] + 3) < 1e-6);
});

test('centerOfTris is the AABB midpoint, and the origin for nothing (§7)', () => {
  assert.deepEqual(centerOfTris([boxTris([0, 0, 0], [2, 4, 6])]), [1, 2, 3]);
  assert.deepEqual(centerOfTris([]), [0, 0, 0]);
});

test('pivotOffset carries the centre through the object scale and rotation (§7)', () => {
  // Identity: the offset is the centre itself.
  assert.deepEqual(pivotOffset([1, 2, 3], [0, 0, 0, 1], [1, 1, 1]), [1, 2, 3]);
  // Scale applies in the object's own frame, before the rotation.
  assert.deepEqual(pivotOffset([1, 2, 3], [0, 0, 0, 1], [2, 1, 0.5]), [2, 2, 1.5]);
  // 90° about Y maps +X to −Z.
  const rotated = pivotOffset([1, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2], [1, 1, 1]);
  assert.ok(Math.abs(rotated[0]) < 1e-6);
  assert.ok(Math.abs(rotated[2] + 1) < 1e-6);
});
