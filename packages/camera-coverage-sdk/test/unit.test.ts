/**
 * Unit tests for the lower-level building blocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanMesh } from '../src/geometry/mesh.ts';
import { buildBvh } from '../src/geometry/bvh.ts';
import { occluded } from '../src/kernel.ts';
import { buildSvo, svoAccessor, type DenseChunk } from '../src/svo.ts';
import { denseAccessor } from '../src/results.ts';
import { prepareCamera, packCameras, camWords, pointInFrustum, CAMERA_STRUCT_F32 } from '../src/camera.ts';
import { box, wallZ, LOOK_NEG_Z } from './helpers.ts';
import type { Vec3 } from '../src/types.ts';

test('camWords parameterization (§7.1)', () => {
  assert.equal(camWords(1), 1);
  assert.equal(camWords(32), 1);
  assert.equal(camWords(33), 2);
  assert.equal(camWords(128), 4);
});

test('mesh cleaning removes degenerate triangles', () => {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0, // valid
    0, 0, 0, 1, 0, 0, 2, 0, 0, // collinear (degenerate)
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const clean = cleanMesh({ positions, indices });
  assert.equal(clean.triangleCount, 1);
  assert.equal(clean.removed, 1);
});

test('BVH occlusion: wall blocks, empty direction clear', () => {
  const bvh = buildBvh(cleanMesh(wallZ(0, -1, 1, -1, 1)));
  // Ray crossing the wall plane between the two points.
  const a: Vec3 = [0, 0, -1];
  const b: Vec3 = [0, 0, 1];
  const dist = 2;
  const dir: Vec3 = [0, 0, 1];
  assert.equal(occluded(bvh, a, dir, 1e-3, dist - 1e-3), true, 'wall between → occluded');

  // Ray that never reaches the wall (t_max short).
  assert.equal(occluded(bvh, a, dir, 1e-3, 0.5), false, 'stops before wall → clear');

  // Lateral ray missing the 2×2 wall.
  const off: Vec3 = [5, 0, -1];
  assert.equal(occluded(bvh, off, dir, 1e-3, dist - 1e-3), false, 'misses wall');
});

test('BVH builds over a box and is traversable', () => {
  const bvh = buildBvh(cleanMesh(box([0, 0, 0], [1, 1, 1])));
  assert.ok(bvh.nodeCount >= 1);
  assert.equal(bvh.triangleCount, 12);
  // Ray through the box interior is occluded.
  assert.equal(occluded(bvh, [0.5, 0.5, -1], [0, 0, 1], 1e-3, 3), true);
});

test('empty-scene BVH never occludes', () => {
  const bvh = buildBvh(cleanMesh({ positions: new Float32Array(0), indices: new Uint32Array(0) }));
  assert.equal(occluded(bvh, [0, 0, 0], [0, 0, 1], 1e-3, 100), false);
});

test('camera struct packing is 96 bytes and frustum test works', () => {
  const cam = prepareCamera({ id: 'c', position: [0, 0, 5], rotation: LOOK_NEG_Z, fov: 90, aspect: 1, near: 0.1, far: 50 });
  const packed = packCameras([cam]);
  assert.equal(packed.length, CAMERA_STRUCT_F32);
  assert.equal(packed.byteLength, 96);

  assert.equal(pointInFrustum(cam, [0, 0, 0]), true, 'point in front is inside');
  assert.equal(pointInFrustum(cam, [0, 0, 10]), false, 'point behind is outside');
  assert.equal(pointInFrustum(cam, [0, 0, -60]), false, 'point beyond far is outside');
});

// --- SVO -------------------------------------------------------------------

function denseFromFn(
  dims: Vec3,
  camWordsN: number,
  fn: (i: number, j: number, k: number) => { mask: number[]; valid: boolean },
): DenseChunk {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const visibility = new Uint32Array(n * camWordsN);
  const validity = new Uint32Array((n + 31) >> 5);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const li = i + nx * (j + ny * k);
        const { mask, valid } = fn(i, j, k);
        for (let w = 0; w < camWordsN; w++) visibility[li * camWordsN + w] = mask[w] >>> 0;
        if (valid) validity[li >> 5] |= 1 << (li & 31);
      }
  return { dims, camWords: camWordsN, visibility, validity };
}

function assertAccessorMatches(dense: DenseChunk, chunkId = 0): void {
  const svo = buildSvo(chunkId, dense);
  const acc = svo ? svoAccessor(svo) : denseAccessor(dense.dims, dense.camWords, dense.visibility, dense.validity);
  const [nx, ny, nz] = dense.dims;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const li = i + nx * (j + ny * k);
        const validExpected = ((dense.validity[li >> 5] >>> (li & 31)) & 1) === 1;
        assert.equal(acc.isValid(i, j, k), validExpected, `valid @ ${i},${j},${k}`);
        for (let w = 0; w < dense.camWords; w++) {
          assert.equal(
            acc.getMaskWord(i, j, k, w) >>> 0,
            dense.visibility[li * dense.camWords + w] >>> 0,
            `mask word ${w} @ ${i},${j},${k}`,
          );
        }
      }
}

test('SVO homogeneous scene compresses and round-trips', () => {
  const dense = denseFromFn([16, 16, 16], 1, () => ({ mask: [0], valid: true }));
  const svo = buildSvo(0, dense);
  assert.ok(svo, 'homogeneous scene must produce an SVO');
  assert.ok(svo!.nodeChild.length < 16 * 16 * 16, 'far fewer nodes than voxels');
  assertAccessorMatches(dense);
});

test('SVO round-trips a block pattern (CAM_WORDS=1)', () => {
  const dense = denseFromFn([16, 16, 16], 1, (i, j, k) => {
    const inBlock = i >= 4 && i < 12 && j >= 4 && j < 12 && k >= 4 && k < 12;
    return { mask: [inBlock ? 0b1011 : 0], valid: true };
  });
  assertAccessorMatches(dense);
});

test('SVO round-trips with palette (CAM_WORDS=2)', () => {
  const dense = denseFromFn([16, 16, 16], 2, (i) => {
    if (i < 6) return { mask: [0, 0], valid: false };
    if (i < 11) return { mask: [0xdeadbeef, 0x1], valid: true };
    return { mask: [0xffffffff, 0xffffffff], valid: true };
  });
  const svo = buildSvo(0, dense);
  if (svo) assert.ok(svo.palette, 'CAM_WORDS>1 uses a palette');
  assertAccessorMatches(dense);
});

test('SVO non-power-of-two dims (padding) round-trips', () => {
  const dense = denseFromFn([20, 10, 20], 1, (i, j, k) => ({
    mask: [(i + j + k) % 3 === 0 ? 0b101 : 0],
    valid: (i + j + k) % 2 === 0,
  }));
  assertAccessorMatches(dense);
});

test('forEachLeaf reconstructs the mask field within extent', () => {
  const dims: Vec3 = [16, 16, 16];
  const dense = denseFromFn(dims, 1, (i, j, k) => ({
    mask: [i < 8 ? 0b11 : 0b100],
    valid: k >= 2,
  }));
  const svo = buildSvo(0, dense);
  const acc = svo ? svoAccessor(svo) : denseAccessor(dims, 1, dense.visibility, dense.validity);

  const recon = new Int32Array(dims[0] * dims[1] * dims[2]).fill(-1);
  acc.forEachLeaf((min, size, mask, valid) => {
    for (let dz = 0; dz < size; dz++)
      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++) {
          const i = min[0] + dx, j = min[1] + dy, k = min[2] + dz;
          if (i >= dims[0] || j >= dims[1] || k >= dims[2]) continue;
          recon[i + dims[0] * (j + dims[1] * k)] = valid ? mask : mask; // record mask
        }
  });
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) {
        assert.equal(recon[i + dims[0] * (j + dims[1] * k)], acc.getMask(i, j, k));
      }
});
