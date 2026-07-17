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
