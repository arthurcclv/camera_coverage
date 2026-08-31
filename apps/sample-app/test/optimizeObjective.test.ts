/**
 * `aim_optimization.md` §8 — the objective's exponent earns its default (§1.1).
 *
 * The regression this guards is not a crash but a *worse layout*: with
 * `REDUNDANCY_EXPONENT = 1` the optimizer spent real aim budget thinning
 * redundancy instead of filling blind spots, and finished with measurably less
 * coverage than a sharper discount reaches on the same scene from the same start.
 * Nothing in the unit tests could see that — only running the loop and measuring
 * the result can.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CoverageEngine,
  accessor,
  camWords,
  emptyProjections,
  mergeProjections,
  prepareCamera,
  type AggregateSpec,
  type CameraConfig,
  type ChunkResult,
  type Quat,
  type SceneMesh,
  type Vec3,
  type WorkspaceConfig,
} from '@linkervision/camera-coverage-sdk';

import type { SceneCamera } from '../src/cameras/camera.ts';
import { eulerToQuat } from '../src/cameras/math.ts';
import { buildPanorama, PANORAMA_RESOLUTION } from '../src/optimize/panorama.ts';
import { scoreOrientation, searchBest } from '../src/optimize/search.ts';
import { CUBE_FACES } from '../src/optimize/cubeRig.ts';
import { sessionCameras } from '../src/optimize/session.ts';
import { MIN_GAIN } from '../src/optimize/greedy.ts';
import { REDUNDANCY_EXPONENT, SCORE_SCALE, blindWeights, scoreWeights } from '../src/optimize/weights.ts';

const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [9, 3, 9], voxelSize: 0.5, chunkSizeXZ: 9 };
const LENS = { fov: 60, aspect: 16 / 9, roll: 0 };

function boxMesh(min: Vec3, max: Vec3): SceneMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const q = (a: number, b: number, c: number, d: number) => [a, b, c, a, c, d];
  return {
    positions,
    indices: new Uint32Array([
      ...q(0, 1, 2, 3), ...q(4, 5, 6, 7), ...q(0, 4, 7, 3),
      ...q(1, 5, 6, 2), ...q(0, 1, 5, 4), ...q(3, 2, 6, 7),
    ]),
  };
}

const mk = (id: string, position: Vec3, yaw: number): SceneCamera => ({
  id, name: '', enabled: true, position, rotation: eulerToQuat({ yaw, pitch: -30, roll: 0 }),
  fov: LENS.fov, aspect: LENS.aspect, near: 0.1, far: 14,
});

// Three cameras clustered so their views overlap heavily at the start: that is the
// state where "reduce redundancy" and "fill blind spots" disagree, and therefore
// the state where the exponent is observable at all.
const START: SceneCamera[] = [
  mk('cam-1', [1.13, 2.67, 1.31], 40),
  mk('cam-2', [1.87, 2.61, 2.23], 50),
  mk('cam-3', [7.93, 2.57, 1.67], 130),
];

/** A capture descriptor whose only variable is the weight table. */
function specFor(cams: SceneCamera[], mount: SceneCamera, alpha: number): AggregateSpec {
  const all = sessionCameras(cams, new Map(), mount);
  const total = all.length;
  const first = cams.length;
  const mask = new Uint32Array(camWords(total));
  cams.forEach((c, i) => {
    if (c.enabled && c.id !== mount.id) mask[i >>> 5] |= 1 << (i & 31);
  });
  return {
    projections: CUBE_FACES.map((_, f) => ({
      camera: first + f,
      viewProj: Array.from(prepareCamera(all[first + f]).viewProj),
      resolution: PANORAMA_RESOLUTION,
      maskRegions: [],
      weights: [scoreWeights(total, alpha), blindWeights(total)],
    })),
    cameras: mask,
  };
}

async function coverage(engine: CoverageEngine, cams: readonly SceneCamera[]): Promise<number> {
  engine.setCameras(cams.map((c) => ({ ...c }) as CameraConfig));
  const chunks: ChunkResult[] = [];
  await engine.compute({ mode: 1, onChunkDone: (_i, r) => chunks.push(r) });
  let valid = 0;
  let covered = 0;
  for (const ch of chunks) {
    const acc = accessor(ch);
    const [nx, ny, nz] = ch.dims;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (!acc.isValid(i, j, k)) continue;
          valid++;
          if (acc.getMask(i, j, k) !== 0) covered++;
        }
      }
    }
  }
  return valid > 0 ? covered / valid : 0;
}

/** The §4 loop, with the exponent as its only parameter. */
async function optimize(engine: CoverageEngine, alpha: number): Promise<SceneCamera[]> {
  const cams = START.map((c) => ({ ...c }));
  for (let round = 0; round < 3; round++) {
    let moved = 0;
    for (let i = 0; i < cams.length; i++) {
      const mount = cams[i];
      const spec = specFor(cams, mount, alpha);
      engine.setCameras(sessionCameras(cams, new Map(), mount));
      const merged = emptyProjections(spec.projections!);
      await engine.compute({
        mode: 1,
        aggregate: spec,
        onAggregate: (r) => mergeProjections(merged, r.projections!),
      });
      const pano = buildPanorama(merged);
      const cur = scoreOrientation(pano, mount.rotation, LENS);
      const best = searchBest(pano, LENS, cur.blind);
      const gain = cur.score > 0 ? best.score / cur.score - 1 : best.score > 0 ? Infinity : 0;
      if (Number.isFinite(best.score) && gain >= MIN_GAIN) {
        cams[i] = { ...mount, rotation: eulerToQuat({ yaw: best.yaw, pitch: best.pitch, roll: 0 }) };
        moved++;
      }
    }
    if (moved === 0) break;
  }
  return cams;
}

test('§1.1: the default exponent reaches at least as much coverage as α = 1', async () => {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS, backend: 'cpu', solidDetection: false });
  await engine.loadScene(boxMesh([4.4, 0, 1.5], [5.2, 3, 7.5]));
  await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.5, yMax: 2.0 }] });

  const start = await coverage(engine, START);
  const atOne = await coverage(engine, await optimize(engine, 1));
  const atDefault = await coverage(engine, await optimize(engine, REDUNDANCY_EXPONENT));

  assert.ok(atOne > start, `the fixture must leave room to improve: ${start} → ${atOne}`);
  assert.ok(
    atDefault >= atOne - 0.001,
    `α = ${REDUNDANCY_EXPONENT} reached ${(atDefault * 100).toFixed(2)}%, ` +
      `worse than α = 1's ${(atOne * 100).toFixed(2)}%`,
  );
  engine.dispose();
});

test('§1.1: the weight table is exact and never truncates at the default exponent', () => {
  // 4096 was enough for α = 1 but rounded `1/(n+1)²` to zero above n = 90,
  // silently truncating the objective's tail the moment the exponent moved.
  const w = scoreWeights(127);
  assert.equal(w[0], SCORE_SCALE);
  for (let n = 0; n <= 127; n++) {
    assert.ok(w[n] > 0, `weight for n = ${n} truncated to zero`);
    const exact = SCORE_SCALE / Math.pow(n + 1, REDUNDANCY_EXPONENT);
    assert.ok(Math.abs(w[n] - exact) <= 0.5 + 1e-9, `n = ${n}: ${w[n]} vs ${exact}`);
  }
  // The overflow bound the scale is chosen against (§2.2).
  assert.equal(SCORE_SCALE * 262_144, 2 ** 32);
});
