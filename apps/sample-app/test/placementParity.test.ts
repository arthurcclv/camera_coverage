/**
 * `camera_placement.md` §13 — the feature's contract.
 *
 * The cached reachable sets (§2.1) and the CPU union (§4.4) are the two pieces
 * of this design that can be wrong and still produce believable percentages, so
 * they are pinned against the engine itself: the union of a layout's cached leaf
 * cubes must **exactly equal** a real `compute()` carrying all `6N` capture rigs
 * at once, read back as one `RegionAccum.covered`.
 *
 * **Exact, not approximate.** SDK spec §19.5 makes both reductions integral and
 * bit-identical, so any inequality here is a bug and not a tolerance — which is
 * what makes this test worth more than a plausibility check on the numbers.
 *
 * The scene deliberately spans **four chunks**, because a per-chunk base offset
 * is exactly the kind of arithmetic that produces a plausible-but-wrong union.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CoverageEngine,
  WorkspaceGrid,
  camWords,
  type AggregateRegion,
  type AggregateSpec,
  type CameraConfig,
  type Quat,
  type SceneMesh,
  type Vec3,
  type WorkspaceConfig,
} from '@linkervision/camera-coverage-sdk';

import { captureRig, CAPTURE_SLOTS } from '../src/optimize/cubeRig.ts';
import { buildStepSpec } from '../src/placement/pool.ts';
import { VoxelBitset, leafChunkFrom, leafSetOf, type LeafChunk } from '../src/placement/leafSet.ts';
import type { MarkedFilter } from '../src/scene/aggregateSpec.ts';

const IDENTITY: Quat = [0, 0, 0, 1];

// chunkSizeXZ < the workspace, so the run spans 2 × 2 chunks (§13).
const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [8, 3, 8], voxelSize: 0.4, chunkSizeXZ: 4 };
const GRID = new WorkspaceGrid(WS);
const NEAR = 0.1;
const FAR = 12;

/** Mount points off the voxel lattice, with real occlusion between them. */
const MOUNTS: Vec3[] = [
  [1.13, 2.57, 1.31],
  [6.71, 2.51, 6.43],
  [1.07, 2.63, 6.79],
];

/** Two upright slabs, so a reachable set is genuinely occluded in places. */
function scene(): SceneMesh {
  const parts = [boxMesh([2.0, 0, 2.0], [2.4, 3, 5.6]), boxMesh([5.2, 0, 1.2], [5.6, 3, 4.0])];
  const positions = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  const indices = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0));
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + vo / 3;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return { positions, indices };
}

function boxMesh(min: Vec3, max: Vec3): SceneMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const quad = (a: number, b: number, c: number, d: number) => [a, b, c, a, c, d];
  const indices = new Uint32Array([
    ...quad(0, 1, 2, 3), ...quad(4, 5, 6, 7), ...quad(0, 4, 7, 3),
    ...quad(1, 5, 6, 2), ...quad(0, 1, 5, 4), ...quad(3, 2, 6, 7),
  ]);
  return { positions, indices };
}

async function makeEngine(): Promise<CoverageEngine> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS, backend: 'cpu', solidDetection: false });
  await engine.loadScene(scene());
  await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.4, yMax: 2.0 }] });
  return engine;
}

/** The whole workspace as one aggregation region — the counted set, exactly. */
const WHOLE: AggregateRegion = {
  center: [4, 1.5, 4],
  rotation: IDENTITY,
  halfSize: [4, 1.5, 4],
  groups: [0],
};

/** A rotated box over one corner — the marked-zone case (§3.3, §13). */
const ROTATED: AggregateRegion = {
  center: [2.5, 1.2, 2.5],
  // 30° about Y, so its AABB is strictly larger than the box: a build step that
  // skipped the filter would count the slop (§3.3).
  rotation: [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)],
  halfSize: [2.2, 0.8, 1.4],
  groups: [0],
};

function filterOf(region: AggregateRegion): MarkedFilter {
  return { regions: [region], maskRegions: [0] };
}

/** One build step: the six-slot rig alone in the camera list (§2.1). */
async function buildStep(
  engine: CoverageEngine,
  mount: Vec3,
  marked: MarkedFilter,
): Promise<LeafChunk[]> {
  engine.setCameras(captureRig({ position: mount, near: NEAR, far: FAR }));
  const chunks: LeafChunk[] = [];
  await engine.compute({
    mode: 1,
    aggregate: buildStepSpec(0, marked),
    onAggregate: (r) => {
      const chunk = leafChunkFrom(r, GRID.chunk(r.chunkId));
      if (chunk) chunks.push(chunk);
    },
  });
  return chunks;
}

/**
 * Ground truth: every rig resident at once, one `covered` read.
 *
 * `covered` is "seen by ≥ 1 camera in the descriptor's mask" (SDK §19.2), so
 * with the mask naming all `6N` slots it is precisely `|⋃ᵢ R(pᵢ) ∩ region|` —
 * the union the CPU is supposed to reproduce.
 */
async function trueUnion(engine: CoverageEngine, mounts: Vec3[], region: AggregateRegion): Promise<number> {
  const cameras: CameraConfig[] = mounts.flatMap((mount, i) =>
    captureRig({ position: mount, near: NEAR, far: FAR }).map((c) => ({ ...c, id: `rig-${i}-${c.id}` })),
  );
  engine.setCameras(cameras);
  const mask = new Uint32Array(camWords(cameras.length));
  for (let i = 0; i < cameras.length; i++) mask[i >>> 5] |= 1 << (i & 31);
  const spec: AggregateSpec = { regions: [region], cameras: mask };

  let covered = 0;
  await engine.compute({
    mode: 1,
    aggregate: spec,
    onAggregate: (r) => {
      for (const acc of r.regions ?? []) covered += acc.covered;
    },
  });
  return covered;
}

test('§13: the CPU union of cached leaf cubes equals a real 6N-rig compute(), exactly', async () => {
  const engine = await makeEngine();
  try {
    const marked = filterOf(WHOLE);
    const sets = [];
    for (const mount of MOUNTS) sets.push(leafSetOf(await buildStep(engine, mount, marked)));

    // Every position must actually see something, or the test would pass on two
    // empty sets agreeing about nothing.
    for (const [i, set] of sets.entries()) assert.ok(set.count > 0, `mount ${i} saw nothing`);

    const bits = new VoxelBitset(GRID.gridDims);
    let union = 0;
    for (const set of sets) union += bits.add(set);
    assert.equal(bits.count(), union, 'the marginal counts must sum to the union');

    const truth = await trueUnion(engine, MOUNTS, WHOLE);
    assert.equal(union, truth);

    // The union is strictly less than the sum, i.e. the mounts really do overlap
    // — otherwise a summed score would have passed this too (§1.2).
    const summed = sets.reduce((n, s) => n + s.count, 0);
    assert.ok(union < summed, `expected overlap: union ${union} vs sum ${summed}`);
  } finally {
    engine.dispose();
  }
});

test('§13: a rotated marked zone is honoured — the filtered union matches in-zone truth', async () => {
  const engine = await makeEngine();
  try {
    const marked = filterOf(ROTATED);
    const bits = new VoxelBitset(GRID.gridDims);
    let union = 0;
    for (const mount of MOUNTS) union += bits.add(leafSetOf(await buildStep(engine, mount, marked)));

    const truth = await trueUnion(engine, MOUNTS, ROTATED);
    assert.equal(union, truth);
    assert.ok(truth > 0, 'the rotated zone must contain some reachable voxels');

    // And it is genuinely a filter: the in-zone union is smaller than the whole
    // workspace's, so a build step that dropped `maskRegions` would count the slop
    // outside the rotated box and read as a superset (§3.3).
    const whole = await trueUnion(engine, MOUNTS, WHOLE);
    assert.ok(truth < whole, `expected the zone to restrict: ${truth} vs ${whole}`);
  } finally {
    engine.dispose();
  }
});

test('§13: one build step per position equals one compute() with that position alone', async () => {
  // The per-position half of the contract: a single cached set is exactly what
  // the engine reports for that rig, before any union arithmetic enters.
  const engine = await makeEngine();
  try {
    const marked = filterOf(WHOLE);
    const set = leafSetOf(await buildStep(engine, MOUNTS[0], marked));
    const truth = await trueUnion(engine, [MOUNTS[0]], WHOLE);
    assert.equal(set.count, truth);

    const bits = new VoxelBitset(GRID.gridDims);
    assert.equal(bits.add(set), truth);
    // Re-adding the same set contributes nothing: the property that makes two
    // cameras on one mount worth no more than one (§1.2).
    assert.equal(bits.add(set), 0);
    assert.equal(CAPTURE_SLOTS, 6);
  } finally {
    engine.dispose();
  }
});
