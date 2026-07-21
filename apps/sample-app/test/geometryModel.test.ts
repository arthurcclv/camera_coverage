import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  boxTris,
  computeAabb,
  computeWorkspaceBounds,
  mergeTris,
  roomTris,
  transformTriMesh,
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

test('computeAabb throws on an empty mesh', () => {
  assert.throws(() => computeAabb({ positions: new Float32Array(0), indices: new Uint32Array(0) }));
});
