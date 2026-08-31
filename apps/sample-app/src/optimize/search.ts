/**
 * Scoring an orientation against a panorama, and the exhaustive search over
 * yaw × pitch (`aim_optimization.md` §4.3, §4.4, §7.2).
 *
 * A candidate's frustum is five half-spaces through the camera position — front,
 * left, right, bottom, top — so containment of a *direction* is five dot
 * products and nothing else. The pyramid turns "test 24,576 bins" into "test the
 * frustum's boundary", which is what makes 64,440 candidates affordable on the
 * main thread.
 */
import type { Quat } from '@linkervision/camera-coverage-sdk';
import { eulerToQuat } from '../cameras/math.ts';
import { MAX_PITCH_DEG } from '../cameras/aim.ts';
import type { Panorama } from './panorama.ts';
import { toScore } from './weights.ts';

/** The lens a candidate is scored through; roll rides along untouched (§4.3). */
export interface Lens {
  fov: number;
  aspect: number;
  roll: number;
}

export interface OrientationScore {
  /** §1.1 units — the raw fixed-point sum divided out. */
  score: number;
  /** Voxels in the frustum that no other enabled camera sees (§4.4). */
  blind: number;
}

const DEG2RAD = Math.PI / 180;

/**
 * The five inward half-space normals of a frustum, in world space.
 *
 * In the camera's own frame the tests are `−z > 0`, `|x| ≤ tanH·(−z)` and
 * `|y| ≤ tanV·(−z)`; rewritten as `dot(n, v) ≥ 0` the normals are constant, so
 * rotating five of them per candidate beats rotating every bin direction.
 */
export function frustumNormals(q: Quat, lens: Lens): Float32Array {
  const tanV = Math.tan((lens.fov * DEG2RAD) / 2);
  const tanH = tanV * lens.aspect;
  const local = [
    [0, 0, -1],
    [1, 0, -tanH],
    [-1, 0, -tanH],
    [0, 1, -tanV],
    [0, -1, -tanV],
  ];
  const out = new Float32Array(15);
  const [qx, qy, qz, qw] = q;
  for (let i = 0; i < 5; i++) {
    const [x, y, z] = local[i];
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    out[i * 3] = x + qw * tx + (qy * tz - qz * ty);
    out[i * 3 + 1] = y + qw * ty + (qz * tx - qx * tz);
    out[i * 3 + 2] = z + qw * tz + (qx * ty - qy * tx);
  }
  return out;
}

/**
 * Sum the panorama over one orientation's frustum (§7.2).
 *
 * The walk rests on a cube-face cell projecting to a **convex** spherical
 * polygon, which it always does — it is the central projection of a planar
 * rectangle subtending well under a hemisphere. So all four corners inside every
 * half-space means the whole cell is inside, and all four outside any *one*
 * half-space means the whole cell is outside. Only a cell the boundary crosses
 * descends, and at the bin level the centre decides — which is where §2.3's 1.4°
 * quantization lives.
 */
export function scoreOrientation(pano: Panorama, q: Quat, lens: Lens): OrientationScore {
  const n = frustumNormals(q, lens);
  const top = pano.levels.length - 1;
  let score = 0;
  let blind = 0;

  const walk = (level: number, f: number, i: number, j: number): void => {
    const lv = pano.levels[level];
    const cell = f * lv.size * lv.size + j * lv.size + i;
    if (lv.score[cell] === 0 && lv.blind[cell] === 0) return;

    const c = lv.corners;
    const co = cell * 12;
    let allIn = true;
    for (let p = 0; p < 5; p++) {
      const nx = n[p * 3];
      const ny = n[p * 3 + 1];
      const nz = n[p * 3 + 2];
      let inCount = 0;
      for (let k = 0; k < 4; k++) {
        const d = nx * c[co + k * 3] + ny * c[co + k * 3 + 1] + nz * c[co + k * 3 + 2];
        if (d >= 0) inCount++;
      }
      if (inCount === 0) return; // wholly outside this plane ⇒ wholly outside
      if (inCount !== 4) allIn = false;
    }
    if (allIn) {
      score += lv.score[cell];
      blind += lv.blind[cell];
      return;
    }
    if (level === 0) {
      // The boundary crosses this bin: its centre decides, all or nothing.
      const d = pano.dir;
      const o = cell * 3;
      for (let p = 0; p < 5; p++) {
        if (n[p * 3] * d[o] + n[p * 3 + 1] * d[o + 1] + n[p * 3 + 2] * d[o + 2] < 0) return;
      }
      score += lv.score[cell];
      blind += lv.blind[cell];
      return;
    }
    const child = pano.levels[level - 1].size;
    for (let k = 0; k < 4; k++) {
      const ci = 2 * i + (k & 1);
      const cj = 2 * j + (k >> 1);
      if (ci < child && cj < child) walk(level - 1, f, ci, cj);
    }
  };

  for (let f = 0; f < 6; f++) walk(top, f, 0, 0);
  return { score: toScore(score), blind };
}

export interface Candidate extends OrientationScore {
  yaw: number;
  pitch: number;
}

/** §4.3's grid: 1° over the full yaw circle and the pitch clamp. */
export const COARSE_STEP_DEG = 1;
/** …then ±1° at this step around the winner. */
export const REFINE_STEP_DEG = 0.25;

function scoreAt(pano: Panorama, yaw: number, pitch: number, lens: Lens): Candidate {
  const s = scoreOrientation(pano, eulerToQuat({ yaw, pitch, roll: lens.roll }), lens);
  return { yaw, pitch, ...s };
}

/**
 * The best orientation the blind gate admits (§4.4).
 *
 * `minBlind` is the current orientation's blind count, so the candidate may not
 * abandon more currently-blind voxels than it gains. The current orientation
 * always satisfies it, which is why the caller can rely on a result: the eligible
 * set is never empty, and `searchBest` is only ever choosing *how much* better.
 */
export function searchBest(pano: Panorama, lens: Lens, minBlind: number): Candidate {
  let best: Candidate | null = null;
  const consider = (c: Candidate): void => {
    if (c.blind < minBlind) return;
    if (!best || c.score > best.score) best = c;
  };

  for (let yaw = -180; yaw < 180; yaw += COARSE_STEP_DEG) {
    for (let pitch = -MAX_PITCH_DEG; pitch <= MAX_PITCH_DEG; pitch += COARSE_STEP_DEG) {
      consider(scoreAt(pano, yaw, pitch, lens));
    }
  }
  // Nothing cleared the gate on the grid — the caller's own orientation is the
  // answer, and it is not on the grid unless by luck.
  if (!best) return { yaw: 0, pitch: 0, score: -Infinity, blind: 0 };

  const coarse: Candidate = best;
  for (let dy = -COARSE_STEP_DEG; dy <= COARSE_STEP_DEG; dy += REFINE_STEP_DEG) {
    for (let dp = -COARSE_STEP_DEG; dp <= COARSE_STEP_DEG; dp += REFINE_STEP_DEG) {
      const pitch = Math.min(MAX_PITCH_DEG, Math.max(-MAX_PITCH_DEG, coarse.pitch + dp));
      consider(scoreAt(pano, normalizeYaw(coarse.yaw + dy), pitch, lens));
    }
  }
  return best;
}

/** Fold a yaw into `[−180, 180)`, the range the rotation fields display. */
export function normalizeYaw(yaw: number): number {
  const y = ((yaw + 180) % 360 + 360) % 360;
  return y - 180;
}
