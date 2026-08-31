/**
 * The panorama: a mount point's reachable set as a weighted angular image, plus
 * the mip pyramid that makes scoring an orientation cost the frustum's boundary
 * rather than the whole image (`aim_optimization.md` §3.2, §7.2).
 *
 * Everything here is pure arithmetic over the six `ProjectionAccum`s a capture
 * returns. It knows nothing about the engine, the worker, or React — which is
 * what lets `test/panorama.test.ts` build one by hand.
 */
import type { ProjectionAccum, Quat } from '@linkervision/camera-coverage-sdk';
import { CUBE_FACES } from './cubeRig.ts';

/** Bins per face edge (§2.2). 64 is 1.4° per bin at the cube face's 90°. */
export const PANORAMA_RESOLUTION = 64;

export interface PanoramaLevel {
  /** Cells per axis, per face. */
  size: number;
  /** `6 * size * size` summed score, in {@link SCORE_SCALE} fixed point. */
  score: Float64Array;
  /** `6 * size * size` summed blind-voxel counts. */
  blind: Float64Array;
  /**
   * `6 * size * size * 12` — four unit corner directions per cell, world space.
   *
   * Precomputed because they are the same for every candidate: a cell's angular
   * footprint is a property of the cube face, and only the frustum moves.
   */
  corners: Float32Array;
}

export interface Panorama {
  resolution: number;
  /** Levels finest-first: `[0]` is the bin grid, the last is one cell per face. */
  levels: PanoramaLevel[];
  /** `6 * R * R * 3` unit direction of each bin centre — the leaf-level test. */
  dir: Float32Array;
  /** Total score over every bin, in fixed point: the whole reachable set. */
  totalScore: number;
  /** Total blind voxels over every bin. */
  totalBlind: number;
}

// --- small quaternion helpers ------------------------------------------------
// Written on plain numbers rather than three.js objects: the pyramid build
// rotates ~200k vectors, and a Vector3 per rotation is 200k allocations.

/** Rotate `(x,y,z)` by quaternion `q` (xyzw), writing into `out` at `o`. */
function rotate(q: Quat, x: number, y: number, z: number, out: Float32Array, o: number): void {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * The unit world direction of NDC `(ndcX, ndcY)` on cube face `f`.
 *
 * The inverse of the SDK's `projectionBin` for a 90°/aspect-1 camera: there
 * `ndc = (x_view, y_view) / -z_view` with both tangents 1, so the ray through an
 * NDC point is simply `(ndcX, ndcY, -1)` in the face's own frame.
 */
function faceDir(f: number, ndcX: number, ndcY: number, out: Float32Array, o: number): void {
  const inv = 1 / Math.hypot(ndcX, ndcY, 1);
  rotate(CUBE_FACES[f], ndcX * inv, ndcY * inv, -inv, out, o);
}

/** NDC of a bin edge: bin `i` of `size` spans `[edge(i), edge(i+1))` in x. */
function edgeX(i: number, size: number): number {
  return (i / size) * 2 - 1;
}
/** …and `y` runs top-down, matching `projectionBin`'s `0.5*R - ndcY*0.5*R`. */
function edgeY(j: number, size: number): number {
  return 1 - (j / size) * 2;
}

/**
 * Sum the six per-chunk accumulators of a capture into one panorama.
 *
 * `accums` is the merged result across every chunk the capture computed — six
 * `Float64Array`s of `planes × R × R`, plane 0 score and plane 1 blind
 * (`weights.ts`). `Float64Array` because the merge spans up to every chunk of
 * the workspace and each may sit close to the per-chunk `u32` bound (§3.2).
 */
export function buildPanorama(merged: Float64Array[], resolution = PANORAMA_RESOLUTION): Panorama {
  const R = resolution;
  const faces = CUBE_FACES.length;
  const plane = R * R;

  const score = new Float64Array(faces * plane);
  const blind = new Float64Array(faces * plane);
  for (let f = 0; f < faces; f++) {
    const src = merged[f];
    for (let b = 0; b < plane; b++) {
      score[f * plane + b] = src[b];
      blind[f * plane + b] = src[plane + b];
    }
  }

  const dir = new Float32Array(faces * plane * 3);
  for (let f = 0; f < faces; f++) {
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const b = f * plane + y * R + x;
        faceDir(f, ((x + 0.5) / R) * 2 - 1, 1 - ((y + 0.5) / R) * 2, dir, b * 3);
      }
    }
  }

  const levels: PanoramaLevel[] = [makeLevel(R, score, blind, faces)];
  // Halved with a ceiling, so an odd level leaves a half-width cell rather than
  // a padded one — the cell's own corners describe it, so nothing is assumed
  // about what lies past the edge.
  let size = R;
  while (size > 1) {
    const half = (size + 1) >> 1;
    const prev = levels[levels.length - 1];
    const s = new Float64Array(faces * half * half);
    const bl = new Float64Array(faces * half * half);
    for (let f = 0; f < faces; f++) {
      for (let j = 0; j < half; j++) {
        for (let i = 0; i < half; i++) {
          let ss = 0;
          let bb = 0;
          for (let d = 0; d < 4; d++) {
            const cx = 2 * i + (d & 1);
            const cy = 2 * j + (d >> 1);
            if (cx >= size || cy >= size) continue;
            const ci = f * size * size + cy * size + cx;
            ss += prev.score[ci];
            bb += prev.blind[ci];
          }
          const o = f * half * half + j * half + i;
          s[o] = ss;
          bl[o] = bb;
        }
      }
    }
    levels.push(makeLevel(half, s, bl, faces));
    size = half;
  }

  let totalScore = 0;
  let totalBlind = 0;
  for (let b = 0; b < score.length; b++) {
    totalScore += score[b];
    totalBlind += blind[b];
  }
  return { resolution: R, levels, dir, totalScore, totalBlind };
}

function makeLevel(size: number, score: Float64Array, blind: Float64Array, faces: number): PanoramaLevel {
  const corners = new Float32Array(faces * size * size * 12);
  for (let f = 0; f < faces; f++) {
    for (let j = 0; j < size; j++) {
      const y0 = edgeY(j, size);
      const y1 = edgeY(j + 1, size);
      for (let i = 0; i < size; i++) {
        const x0 = edgeX(i, size);
        const x1 = edgeX(i + 1, size);
        const o = (f * size * size + j * size + i) * 12;
        faceDir(f, x0, y0, corners, o);
        faceDir(f, x1, y0, corners, o + 3);
        faceDir(f, x0, y1, corners, o + 6);
        faceDir(f, x1, y1, corners, o + 9);
      }
    }
  }
  return { size, score, blind, corners };
}
