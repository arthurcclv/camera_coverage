/**
 * §19 aggregation acceptance tests (§18, 6m–6r).
 *
 * 6l (backend parity) and 6o (one submission per chunk) need a real device and
 * live in `webgpu.test.ts`; everything here is backend-independent and runs on
 * the CPU reference under `npm test`.
 *
 * The reference scan below is deliberately written the naive way — one loop, no
 * packing, no bit tricks — because its whole job is to be a second opinion. If
 * it shared `aggregate.ts`'s helpers it would agree with the implementation for
 * the wrong reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoverageEngine } from '../src/engine.ts';
import { EngineErrorCode, EngineError } from '../src/types.ts';
import type { ChunkResult, Quat, Vec3, WorkspaceConfig } from '../src/types.ts';
import {
  COLUMN_MIN_EMPTY,
  MAX_AGGREGATE_GROUPS,
  ProbeHit,
  emptyColumns,
  emptyRegions,
  mergeColumns,
  mergeRegions,
  mergeLeafCounts,
  packAggregate,
  planeAxes,
  aggregateChunkCPU,
  type AggregateRegion,
  type AggregateResult,
  type AggregateSpec,
  type ColumnAccum,
  type LeafCounts,
} from '../src/aggregate.ts';
import { accessor } from '../src/results.ts';
import { prepareCamera } from '../src/camera.ts';
import { box, camera, LOOK_NEG_Z, LOOK_POS_Z } from './helpers.ts';

const IDENTITY: Quat = [0, 0, 0, 1];
const GROUPS = MAX_AGGREGATE_GROUPS;

const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 10 };
/** Same workspace, partitioned so the aggregation has to merge across chunks. */
const WS_SPLIT: WorkspaceConfig = { ...WS, chunkSizeXZ: 3 };

function region(
  center: Vec3,
  halfSize: Vec3,
  groups: number[] = [0],
  rotation: Quat = IDENTITY,
): AggregateRegion {
  return { center, rotation, halfSize, groups };
}

interface Run {
  engine: CoverageEngine;
  chunks: ChunkResult[];
  aggregates: AggregateResult[];
  numCameras: number;
  camWords: number;
}

async function run(
  ws: WorkspaceConfig,
  spec: AggregateSpec | undefined,
  cams = [camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z), camera('b', [3.15, 1.65, 0.6], LOOK_POS_Z)],
): Promise<Run> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...ws, backend: 'cpu', solidDetection: true });
  await engine.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(cams);
  const chunks: ChunkResult[] = [];
  const aggregates: AggregateResult[] = [];
  await engine.compute({
    mode: 1,
    aggregate: spec,
    onChunkDone: (_id, r) => chunks.push(r),
    onAggregate: (r) => aggregates.push(r),
  });
  return { engine, chunks, aggregates, numCameras: cams.length, camWords: chunks[0]?.camWords ?? 1 };
}

// ---------------------------------------------------------------------------
// Independent reference scan
// ---------------------------------------------------------------------------

function inBox(p: Vec3, r: AggregateRegion): boolean {
  // Rotate world→local by the conjugate quaternion, the long way round.
  const d: Vec3 = [p[0] - r.center[0], p[1] - r.center[1], p[2] - r.center[2]];
  const [qx, qy, qz, qw] = [-r.rotation[0], -r.rotation[1], -r.rotation[2], r.rotation[3]];
  const tx = 2 * (qy * d[2] - qz * d[1]);
  const ty = 2 * (qz * d[0] - qx * d[2]);
  const tz = 2 * (qx * d[1] - qy * d[0]);
  const l: Vec3 = [
    d[0] + qw * tx + (qy * tz - qz * ty),
    d[1] + qw * ty + (qz * tx - qx * tz),
    d[2] + qw * tz + (qx * ty - qy * tx),
  ];
  return (
    Math.abs(l[0]) <= r.halfSize[0] &&
    Math.abs(l[1]) <= r.halfSize[1] &&
    Math.abs(l[2]) <= r.halfSize[2]
  );
}

interface RefRegion {
  valid: number;
  covered: number;
  blind: number;
  seen: number[];
}

/**
 * Scan one chunk the obvious way. Returns `regions.length` per-region entries
 * followed by MAX_AGGREGATE_GROUPS group entries, matching §19.2.
 */
function refRegions(chunk: ChunkResult, regions: AggregateRegion[], numCameras: number): RefRegion[] {
  const out: RefRegion[] = Array.from({ length: regions.length + GROUPS }, () => ({
    valid: 0,
    covered: 0,
    blind: 0,
    seen: new Array<number>(numCameras).fill(0),
  }));
  const acc = accessor(chunk);
  const [nx, ny, nz] = chunk.dims;
  const vs = chunk.voxelSize;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!acc.isValid(i, j, k)) continue;
        const p: Vec3 = [
          chunk.origin[0] + (i + 0.5) * vs,
          chunk.origin[1] + (j + 0.5) * vs,
          chunk.origin[2] + (k + 0.5) * vs,
        ];
        const seenBy: number[] = [];
        for (let c = 0; c < numCameras; c++) {
          const w = c >>> 5;
          if (w < chunk.camWords && ((acc.getMaskWord(i, j, k, w) >>> (c & 31)) & 1) === 1) seenBy.push(c);
        }
        const hitGroups = new Set<number>();
        regions.forEach((r, ri) => {
          if (!inBox(p, r)) return;
          for (const g of r.groups) hitGroups.add(g);
          bump(out[ri], seenBy);
        });
        for (const g of hitGroups) bump(out[regions.length + g], seenBy);
      }
    }
  }
  return out;
}

function bump(a: RefRegion, seenBy: number[]): void {
  a.valid += 1;
  if (seenBy.length > 0) a.covered += 1;
  else a.blind += 1;
  for (const c of seenBy) a.seen[c] += 1;
}

function sumRefRegions(parts: RefRegion[][]): RefRegion[] {
  const total = parts[0].map((r) => ({
    valid: 0,
    covered: 0,
    blind: 0,
    seen: new Array<number>(r.seen.length).fill(0),
  }));
  for (const part of parts) {
    part.forEach((r, i) => {
      total[i].valid += r.valid;
      total[i].covered += r.covered;
      total[i].blind += r.blind;
      r.seen.forEach((v, c) => (total[i].seen[c] += v));
    });
  }
  return total;
}

/** Merge per-region and per-group accumulators into one array laid out like `refRegions`. */
function mergeAll(results: AggregateResult[], regionCount: number, numCameras: number) {
  const totals = emptyRegions(regionCount + GROUPS, numCameras);
  for (const r of results) {
    if (r.regions) mergeRegions(totals, r.regions);
    if (r.groups) mergeRegions(totals.slice(regionCount), r.groups);
  }
  return totals;
}

function mergeSlab(results: AggregateResult[], slab: number, camWords: number): ColumnAccum {
  const first = results.find((r) => r.columns)!.columns![slab];
  const total = emptyColumns(first.dimsA, first.dimsB, camWords);
  for (const r of results) if (r.columns) mergeColumns(total, r.columns[slab], camWords);
  return total;
}

// ---------------------------------------------------------------------------
// 6m — region aggregation matches an independent scan
// ---------------------------------------------------------------------------

test('§18 6m: region accumulators match an independent scalar scan', async () => {
  const regions = [
    region([1.5, 1.5, 1.5], [1.2, 1.2, 1.2]),
    region([4.5, 1.5, 4.5], [1.5, 1.5, 1.5]),
    // Rotated 45° about Y — the case an AABB region could not express (§19.1).
    region([3.0, 1.5, 3.0], [1.0, 1.4, 0.6], [0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]),
  ];
  const r = await run(WS, { regions });
  const got = mergeAll(r.aggregates, regions.length, r.numCameras);
  const want = sumRefRegions(r.chunks.map((c) => refRegions(c, regions, r.numCameras)));

  assert.equal(got.length, want.length);
  got.forEach((a, i) => {
    assert.equal(a.valid, want[i].valid, `region ${i} valid`);
    assert.equal(a.covered, want[i].covered, `region ${i} covered`);
    assert.equal(a.blind, want[i].blind, `region ${i} blind`);
    assert.deepEqual(Array.from(a.seen), want[i].seen, `region ${i} seen`);
  });
  // A test that passes because everything is zero proves nothing.
  assert.ok(want[0].valid > 0 && want[regions.length].covered > 0);
  // Group 0 is fed by all three regions; only groups 1..31 stay empty.
  assert.ok(got.slice(regions.length + 1).every((g) => g.valid === 0));
  r.engine.dispose();
});

// ---------------------------------------------------------------------------
// 6p — the union counts an overlapping voxel once
// ---------------------------------------------------------------------------

test('§18 6p: a group counts an overlapping voxel once, not per region', async () => {
  // Two boxes sharing a slab of the workspace, both declared into group 0.
  const regions = [
    region([2.0, 1.5, 3.0], [1.5, 1.5, 3.0]),
    region([3.0, 1.5, 3.0], [1.5, 1.5, 3.0]),
  ];
  const r = await run(WS, { regions });
  const [a, b, group0] = mergeAll(r.aggregates, 2, r.numCameras);

  assert.ok(a.valid > 0 && b.valid > 0);
  // Summing regions double-counts the overlap; the group must not.
  assert.ok(group0.valid < a.valid + b.valid, 'the boxes must actually overlap for this to test anything');
  const want = sumRefRegions(r.chunks.map((c) => refRegions(c, regions, r.numCameras)))[2];
  assert.equal(group0.valid, want.valid);
  assert.equal(group0.covered, want.covered);
  assert.deepEqual(Array.from(group0.seen), want.seen);
  r.engine.dispose();
});

test('§18 6p: a region in no group feeds only its own entry', async () => {
  const regions = [
    region([1.5, 1.5, 1.5], [1.2, 1.2, 1.2], [0]),
    region([4.5, 1.5, 4.5], [1.2, 1.2, 1.2], []),
  ];
  const r = await run(WS, { regions });
  const [inGroup, ungrouped, group0] = mergeAll(r.aggregates, 2, r.numCameras);
  assert.ok(ungrouped.valid > 0, 'the ungrouped region must hold voxels for this to test anything');
  assert.equal(group0.valid, inGroup.valid);
  r.engine.dispose();
});

test('§18 6p: a region in two groups feeds both', async () => {
  const regions = [
    region([1.5, 1.5, 1.5], [1.2, 1.2, 1.2], [0, 3]),
    region([4.5, 1.5, 4.5], [1.2, 1.2, 1.2], [3]),
  ];
  const r = await run(WS, { regions });
  const merged = mergeAll(r.aggregates, 2, r.numCameras);
  const [a, b] = merged;
  const g0 = merged[2 + 0];
  const g3 = merged[2 + 3];
  assert.ok(a.valid > 0 && b.valid > 0);
  assert.equal(g0.valid, a.valid, 'group 0 sees only region 0');
  // The boxes are disjoint, so group 3 is their plain sum — the dedupe path is
  // covered by the overlapping-regions test above.
  assert.equal(g3.valid, a.valid + b.valid, 'group 3 sees both regions');
  r.engine.dispose();
});

// ---------------------------------------------------------------------------
// 6q — column merge is chunk-invariant
// ---------------------------------------------------------------------------

test('§18 6q: column accumulators merge to the same answer across chunk sizes', async () => {
  const grid = { nx: 20, ny: 10, nz: 20 }; // 6 m / 0.3 m
  const spec: AggregateSpec = {
    // collapse Y — the sample app's horizontal section
    columns: [{ axis: 1, range: [[0, grid.nx - 1], [2, 7], [0, grid.nz - 1]], maskRegions: [] }],
  };
  const whole = await run(WS, spec);
  const split = await run(WS_SPLIT, spec);
  assert.ok(split.chunks.length > whole.chunks.length, 'WS_SPLIT must actually partition');

  const a = mergeSlab(whole.aggregates, 0, whole.camWords);
  const b = mergeSlab(split.aggregates, 0, split.camWords);

  assert.deepEqual(Array.from(a.camCountSum), Array.from(b.camCountSum));
  assert.deepEqual(Array.from(a.validCount), Array.from(b.validCount));
  assert.deepEqual(Array.from(a.obstacleCount), Array.from(b.obstacleCount));
  assert.deepEqual(Array.from(a.blindCount), Array.from(b.blindCount));
  assert.deepEqual(Array.from(a.camCountMax), Array.from(b.camCountMax));
  assert.deepEqual(Array.from(a.camCountMin), Array.from(b.camCountMin));
  assert.deepEqual(Array.from(a.seenWords), Array.from(b.seenWords));
  assert.ok(a.validCount.some((v) => v > 0));
  whole.engine.dispose();
  split.engine.dispose();
});

test('§18 6q: a cell no chunk counted keeps the empty-minimum sentinel', async () => {
  // A slab whose Y range sits above the workspace: in range on X/Z, so cells
  // exist, but no voxel is ever counted into them.
  const spec: AggregateSpec = {
    columns: [{ axis: 1, range: [[0, 4], [50, 60], [0, 4]], maskRegions: [] }],
  };
  const r = await run(WS_SPLIT, spec);
  const merged = mergeSlab(r.aggregates, 0, r.camWords);
  assert.ok(merged.camCountMin.every((v) => v === COLUMN_MIN_EMPTY), 'untouched cells keep 0xFF');
  assert.ok(merged.validCount.every((v) => v === 0));
  assert.ok(merged.camCountMax.every((v) => v === 0));
  r.engine.dispose();
});

test('§18 6q: a slab classifies obstacles separately from blind voxels', async () => {
  // The box sits at x 1.5–3.0, z 2.4–3.3: its interior voxels are invalid.
  const spec: AggregateSpec = {
    columns: [{ axis: 1, range: [[0, 19], [0, 9], [0, 19]], maskRegions: [] }],
  };
  const r = await run(WS, spec);
  const merged = mergeSlab(r.aggregates, 0, r.camWords);
  assert.ok(merged.obstacleCount.some((v) => v > 0), 'the scene must contain solid geometry');
  // Obstacle voxels are never valid, so the two counts cannot both be driven by
  // the same voxel — which is the distinction §13.3 needs to colour a cell.
  merged.obstacleCount.forEach((_o, c) => {
    assert.equal(
      merged.validCount[c] + merged.obstacleCount[c] + merged.filteredCount[c] <= 10,
      true,
      `cell ${c} counted more voxels than the slab holds`,
    );
  });
  r.engine.dispose();
});

// ---------------------------------------------------------------------------
// Column filtering by region (the marked set)
// ---------------------------------------------------------------------------

test('§19.1: a slab filtered by regions counts only voxels inside them', async () => {
  const regions = [region([1.5, 1.5, 1.5], [1.2, 1.2, 1.2])];
  const slabRange: [[number, number], [number, number], [number, number]] =
    [[0, 19], [0, 9], [0, 19]];
  const filtered = await run(WS, {
    regions,
    columns: [{ axis: 1, range: slabRange, maskRegions: [0] }],
  });
  const unfiltered = await run(WS, {
    regions,
    columns: [{ axis: 1, range: slabRange, maskRegions: [] }],
  });

  const f = mergeSlab(filtered.aggregates, 0, filtered.camWords);
  const u = mergeSlab(unfiltered.aggregates, 0, unfiltered.camWords);
  const fTotal = f.validCount.reduce((a, b) => a + b, 0);
  const uTotal = u.validCount.reduce((a, b) => a + b, 0);
  assert.ok(fTotal > 0 && fTotal < uTotal, 'the filter must remove some voxels but not all');
  // What the filter removed is reported, not silently dropped — that is what
  // lets a caller tell "filtered out" from "no data" (§19.2).
  assert.ok(f.filteredCount.reduce((a, b) => a + b, 0) > 0);
  filtered.engine.dispose();
  unfiltered.engine.dispose();
});

// ---------------------------------------------------------------------------
// leafCounts + probes
// ---------------------------------------------------------------------------

/**
 * Expand merged leaves back to a dense field, asserting as it goes that the
 * leaves **tile** the chunk: no voxel is covered twice, and none is out of
 * bounds. `-1` means no leaf covered that voxel.
 */
function expandLeaves(leaves: LeafCounts, dims: Vec3): Int16Array {
  const [nx, ny, nz] = dims;
  const out = new Int16Array(nx * ny * nz).fill(-1);
  for (let n = 0; n < leaves.index.length; n++) {
    const li = leaves.index[n];
    const e = leaves.size[n];
    const i0 = li % nx;
    const j0 = Math.floor(li / nx) % ny;
    const k0 = Math.floor(li / (nx * ny));
    assert.ok(i0 + e <= nx && j0 + e <= ny && k0 + e <= nz, `leaf ${n} runs past the chunk`);
    for (let k = k0; k < k0 + e; k++) {
      for (let j = j0; j < j0 + e; j++) {
        for (let i = i0; i < i0 + e; i++) {
          const at = i + nx * (j + ny * k);
          assert.equal(out[at], -1, `voxel ${i},${j},${k} covered by two leaves`);
          out[at] = leaves.count[n];
        }
      }
    }
  }
  return out;
}

test('§19.2: merged leaves expand back to the per-voxel popcount exactly', async () => {
  const r = await run(WS_SPLIT, { leafCounts: { maskRegions: [] } });
  let checked = 0;
  for (const chunk of r.chunks) {
    const agg = r.aggregates.find((a) => a.chunkId === chunk.chunkId)!;
    const dense = expandLeaves(agg.leafCounts!, chunk.dims);
    const acc = accessor(chunk);
    const [nx, ny, nz] = chunk.dims;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const li = i + nx * (j + ny * k);
          if (!acc.isValid(i, j, k)) {
            assert.equal(dense[li], -1, `invalid voxel ${i},${j},${k} must have no leaf`);
            continue;
          }
          let n = 0;
          for (let w = 0; w < chunk.camWords; w++) n += popcount(acc.getMaskWord(i, j, k, w));
          assert.equal(dense[li], n, `count at ${i},${j},${k}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0);
  r.engine.dispose();
});

test('§19.3: a uniform region collapses instead of emitting a leaf per voxel', () => {
  // 8×8×8 all valid, all count 3 ⇒ exactly one leaf of edge 8.
  const dims: Vec3 = [8, 8, 8];
  const counts = new Uint8Array(512).fill(3);
  const validity = new Uint32Array(16).fill(0xffffffff);
  const merged = mergeLeafCounts(counts, validity, dims);
  assert.equal(merged.index.length, 1);
  assert.equal(merged.size[0], 8);
  assert.equal(merged.count[0], 3);

  // Break one voxel and the collapse stops at that branch — far fewer than 512
  // leaves, but more than one, and still an exact tiling.
  counts[0] = 1;
  const split = mergeLeafCounts(counts, validity, dims);
  assert.ok(split.index.length > 1 && split.index.length < 64, `got ${split.index.length} leaves`);
  const dense = expandLeaves(split, dims);
  assert.equal(dense[0], 1);
  for (let i = 1; i < 512; i++) assert.equal(dense[i], 3);
});

test('§19.3: merging is lossless on a non-power-of-two chunk', () => {
  // Padding outside `dims` must neither block a merge nor produce a leaf.
  const dims: Vec3 = [5, 3, 7];
  const n = 5 * 3 * 7;
  const counts = new Uint8Array(n);
  const validity = new Uint32Array((n + 31) >> 5);
  for (let i = 0; i < n; i++) {
    counts[i] = i % 4;
    if (i % 5 !== 0) validity[i >> 5] |= 1 << (i & 31);
  }
  const dense = expandLeaves(mergeLeafCounts(counts, validity, dims), dims);
  for (let i = 0; i < n; i++) {
    const valid = ((validity[i >> 5] >>> (i & 31)) & 1) === 1;
    assert.equal(dense[i], valid ? counts[i] : -1, `voxel ${i}`);
  }
});

test('§19.3: an all-invalid chunk emits no leaves at all', () => {
  const dims: Vec3 = [4, 4, 4];
  const merged = mergeLeafCounts(new Uint8Array(64), new Uint32Array(2), dims);
  assert.equal(merged.index.length, 0);
});

test('§19.2: a leafCounts region filter drops the voxels outside it', async () => {
  const regions = [region([1.5, 1.5, 1.5], [1.2, 1.2, 1.2])];
  const r = await run(WS, { regions, leafCounts: { maskRegions: [0] } });
  const agg = r.aggregates[0];
  const chunk = r.chunks[0];
  const dense = expandLeaves(agg.leafCounts!, chunk.dims);
  const acc = accessor(chunk);
  const [nx, ny, nz] = chunk.dims;
  let inside = 0;
  let outsideCleared = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const li = i + nx * (j + ny * k);
        const bit = dense[li] >= 0;
        const p: Vec3 = [
          chunk.origin[0] + (i + 0.5) * chunk.voxelSize,
          chunk.origin[1] + (j + 0.5) * chunk.voxelSize,
          chunk.origin[2] + (k + 0.5) * chunk.voxelSize,
        ];
        const want = acc.isValid(i, j, k) && inBox(p, regions[0]);
        assert.equal(bit, want, `filtered validity at ${i},${j},${k}`);
        if (want) inside++;
        else if (acc.isValid(i, j, k)) outsideCleared++;
      }
    }
  }
  assert.ok(inside > 0 && outsideCleared > 0);
  r.engine.dispose();
});

test('§19.2: probes report their chunk, validity, and mask', async () => {
  const probes: Vec3[] = [
    [3.15, 1.65, 4.5], // open space
    [2.25, 1.35, 2.85], // inside the solid box
    [99, 99, 99], // outside the workspace entirely
  ];
  const r = await run(WS_SPLIT, { probes });
  const hits = probes.map((_p, i) =>
    r.aggregates.map((a) => a.probeHits![i]).filter((h) => h !== ProbeHit.Missed),
  );
  assert.deepEqual(hits[0], [ProbeHit.Valid]);
  assert.deepEqual(hits[1], [ProbeHit.Invalid]);
  assert.deepEqual(hits[2], [], 'a probe outside every chunk is missed everywhere');

  // The reported mask is the chunk's own mask at that voxel.
  const owner = r.aggregates.find((a) => a.probeHits![0] === ProbeHit.Valid)!;
  const chunk = r.chunks.find((c) => c.chunkId === owner.chunkId)!;
  const acc = accessor(chunk);
  const vs = chunk.voxelSize;
  const ijk: [number, number, number] = [
    Math.floor((probes[0][0] - chunk.origin[0]) / vs),
    Math.floor((probes[0][1] - chunk.origin[1]) / vs),
    Math.floor((probes[0][2] - chunk.origin[2]) / vs),
  ];
  for (let w = 0; w < chunk.camWords; w++) {
    assert.equal(owner.probeMasks![w], acc.getMaskWord(ijk[0], ijk[1], ijk[2], w));
  }
  r.engine.dispose();
});

// ---------------------------------------------------------------------------
// 6n — inline equals standalone
// ---------------------------------------------------------------------------

test('§18 6n: standalone aggregate() over retained chunks equals the inline run', async () => {
  const spec: AggregateSpec = {
    regions: [region([2.0, 1.5, 3.0], [1.6, 1.4, 2.0]), region([4.5, 1.5, 4.5], [1.2, 1.2, 1.2])],
    columns: [{ axis: 1, range: [[0, 19], [1, 8], [0, 19]], maskRegions: [0] }],
    leafCounts: { maskRegions: [] },
    probes: [[3.15, 1.65, 4.5]],
  };
  const r = await run(WS_SPLIT, spec);

  const redone: AggregateResult[] = [];
  await r.engine.aggregate(r.chunks, spec, { onAggregate: (a) => redone.push(a) });

  assert.equal(redone.length, r.aggregates.length);
  for (const inline of r.aggregates) {
    const again = redone.find((a) => a.chunkId === inline.chunkId)!;
    assert.deepEqual(again.regions, inline.regions, `chunk ${inline.chunkId} regions`);
    assert.deepEqual(again.columns, inline.columns, `chunk ${inline.chunkId} columns`);
    assert.deepEqual(again.leafCounts, inline.leafCounts, `chunk ${inline.chunkId} leafCounts`);
    assert.deepEqual(again.probeMasks, inline.probeMasks, `chunk ${inline.chunkId} probeMasks`);
    assert.deepEqual(again.probeHits, inline.probeHits, `chunk ${inline.chunkId} probeHits`);
  }
  r.engine.dispose();
});

test('§19.4: a standalone aggregate can change the descriptor without recomputing', async () => {
  const r = await run(WS, { regions: [region([1.5, 1.5, 1.5], [1.2, 1.2, 1.2])] });
  const before = mergeAll(r.aggregates, 1, r.numCameras)[0].valid;

  // A larger box over the same retained masks: no raycast, a different answer.
  const wider: AggregateSpec = { regions: [region([1.5, 1.5, 1.5], [2.4, 1.5, 2.4])] };
  const redone: AggregateResult[] = [];
  await r.engine.aggregate(r.chunks, wider, { onAggregate: (a) => redone.push(a) });
  const after = mergeAll(redone, 1, r.numCameras)[0].valid;

  assert.ok(after > before, 'a wider region must count more voxels');
  r.engine.dispose();
});

// ---------------------------------------------------------------------------
// 6r — validation
// ---------------------------------------------------------------------------

async function expectThrows(spec: AggregateSpec, code: string, label: string): Promise<void> {
  const r = await run(WS, undefined);
  await assert.rejects(
    () => r.engine.compute({ aggregate: spec, onChunkDone: () => {} }),
    (err: unknown) => {
      assert.ok(err instanceof EngineError, `${label}: expected an EngineError`);
      assert.equal(err.code, code, label);
      return true;
    },
  );
  r.engine.dispose();
}

test('§18 6r: descriptor caps throw AGGREGATE_TOO_LARGE', async () => {
  await expectThrows(
    { regions: Array.from({ length: 65 }, () => region([1, 1, 1], [1, 1, 1])) },
    EngineErrorCode.AGGREGATE_TOO_LARGE,
    '65 regions',
  );
  await expectThrows(
    {
      columns: Array.from({ length: 33 }, () => ({
        axis: 1 as const,
        range: [[0, 1], [0, 1], [0, 1]] as [[number, number], [number, number], [number, number]],
        maskRegions: [],
      })),
    },
    EngineErrorCode.AGGREGATE_TOO_LARGE,
    '33 slabs',
  );
  await expectThrows(
    { probes: Array.from({ length: 257 }, () => [0, 0, 0] as Vec3) },
    EngineErrorCode.AGGREGATE_TOO_LARGE,
    '257 probes',
  );
});

test('§18 6r: malformed descriptors throw INVALID_AGGREGATE', async () => {
  await expectThrows(
    { regions: [region([1, 1, 1], [1, 0, 1])] },
    EngineErrorCode.INVALID_AGGREGATE,
    'zero half-extent',
  );
  await expectThrows(
    { regions: [region([1, NaN, 1], [1, 1, 1])] },
    EngineErrorCode.INVALID_AGGREGATE,
    'non-finite center',
  );
  await expectThrows(
    {
      regions: [region([1, 1, 1], [1, 1, 1])],
      columns: [{ axis: 1, range: [[0, 1], [0, 1], [0, 1]], maskRegions: [3] }],
    },
    EngineErrorCode.INVALID_AGGREGATE,
    'maskRegions index out of range',
  );
  await expectThrows(
    { leafCounts: { maskRegions: [0] } },
    EngineErrorCode.INVALID_AGGREGATE,
    'leafCounts filter with no regions declared',
  );
});

test('§19.6: an empty descriptor adds no passes and fires no callback', async () => {
  const r = await run(WS, { regions: [], probes: [] });
  assert.equal(r.aggregates.length, 0);
  r.engine.dispose();
});

// ---------------------------------------------------------------------------
// Interaction with the rest of the engine
// ---------------------------------------------------------------------------

test('§19: a fully pre-culled chunk still aggregates its validity', async () => {
  // Cameras confined to one corner leave far chunks with an all-zero active
  // mask. Those chunks are valid and fully blind, not absent (§19.2).
  const spec: AggregateSpec = {
    columns: [{ axis: 1, range: [[0, 19], [0, 9], [0, 19]], maskRegions: [] }],
  };
  const r = await run(WS_SPLIT, spec, [camera('a', [0.6, 0.45, 0.6], LOOK_NEG_Z, { far: 1 })]);
  const merged = mergeSlab(r.aggregates, 0, r.camWords);
  const totalValid = merged.validCount.reduce((a, b) => a + b, 0);
  const totalBlind = merged.blindCount.reduce((a, b) => a + b, 0);
  assert.ok(totalValid > 0);
  assert.ok(totalBlind > 0, 'pre-culled chunks contribute blind voxels, not nothing');
  // Every chunk reported, including the ones no camera reaches.
  assert.equal(r.aggregates.length, r.chunks.length);
  r.engine.dispose();
});

test('§19: aggregation does not disturb the CoverageSummary', async () => {
  const spec: AggregateSpec = {
    regions: [region([2.0, 1.5, 3.0], [1.6, 1.4, 2.0])],
    leafCounts: { maskRegions: [] },
  };
  const cams = [camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z)];
  const plain = await run(WS, undefined, cams);
  const withAgg = await run(WS, spec, cams);
  const a = await plain.engine.compute({ mode: 1 });
  const b = await withAgg.engine.compute({ mode: 1, aggregate: spec });
  assert.equal(a.overallRate, b.overallRate);
  assert.equal(a.validVoxels, b.validVoxels);
  plain.engine.dispose();
  withAgg.engine.dispose();
});

test('§19.2: planeAxes pins the in-plane mapping for every collapse axis', () => {
  assert.deepEqual(planeAxes(0), [1, 2]);
  assert.deepEqual(planeAxes(1), [0, 2]);
  assert.deepEqual(planeAxes(2), [0, 1]);
});

function popcount(x: number): number {
  let v = x >>> 0;
  let n = 0;
  while (v !== 0) {
    v &= v - 1;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Pre-culled chunks: correct, and allocation-free (§19.4, §11.1)
// ---------------------------------------------------------------------------

test('§19.4: a pre-culled chunk aggregates from an absent visibility buffer', () => {
  // `visibility: null` says "every mask word is zero" without a dense array of
  // zeros to say it. The answer must match the array it replaces exactly.
  const packed = packAggregate({
    regions: [region([1.0, 0.5, 1.0], [1.0, 0.5, 1.0])],
    columns: [{ axis: 1, range: [[0, 3], [0, 1], [0, 3]], maskRegions: [] }],
    leafCounts: { maskRegions: [] },
    probes: [[0.5, 0.5, 0.5]],
  });
  const dims: Vec3 = [4, 2, 4];
  const voxelCount = 32;
  const validity = new Uint32Array([0xffffffff]);
  const base: [number, number, number] = [0, 0, 0];
  const shared = {
    chunkId: 7, dims, origin: [0, 0, 0] as Vec3, base, voxelSize: 0.5,
    camWords: 1, numCameras: 2, validity, packed,
  };

  const withZeros = aggregateChunkCPU({ ...shared, visibility: new Uint32Array(voxelCount) });
  const withNull = aggregateChunkCPU({ ...shared, visibility: null });

  assert.deepEqual(withNull.regions, withZeros.regions);
  assert.deepEqual(withNull.groups, withZeros.groups);
  assert.deepEqual(withNull.columns, withZeros.columns);
  assert.deepEqual(withNull.leafCounts, withZeros.leafCounts);
  assert.deepEqual(withNull.probeHits, withZeros.probeHits);
  assert.deepEqual(withNull.probeMasks, withZeros.probeMasks);

  // And it is not a vacuous match: the chunk's voxels are valid and fully blind.
  assert.ok(withNull.regions![0].valid > 0);
  assert.equal(withNull.regions![0].covered, 0);
  assert.equal(withNull.regions![0].blind, withNull.regions![0].valid);
  assert.equal(withNull.probeHits![0], ProbeHit.Valid, 'a valid voxel nobody sees is still valid');
});

test('§19.4: a run over a mostly pre-culled workspace allocates one zero-mask array, not one per chunk', async () => {
  // The regression this guards: every chunk pre-cull emptied used to allocate
  // two dense zero arrays — several MiB each at a fine voxel size, and most
  // chunks on a large site take that path.
  const OrigU32 = globalThis.Uint32Array;
  const big: number[] = [];
  class Traced extends OrigU32 {
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      if (this.byteLength >= 64 * 1024) big.push(this.byteLength);
    }
  }
  (globalThis as { Uint32Array: unknown }).Uint32Array = Traced;
  let chunks = 0;
  try {
    const engine = new CoverageEngine({ onWarning: () => {} });
    // 8 chunks; one camera in a corner with a short range leaves most empty.
    await engine.init({
      worldMin: [0, 0, 0], worldMax: [8, 4, 4], voxelSize: 0.1, chunkSizeXZ: 2,
      backend: 'cpu', solidDetection: false,
    });
    await engine.loadScene(box([100, 100, 100], [101, 101, 101])); // out of the way
    await engine.setSampling({ regions: [{ type: 'full' }] });
    engine.setCameras([camera('a', [0.5, 2, 0.5], LOOK_NEG_Z, { far: 1 })]);
    await engine.compute({
      mode: 1,
      aggregate: { leafCounts: { maskRegions: [] } },
      onChunkDone: () => { chunks++; },
      onAggregate: () => {},
    });
    engine.dispose();
  } finally {
    (globalThis as { Uint32Array: unknown }).Uint32Array = OrigU32;
  }

  assert.ok(chunks >= 8, `expected a multi-chunk workspace, got ${chunks}`);
  // The CPU backend allocates its own visibility per chunk (that is its job);
  // what must not scale is the engine's zero-mask scratch on top of it.
  const perChunk = big.length / chunks;
  assert.ok(perChunk <= 2, `${perChunk.toFixed(1)} large arrays per chunk — the scratch is not being reused`);
});

test("§19.3: merge scratch scales with a chunk's voxels, not with its longest edge cubed", () => {
  // The regression this guards: the collapse used to run on a padded
  // power-of-two *cube*, so a tall chunk paid `maxDim³` rather than `voxels`.
  // A 100×400×100 chunk padded to 512³ is 268 MiB of `Int16Array` — one
  // allocation, large enough to fail outright, for 4M voxels of input.
  const dims: Vec3 = [16, 128, 16];
  const voxelCount = dims[0] * dims[1] * dims[2];
  const counts = new Uint8Array(voxelCount);
  const validity = new Uint32Array((voxelCount + 31) >> 5).fill(0xffffffff);
  // Uniform in 8-voxel bands of y, so there is something to merge.
  for (let li = 0; li < voxelCount; li++) {
    const j = Math.floor(li / dims[0]) % dims[1];
    counts[li] = (j >> 3) & 3;
  }

  const OrigI16 = globalThis.Int16Array;
  let scratchBytes = 0;
  class Traced extends OrigI16 {
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      scratchBytes += this.byteLength;
    }
  }
  (globalThis as { Int16Array: unknown }).Int16Array = Traced;
  let merged: LeafCounts;
  try {
    merged = mergeLeafCounts(counts, validity, dims);
  } finally {
    (globalThis as { Int16Array: unknown }).Int16Array = OrigI16;
  }

  // The levels are a geometric series over the chunk's own voxels; 2 bytes each
  // at 2× covers it with room to spare. The cube would have been 128³ — 32× the
  // voxel count, and that is the ratio that has to stay gone.
  assert.ok(
    scratchBytes <= 2 * 2 * voxelCount,
    `${scratchBytes} bytes of scratch for ${voxelCount} voxels — padding is back`,
  );
  const dense = expandLeaves(merged, dims);
  for (let i = 0; i < voxelCount; i++) assert.equal(dense[i], counts[i], `voxel ${i}`);
  assert.ok(merged.index.length < voxelCount / 8, `only ${merged.index.length} merged`);
});

test('§19.3: a chunk whose longest edge is not a power of two merges losslessly', () => {
  // Levels are halved with a ceiling, so an odd level dimension leaves a 2×2×2
  // block with children past the edge. They must read as empty — neither
  // blocking a merge nor emitting a leaf that runs outside `dims`.
  for (const dims of [[5, 3, 7], [9, 9, 9], [3, 17, 2], [1, 64, 1], [12, 6, 20]] as Vec3[]) {
    const n = dims[0] * dims[1] * dims[2];
    const counts = new Uint8Array(n);
    const validity = new Uint32Array((n + 31) >> 5);
    for (let i = 0; i < n; i++) {
      counts[i] = (i * 7) % 3;
      if (i % 11 !== 0) validity[i >> 5] |= 1 << (i & 31);
    }
    const merged = mergeLeafCounts(counts, validity, dims);
    for (let l = 0; l < merged.index.length; l++) {
      const idx = merged.index[l];
      const edge = merged.size[l];
      const i = idx % dims[0];
      const j = Math.floor(idx / dims[0]) % dims[1];
      const k = Math.floor(idx / (dims[0] * dims[1]));
      assert.ok(
        i + edge <= dims[0] && j + edge <= dims[1] && k + edge <= dims[2],
        `leaf ${edge}³ at ${i},${j},${k} runs past dims ${dims.join('×')}`,
      );
    }
    const dense = expandLeaves(merged, dims);
    for (let i = 0; i < n; i++) {
      const valid = ((validity[i >> 5] >>> (i & 31)) & 1) === 1;
      assert.equal(dense[i], valid ? counts[i] : -1, `${dims.join('×')} voxel ${i}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Re-aggregating retained chunks (§19.4)
// ---------------------------------------------------------------------------

/**
 * A multi-chunk workspace big enough that a chunk's dense expansion is worth
 * counting, with an empty scene so every chunk compresses to an SVO.
 */
async function retainedRun(far: number): Promise<Run> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({
    worldMin: [0, 0, 0], worldMax: [8, 4, 8], voxelSize: 0.1, chunkSizeXZ: 2,
    backend: 'cpu', solidDetection: false,
  });
  await engine.loadScene(box([100, 100, 100], [101, 101, 101])); // out of the way
  await engine.setSampling({ regions: [{ type: 'full' }] });
  const cams = [camera('a', [0.5, 2, 0.5], LOOK_NEG_Z, { far })];
  engine.setCameras(cams);
  const chunks: ChunkResult[] = [];
  const aggregates: AggregateResult[] = [];
  await engine.compute({
    mode: 1,
    aggregate: RETAINED_SPEC,
    onChunkDone: (_id, r) => chunks.push(r),
    onAggregate: (a) => aggregates.push(a),
  });
  return { engine, chunks, aggregates, numCameras: 1, camWords: chunks[0]?.camWords ?? 1 };
}

const RETAINED_SPEC: AggregateSpec = { leafCounts: { maskRegions: [] } };

/**
 * Leaf-list equality by value. The allocation traces below install a
 * `Uint32Array` subclass, and `deepEqual` would report two identical lists as
 * different because their constructors are.
 */
function assertSameLeaves(a: LeafCounts, b: LeafCounts, label: string): void {
  for (const key of ['index', 'size', 'count'] as const) {
    assert.deepEqual(Array.from(a[key]), Array.from(b[key]), `${label} ${key}`);
  }
}

/** Count `Uint32Array`s big enough to be a chunk's dense expansion, not an accumulator. */
async function countBigU32(fn: () => Promise<void>): Promise<number> {
  const OrigU32 = globalThis.Uint32Array;
  let big = 0;
  class Traced extends OrigU32 {
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      if (this.byteLength >= 32 * 1024) big++;
    }
  }
  (globalThis as { Uint32Array: unknown }).Uint32Array = Traced;
  try {
    await fn();
  } finally {
    (globalThis as { Uint32Array: unknown }).Uint32Array = OrigU32;
  }
  return big;
}

test('§19.4: re-aggregating retained chunks reuses one expansion buffer for all of them', async () => {
  // The regression this guards: `denseOf` inflated every retained SVO chunk into
  // a *fresh* dense pair, and a descriptor edit re-reduces every retained chunk —
  // so one zone drag churned the whole scene's per-voxel footprint.
  const r = await retainedRun(1);
  assert.ok(r.chunks.length >= 8, `expected a multi-chunk workspace, got ${r.chunks.length}`);
  assert.ok(r.chunks.some((c) => c.encoding === 'svo'), 'nothing was retained compressed');
  assert.ok(r.chunks.some((c) => c.stats.coveredCount > 0), 'nothing was covered');

  const again: AggregateResult[] = [];
  const big = await countBigU32(() =>
    r.engine.aggregate(r.chunks, RETAINED_SPEC, { onAggregate: (a) => again.push(a) }));

  // The answer is unchanged…
  assert.equal(again.length, r.chunks.length);
  for (const a of again) {
    const inline = r.aggregates.find((x) => x.chunkId === a.chunkId)!;
    assertSameLeaves(a.leafCounts!, inline.leafCounts!, `chunk ${a.chunkId}`);
  }
  // …and the expansion did not repeat per chunk. It used to be one array each.
  assert.ok(big <= 2, `${big} dense expansions for ${r.chunks.length} chunks`);
  r.engine.dispose();
});

test('§19.4: a retained chunk nobody covers is re-aggregated without expanding its masks', async () => {
  // `coveredCount === 0` is the §19.4 absent-buffer case, decided in O(1). After
  // chunk-level pre-cull (§7.2) most chunks of a large site are in it.
  const r = await retainedRun(0.05);
  assert.ok(
    r.chunks.every((c) => c.stats.coveredCount === 0),
    'expected an uncovered scene',
  );

  const again: AggregateResult[] = [];
  const big = await countBigU32(() =>
    r.engine.aggregate(r.chunks, RETAINED_SPEC, { onAggregate: (a) => again.push(a) }));

  assert.equal(again.length, r.chunks.length);
  for (const a of again) {
    const inline = r.aggregates.find((x) => x.chunkId === a.chunkId)!;
    assertSameLeaves(a.leafCounts!, inline.leafCounts!, `chunk ${a.chunkId}`);
  }
  assert.equal(big, 0, 'an uncovered chunk was expanded anyway');
  r.engine.dispose();
});

// ---------------------------------------------------------------------------
// §19.1 camera mask, §19.3 Pass 7 projections
// ---------------------------------------------------------------------------

/** The two-camera scene of `run()`, so a mask that drops camera 1 is observable. */
const MASK_REGION = region([3, 1.5, 3], [3, 1.5, 3], [0]);

test('§19.1: `cameras` narrows every reduction to the named bits', async () => {
  const spec = (cameras?: Uint32Array): AggregateSpec => ({
    regions: [MASK_REGION],
    leafCounts: { maskRegions: [] },
    probes: [[3.15, 1.65, 5.1]],
    cameras,
  });

  const all = await run(WS, spec());
  const only0 = await run(WS, spec(new Uint32Array([0b01])));
  const none = await run(WS, spec(new Uint32Array([0b00])));

  const total = (rs: Run, f: (a: (typeof rs.aggregates)[number]) => number) =>
    rs.aggregates.reduce((s, a) => s + f(a), 0);

  // `valid` is a geometry count and must not move; everything mask-derived must.
  assert.equal(total(all, (a) => a.regions![0].valid), total(only0, (a) => a.regions![0].valid));
  assert.equal(total(only0, (a) => a.regions![0].seen[1]), 0, 'a masked-out camera was still counted');
  assert.equal(
    total(only0, (a) => a.regions![0].seen[0]),
    total(all, (a) => a.regions![0].seen[0]),
    'masking one camera changed the other one’s count',
  );
  assert.ok(total(all, (a) => a.regions![0].covered) > total(only0, (a) => a.regions![0].covered));
  assert.equal(total(none, (a) => a.regions![0].covered), 0, 'an empty mask still reported coverage');
  assert.equal(
    total(none, (a) => a.regions![0].blind),
    total(none, (a) => a.regions![0].valid),
    'an empty mask must make every valid voxel blind',
  );

  // leafCounts.count is a masked popcount, so nothing may exceed the mask width.
  for (const a of only0.aggregates) {
    for (const c of a.leafCounts!.count) assert.ok(c <= 1, `leaf count ${c} over a 1-camera mask`);
  }
  // …and probe masks are masked too.
  for (const a of none.aggregates) {
    for (const w of a.probeMasks!) assert.equal(w, 0, 'an empty mask left probe bits set');
  }

  for (const r of [all, only0, none]) r.engine.dispose();
});

/** Column-major `viewProj * (x,y,z,1)` → bin index, written the long way round. */
function refBin(vp: Float32Array | number[], r: number, p: Vec3): number {
  const m = (col: number, row: number) => vp[col * 4 + row];
  const cx = m(0, 0) * p[0] + m(1, 0) * p[1] + m(2, 0) * p[2] + m(3, 0);
  const cy = m(0, 1) * p[0] + m(1, 1) * p[1] + m(2, 1) * p[2] + m(3, 1);
  const cw = m(0, 3) * p[0] + m(1, 3) * p[1] + m(2, 3) * p[2] + m(3, 3);
  if (!(cw > 0)) return -1;
  const clamp = (v: number) => Math.min(r - 1, Math.max(0, Math.floor(v)));
  const bx = clamp((cx / cw) * 0.5 * r + 0.5 * r);
  const by = clamp(0.5 * r - (cy / cw) * 0.5 * r);
  return by * r + bx;
}

const PROJ_R = 8;

function projSpec(cameraIndex: number, numCameras: number, viewProj: number[]): AggregateSpec {
  // Plane 0 sums a fixed-point 1/(n+1); plane 1 counts the voxels no *other*
  // camera sees. Both are the caller's tables — the SDK never learns what they
  // mean (§19.2).
  const score = new Uint32Array(numCameras + 1);
  const blind = new Uint32Array(numCameras + 1);
  for (let n = 0; n <= numCameras; n++) score[n] = Math.round(4096 / (n + 1));
  blind[0] = 1;
  // Everything except the camera being projected: that is what makes `n` count
  // the *other* cameras (§19.1).
  const cameras = new Uint32Array(1);
  for (let c = 0; c < numCameras; c++) if (c !== cameraIndex) cameras[0] |= 1 << c;
  return {
    projections: [
      { camera: cameraIndex, viewProj, resolution: PROJ_R, maskRegions: [], weights: [score, blind] },
    ],
    cameras,
  };
}

test('§19.3 Pass 7: a projection bins exactly the voxels its camera sees', async () => {
  const cams = [camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z), camera('b', [3.15, 1.65, 0.6], LOOK_POS_Z)];
  const vp = Array.from(prepareCamera(cams[0]).viewProj);
  const r = await run(WS, projSpec(0, cams.length, vp), cams);

  const merged = new Float64Array(2 * PROJ_R * PROJ_R);
  for (const a of r.aggregates) {
    assert.equal(a.projections!.length, 1);
    assert.equal(a.projections![0].resolution, PROJ_R);
    assert.equal(a.projections![0].planeCount, 2);
    for (let b = 0; b < merged.length; b++) merged[b] += a.projections![0].bins[b];
  }

  // Independent scan: walk the retained chunks, bin every voxel camera 0 sees.
  const ref = new Float64Array(2 * PROJ_R * PROJ_R);
  let seenByZero = 0;
  for (const chunk of r.chunks) {
    const acc = accessor(chunk);
    const [nx, ny, nz] = chunk.dims;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (!acc.isValid(i, j, k)) continue;
          if ((acc.getMask(i, j, k) & 1) === 0) continue;
          seenByZero++;
          const p: Vec3 = [
            chunk.origin[0] + (i + 0.5) * chunk.voxelSize,
            chunk.origin[1] + (j + 0.5) * chunk.voxelSize,
            chunk.origin[2] + (k + 0.5) * chunk.voxelSize,
          ];
          const bin = refBin(vp, PROJ_R, p);
          assert.ok(bin >= 0, 'a voxel the camera sees projected behind it');
          // `n` counts the *other* cameras, so here just camera 1.
          const n = (acc.getMask(i, j, k) >> 1) & 1;
          ref[bin] += Math.round(4096 / (n + 1));
          if (n === 0) ref[PROJ_R * PROJ_R + bin] += 1;
        }
      }
    }
  }

  assert.ok(seenByZero > 100, `too few voxels to be a real test: ${seenByZero}`);
  assert.deepEqual(Array.from(merged), Array.from(ref));
  // The blind plane is a plain count, so it totals the voxels only camera 0 sees.
  const blindTotal = ref.slice(PROJ_R * PROJ_R).reduce((s, v) => s + v, 0);
  assert.ok(blindTotal > 0 && blindTotal <= seenByZero);
  r.engine.dispose();
});

test('§19.3 Pass 7: projections merge across chunks by addition', async () => {
  const cams = [camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z), camera('b', [3.15, 1.65, 0.6], LOOK_POS_Z)];
  const vp = Array.from(prepareCamera(cams[0]).viewProj);
  const spec = projSpec(0, cams.length, vp);
  const one = await run(WS, spec, cams);
  const many = await run(WS_SPLIT, spec, cams);
  assert.ok(many.aggregates.length > one.aggregates.length, 'the split workspace did not split');

  const sum = (rs: Run) => {
    const out = new Float64Array(2 * PROJ_R * PROJ_R);
    for (const a of rs.aggregates) for (let b = 0; b < out.length; b++) out[b] += a.projections![0].bins[b];
    return Array.from(out);
  };
  assert.deepEqual(sum(many), sum(one));
  one.engine.dispose();
  many.engine.dispose();
});

test('§19.6: projection and camera-mask descriptors are validated', async () => {
  const cams = [camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z), camera('b', [3.15, 1.65, 0.6], LOOK_POS_Z)];
  const vp = Array.from(prepareCamera(cams[0]).viewProj);
  const ok = () => projSpec(0, cams.length, vp);

  const rejects = async (spec: AggregateSpec, code: EngineErrorCode, why: string) => {
    const engine = new CoverageEngine({ onWarning: () => {} });
    await engine.init({ ...WS, backend: 'cpu' });
    await engine.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
    await engine.setSampling({ regions: [{ type: 'full' }] });
    engine.setCameras(cams);
    await assert.rejects(
      () => engine.compute({ mode: 1, aggregate: spec }),
      (e: unknown) => e instanceof EngineError && e.code === code,
      why,
    );
    engine.dispose();
  };

  const mutate = (f: (s: AggregateSpec) => void): AggregateSpec => {
    const s = ok();
    f(s);
    return s;
  };

  await rejects(
    mutate((s) => { s.projections = Array.from({ length: 9 }, () => s.projections![0]); }),
    EngineErrorCode.AGGREGATE_TOO_LARGE,
    'nine projections',
  );
  await rejects(
    mutate((s) => { s.projections![0] = { ...s.projections![0], resolution: 0 }; }),
    EngineErrorCode.INVALID_AGGREGATE,
    'resolution 0',
  );
  await rejects(
    mutate((s) => { s.projections![0] = { ...s.projections![0], resolution: 129 }; }),
    EngineErrorCode.INVALID_AGGREGATE,
    'resolution over the cap',
  );
  await rejects(
    mutate((s) => { s.projections![0] = { ...s.projections![0], camera: 2 }; }),
    EngineErrorCode.INVALID_AGGREGATE,
    'a camera index past the run',
  );
  await rejects(
    mutate((s) => { s.projections![0] = { ...s.projections![0], viewProj: vp.slice(0, 15) }; }),
    EngineErrorCode.INVALID_AGGREGATE,
    'a 15-element matrix',
  );
  await rejects(
    mutate((s) => { s.projections![0] = { ...s.projections![0], weights: [] }; }),
    EngineErrorCode.INVALID_AGGREGATE,
    'no weight table',
  );
  await rejects(
    mutate((s) => {
      const w = s.projections![0].weights;
      s.projections![0] = { ...s.projections![0], weights: [w[0], new Uint32Array(2)] };
    }),
    EngineErrorCode.INVALID_AGGREGATE,
    'weight tables of unequal length',
  );
  await rejects(
    mutate((s) => {
      s.projections![0] = { ...s.projections![0], weights: [new Uint32Array(2), new Uint32Array(2)] };
    }),
    EngineErrorCode.INVALID_AGGREGATE,
    'weight tables that are not numCameras + 1 long',
  );
  await rejects(
    mutate((s) => { s.cameras = new Uint32Array(2); }),
    EngineErrorCode.INVALID_AGGREGATE,
    'a camera mask wider than CAM_WORDS',
  );
});

test('§19.1: a projection honours its `maskRegions` filter', async () => {
  // The bug this guards: a caller whose *sampled* set is a conservative AABB
  // (§6.3) and whose *counted* set is an exact OBB got the sampled one, so the
  // projection answered a question about voxels the caller does not count.
  const cams = [camera('a', [3.17, 1.63, 5.41], LOOK_NEG_Z), camera('b', [3.15, 1.65, 0.6], LOOK_POS_Z)];
  const vp = Array.from(prepareCamera(cams[0]).viewProj);
  const half: Vec3 = [3, 1.5, 1.5];
  const spec = (maskRegions: number[]): AggregateSpec => {
    const base = projSpec(0, cams.length, vp);
    return {
      ...base,
      // A slab across the half of the workspace nearer the camera.
      regions: [region([3, 1.5, 4.5], half, [])],
      projections: [{ ...base.projections![0], maskRegions }],
    };
  };

  const total = async (maskRegions: number[]) => {
    const r = await run(WS, spec(maskRegions), cams);
    let sum = 0;
    for (const a of r.aggregates) {
      for (let b = 0; b < PROJ_R * PROJ_R; b++) sum += a.projections![0].bins[b];
    }
    r.engine.dispose();
    return sum;
  };

  const unfiltered = await total([]);
  const filtered = await total([0]);
  assert.ok(unfiltered > 0, 'the unfiltered projection binned nothing');
  assert.ok(filtered > 0, 'the filter removed everything — the fixture proves nothing');
  assert.ok(filtered < unfiltered, `the filter changed nothing: ${filtered} === ${unfiltered}`);

  // And it is exactly the in-region subset, not merely smaller: the reference
  // walks the retained masks and applies the OBB test itself.
  const r = await run(WS, spec([0]), cams);
  let ref = 0;
  for (const chunk of r.chunks) {
    const acc = accessor(chunk);
    const [nx, ny, nz] = chunk.dims;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (!acc.isValid(i, j, k)) continue;
          const mask = acc.getMask(i, j, k);
          if ((mask & 1) === 0) continue;
          const p: Vec3 = [
            chunk.origin[0] + (i + 0.5) * chunk.voxelSize,
            chunk.origin[1] + (j + 0.5) * chunk.voxelSize,
            chunk.origin[2] + (k + 0.5) * chunk.voxelSize,
          ];
          if (!inBox(p, region([3, 1.5, 4.5], half, []))) continue;
          const n = (mask >> 1) & 1;
          ref += Math.round(4096 / (n + 1));
        }
      }
    }
  }
  assert.equal(filtered, ref);
  r.engine.dispose();
});
