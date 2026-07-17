/**
 * Workspace grid + chunk partitioning (§2, §3).
 *
 * The logical voxel grid is never allocated densely (§3). This module only
 * computes index-space geometry: grid dimensions, chunk partitioning, and the
 * voxel-index ↔ world-center mapping.
 */

import type { Vec3, WorkspaceConfig } from './types.ts';

export interface ChunkGrid {
  chunkId: number;
  /** Chunk position in the chunk partition (cx, cz). */
  cx: number;
  cz: number;
  /** Voxel dimensions of this chunk (X,Y,Z). May be smaller at the workspace edge. */
  dims: Vec3;
  /** World-space minimum corner (m). */
  origin: Vec3;
  /** Base voxel index of this chunk in the logical grid (i0, j0, k0). */
  base: [number, number, number];
  voxelCount: number;
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
      voxelCount: nx * ny * nz,
    };
  }

  *chunks(): Generator<ChunkGrid> {
    for (let id = 0; id < this.chunkCount; id++) yield this.chunk(id);
  }
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
