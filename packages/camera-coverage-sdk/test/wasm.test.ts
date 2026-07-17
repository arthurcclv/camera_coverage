/**
 * Rust WASM kernel verification.
 *
 * 1. Parity: WASM kernels vs the TS reference (occupancy cells, SVO arrays,
 *    BVH occlusion, mesh cleaning) on fixed scenes.
 * 2. Integration: the engine driven end-to-end through the WASM kernels
 *    reproduces the acceptance-test outcomes.
 *
 * Requires the built artifact at src/wasm/camera_coverage_wasm.wasm
 * (run `npm run build:wasm`). Skips cleanly if it is missing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { createWasmKernels, type Kernels } from '../src/index.ts';
import { tsKernels } from '../src/kernels.ts';
import { CoverageEngine } from '../src/engine.ts';
import { accessor } from '../src/results.ts';
import { WorkspaceGrid } from '../src/grid.ts';
import { occluded } from '../src/kernel.ts';
import type { DenseChunk } from '../src/svo.ts';
import type { SceneMesh, Vec3, WorkspaceConfig } from '../src/types.ts';
import { box, camera, LOOK_NEG_Z, voxelIndexOf, wallZ } from './helpers.ts';

const WASM_URL = new URL('../src/wasm/camera_coverage_wasm.wasm', import.meta.url);
const available = existsSync(WASM_URL);

let wasm: Kernels;
test('load WASM kernels', { skip: !available && 'wasm artifact not built' }, async () => {
  wasm = await createWasmKernels(readFileSync(WASM_URL));
  assert.ok(wasm);
});

const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 10 };

test('parity: mesh cleaning', { skip: !available && 'no wasm' }, () => {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0, // valid
    0, 0, 0, 1, 0, 0, 2, 0, 0, // degenerate
    0, 0, 0, NaN, 0, 0, 0, 1, 0, // NaN
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const a = tsKernels.cleanMesh({ positions, indices });
  const b = wasm.cleanMesh({ positions, indices });
  assert.equal(b.triangleCount, a.triangleCount);
  assert.equal(b.removed, a.removed);
  assert.deepEqual(Array.from(b.triVerts), Array.from(a.triVerts));
});

test('parity: occupancy cells are bit-identical (closed box)', { skip: !available && 'no wasm' }, () => {
  const grid = new WorkspaceGrid(WS);
  const clean = tsKernels.cleanMesh(box([1.2, 0.9, 1.2], [3.6, 2.4, 3.6]));
  const a = tsKernels.computeOccupancy(grid, clean, true);
  const b = wasm.computeOccupancy(grid, clean, true);
  assert.equal(b.solidCount, a.solidCount);
  assert.equal(b.mixedCount, a.mixedCount);
  assert.deepEqual(Array.from(b.cells), Array.from(a.cells));
});

test('parity: SVO arrays identical (CAM_WORDS=2 palette)', { skip: !available && 'no wasm' }, () => {
  const dims: Vec3 = [16, 16, 16];
  const cw = 2;
  const n = dims[0] * dims[1] * dims[2];
  const visibility = new Uint32Array(n * cw);
  const validity = new Uint32Array((n + 31) >> 5);
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) {
        const li = i + dims[0] * (j + dims[1] * k);
        const inBlock = i >= 4 && i < 12;
        visibility[li * cw] = inBlock ? 0xdeadbeef : 0;
        visibility[li * cw + 1] = inBlock ? 0x1 : 0;
        if (k >= 2) validity[li >> 5] |= 1 << (li & 31);
      }
  const dense: DenseChunk = { dims, camWords: cw, visibility, validity };
  const a = tsKernels.buildSvo(0, dense);
  const b = wasm.buildSvo(0, dense);
  assert.ok(a && b, 'both produce an SVO');
  assert.deepEqual(Array.from(b!.nodeChild), Array.from(a!.nodeChild));
  assert.deepEqual(Array.from(b!.nodeKey), Array.from(a!.nodeKey));
  assert.deepEqual(Array.from(b!.nodeValid), Array.from(a!.nodeValid));
  assert.deepEqual(Array.from(b!.palette ?? []), Array.from(a!.palette ?? []));
});

test('parity: BVH occlusion matches TS', { skip: !available && 'no wasm' }, () => {
  const clean = tsKernels.cleanMesh(box([1, 1, 1], [3, 3, 3]));
  const a = tsKernels.buildBvh(clean);
  const b = wasm.buildBvh(clean);
  assert.equal(b.triangleCount, a.triangleCount);

  const rays: { o: Vec3; d: Vec3; t: number }[] = [
    { o: [2, 2, -2], d: [0, 0, 1], t: 10 }, // through the box → occluded
    { o: [2, 2, -2], d: [0, 0, 1], t: 2.5 }, // stops before box → clear
    { o: [-5, 2, 2], d: [0, 0, 1], t: 10 }, // misses the box
    { o: [2, 5, 2], d: [0, -1, 0], t: 10 }, // top-down through box
  ];
  for (const r of rays) {
    assert.equal(
      occluded(b, r.o, r.d, 1e-3, r.t),
      occluded(a, r.o, r.d, 1e-3, r.t),
      `ray ${JSON.stringify(r)}`,
    );
  }
});

// --- integration through the WASM kernels ----------------------------------

async function runWasm(scene: SceneMesh, cams: ReturnType<typeof camera>[], solidDetection = true) {
  const engine = new CoverageEngine({ onWarning: () => {}, kernels: wasm });
  await engine.init({ ...WS, backend: 'cpu', solidDetection });
  await engine.loadScene(scene);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(cams);
  let acc0!: ReturnType<typeof accessor>;
  await engine.compute({ onChunkDone: (id, r) => { if (id === 0) acc0 = accessor(r); } });
  engine.dispose();
  return acc0;
}

const idx = (p: Vec3) => voxelIndexOf(WS.worldMin, WS.voxelSize, p);

test('integration (WASM): single-wall occlusion', { skip: !available && 'no wasm' }, async () => {
  const acc = await runWasm(wallZ(2.5, 0, 6, 0, 3), [camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);
  assert.equal(acc.getMask(...idx([3.15, 1.65, 4.05])) & 1, 1, 'front visible');
  assert.equal(acc.getMask(...idx([3.15, 1.65, 1.05])), 0, 'behind occluded');
  assert.equal(acc.isValid(...idx([3.15, 1.65, 2.55])), false, 'wall voxel invalid');
});

test('integration (WASM): closed-box SOLID interior', { skip: !available && 'no wasm' }, async () => {
  const acc = await runWasm(box([1.2, 0.9, 1.2], [3.6, 2.4, 3.6]), [camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);
  assert.equal(acc.isValid(...idx([2.55, 1.65, 2.55])), false, 'interior is SOLID → invalid');
});
