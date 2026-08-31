/**
 * `aim_optimization.md` §8 — the feature's contract.
 *
 * The panorama derivation (§2) is the part of this design that can be wrong and
 * still produce plausible numbers, so it is pinned by its **outcome**: the
 * orientation chosen from a single capture must be as good as the best
 * orientation a brute-force sweep of real `compute()` runs can find. Bin
 * quantization is only a failure if it changes the choice.
 *
 * The ground truth here deliberately shares nothing with `panorama.ts` or
 * `search.ts` — it walks retained chunk masks with the public accessor and sums
 * `1/(n_others+1)^α` the naive way, reading α from `weights.ts` so the reference
 * cannot drift from the objective it is checking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CoverageEngine,
  accessor,
  emptyProjections,
  mergeProjections,
  type CameraConfig,
  type ChunkResult,
  type Quat,
  type SceneMesh,
  type Vec3,
  type WorkspaceConfig,
} from '@linkervision/camera-coverage-sdk';

import type { SceneCamera } from '../src/cameras/camera.ts';
import { eulerToQuat } from '../src/cameras/math.ts';
import { buildPanorama } from '../src/optimize/panorama.ts';
import { searchBest, type Lens } from '../src/optimize/search.ts';
import { captureSpec, sessionCameras } from '../src/optimize/session.ts';
import { REDUNDANCY_EXPONENT } from '../src/optimize/weights.ts';
import type { MarkedFilter } from '../src/scene/aggregateSpec.ts';

const NO_FILTER: MarkedFilter = { regions: [], maskRegions: [] };

const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [8, 3, 8], voxelSize: 0.4, chunkSizeXZ: 8 };

/** Two upright slabs, so the reachable set is genuinely occluded in places. */
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

const LENS: Lens = { fov: 60, aspect: 16 / 9, roll: 0 };

function sceneCamera(id: string, position: Vec3, yaw: number, pitch: number): SceneCamera {
  return {
    id,
    name: '',
    enabled: true,
    position,
    rotation: eulerToQuat({ yaw, pitch, roll: 0 }),
    fov: LENS.fov,
    aspect: LENS.aspect,
    near: 0.1,
    far: 12,
  };
}

// The camera under optimization sits off the voxel lattice, so no voxel centre
// lands exactly on a bin edge (SDK spec §19.5's boundary caveat).
const CAMS: SceneCamera[] = [
  sceneCamera('cam-1', [4.07, 2.63, 7.31], 0, -25),
  sceneCamera('cam-2', [0.53, 2.57, 0.61], -135, -25),
  sceneCamera('cam-3', [7.43, 2.51, 0.67], 135, -25),
];

async function makeEngine(): Promise<CoverageEngine> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS, backend: 'cpu', solidDetection: false });
  await engine.loadScene(scene());
  await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.4, yMax: 2.0 }] });
  return engine;
}

/**
 * The true §1.1 score of camera 0 at one orientation, from real masks.
 *
 * Naive on purpose: one loop, `accessor`, a running sum of `1/(n_others+1)`.
 */
async function trueScore(engine: CoverageEngine, rotation: Quat): Promise<number> {
  const cams: CameraConfig[] = CAMS.map((c, i) => (i === 0 ? { ...c, rotation } : { ...c }));
  engine.setCameras(cams);
  const chunks: ChunkResult[] = [];
  await engine.compute({ mode: 1, onChunkDone: (_id, r) => chunks.push(r) });

  let total = 0;
  for (const chunk of chunks) {
    const acc = accessor(chunk);
    const [nx, ny, nz] = chunk.dims;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (!acc.isValid(i, j, k)) continue;
          const mask = acc.getMask(i, j, k);
          if ((mask & 1) === 0) continue;
          let others = 0;
          for (let c = 1; c < cams.length; c++) if ((mask >> c) & 1) others++;
          // The production exponent, never a literal: the reference must track
          // the objective or it tests last week's objective (§1.1).
          total += 1 / Math.pow(others + 1, REDUNDANCY_EXPONENT);
        }
      }
    }
  }
  return total;
}

test('§8: the orientation chosen from one capture is within 1% of a brute-force sweep', async () => {
  const engine = await makeEngine();

  // One capture: six cube cameras at cam-1's mount point, one compute().
  const overrides = new Map<string, Quat>();
  const spec = captureSpec(CAMS, overrides, CAMS[0], NO_FILTER);
  engine.setCameras(sessionCameras(CAMS, overrides, CAMS[0]));
  const merged = emptyProjections(spec.projections!);
  await engine.compute({
    mode: 1,
    aggregate: spec,
    onAggregate: (r) => mergeProjections(merged, r.projections!),
  });
  const pano = buildPanorama(merged);
  assert.ok(pano.totalScore > 0, 'the capture found nothing reachable');

  // `minBlind: 0` — this test is about the panorama derivation, not §4.4's gate,
  // which `greedy.test.ts` covers on its own.
  const picked = searchBest(pano, LENS, 0);
  const pickedTrue = await trueScore(engine, eulerToQuat({ yaw: picked.yaw, pitch: picked.pitch, roll: 0 }));

  // Brute force: real runs on a coarse grid the panorama never saw.
  let bestTrue = 0;
  let bestAt = { yaw: 0, pitch: 0 };
  for (let yaw = -180; yaw < 180; yaw += 20) {
    for (const pitch of [-60, -40, -20, 0]) {
      const s = await trueScore(engine, eulerToQuat({ yaw, pitch, roll: 0 }));
      if (s > bestTrue) {
        bestTrue = s;
        bestAt = { yaw, pitch };
      }
    }
  }

  assert.ok(bestTrue > 0, 'the brute-force sweep found no orientation worth anything');
  assert.ok(
    pickedTrue >= 0.99 * bestTrue,
    `panorama picked (${picked.yaw}, ${picked.pitch}) worth ${pickedTrue.toFixed(1)}; ` +
      `sweep best (${bestAt.yaw}, ${bestAt.pitch}) worth ${bestTrue.toFixed(1)}`,
  );

  // …and the panorama's own estimate of its pick is close to the truth. Looser
  // than the choice above by design: quantization moves the *number* more than
  // it moves the argmax, which is exactly why §8 makes the choice the contract.
  assert.ok(
    Math.abs(picked.score - pickedTrue) <= 0.1 * pickedTrue,
    `panorama scored its pick ${picked.score.toFixed(1)}, truth ${pickedTrue.toFixed(1)}`,
  );

  engine.dispose();
});

/** Whether a world point is inside a marked filter's first region. */
function inFirstRegion(marked: MarkedFilter, p: Vec3): boolean {
  const r = marked.regions[0];
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
  return Math.abs(l[0]) <= r.halfSize[0] && Math.abs(l[1]) <= r.halfSize[1] && Math.abs(l[2]) <= r.halfSize[2];
}

/** As `trueScore`, but counting only the voxels a marked filter admits. */
async function trueScoreIn(
  engine: CoverageEngine,
  rotation: Quat,
  marked: MarkedFilter | null,
): Promise<number> {
  const cams: CameraConfig[] = CAMS.map((c, i) => (i === 0 ? { ...c, rotation } : { ...c }));
  engine.setCameras(cams);
  const chunks: ChunkResult[] = [];
  await engine.compute({ mode: 1, onChunkDone: (_id, r) => chunks.push(r) });

  let total = 0;
  for (const chunk of chunks) {
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
          if (marked && !inFirstRegion(marked, p)) continue;
          let others = 0;
          for (let c = 1; c < cams.length; c++) if ((mask >> c) & 1) others++;
          // The production exponent, never a literal: the reference must track
          // the objective or it tests last week's objective (§1.1).
          total += 1 / Math.pow(others + 1, REDUNDANCY_EXPONENT);
        }
      }
    }
  }
  return total;
}

test('§2.2: a marked zone restricts what the optimizer scores, and changes what it picks', async () => {
  // The bug this guards: the capture inherited `setSampling`'s conservative
  // AABBs (`sampling_volumes.md` §7.1) instead of the exact marked OBBs, so it
  // scored — and aimed at — voxels no panel counts. The zone below is **rotated**
  // and sits to one side, so its AABB is a strictly larger, differently-shaped
  // set: a capture reading the AABB cannot produce the filtered answer by luck.
  const engine = await makeEngine();
  const marked: MarkedFilter = {
    regions: [{
      center: [6.1, 1.2, 6.3],
      rotation: eulerToQuat({ yaw: 35, pitch: 0, roll: 0 }),
      halfSize: [1.4, 1.0, 2.2],
      groups: [0],
    }],
    maskRegions: [0],
  };

  const capture = async (filter: MarkedFilter) => {
    const overrides = new Map<string, Quat>();
    const spec = captureSpec(CAMS, overrides, CAMS[0], filter);
    engine.setCameras(sessionCameras(CAMS, overrides, CAMS[0]));
    const merged = emptyProjections(spec.projections!);
    await engine.compute({
      mode: 1,
      aggregate: spec,
      onAggregate: (r) => mergeProjections(merged, r.projections!),
    });
    return buildPanorama(merged);
  };

  const zoned = await capture(marked);
  const all = await capture(NO_FILTER);

  assert.ok(zoned.totalScore > 0, 'the filter removed everything — the fixture proves nothing');
  assert.ok(
    zoned.totalScore < all.totalScore * 0.9,
    `the filter barely changed the panorama: ${zoned.totalScore} vs ${all.totalScore}`,
  );

  // The filtered panorama's score is the *filtered* ground truth, not the full one.
  const pick = searchBest(zoned, LENS, 0);
  const rot = eulerToQuat({ yaw: pick.yaw, pitch: pick.pitch, roll: 0 });
  const truthInZone = await trueScoreIn(engine, rot, marked);
  const truthEverywhere = await trueScoreIn(engine, rot, null);

  assert.ok(
    Math.abs(pick.score - truthInZone) <= 0.1 * truthInZone,
    `zoned panorama scored ${pick.score.toFixed(1)}, in-zone truth ${truthInZone.toFixed(1)}`,
  );
  assert.ok(
    truthEverywhere > truthInZone,
    'the fixture must have voxels outside the zone for this to mean anything',
  );

  // And it is at least as good, inside the zone, as the unfiltered pick — which
  // is the behaviour the bug destroyed.
  const naive = searchBest(all, LENS, 0);
  const naiveInZone = await trueScoreIn(
    engine,
    eulerToQuat({ yaw: naive.yaw, pitch: naive.pitch, roll: 0 }),
    marked,
  );
  assert.ok(
    truthInZone >= naiveInZone,
    `ignoring the zone aimed better inside it (${naiveInZone.toFixed(1)}) than honouring it (${truthInZone.toFixed(1)})`,
  );

  engine.dispose();
});
