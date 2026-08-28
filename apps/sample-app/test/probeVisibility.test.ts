import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceGrid, type ChunkResult } from '@linkervision/camera-coverage-sdk';
import { ProbeVisibility, defaultProbeName, locateVoxel, probeLabel } from '../src/scene/probeVisibility.ts';

test('probeLabel trims the name and falls back to "Probe N" when blank (spec §5.6, §12.1)', () => {
  assert.equal(defaultProbeName('probe-1'), 'Probe 1');
  assert.equal(defaultProbeName('odd'), 'odd');
  assert.equal(probeLabel({ id: 'probe-1', position: [0, 0, 0], name: 'Aisle 3' }), 'Aisle 3');
  assert.equal(probeLabel({ id: 'probe-1', position: [0, 0, 0], name: '  Dock  ' }), 'Dock');
  assert.equal(probeLabel({ id: 'probe-2', position: [0, 0, 0], name: '' }), 'Probe 2');
  assert.equal(probeLabel({ id: 'probe-3', position: [0, 0, 0], name: '   ' }), 'Probe 3');
});

// A 2×2×2 workspace of 1 m voxels → a single 2×2×2 chunk.
const grid = new WorkspaceGrid({
  worldMin: [0, 0, 0],
  worldMax: [2, 2, 2],
  voxelSize: 1,
  chunkSizeXZ: 2,
});

// local index within the chunk: X fastest, then Y, then Z.
const li = (i: number, j: number, k: number) => i + 2 * (j + 2 * k);

/** Dense chunk: voxel (1,0,0) seen by cameras 0 and 2; (0,0,0) a blind spot; (0,1,0) invalid. */
function buildChunk(): ChunkResult {
  const visibility = new Uint32Array(8); // 1 word per voxel (camWords = 1)
  visibility[li(1, 0, 0)] = 0b101; // cameras at bit 0 and bit 2
  const validity = new Uint32Array(1); // 1 bit per voxel
  validity[0] = (1 << li(0, 0, 0)) | (1 << li(1, 0, 0)); // only these two are valid
  return {
    chunkId: 0,
    encoding: 'dense',
    dims: [2, 2, 2],
    origin: [0, 0, 0],
    voxelSize: 1,
    camWords: 1,
    mode: 1,
    visibility,
    validity,
    stats: { validCount: 2, coveredCount: 1, visibleCount: [1, 0, 1] },
  };
}

test('locateVoxel maps a world point to its (chunk, i, j, k) (spec §12.2)', () => {
  assert.deepEqual(locateVoxel(grid, [1.5, 0.5, 0.5]), { chunkId: 0, i: 1, j: 0, k: 0 });
  assert.deepEqual(locateVoxel(grid, [0.2, 1.9, 0.0]), { chunkId: 0, i: 0, j: 1, k: 0 });
});

test('locateVoxel returns null outside the workspace grid', () => {
  assert.equal(locateVoxel(grid, [-0.1, 0.5, 0.5]), null);
  assert.equal(locateVoxel(grid, [5, 5, 5]), null);
});

test('query before any run has no data (never "0 of N", spec §12.3)', () => {
  const pv = new ProbeVisibility();
  assert.deepEqual(pv.query([1.5, 0.5, 0.5]), { status: 'no-data' });
});

test('query decodes the retained mask against the snapshotted camera list', () => {
  const pv = new ProbeVisibility();
  pv.reset(grid, ['cam-a', 'cam-b', 'cam-c'].map((id) => ({ id, enabled: true })));
  pv.addChunk(buildChunk());

  const q = pv.query([1.5, 0.5, 0.5]);
  assert.equal(q.status, 'ok');
  assert.ok(q.status === 'ok');
  assert.deepEqual(q.cameraIds, ['cam-a', 'cam-b', 'cam-c']);
  assert.deepEqual(q.visible, [true, false, true]); // bits 0 and 2
  assert.equal(q.seenCount, 2);
});

test('blind-spot voxel reports zero cameras but is still "ok" data', () => {
  const pv = new ProbeVisibility();
  pv.reset(grid, ['cam-a', 'cam-b'].map((id) => ({ id, enabled: true })));
  pv.addChunk(buildChunk());

  const q = pv.query([0.5, 0.5, 0.5]); // voxel (0,0,0): valid, mask 0
  assert.ok(q.status === 'ok');
  assert.equal(q.seenCount, 0);
  assert.deepEqual(q.visible, [false, false]);
});

test('invalid voxel and out-of-workspace point both report no-data', () => {
  const pv = new ProbeVisibility();
  pv.reset(grid, ['cam-a'].map((id) => ({ id, enabled: true })));
  pv.addChunk(buildChunk());

  assert.deepEqual(pv.query([0.5, 1.5, 0.5]).status, 'no-data'); // voxel (0,1,0) invalid
  assert.deepEqual(pv.query([9, 9, 9]).status, 'no-data'); // outside workspace
});

test('reset clears retained chunks and the camera snapshot', () => {
  const pv = new ProbeVisibility();
  pv.reset(grid, ['cam-a', 'cam-b', 'cam-c'].map((id) => ({ id, enabled: true })));
  pv.addChunk(buildChunk());
  assert.ok(pv.query([1.5, 0.5, 0.5]).status === 'ok');

  pv.reset(grid, ['cam-x'].map((id) => ({ id, enabled: true }))); // new run: no chunks yet
  assert.deepEqual(pv.query([1.5, 0.5, 0.5]), { status: 'no-data' });
});

test('clear() discards the retained run so query() reads no-data (spec §14.4)', () => {
  const pv = new ProbeVisibility();
  pv.reset(grid, ['cam-a', 'cam-b', 'cam-c'].map((id) => ({ id, enabled: true })));
  pv.addChunk(buildChunk());
  assert.ok(pv.query([1.5, 0.5, 0.5]).status === 'ok');

  pv.clear();
  assert.deepEqual(pv.query([1.5, 0.5, 0.5]), { status: 'no-data' });
});

test('a disabled camera is dropped from the readout without shifting the others (spec §5.4, §12.2)', () => {
  const pv = new ProbeVisibility();
  // Camera 'b' is disabled but still holds bit 1, so 'c' stays at bit 2 — which
  // is the bit the retained mask actually has set.
  pv.reset(grid, [
    { id: 'cam-a', enabled: true },
    { id: 'cam-b', enabled: false },
    { id: 'cam-c', enabled: true },
  ]);
  pv.addChunk(buildChunk());

  const q = pv.query([1.5, 0.5, 0.5]);
  assert.equal(q.status, 'ok');
  if (q.status !== 'ok') return;
  assert.deepEqual(q.cameraIds, ['cam-a', 'cam-c'], 'the disabled camera is not listed');
  assert.deepEqual(q.visible, [true, true], 'bits 0 and 2 — not bits 0 and 1');
  // "Seen by K of N": N is the enabled count, never the list length (spec §12.3).
  assert.equal(q.seenCount, 2);
  assert.equal(q.cameraIds.length, 2);
});
