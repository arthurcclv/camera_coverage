/**
 * §6.2 occupancy materialization acceptance tests (§18, 6u–6w).
 *
 * The property under test is that *where* occupancy is materialized cannot
 * change *what* it says. The per-chunk source exists purely to avoid retaining a
 * workspace-scale array, so any classification difference between it and the
 * dense grid is a bug in this module and nowhere else — and it would surface as
 * a slightly wrong coverage percentage, never as a crash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoverageEngine } from '../src/engine.ts';
import { WorkspaceGrid, suggestChunkSizeXZ } from '../src/grid.ts';
import { cleanMesh } from '../src/geometry/mesh.ts';
import {
  ChunkOccupancy,
  DenseOccupancy,
  occupancyCounters,
  type OccupancySource,
} from '../src/occupancy.ts';
import { installHost } from '../src/worker/host.ts';
import { WorkerClient } from '../src/worker/client.ts';
import { loopback } from '../src/worker/protocol.ts';
import {
  CellType,
  EngineError,
  EngineErrorCode,
  type SceneMesh,
  type Vec3,
  type WorkspaceConfig,
} from '../src/types.ts';
import { box, camera, LOOK_NEG_Z } from './helpers.ts';

/**
 * Compare two sources chunk by chunk. SOLID exists only on the dense path (the
 * flood fill is global, §6.2), so it reads back as EMPTY: what both sources must
 * agree on is the voxelization.
 */
function assertSameVoxelization(
  a: OccupancySource,
  b: OccupancySource,
  grid: WorkspaceGrid,
): { voxels: number; mixed: number } {
  let voxels = 0;
  let mixed = 0;
  for (const chunk of grid.chunks()) {
    // Both hand out reused scratch, so one must be copied before asking the other.
    const ca = Uint8Array.from(a.cellsForChunk(chunk));
    const cb = b.cellsForChunk(chunk);
    assert.equal(ca.length, cb.length, `chunk ${chunk.chunkId} length`);
    for (let i = 0; i < ca.length; i++) {
      voxels++;
      const ma = ca[i] === CellType.MixedSpace;
      if (ma) mixed++;
      assert.equal(ma, cb[i] === CellType.MixedSpace, `chunk ${chunk.chunkId} voxel ${i}`);
    }
  }
  return { voxels, mixed };
}

test('§18 6u: per-chunk occupancy equals the dense voxelization', () => {
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.1, chunkSizeXZ: 2,
  };
  const grid = new WorkspaceGrid(ws);
  const clean = cleanMesh(box([1.2, 0.4, 1.2], [4.6, 2.4, 4.6]));
  const { voxels, mixed } = assertSameVoxelization(
    DenseOccupancy.build(grid, clean),
    new ChunkOccupancy(grid, clean),
    grid,
  );
  const [gx, gy, gz] = grid.gridDims;
  assert.equal(voxels, gx * gy * gz, 'covered the whole grid');
  assert.ok(mixed > 0, 'the scene must actually mark some cells MIXED');
});

test('§18 6u: chunk seams agree even where the origin arithmetic drifts', () => {
  // A voxel center taken off the *chunk* origin is not bit-identical to one
  // taken off `worldMin` — `worldMin + (i0 + i + 0.5) * vs` vs
  // `(worldMin + i0 * vs) + (i + 0.5) * vs`. The first cut of the per-chunk
  // source did the latter and reclassified ~48k of 97M voxels at chunk seams,
  // which no small-grid test noticed. Hence: an unaligned origin, a voxel size
  // with no exact binary form, many chunks, and geometry lying *on* the seams.
  const ws: WorkspaceConfig = {
    worldMin: [-3.7, 0.3, 11.9], worldMax: [16.3, 2.3, 31.9], voxelSize: 0.1, chunkSizeXZ: 1,
  };
  const grid = new WorkspaceGrid(ws);
  assert.ok(grid.chunkCount >= 400, `expected many chunks, got ${grid.chunkCount}`);

  // Walls at every chunk boundary, so the seam voxels are the contested ones.
  const pos: number[] = [];
  const idx: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) pos.push(p[0], p[1], p[2]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let n = 1; n < 20; n++) {
    const x = -3.7 + n * 1;
    quad([x, 0.3, 11.9], [x, 0.3, 31.9], [x, 2.3, 31.9], [x, 2.3, 11.9]);
    const z = 11.9 + n * 1;
    quad([-3.7, 0.3, z], [16.3, 0.3, z], [16.3, 2.3, z], [-3.7, 2.3, z]);
  }
  const clean = cleanMesh({
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
  });
  const { mixed } = assertSameVoxelization(
    DenseOccupancy.build(grid, clean),
    new ChunkOccupancy(grid, clean),
    grid,
  );
  assert.ok(mixed > 10_000, `expected the seams to be marked, got ${mixed}`);
});

test('§18 6u: validVoxels is unchanged by where occupancy is materialized', async () => {
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.1, chunkSizeXZ: 2,
  };
  const mesh: SceneMesh = box([1.2, 0.4, 1.2], [4.6, 2.4, 4.6]);
  const grid = new WorkspaceGrid(ws);
  const clean = cleanMesh({ positions: mesh.positions.slice(), indices: mesh.indices.slice() });
  const dense = DenseOccupancy.build(grid, clean);

  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...ws, backend: 'cpu', solidDetection: false });
  await engine.loadScene({ positions: mesh.positions.slice(), indices: mesh.indices.slice() });
  const stats = await engine.setSampling({ regions: [{ type: 'full' }] });

  // The dense grid's EMPTY count, minus what only its flood fill can cull.
  let empty = 0;
  for (const chunk of grid.chunks()) {
    const cells = dense.cellsForChunk(chunk);
    for (let i = 0; i < cells.length; i++) if (cells[i] === CellType.EmptySpace) empty++;
  }
  assert.equal(stats.validVoxels, empty + dense.solidCount!,
    'per-chunk validity must equal the dense grid with SOLID read as EMPTY');
  engine.dispose();
});

test('§18 6v: nothing workspace-wide survives loadScene + setSampling', async () => {
  // 30 × 4 × 30 m at 0.1 m ⇒ 3.6M workspace voxels in 9 chunks of 400k. The
  // regression this guards is a single `Uint8Array` over the whole grid: 95.4
  // MiB at the scale a real site reaches, retained for the session, and the
  // largest allocation the engine made.
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [30, 4, 30], voxelSize: 0.1, chunkSizeXZ: 10,
  };
  const grid = new WorkspaceGrid(ws);
  const workspaceVoxels = grid.gridDims[0] * grid.gridDims[1] * grid.gridDims[2];
  const chunkVoxels = grid.chunk(0).voxelCount;
  assert.ok(workspaceVoxels / chunkVoxels >= 8, 'need a genuinely multi-chunk workspace');

  const OrigU8 = globalThis.Uint8Array;
  let largest = 0;
  class Traced extends OrigU8 {
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      if (this.byteLength > largest) largest = this.byteLength;
    }
  }
  (globalThis as { Uint8Array: unknown }).Uint8Array = Traced;
  try {
    const engine = new CoverageEngine({ onWarning: () => {} });
    await engine.init({ ...ws, backend: 'cpu', solidDetection: false });
    await engine.loadScene(box([5, 0.5, 5], [25, 3.5, 25]));
    await engine.setSampling({ regions: [{ type: 'full' }] });
    engine.dispose();
  } finally {
    (globalThis as { Uint8Array: unknown }).Uint8Array = OrigU8;
  }

  // One chunk's cells is the legitimate peak; the workspace grid is not.
  assert.ok(
    largest <= 2 * chunkVoxels,
    `largest Uint8Array was ${largest} bytes for a ${chunkVoxels}-voxel chunk — ` +
      `something is sized by the workspace (${workspaceVoxels} voxels)`,
  );
});

test('§18 6w: a camera edit never voxelizes', async () => {
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [8, 3, 8], voxelSize: 0.1, chunkSizeXZ: 2,
  };
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...ws, backend: 'cpu', solidDetection: false });
  await engine.loadScene(box([2, 0.5, 2], [6, 2.5, 6]));
  await engine.setSampling({ regions: [{ type: 'full' }] });

  // setSampling warmed every chunk (§6.4), so nothing below may build again.
  occupancyCounters.reset();
  engine.setCameras([camera('a', [1, 1.5, 1] as Vec3, LOOK_NEG_Z)]);
  await engine.compute({ mode: 1 });
  engine.setCameras([camera('a', [1.4, 1.5, 1.2] as Vec3, LOOK_NEG_Z)]);
  await engine.compute({ mode: 1 });
  assert.equal(occupancyCounters.chunkBuilds, 0, 'a camera edit voxelized');
  assert.equal(occupancyCounters.denseBuilds, 0, 'a workspace grid was materialized');
  engine.dispose();
});

test('§18 6w: the SOLID camera test is skipped when solid detection is off', async () => {
  // A camera inside the closed box: flagged with solid detection on, and with it
  // off the question is not even asked — no cell can be SOLID, so answering it
  // would voxelize the camera's chunk for a `false` already known (§6.2).
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.1, chunkSizeXZ: 2,
  };
  const inside = camera('c', [3, 1.5, 3] as Vec3, LOOK_NEG_Z);

  const warnings: string[] = [];
  const on = new CoverageEngine({ onWarning: (code) => warnings.push(code) });
  await on.init({ ...ws, backend: 'cpu', solidDetection: true });
  await on.loadScene(box([1.2, 0.4, 1.2], [4.6, 2.4, 4.6]));
  await on.setSampling({ regions: [{ type: 'full' }] });
  on.setCameras([inside]);
  assert.ok(warnings.includes('CAMERA_INSIDE_GEOMETRY'), 'expected the camera to be flagged');
  on.dispose();

  const off = new CoverageEngine({ onWarning: () => {} });
  await off.init({ ...ws, backend: 'cpu', solidDetection: false });
  await off.loadScene(box([1.2, 0.4, 1.2], [4.6, 2.4, 4.6]));
  await off.setSampling({ regions: [{ type: 'full' }] });
  occupancyCounters.reset();
  off.setCameras([inside]);
  assert.equal(occupancyCounters.chunkBuilds, 0, 'the skipped test voxelized anyway');
  off.dispose();
});

test('§16.1: re-init releases the previous engine and its retained chunks', async () => {
  const disposed: number[] = [];
  let created = 0;
  const [a, b] = loopback();
  installHost(b, {
    retainChunks: true,
    createEngine: () => {
      const id = created++;
      const engine = new CoverageEngine({ onWarning: () => {} });
      const original = engine.dispose.bind(engine);
      engine.dispose = () => { disposed.push(id); original(); };
      return engine;
    },
  });
  const client = new WorkerClient(a);
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [4, 2, 4], voxelSize: 0.2, chunkSizeXZ: 2,
  };
  const mesh = box([1, 0.4, 1], [3, 1.6, 3]);

  const load = async (voxelSize: number) => {
    await client.init({ ...ws, voxelSize, backend: 'cpu', solidDetection: false });
    await client.loadScene({ positions: mesh.positions.slice(), indices: mesh.indices.slice() });
    await client.setSampling({ regions: [{ type: 'full' }] });
    client.setCameras([camera('a', [0.5, 1, 0.5] as Vec3, LOOK_NEG_Z)]);
    await client.compute({ mode: 1 });
  };

  await load(0.2);
  assert.deepEqual(disposed, [], 'nothing to release on the first init');
  await load(0.1);
  assert.deepEqual(disposed, [0], 'the first engine was not released on re-init');

  // The retained chunks went with it: a re-init reshapes the grid, so those ids
  // describe a different partition. Re-aggregating must answer over the new run.
  const results: number[] = [];
  await client.aggregateRetained(
    { leafCounts: { maskRegions: [] } },
    { onAggregate: (r) => results.push(r.chunkId) },
  );
  assert.ok(results.length > 0, 'the new run retained nothing');
  const chunkCount = new WorkspaceGrid({ ...ws, voxelSize: 0.1 }).chunkCount;
  assert.ok(
    results.every((id) => id < chunkCount),
    `retained a chunk id outside the new partition: ${results.join(',')}`,
  );
  await client.dispose();
});

// §3 chunk partitioning, §18 6z ---------------------------------------------

test('§3: chunkSizeXZ is derived so a chunk lands near the target voxel count', () => {
  // The §3 defaults must come out unchanged — this is a generalization of the
  // constant, not a replacement for it.
  assert.equal(
    suggestChunkSizeXZ([0, 0, 0], [100, 20, 100], 0.1),
    10,
    'the spec default must be reproduced exactly',
  );

  // The site that exposed the problem: 440 × 201 × 1120 m at 1.0 m voxels. A
  // pinned 10 m gives 4,928 chunks of 20,100 voxels.
  const big = suggestChunkSizeXZ([0, 0, 0], [440, 201, 1120], 1.0);
  const pinned = new WorkspaceGrid({
    worldMin: [0, 0, 0], worldMax: [440, 201, 1120], voxelSize: 1.0, chunkSizeXZ: 10,
  });
  const derived = new WorkspaceGrid({
    worldMin: [0, 0, 0], worldMax: [440, 201, 1120], voxelSize: 1.0, chunkSizeXZ: big,
  });
  assert.ok(pinned.chunkCount > 4000, `sanity: pinned gives ${pinned.chunkCount} chunks`);
  assert.ok(
    derived.chunkCount < pinned.chunkCount / 50,
    `${derived.chunkCount} chunks vs ${pinned.chunkCount} — the derivation did not help`,
  );
  const voxels = derived.chunk(0).voxelCount;
  assert.ok(
    voxels > 1_000_000 && voxels <= 4_000_000,
    `chunk of ${voxels} voxels is not near the 2M target`,
  );

  // Degenerate inputs stay legal: never finer than one voxel, never coarser
  // than the workspace.
  assert.ok(suggestChunkSizeXZ([0, 0, 0], [1, 500, 1], 0.01) >= 0.01);
  const tiny = suggestChunkSizeXZ([0, 0, 0], [2, 2, 2], 1.0);
  assert.ok(tiny >= 1.0 && tiny <= 2.0, `got ${tiny}`);
});

test('§3: the suggestion is clamped by §11.1\'s readback budget, not only the dispatch limit', () => {
  const site: [Vec3, Vec3] = [[0, 0, 0], [440, 201, 1120]];

  // The default (1 camera → 1 word) is the permissive end and must not move the
  // §3 worked examples.
  assert.equal(suggestChunkSizeXZ([0, 0, 0], [100, 20, 100], 0.1), 10);

  // Camera count is what tightens it: readback is `CAM_WORDS × 4` bytes per
  // voxel plus ~1.13 B for leafCounts, so 96 cameras (3 words) cost more than
  // twice what 1 camera does, for the same voxels.
  const one = suggestChunkSizeXZ(...site, 1.0, { numCameras: 1 });
  const many = suggestChunkSizeXZ(...site, 1.0, { numCameras: 96 });
  assert.ok(many <= one, `${many} m at 96 cameras should not exceed ${one} m at 1`);

  // The clamp is real, not cosmetic: the chunk it proposes must fit the budget
  // it was given. This is the check that was missing — the suggestion itself
  // used to hand `computeChunk` a chunk the backend then had to reject.
  const budget = 64 * 1024 * 1024;
  const size = suggestChunkSizeXZ(...site, 1.0, { numCameras: 96, maxReadbackBytes: budget });
  const grid = new WorkspaceGrid({
    worldMin: site[0], worldMax: site[1], voxelSize: 1.0, chunkSizeXZ: size,
  });
  const camWords = Math.ceil(96 / 32);
  const readback = grid.chunk(0).voxelCount * (camWords * 4 + 1 + 1 / 8);
  assert.ok(readback <= budget, `chunk needs ${readback} B, budget is ${budget} B`);

  // A budget so small only a sliver fits still returns a legal size, never 0.
  assert.ok(suggestChunkSizeXZ(...site, 1.0, { numCameras: 96, maxReadbackBytes: 1024 }) >= 1.0);
});

test('§18 6z: a worker failure reaches the client with its stack and detail', async () => {
  const [a, b] = loopback();
  installHost(b, {
    createEngine: () => {
      const engine = new CoverageEngine({ onWarning: () => {} });
      // A plain (non-`EngineError`) throw — the shape an allocation failure has.
      engine.loadScene = () => {
        throw new Error('Array buffer allocation failed');
      };
      return engine;
    },
  });
  const client = new WorkerClient(a);
  await client.init({
    worldMin: [0, 0, 0], worldMax: [2, 2, 2], voxelSize: 0.5, chunkSizeXZ: 2,
    backend: 'cpu', solidDetection: false,
  });

  const err = await client
    .loadScene(box([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]))
    .then(() => null, (e: unknown) => e);

  assert.ok(err instanceof EngineError, 'expected an EngineError');
  assert.equal(err.code, EngineErrorCode.INVALID_STATE, 'a bare throw still maps to INVALID_STATE');
  assert.match(err.message, /Array buffer allocation failed/);
  // The point of the change: the frame that threw survives the boundary. Without
  // it this error names neither the allocation, its size, nor where it happened.
  assert.ok(err.stack?.includes('--- worker ---'), 'the worker stack was dropped');
  assert.match(err.stack!, /host\.ts|engine\.ts|occupancy\.test\.ts/, `stack was empty: ${err.stack}`);
  await client.dispose();
});

test('§18 6z: an EngineError keeps its detail across the boundary', async () => {
  const [a, b] = loopback();
  installHost(b, {
    createEngine: () => {
      const engine = new CoverageEngine({ onWarning: () => {} });
      engine.loadScene = () => {
        throw new EngineError(EngineErrorCode.SCENE_TOO_LARGE, 'readback too large', {
          requestedBytes: 1234,
          dims: [10, 201, 10],
          camWords: 3,
        });
      };
      return engine;
    },
  });
  const client = new WorkerClient(a);
  await client.init({
    worldMin: [0, 0, 0], worldMax: [2, 2, 2], voxelSize: 0.5, chunkSizeXZ: 2,
    backend: 'cpu', solidDetection: false,
  });
  const err = (await client
    .loadScene(box([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]))
    .then(() => null, (e: unknown) => e)) as EngineError;

  assert.equal(err.code, EngineErrorCode.SCENE_TOO_LARGE);
  assert.deepEqual(err.detail, { requestedBytes: 1234, dims: [10, 201, 10], camWords: 3 });
  await client.dispose();
});
