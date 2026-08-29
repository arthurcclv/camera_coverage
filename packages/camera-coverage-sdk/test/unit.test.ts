/**
 * Unit tests for the lower-level building blocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanMesh } from '../src/geometry/mesh.ts';
import { buildBvh } from '../src/geometry/bvh.ts';
import { occluded } from '../src/kernel.ts';
import { buildSvo, svoAccessor, type DenseChunk, type VoxelAccessor } from '../src/svo.ts';
import { denseAccessor } from '../src/results.ts';
import { prepareCamera, packCameras, camWords, pointInFrustum, CAMERA_STRUCT_F32 } from '../src/camera.ts';
import { planStaging } from '../src/compute/webgpu.ts';
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

// --- forEachLeaf above 32 cameras (§7.1, §9.5) ------------------------------

/** Reconstruct every mask word from forEachLeaf and compare against getMaskWord. */
function assertForEachLeafCarriesAllWords(acc: VoxelAccessor, dims: Vec3, cw: number): void {
  const [nx, ny, nz] = dims;
  const recon = new Int32Array(nx * ny * nz * cw).fill(-1);
  acc.forEachLeaf((min, size, mask, _valid, maskWords) => {
    assert.equal(maskWords.length, cw, 'maskWords carries CAM_WORDS words');
    assert.equal(mask, maskWords[0] >>> 0, 'mask argument stays word 0');
    // Copy immediately: maskWords is accessor-owned scratch (§9.5).
    const words = Array.from(maskWords, (v) => v >>> 0);
    for (let dz = 0; dz < size; dz++)
      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++) {
          const i = min[0] + dx, j = min[1] + dy, k = min[2] + dz;
          if (i >= nx || j >= ny || k >= nz) continue;
          const li = i + nx * (j + ny * k);
          for (let w = 0; w < cw; w++) recon[li * cw + w] = words[w];
        }
  });
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const li = i + nx * (j + ny * k);
        for (let w = 0; w < cw; w++) {
          assert.equal(
            recon[li * cw + w] >>> 0,
            acc.getMaskWord(i, j, k, w) >>> 0,
            `forEachLeaf word ${w} @ ${i},${j},${k}`,
          );
        }
      }
}

// Regression: voxels seen only by cameras at index >= 32 have word 0 == 0, so a
// consumer reading only the `mask` argument rendered them as blind spots.
const HIGH_CAM_DIMS: Vec3 = [16, 16, 16];
const highCamDense = () =>
  denseFromFn(HIGH_CAM_DIMS, 2, (i, j, k) => {
    if (i < 5) return { mask: [0, 0], valid: k >= 2 }; // blind everywhere
    if (i < 11) return { mask: [0, 0x00000005], valid: true }; // cameras 32 & 34 ONLY
    return { mask: [0b11, 0x80000000], valid: true }; // cameras 0,1 and 63
  });

test('forEachLeaf carries all CAM_WORDS words (SVO/palette encoding)', () => {
  const dense = highCamDense();
  const svo = buildSvo(0, dense);
  assert.ok(svo, 'blocky pattern must compress to an SVO');
  assertForEachLeafCarriesAllWords(svoAccessor(svo!), HIGH_CAM_DIMS, 2);
});

test('forEachLeaf carries all CAM_WORDS words (dense encoding)', () => {
  const dense = highCamDense();
  const acc = denseAccessor(HIGH_CAM_DIMS, 2, dense.visibility, dense.validity);
  assertForEachLeafCarriesAllWords(acc, HIGH_CAM_DIMS, 2);
});

test('forEachLeaf reports voxels seen only by cameras >= 32 as covered', () => {
  const dense = highCamDense();
  const svo = buildSvo(0, dense);
  const acc = svo ? svoAccessor(svo) : denseAccessor(HIGH_CAM_DIMS, 2, dense.visibility, dense.validity);
  let highOnlyVoxels = 0;
  acc.forEachLeaf((min, size, mask, valid, maskWords) => {
    if (!valid) return;
    if (mask !== 0) return; // word 0 empty …
    let anyHigh = 0;
    for (let w = 1; w < maskWords.length; w++) anyHigh |= maskWords[w];
    if (anyHigh === 0) return; // … and genuinely blind
    highOnlyVoxels += size * size * size;
  });
  assert.ok(highOnlyVoxels > 0, 'the fixture has voxels covered only by cameras 32+');
});

test('maxDepth majority key is taken over all words, not word 0', () => {
  // Every voxel is blind in word 0; the majority is camera 32 with a minority of
  // camera 33. A word-0-only majority would bucket both as "0" and approximate the
  // subtree as fully blind. maxDepth 4 reports 16³ nodes — exactly the chunk
  // extent, so the single reported node is internal and takes the majority path.
  const dims: Vec3 = [16, 16, 16];
  const dense = denseFromFn(dims, 2, (i, j, k) => ({
    mask: [0, i < 2 && j < 2 && k < 2 ? 0x2 : 0x1],
    valid: true,
  }));
  const svo = buildSvo(0, dense);
  assert.ok(svo, 'blocky pattern must produce an SVO');
  let leaves = 0;
  svoAccessor(svo!).forEachLeaf((min, size, mask, valid, maskWords) => {
    leaves++;
    assert.deepEqual([...min], [0, 0, 0]);
    assert.equal(size, 16);
    assert.equal(mask, 0, 'word 0 is empty');
    assert.equal(maskWords[1] >>> 0, 0x1, 'camera 32 survives the LOD approximation');
    assert.equal(valid, true);
  }, 4);
  assert.equal(leaves, 1, 'maxDepth traversal reported the extent as one node');
});

// §18.6f (arithmetic half) --------------------------------------------------
test('staging plan sizes the buffer by the sum of its segments (§11.1)', () => {
  // Stats-only: one segment, no per-voxel readback.
  const statsOnly = planStaging([
    { key: 'stats', bytes: 24 },
    { key: 'visibility', bytes: 0 },
    { key: 'coverage', bytes: 0 },
  ]);
  assert.equal(statsOnly.size, 24);
  assert.equal(statsOnly.segments.length, 1);
  assert.equal(statsOnly.offsetOf('stats'), 0);
  assert.equal(statsOnly.has('visibility'), false);
  assert.equal(statsOnly.offsetOf('visibility'), -1);

  // Mode 1 emitting: stats + visibility, the stats segment padded to 8 bytes.
  const mode1 = planStaging([
    { key: 'stats', bytes: 20 },
    { key: 'visibility', bytes: 4096 },
    { key: 'coverage', bytes: 0 },
  ]);
  assert.equal(mode1.offsetOf('stats'), 0);
  assert.equal(mode1.offsetOf('visibility'), 24);
  assert.equal(mode1.offsetOf('coverage'), -1);
  assert.equal(mode1.size, 4120);

  // Mode 2 emitting: all three are resident at once, so the peak is their sum
  // — not max(visBytes, covBytes), which is what the old one-at-a-time read
  // paid and what the maxBufferSize check would have under-counted.
  const visBytes = 32 * 1024 * 1024;
  const covBytes = 128 * 1024 * 1024;
  const mode2 = planStaging([
    { key: 'stats', bytes: 24 },
    { key: 'visibility', bytes: visBytes },
    { key: 'coverage', bytes: covBytes },
  ]);
  assert.equal(mode2.size, 24 + visBytes + covBytes);
  assert.ok(mode2.size > Math.max(visBytes, covBytes));
  assert.equal(mode2.offsetOf('visibility'), 24);
  assert.equal(mode2.offsetOf('coverage'), 24 + visBytes);
  assert.deepEqual(
    mode2.segments.map((s) => s.key),
    ['stats', 'visibility', 'coverage'],
  );

  // An omitted earlier primitive shifts nothing it should not: the segments a
  // descriptor *did* ask for are still found by name, which is the whole reason
  // the plan is keyed rather than positional.
  const aggOnly = planStaging([
    { key: 'stats', bytes: 24 },
    { key: 'visibility', bytes: 0 },
    { key: 'coverage', bytes: 0 },
    { key: 'leafCounts', bytes: 64 },
    { key: 'leafValid', bytes: 16 },
  ]);
  assert.equal(aggOnly.offsetOf('leafCounts'), 24);
  assert.equal(aggOnly.sizeOf('leafCounts'), 64);
  assert.equal(aggOnly.offsetOf('leafValid'), 88);
  assert.equal(aggOnly.has('regionAccum'), false);
  assert.equal(aggOnly.sizeOf('regionAccum'), 0);

  // Every getMappedRange offset stays 8-byte aligned.
  const aligned = planStaging([
    { key: 'stats', bytes: 20 },
    { key: 'visibility', bytes: 12 },
    { key: 'coverage', bytes: 36 },
  ]);
  for (const seg of aligned.segments) assert.equal(seg.offset % 8, 0);
});
