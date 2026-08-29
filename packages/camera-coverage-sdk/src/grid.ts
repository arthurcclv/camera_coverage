/**
 * Workspace grid + chunk partitioning (§2, §3).
 *
 * The logical voxel grid is never allocated densely (§3). This module only
 * computes index-space geometry: grid dimensions, chunk partitioning, and the
 * voxel-index ↔ world-center mapping.
 */

import type { Vec3, WorkspaceConfig } from './types.ts';

/**
 * Where one chunk sits in the workspace, and at what resolution.
 *
 * These four travel together everywhere a chunk is handed to a backend — the
 * compute path, the §19.4 aggregation path, and the CPU reference all need the
 * same four to turn a local voxel index into a world point and a global grid
 * index. Naming the group is what keeps a caller from passing three of them
 * from one chunk and the fourth from another.
 */
export interface ChunkPlacement {
  /** Voxel dimensions of this chunk (X,Y,Z). May be smaller at the workspace edge. */
  dims: Vec3;
  /** World-space minimum corner (m). */
  origin: Vec3;
  /** Base voxel index of this chunk in the logical grid (i0, j0, k0). */
  base: [number, number, number];
  voxelSize: number;
}

export interface ChunkGrid extends ChunkPlacement {
  chunkId: number;
  /** Chunk position in the chunk partition (cx, cz). */
  cx: number;
  cz: number;
  voxelCount: number;
}

/** The placement half of a chunk, for handing to a backend. */
export function placementOf(chunk: ChunkPlacement): ChunkPlacement {
  const { dims, origin, base, voxelSize } = chunk;
  return { dims, origin, base, voxelSize };
}

export class WorkspaceGrid {
  readonly worldMin: Vec3;
  readonly worldMax: Vec3;
  readonly voxelSize: number;
  readonly chunkSizeXZ: number;

  /** Logical voxel grid dimensions (X,Y,Z). */
  readonly gridDims: Vec3;
  /** Voxels per chunk on each axis (edge chunks are clamped). */
  readonly chunkVoxels: [number, number, number];
  /** Number of chunks along X and Z. */
  readonly chunkCountX: number;
  readonly chunkCountZ: number;

  constructor(cfg: WorkspaceConfig) {
    this.worldMin = cfg.worldMin;
    this.worldMax = cfg.worldMax;
    this.voxelSize = cfg.voxelSize;
    this.chunkSizeXZ = cfg.chunkSizeXZ;

    const ext: Vec3 = [
      cfg.worldMax[0] - cfg.worldMin[0],
      cfg.worldMax[1] - cfg.worldMin[1],
      cfg.worldMax[2] - cfg.worldMin[2],
    ];
    if (ext[0] <= 0 || ext[1] <= 0 || ext[2] <= 0) {
      throw new Error('WorkspaceGrid: worldMax must be strictly greater than worldMin on every axis');
    }
    this.gridDims = [
      Math.max(1, Math.round(ext[0] / cfg.voxelSize)),
      Math.max(1, Math.round(ext[1] / cfg.voxelSize)),
      Math.max(1, Math.round(ext[2] / cfg.voxelSize)),
    ];

    // Chunk partitioning derived from workspace dims — never hard-coded (§3).
    const vpcX = Math.max(1, Math.round(cfg.chunkSizeXZ / cfg.voxelSize));
    const vpcZ = vpcX;
    this.chunkVoxels = [vpcX, this.gridDims[1], vpcZ];
    this.chunkCountX = Math.ceil(this.gridDims[0] / vpcX);
    this.chunkCountZ = Math.ceil(this.gridDims[2] / vpcZ);
  }

  get chunkCount(): number {
    return this.chunkCountX * this.chunkCountZ;
  }

  chunk(chunkId: number): ChunkGrid {
    if (chunkId < 0 || chunkId >= this.chunkCount) {
      throw new Error(`chunkId ${chunkId} out of range [0, ${this.chunkCount})`);
    }
    const cx = chunkId % this.chunkCountX;
    const cz = Math.floor(chunkId / this.chunkCountX);
    const [vpcX, , vpcZ] = this.chunkVoxels;

    const i0 = cx * vpcX;
    const k0 = cz * vpcZ;
    const nx = Math.min(vpcX, this.gridDims[0] - i0);
    const nz = Math.min(vpcZ, this.gridDims[2] - k0);
    const ny = this.gridDims[1];

    const origin: Vec3 = [
      this.worldMin[0] + i0 * this.voxelSize,
      this.worldMin[1],
      this.worldMin[2] + k0 * this.voxelSize,
    ];
    return {
      chunkId,
      cx,
      cz,
      dims: [nx, ny, nz],
      origin,
      base: [i0, 0, k0],
      voxelSize: this.voxelSize,
      voxelCount: nx * ny * nz,
    };
  }

  *chunks(): Generator<ChunkGrid> {
    for (let id = 0; id < this.chunkCount; id++) yield this.chunk(id);
  }
}

/**
 * A `chunkSizeXZ` that puts a chunk near `targetVoxels` (§3).
 *
 * The 10 m default describes a 100 × 20 × 100 m site, where it gives the
 * intended ~100 chunks of 2M voxels. Pinned and applied to a 440 × 201 × 1120 m
 * site at 1.0 m voxels it gives **4,928 chunks of 20,100 voxels** — 50× the
 * chunk count, each 100× smaller. None of that is a per-voxel cost: it
 * multiplies every *per-chunk* fixed cost (a GPU buffer set, a submission, a
 * mapping, a result message, a §19.3 leaf merge) by 50.
 *
 * Chunks partition XZ only, so the workspace height is a fixed multiplier and
 * the square footprint follows: `vpc = floor(sqrt(target / gridY))`. On the
 * §3 defaults this returns exactly 10 m; on the site above, ~99 m — 60 chunks
 * of 1.97M voxels.
 */
export function suggestChunkSizeXZ(
  worldMin: Vec3,
  worldMax: Vec3,
  voxelSize: number,
  opts: {
    targetVoxels?: number;
    maxVoxels?: number;
    /**
     * Cameras the run will carry. The readback clamp below is per *camera word*,
     * so it does nothing without this — and the default of 1 word is the
     * smallest, most permissive answer, never a silently tighter one.
     */
    numCameras?: number;
    /** §11.1's host-heap budget. Defaults to the same 256 MiB `EngineOptions` does. */
    maxReadbackBytes?: number;
  } = {},
): number {
  const target = opts.targetVoxels ?? 2_000_000;
  // The §11 Pass 1 dispatch limit caps a chunk near 4.19M voxels on typical
  // hardware (65,535 workgroups × 64); never propose past it.
  const dispatchCap = opts.maxVoxels ?? 4_000_000;

  // §3's second clamp: the planned readback has to stay inside §11.1's host-heap
  // budget. A chunk's per-voxel readback is `CAM_WORDS × 4` bytes of masks plus
  // ~1.13 B for §19's `leafCounts` (one byte per voxel, plus a validity bit),
  // and `voxelCount` scales with the *full workspace height* because chunks
  // partition XZ only. A tall site at a fine voxel size therefore crosses this
  // long before it crosses the dispatch limit — and without the clamp the
  // suggestion itself is what hands `computeChunk` a chunk it must reject.
  const camWords = Math.ceil(Math.max(1, opts.numCameras ?? 1) / 32);
  const bytesPerVoxel = camWords * 4 + 1 + 1 / 8;
  const readbackCap = Math.floor((opts.maxReadbackBytes ?? 256 * 1024 * 1024) / bytesPerVoxel);

  const cap = Math.min(target, dispatchCap, readbackCap);
  const gridY = Math.max(1, Math.round((worldMax[1] - worldMin[1]) / voxelSize));
  const gridX = Math.max(1, Math.round((worldMax[0] - worldMin[0]) / voxelSize));
  const gridZ = Math.max(1, Math.round((worldMax[2] - worldMin[2]) / voxelSize));
  // Never finer than one voxel, never coarser than the workspace itself — a
  // chunk larger than the grid just wastes the clamp in `WorkspaceGrid.chunk`.
  const vpc = Math.min(
    Math.max(1, Math.floor(Math.sqrt(cap / gridY))),
    Math.max(gridX, gridZ),
  );
  return vpc * voxelSize;
}

/** Linear voxel index within a chunk. X fastest, then Y, then Z. */
export function localIndex(i: number, j: number, k: number, dims: Vec3): number {
  return i + dims[0] * (j + dims[1] * k);
}

/** World-space center of local voxel (i,j,k) inside a chunk. */
export function voxelCenter(
  i: number,
  j: number,
  k: number,
  origin: Vec3,
  voxelSize: number,
): Vec3 {
  return [
    origin[0] + (i + 0.5) * voxelSize,
    origin[1] + (j + 0.5) * voxelSize,
    origin[2] + (k + 0.5) * voxelSize,
  ];
}
