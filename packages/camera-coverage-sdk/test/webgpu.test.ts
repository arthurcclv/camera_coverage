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
import type { CameraConfig, ChunkResult, SceneMesh, WorkspaceConfig } from '../src/types.ts';
import type { AggregateResult, AggregateSpec } from '../src/aggregate.ts';
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

/**
 * §18.6g on the real WGSL path. Incremental recompute is engine orchestration
 * rather than shader code, but it changes *which* chunks reach the GPU and
 * reuses statistics the GPU produced on an earlier submission — so the
 * equivalence claim is only proven where the compute actually runs.
 */
test(
  'webgpu: an incremental run matches a full run at the same cameras',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    const WS_CHUNKED: WorkspaceConfig = {
      worldMin: [0, 0, 0],
      worldMax: [12, 3, 12],
      voxelSize: 0.3,
      chunkSizeXZ: 3,
    };
    const wall = wallZ(6, 0, 12, 0, 3);
    const shortCam = (id: string, position: [number, number, number]) =>
      camera(id, position, LOOK_NEG_Z, { fov: 60, far: 2.5 });
    const c0 = [shortCam('a', [1.5, 1.5, 10.5]), shortCam('b', [10.5, 1.5, 4.0])];
    const c1 = [shortCam('a', [1.9, 1.5, 10.3]), shortCam('b', [10.5, 1.5, 4.0])];

    const engine = new CoverageEngine({ onWarning: () => {} });
    await engine.init({ ...WS_CHUNKED, backend: 'webgpu' });
    await engine.loadScene(wall);
    await engine.setSampling({ regions: [{ type: 'full' }] });

    engine.setCameras(c0);
    await engine.compute({ onChunkDone: () => {} });

    engine.setCameras(c1);
    let runStart: { incremental: boolean; chunkIds: number[] } | null = null;
    const incr = await engine.compute({
      incremental: true,
      onRunStart: (i) => (runStart = { ...i }),
      onChunkDone: () => {},
    });
    engine.dispose();

    const fresh = new CoverageEngine({ onWarning: () => {} });
    await fresh.init({ ...WS_CHUNKED, backend: 'webgpu' });
    await fresh.loadScene(wall);
    await fresh.setSampling({ regions: [{ type: 'full' }] });
    fresh.setCameras(c1);
    const full = await fresh.compute({ onChunkDone: () => {} });
    fresh.dispose();

    assert.equal(runStart!.incremental, true);
    assert.ok(runStart!.chunkIds.length < 16, 'the nudge must not dirty every chunk');
    assert.equal(incr.validVoxels, full.validVoxels);
    assert.ok(Math.abs(incr.overallRate - full.overallRate) < 1e-9);
    assert.deepEqual(
      incr.perCamera.map((p) => p.id),
      full.perCamera.map((p) => p.id),
    );
    for (let i = 0; i < incr.perCamera.length; i++) {
      assert.ok(
        Math.abs(incr.perCamera[i].coverageRate - full.perCamera[i].coverageRate) < 1e-9,
        `camera ${incr.perCamera[i].id}: ${incr.perCamera[i].coverageRate} vs ${full.perCamera[i].coverageRate}`,
      );
    }
  },
);

// §19 aggregation on real hardware ------------------------------------------

const AGG_WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 3 };

const AGG_SPEC: AggregateSpec = {
  regions: [
    { center: [2.0, 1.5, 3.0], rotation: [0, 0, 0, 1], halfSize: [1.6, 1.4, 2.0], groups: [0] },
    { center: [4.5, 1.5, 4.5], rotation: [0, 0, 0, 1], halfSize: [1.2, 1.2, 1.2], groups: [0] },
    // Rotated: the case the shader's conjugate-quaternion transform has to get
    // right and an axis-aligned test would silently pass anyway.
    { center: [3.0, 1.5, 3.0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], halfSize: [1.0, 1.4, 0.6], groups: [] },
  ],
  columns: [{ axis: 1, range: [[0, 19], [1, 8], [0, 19]], maskRegions: [0] }],
  leafCounts: { maskRegions: [] },
  probes: [[3.15, 1.65, 4.5], [2.25, 1.35, 2.85]],
};

async function aggregateRun(backend: 'cpu' | 'webgpu') {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...AGG_WS, backend, solidDetection: true });
  await engine.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras([
    camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z),
    camera('b', [3.15, 1.65, 0.6], [0, 1, 0, 0]),
  ]);
  const out: AggregateResult[] = [];
  const chunks: ChunkResult[] = [];
  await engine.compute({
    mode: 1,
    aggregate: AGG_SPEC,
    onChunkDone: (_id, r) => chunks.push(r),
    onAggregate: (r) => out.push(r),
  });
  out.sort((a, b) => a.chunkId - b.chunkId);
  return { engine, out, chunks };
}

/**
 * Compare two `AggregateResult`s field by field. `deepEqual` on the objects
 * would pass on two empty results, so the caller asserts non-emptiness too.
 */
function assertSameAggregate(a: AggregateResult, b: AggregateResult, label: string): void {
  assert.equal(a.chunkId, b.chunkId, `${label} chunkId`);
  for (const key of ['regions', 'groups'] as const) {
    assert.equal(a[key]?.length, b[key]?.length, `${label} ${key} count`);
    a[key]?.forEach((r, i) => {
      const o = b[key]![i];
      assert.equal(r.valid, o.valid, `${label} ${key} ${i} valid`);
      assert.equal(r.covered, o.covered, `${label} ${key} ${i} covered`);
      assert.equal(r.blind, o.blind, `${label} ${key} ${i} blind`);
      assert.deepEqual(Array.from(r.seen), Array.from(o.seen), `${label} ${key} ${i} seen`);
    });
  }
  a.columns?.forEach((c, i) => {
    const o = b.columns![i];
    for (const key of [
      'camCountSum', 'camCountMax', 'camCountMin', 'blindCount',
      'validCount', 'obstacleCount', 'filteredCount', 'seenWords',
    ] as const) {
      assert.deepEqual(Array.from(c[key]), Array.from(o[key]), `${label} slab ${i} ${key}`);
    }
  });
  for (const key of ['index', 'size', 'count'] as const) {
    assert.deepEqual(
      Array.from(a.leafCounts?.[key] ?? []),
      Array.from(b.leafCounts?.[key] ?? []),
      `${label} leaf ${key}`,
    );
  }
  assert.deepEqual(Array.from(a.probeMasks ?? []), Array.from(b.probeMasks ?? []), `${label} probeMasks`);
  assert.deepEqual(Array.from(a.probeHits ?? []), Array.from(b.probeHits ?? []), `${label} probeHits`);
}

test(
  '§18 6l: aggregation is bit-identical between the CPU and WebGPU backends',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    const cpu = await aggregateRun('cpu');
    const gpu2 = await aggregateRun('webgpu');
    assert.equal(gpu2.out.length, cpu.out.length, 'same chunks reported');
    assert.ok(cpu.out.length > 1, 'the workspace must actually be chunked');
    // Guard against a green run over three empty descriptors.
    const totalValid = cpu.out.reduce((n, a) => n + (a.regions?.[0].valid ?? 0), 0);
    assert.ok(totalValid > 0, 'region 0 must contain voxels for this to test anything');

    cpu.out.forEach((a, i) => assertSameAggregate(a, gpu2.out[i], `chunk ${a.chunkId}`));
    cpu.engine.dispose();
    gpu2.engine.dispose();
  },
);

test(
  '§18 6o: a full aggregation descriptor still costs one submit and one map per chunk',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    const { gpuCounters } = await import('../src/compute/webgpu.ts');
    gpuCounters.reset();
    const r = await aggregateRun('webgpu');
    const counted = { ...gpuCounters };
    r.engine.dispose();

    assert.ok(counted.chunks > 1);
    assert.equal(counted.submits, counted.chunks, 'one submit per computed chunk');
    assert.equal(counted.maps, counted.chunks, 'one map per computed chunk');
  },
);

test(
  '§18 6n: standalone aggregate() on the GPU equals the inline run',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    const r = await aggregateRun('webgpu');
    const redone: AggregateResult[] = [];
    await r.engine.aggregate(r.chunks, AGG_SPEC, { onAggregate: (a) => redone.push(a) });
    redone.sort((a, b) => a.chunkId - b.chunkId);
    assert.equal(redone.length, r.out.length);
    r.out.forEach((a, i) => assertSameAggregate(a, redone[i], `chunk ${a.chunkId}`));
    r.engine.dispose();
  },
);

test(
  '§11.1: a chunk over the readback budget is rejected by name, not by an OOM',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    // The device's maxBufferSize says nothing about whether the JS heap can copy
    // the mapped range out; without this check that failure arrives as a bare
    // "Array buffer allocation failed" naming nothing.
    const engine = new CoverageEngine({ onWarning: () => {} });
    await engine.init({ ...AGG_WS, backend: 'webgpu', maxChunkReadbackBytes: 1024 });
    await engine.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
    await engine.setSampling({ regions: [{ type: 'full' }] });
    engine.setCameras([camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);

    await assert.rejects(
      () => engine.compute({ mode: 1, onChunkDone: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.code, EngineErrorCode.SCENE_TOO_LARGE);
        assert.match(err.message, /chunkSizeXZ/, 'the message must name the knob that fixes it');
        return true;
      },
    );
    engine.dispose();
  },
);

// §18 6x / 6y: pooled per-chunk buffers ------------------------------------
test('§18 6x: a pooled multi-chunk run carries nothing between chunks', { skip: !available && 'no WebGPU adapter available' }, async () => {
  // Buffers are reused across chunks now, and WebGPU zero-initializes at
  // *creation* only. Any accumulator missing its per-chunk clear would carry the
  // previous chunk's bits — a plausible wrong number, never an error. The proof
  // is that a multi-chunk run equals running each chunk against a fresh engine,
  // whose pool starts empty.
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [30, 3, 30], voxelSize: 0.3, chunkSizeXZ: 6,
  };
  const cams = [
    camera('a', [5, 1.5, 25], LOOK_NEG_Z),
    camera('b', [25, 1.5, 25], LOOK_NEG_Z),
    camera('c', [15, 1.5, 5], [0, 1, 0, 0]),
  ];
  const scene = box([13, 0, 13], [17, 3, 17]);
  const spec: AggregateSpec = {
    regions: [{ center: [15, 1.5, 15], rotation: [0, 0, 0, 1], halfSize: [12, 1.4, 12], groups: [0] }],
    columns: [{ axis: 1, range: [[0, 99], [0, 9], [0, 99]], maskRegions: [] }],
    leafCounts: { maskRegions: [] },
    probes: [[15, 1.5, 15], [3, 1.5, 3]],
  };

  const run = async (chunks?: number[]) => {
    const engine = new CoverageEngine({ onWarning: () => {} });
    await engine.init({ ...ws, backend: 'webgpu', solidDetection: false });
    await engine.loadScene(scene);
    await engine.setSampling({ regions: [{ type: 'full' }] });
    engine.setCameras(cams);
    const stats = new Map<number, ChunkResult['stats']>();
    const aggs = new Map<number, AggregateResult>();
    await engine.compute({
      mode: 1, chunks, aggregate: spec,
      // Keyed by the id each callback is given: a pre-culled chunk still
      // aggregates (§19.4) while emitting no chunk, so the two streams do not
      // pair up positionally.
      onChunkDone: (id, r) => { stats.set(id, r.stats); },
      onAggregate: (a) => { aggs.set(a.chunkId, a); },
    });
    engine.dispose();
    return { stats, aggs };
  };

  const together = await run();
  assert.ok(together.aggs.size >= 9, `expected a multi-chunk run, got ${together.aggs.size}`);
  assert.ok(together.stats.size > 1, 'expected several chunks to survive pre-cull');

  // One chunk per engine: every pool starts empty, so nothing can bleed in.
  for (const chunkId of together.aggs.keys()) {
    const alone = await run([chunkId]);
    const a = together.aggs.get(chunkId)!;
    const b = alone.aggs.get(chunkId)!;
    assert.deepEqual(together.stats.get(chunkId), alone.stats.get(chunkId), `chunk ${chunkId} stats`);
    for (const key of ['index', 'size', 'count'] as const) {
      assert.deepEqual(
        Array.from(a.leafCounts?.[key] ?? []),
        Array.from(b.leafCounts?.[key] ?? []),
        `chunk ${chunkId} leafCounts.${key}`,
      );
    }
    assert.deepEqual(a.regions, b.regions, `chunk ${chunkId} regions`);
    assert.deepEqual(a.groups, b.groups, `chunk ${chunkId} groups`);
    assert.deepEqual(a.columns, b.columns, `chunk ${chunkId} columns`);
    assert.deepEqual(a.probeHits, b.probeHits, `chunk ${chunkId} probeHits`);
    assert.deepEqual(a.probeMasks, b.probeMasks, `chunk ${chunkId} probeMasks`);
  }
});

test('§18 6y: buffer creation does not scale with chunk count', { skip: !available && 'no WebGPU adapter available' }, async () => {
  // The regression this guards: ~18 GPUBuffers created and destroyed per chunk.
  // At a 4,928-chunk partition that is ~88,700 create/destroy cycles in one run,
  // and a driver reclaims a destroyed buffer's mappable memory asynchronously —
  // so the loop outruns reclamation and fails inside the readback naming nothing.
  const { gpuCounters } = await import('../src/compute/webgpu.ts');
  const cams = [camera('a', [15, 1.5, 28], LOOK_NEG_Z), camera('b', [5, 1.5, 28], LOOK_NEG_Z)];
  const scene = box([13, 0, 13], [17, 3, 17]);

  const created = async (chunkSizeXZ: number) => {
    const engine = new CoverageEngine({ onWarning: () => {} });
    await engine.init({
      worldMin: [0, 0, 0], worldMax: [30, 3, 30], voxelSize: 0.3, chunkSizeXZ,
      backend: 'webgpu', solidDetection: false,
    });
    await engine.loadScene(scene);
    await engine.setSampling({ regions: [{ type: 'full' }] });
    engine.setCameras(cams);
    gpuCounters.reset();
    const summary = await engine.compute({
      mode: 1,
      aggregate: { leafCounts: { maskRegions: [] } },
      onChunkDone: () => {},
      onAggregate: () => {},
    });
    const out = { buffers: gpuCounters.buffersCreated, chunks: gpuCounters.chunks, rate: summary.overallRate };
    engine.dispose();
    return out;
  };

  const coarse = await created(30); // 1 chunk
  const fine = await created(3);    // 100 chunks

  assert.ok(fine.chunks > coarse.chunks * 8, `expected many more chunks, got ${fine.chunks} vs ${coarse.chunks}`);
  // A sanity bound, not an equality: the coverage rate is **not** exactly
  // partition-invariant, and never was. §11 computes a voxel centre from the
  // chunk origin, so `worldMin + i0·vs + (i+0.5)·vs` drifts against a different
  // partition and voxels sitting on an occlusion boundary flip. The CPU backend
  // shows the same spread, so this is not the pool. What the bound is for is
  // catching a pool that carries state between chunks, which moves the rate far
  // more than a boundary voxel does.
  assert.ok(Math.abs(fine.rate - coarse.rate) < 1e-3, `rate ${fine.rate} vs ${coarse.rate}`);
  // A pool sized on the first chunk; the rest reuse. Allow a small constant for
  // the initial grow, but nothing proportional to the chunk count.
  assert.ok(
    fine.buffers <= coarse.buffers + 8,
    `${fine.buffers} buffers for ${fine.chunks} chunks vs ${coarse.buffers} for ${coarse.chunks} — the pool is not being reused`,
  );
});

/**
 * A run that asks for aggregation but for **no** probes and **no** per-voxel
 * output — the shape the app takes on every stats-only re-run.
 */
async function statsOnlyAggregateRun(backend: 'cpu' | 'webgpu') {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...AGG_WS, backend, solidDetection: true });
  await engine.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras([
    camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z),
    camera('b', [3.15, 1.65, 0.6], [0, 1, 0, 0]),
  ]);
  const out: AggregateResult[] = [];
  await engine.compute({
    mode: 1,
    // Everything AGG_SPEC asks for except probes — nothing here needs the masks
    // on the CPU, so the backend has no reason to read `visibility` back.
    aggregate: { ...AGG_SPEC, probes: [] },
    // Deliberately no `onChunkDone`: this is a stats-only run (§11.1).
    onAggregate: (r) => out.push(r),
  });
  out.sort((a, b) => a.chunkId - b.chunkId);
  engine.dispose();
  return out;
}

test(
  '§19.4/§19.5: onAggregate fires on a stats-only run with no probes',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    // The regression: the WebGPU backend gated the whole `AggregateResult` on
    // having read `visibility` back. Only probe resolution (§19.3) needs the
    // masks on the CPU, so a descriptor with no probes and no `onChunkDone`
    // ran Passes 4–6, copied the accumulators into the staging buffer, mapped
    // them — and returned `undefined`. `onAggregate` never fired, while the CPU
    // backend returned the result, breaking §19.5 parity in the one direction
    // no assertion covered. The app never saw it because `retainChunks` forces
    // per-voxel output on.
    const gpu2 = await statsOnlyAggregateRun('webgpu');
    assert.ok(gpu2.length > 0, 'onAggregate never fired on the GPU stats-only run');

    const cpu = await statsOnlyAggregateRun('cpu');
    assert.equal(gpu2.length, cpu.length, 'chunk count differs between backends');
    gpu2.forEach((g, i) => assertSameAggregate(g, cpu[i], `stats-only chunk ${i}`));

    // The primitives that do not need the masks are all present and populated.
    const withRegions = gpu2.find((r) => (r.regions?.length ?? 0) > 0);
    assert.ok(withRegions, 'no chunk carried region accumulators');
    assert.ok(gpu2.some((r) => (r.columns?.length ?? 0) > 0), 'no chunk carried columns');
    assert.ok(gpu2.some((r) => (r.leafCounts?.index.length ?? 0) > 0), 'no chunk carried leafCounts');
    // Probes were not asked for, so they are absent — not empty-but-present.
    assert.equal(gpu2.every((r) => r.probeMasks === undefined), true);
  },
);

test(
  '§11.1: the pool reports a peak, not just what is resident now',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    const { gpuCounters } = await import('../src/compute/webgpu.ts');
    const engine = new CoverageEngine({ onWarning: () => {} });
    await engine.init({ ...AGG_WS, backend: 'webgpu', solidDetection: true });
    await engine.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
    await engine.setSampling({ regions: [{ type: 'full' }] });
    engine.setCameras([camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);
    gpuCounters.reset();
    await engine.compute({ mode: 1, onChunkDone: () => {} });

    assert.ok(gpuCounters.peakPoolBytes > 0, 'peak never moved off zero');
    // The peak is a high-water mark, so it can never sit below the live gauge.
    assert.ok(
      gpuCounters.peakPoolBytes >= gpuCounters.poolBytes,
      `peak ${gpuCounters.peakPoolBytes} below live ${gpuCounters.poolBytes}`,
    );

    // Disposal frees the pool: the gauge drops to zero, the peak remembers.
    const peakBefore = gpuCounters.peakPoolBytes;
    engine.dispose();
    assert.equal(gpuCounters.poolBytes, 0, 'dispose left bytes on the gauge');
    assert.equal(gpuCounters.peakPoolBytes, peakBefore, 'dispose erased the peak');
  },
);

test(
  '§11.1: standalone aggregation honours the readback budget too',
  { skip: !available && 'no WebGPU adapter available' },
  async () => {
    // `aggregateChunk` copies every accumulator segment out of the mapped range
    // into a JS TypedArray exactly as `computeChunk` does, so the host-heap
    // budget binds on both. It previously checked only the device's
    // `maxBufferSize`, which is the limit a tall site crosses *second*.
    const r = await aggregateRun('webgpu');
    const engine = r.engine as unknown as { backend: { maxChunkReadbackBytes: number } };
    const restore = engine.backend.maxChunkReadbackBytes;
    engine.backend.maxChunkReadbackBytes = 1024; // smaller than any real chunk

    await assert.rejects(
      () => r.engine.aggregate(r.chunks, AGG_SPEC, { onAggregate: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof EngineError, `expected EngineError, got ${err}`);
        assert.equal(err.code, EngineErrorCode.SCENE_TOO_LARGE);
        assert.match(err.message, /readback/i);
        // The message has to name the knobs, not just the number (§17).
        assert.match(err.message, /chunkSizeXZ|voxelSize|leafCounts/);
        return true;
      },
    );

    engine.backend.maxChunkReadbackBytes = restore;
    r.engine.dispose();
  },
);
