/**
 * CPU reference implementation of the per-chunk GPU pipeline (§11):
 *   Pass 1  frustum cull (active cameras only)
 *   Pass 2  BVH occlusion ray per in-frustum camera (+ 8-sample coverage, Mode 2)
 *   Pass 3  stats reduction
 *
 * Produces the dense buffers of §9.1–9.3. The WebGPU backend mirrors this in
 * WGSL; results are intended to be bit-identical (§18 determinism / pre-cull).
 */

import type { Vec3 } from '../types.ts';
import type { Bvh } from '../geometry/bvh.ts';
import type { PreparedCamera } from '../camera.ts';
import { pointInFrustum } from '../camera.ts';
import { occluded, T_EPS } from '../kernel.ts';
import { voxelCenter, type ChunkPlacement } from '../grid.ts';
import { aggregateChunkCPU, type AggregateResult, type PackedAggregate } from '../aggregate.ts';

export interface ChunkComputeInput extends ChunkPlacement {
  validity: Uint32Array;
  /**
   * Valid voxels in this chunk, from the §6.4 cache. Bounds Pass 2's dispatch
   * (§11 Pass 2): `candidateCount <= validCount`, so `ceil(validCount / WG)`
   * workgroups suffice and the count never has to leave the GPU.
   */
  validCount: number;
  /**
   * Whether the caller consumes per-voxel results (§11.1). When false the
   * backend may skip reading `visibility` / `coverage` back; `stats` — and
   * therefore `CoverageSummary` — is unaffected.
   */
  emitVoxels: boolean;
  cameras: PreparedCamera[];
  numCameras: number;
  camWords: number;
  activeMask: Uint32Array; // camWords words
  bvh: Bvh;
  mode: 1 | 2;
  threshold: number;
  /**
   * §19 aggregation, evaluated inside this chunk's pipeline while its masks are
   * still resident. Pre-packed by the engine so both backends read the same
   * bytes (§19.5).
   */
  aggregate?: PackedAggregate;
}

export interface ChunkComputeOutput {
  /** voxelCount * camWords. Absent when `emitVoxels` was false (§11.1). */
  visibility?: Uint32Array;
  coverage?: Uint32Array; // Mode 2: voxelCount * 4 * camWords
  stats: { validCount: number; coveredCount: number; visibleCount: number[] };
  /** Present exactly when `input.aggregate` was (§19.4). */
  aggregate?: AggregateResult;
}

// Mode 2 sample offsets: center + 0.35*voxelSize*(±1,±1,±1) (§14).
const M2_OFFSETS: Vec3[] = [
  [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];

export function computeChunkCPU(input: ChunkComputeInput): ChunkComputeOutput {
  const { dims, origin, voxelSize, validity, cameras, numCameras, camWords, activeMask, bvh, mode, threshold } = input;
  const voxelCount = dims[0] * dims[1] * dims[2];

  const visibility = new Uint32Array(voxelCount * camWords);
  const coverage = mode === 2 ? new Uint32Array(voxelCount * 4 * camWords) : undefined;

  const visibleCount = new Array<number>(numCameras).fill(0);
  let validCount = 0;
  let coveredCount = 0;

  const [nx, ny] = dims;

  for (let li = 0; li < voxelCount; li++) {
    if (((validity[li >> 5] >>> (li & 31)) & 1) === 0) continue;
    validCount++;

    const i = li % nx;
    const j = ((li - i) / nx) % ny;
    const k = Math.floor(li / (nx * ny));
    const center = voxelCenter(i, j, k, origin, voxelSize);

    let anyVisible = false;

    for (let c = 0; c < numCameras; c++) {
      if (((activeMask[c >> 5] >>> (c & 31)) & 1) === 0) continue;
      const cam = cameras[c];

      let setBit = false;
      if (mode === 1) {
        if (sampleVisible(cam, center, bvh)) setBit = true;
      } else {
        let count = 0;
        for (const off of M2_OFFSETS) {
          const s: Vec3 = [
            center[0] + 0.35 * voxelSize * off[0],
            center[1] + 0.35 * voxelSize * off[1],
            center[2] + 0.35 * voxelSize * off[2],
          ];
          if (sampleVisible(cam, s, bvh)) count++;
        }
        writeCoverageNibble(coverage!, li, c, camWords, count);
        if (count >= threshold) setBit = true;
      }

      if (setBit) {
        visibility[li * camWords + (c >> 5)] |= 1 << (c & 31);
        visibleCount[c]++;
        anyVisible = true;
      }
    }

    if (anyVisible) coveredCount++;
  }

  return {
    visibility,
    coverage,
    stats: { validCount, coveredCount, visibleCount },
    aggregate: input.aggregate
      ? aggregateChunkCPU({
          chunkId: -1, // stamped by the engine, which owns the chunk identity
          dims,
          origin,
          base: input.base,
          voxelSize,
          camWords,
          numCameras,
          validity,
          visibility,
          packed: input.aggregate,
        })
      : undefined,
  };
}

/** Visibility of a single sample point to one camera (§8). */
function sampleVisible(cam: PreparedCamera, p: Vec3, bvh: Bvh): boolean {
  if (!pointInFrustum(cam, p)) return false;
  const dx = cam.position[0] - p[0];
  const dy = cam.position[1] - p[1];
  const dz = cam.position[2] - p[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist > cam.far) return false;
  if (dist < 2 * T_EPS) return true; // sample nearly coincident with the camera
  const inv = 1 / dist;
  const dir: Vec3 = [dx * inv, dy * inv, dz * inv];
  return !occluded(bvh, p, dir, T_EPS, dist - T_EPS);
}

function writeCoverageNibble(
  coverage: Uint32Array,
  li: number,
  c: number,
  camWords: number,
  count: number,
): void {
  // 4 × CAM_WORDS u32 per voxel; bits [4*(c%8)..+3] of word[c/8] (§9.3).
  const wordsPerVoxel = 4 * camWords;
  const word = li * wordsPerVoxel + (c >> 3);
  const shift = 4 * (c & 7);
  coverage[word] = (coverage[word] & ~(0xf << shift)) | ((count & 0xf) << shift);
}
