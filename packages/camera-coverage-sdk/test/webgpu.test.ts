/**
 * WebGPU backend verification against the CPU reference.
 *
 * The `webgpu` package (dawn-gpu/node-webgpu) provides a native Dawn-backed
 * `navigator.gpu` for Node, so the real WGSL compute path (§11/§12) can be
 * exercised in tests instead of only in a browser — see the SDK README note
 * that the WebGPU path is "written-to-spec but NOT runtime-validated" without
 * this. Skips cleanly if no GPU adapter is available in the current
 * environment (e.g. some CI runners).
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { create, globals } from 'webgpu';

import { CoverageEngine } from '../src/engine.ts';
import { EngineError, EngineErrorCode } from '../src/types.ts';
import type { CameraConfig, SceneMesh, WorkspaceConfig } from '../src/types.ts';
import { box, camera, LOOK_NEG_Z, wallZ } from './helpers.ts';

// Dawn needs its GPU* constants (GPUBufferUsage, GPUShaderStage, ...) on
// globalThis, not just `navigator.gpu` — the WGSL/pipeline code references
// them as bare globals like a browser would provide.
Object.assign(globalThis, globals);
// `node --test` defines `globalThis.navigator` as a getter with no setter,
// so a plain assignment throws — redefine the property instead.
Object.defineProperty(globalThis, 'navigator', {
  value: { gpu: create([]) },
  configurable: true,
  writable: true,
});

// Holding a reference to the Dawn-backed navigator keeps the native GPU
// instance alive, which otherwise keeps the Node process from exiting
// (documented dawn-gpu/node-webgpu limitation). Drop it once this file's
// tests are done so `node --test` can exit.
after(() => {
  delete (globalThis as { navigator?: unknown }).navigator;
});

const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
const adapter = gpu ? await gpu.requestAdapter() : null;
const available = !!adapter;

const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 10 };

async function overallRate(scene: SceneMesh, cams: CameraConfig[], backend: 'cpu' | 'webgpu') {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS, backend, solidDetection: true });
  await engine.loadScene(scene);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(cams);
  const summary = await engine.compute({ mode: 1, threshold: 1, precull: true });
  engine.dispose();
  return summary.overallRate;
}

test('webgpu backend matches CPU reference: empty room', { skip: !available && 'no WebGPU adapter available' }, async () => {
  const cams = [camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)];
  const empty: SceneMesh = { positions: new Float32Array(0), indices: new Uint32Array(0) };

  const cpuRate = await overallRate(empty, cams, 'cpu');
  const gpuRate = await overallRate(empty, cams, 'webgpu');

  assert.ok(cpuRate > 0, 'sanity: CPU reference sees non-zero coverage');
  assert.ok(gpuRate > 0, 'WebGPU must not silently report 0% coverage');
  assert.ok(Math.abs(gpuRate - cpuRate) < 1e-6, `webgpu ${gpuRate} vs cpu ${cpuRate}`);
});

test('webgpu backend matches CPU reference: occluded box', { skip: !available && 'no WebGPU adapter available' }, async () => {
  const cams = [camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)];
  const scene = box([2.5, 0, 3.5], [3.5, 3, 4.5]);

  const cpuRate = await overallRate(scene, cams, 'cpu');
  const gpuRate = await overallRate(scene, cams, 'webgpu');

  assert.ok(Math.abs(gpuRate - cpuRate) < 1e-6, `webgpu ${gpuRate} vs cpu ${cpuRate}`);
});

test('webgpu backend matches CPU reference: two cameras + wall', { skip: !available && 'no WebGPU adapter available' }, async () => {
  const cams = [
    camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z),
    camera('b', [3.15, 1.65, 0.6], [0, 1, 0, 0]),
  ];
  const scene = wallZ(3, 0, 6, 0, 3);

  const cpuRate = await overallRate(scene, cams, 'cpu');
  const gpuRate = await overallRate(scene, cams, 'webgpu');

  assert.ok(Math.abs(gpuRate - cpuRate) < 1e-6, `webgpu ${gpuRate} vs cpu ${cpuRate}`);
});

// §18.6d / §18.6c (GPU half) ------------------------------------------------
test('webgpu: one submit and one map per chunk, conditional voxel readback', { skip: !available && 'no WebGPU adapter available' }, async () => {
  const { gpuCounters } = await import('../src/compute/webgpu.ts');
  // Multi-chunk workspace so "per chunk" is a real ratio, not 1:1:1 by accident.
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [26, 3, 26], voxelSize: 0.5, chunkSizeXZ: 10,
  };
  const cams = [camera('a', [13, 1.5, 24]), camera('b', [5, 1.5, 24])];
  const scene = box([12, 0, 12], [14, 3, 14]);

  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...ws, backend: 'webgpu', solidDetection: true });
  await engine.loadScene(scene);
  await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.5, yMax: 2 }] });
  engine.setCameras(cams);

  gpuCounters.reset();
  const withVoxels = await engine.compute({ mode: 1, onChunkDone: () => {} });
  const emitting = { ...gpuCounters };

  gpuCounters.reset();
  const statsOnly = await engine.compute({ mode: 1 });
  const stats = { ...gpuCounters };
  engine.dispose();

  // §18.6d: exactly one submission and one mapping per computed chunk.
  assert.ok(emitting.chunks > 1, `expected several chunks on the GPU, got ${emitting.chunks}`);
  assert.equal(emitting.submits, emitting.chunks, 'one submit per chunk');
  assert.equal(emitting.maps, emitting.chunks, 'one map per chunk');
  assert.equal(stats.submits, stats.chunks, 'one submit per chunk (stats-only)');
  assert.equal(stats.maps, stats.chunks, 'one map per chunk (stats-only)');
  assert.equal(stats.chunks, emitting.chunks, 'same chunks reach the backend either way');

  // §18.6c: a stats-only run reads back only the stats buffer.
  const statsBytesPerChunk = (2 + cams.length) * 4;
  assert.equal(stats.bytesRead, stats.chunks * statsBytesPerChunk, 'stats-only reads stats alone');
  assert.ok(
    emitting.bytesRead > stats.bytesRead * 100,
    `voxel-emitting readback should dwarf stats-only: ${emitting.bytesRead} vs ${stats.bytesRead}`,
  );

  // ...and produces an identical summary.
  assert.equal(statsOnly.validVoxels, withVoxels.validVoxels);
  assert.equal(statsOnly.overallRate, withVoxels.overallRate);
  assert.deepEqual(statsOnly.perCamera, withVoxels.perCamera);
  assert.ok(withVoxels.overallRate > 0, 'sanity: non-zero coverage');
});

// §18.6f ------------------------------------------------------------------
test('webgpu: oversized staging readback is rejected, not left to mapAsync', { skip: !available && 'no WebGPU adapter available' }, async () => {
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [10, 3, 10], voxelSize: 0.5, chunkSizeXZ: 10,
  };
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...ws, backend: 'webgpu', solidDetection: true });
  await engine.loadScene(box([4, 0, 4], [6, 3, 6]));
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras([camera('a', [5, 1.5, 9], LOOK_NEG_Z)]);

  // A stats-only run needs a handful of bytes, so it must survive a ceiling
  // that the voxel-emitting run cannot possibly meet.
  const backend = (engine as unknown as { backend: { maxBufferSize: number } }).backend;
  const real = backend.maxBufferSize;
  backend.maxBufferSize = 64;

  await assert.rejects(
    () => engine.compute({ mode: 1, onChunkDone: () => {} }),
    (err: unknown) => {
      assert.ok(err instanceof EngineError, `expected EngineError, got ${String(err)}`);
      assert.equal(err.code, EngineErrorCode.SCENE_TOO_LARGE);
      assert.match(err.message, /maxBufferSize/);
      return true;
    },
    'the combined staging buffer is checked before it is created',
  );

  // The rejection released everything: the same engine still computes.
  backend.maxBufferSize = real;
  const after = await engine.compute({ mode: 1, onChunkDone: () => {} });
  assert.ok(after.validVoxels > 0, 'engine still usable after the rejected chunk');
  engine.dispose();
});
