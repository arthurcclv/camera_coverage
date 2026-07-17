/**
 * Sampling policy → per-chunk validity mask (§6.3, §9.2).
 *
 * Final valid sampling points = (union of regions) ∩ EMPTY voxels ∩ stride.
 * The validity mask is 1 bit per voxel packed into u32 words (one word per 32
 * voxels, §9.2).
 */

import type { SamplingConfig, SamplingRegion, Vec3 } from './types.ts';
import { CellType } from './types.ts';
import type { ChunkGrid, WorkspaceGrid } from './grid.ts';
import { localIndex } from './grid.ts';
import type { Occupancy } from './occupancy.ts';

export interface ChunkValidity {
  validity: Uint32Array; // ceil(voxelCount/32) words
  validCount: number;
}

export class SamplingState {
  private regions: SamplingRegion[];
  private stride: number;
  private grid: WorkspaceGrid;
  private occ: Occupancy;

  constructor(grid: WorkspaceGrid, occ: Occupancy, config: SamplingConfig) {
    this.grid = grid;
    this.occ = occ;
    this.regions = config.regions.length ? config.regions : [{ type: 'full' }];
    this.stride = config.stride ?? 1;
  }

  private inRegions(center: Vec3): boolean {
    for (const r of this.regions) {
      if (regionContains(r, center)) return true;
    }
    return false;
  }

  chunkValidity(chunk: ChunkGrid): ChunkValidity {
    const [nx, ny, nz] = chunk.dims;
    const voxelCount = nx * ny * nz;
    const validity = new Uint32Array((voxelCount + 31) >> 5);
    const vs = this.grid.voxelSize;
    const [gx, gy] = this.occ.dims;
    const cells = this.occ.cells;
    const [i0, j0, k0] = chunk.base;
    const s = this.stride;

    let count = 0;
    for (let k = 0; k < nz; k++) {
      const gk = k0 + k;
      for (let j = 0; j < ny; j++) {
        const gj = j0 + j;
        for (let i = 0; i < nx; i++) {
          const gi = i0 + i;
          // Stride is applied in global index space so chunk seams stay aligned.
          if (s > 1 && (gi % s !== 0 || gj % s !== 0 || gk % s !== 0)) continue;

          const gcell = gi + gx * (gj + gy * gk);
          if (cells[gcell] !== CellType.EmptySpace) continue;

          const center: Vec3 = [
            chunk.origin[0] + (i + 0.5) * vs,
            chunk.origin[1] + (j + 0.5) * vs,
            chunk.origin[2] + (k + 0.5) * vs,
          ];
          if (!this.inRegions(center)) continue;

          const li = localIndex(i, j, k, chunk.dims);
          validity[li >> 5] |= 1 << (li & 31);
          count++;
        }
      }
    }
    return { validity, validCount: count };
  }

  /** Total valid voxels + number of chunks with ≥1 valid voxel. */
  summarize(): { validVoxels: number; activeChunks: number } {
    let validVoxels = 0;
    let activeChunks = 0;
    for (const chunk of this.grid.chunks()) {
      const v = this.chunkValidity(chunk);
      if (v.validCount > 0) {
        activeChunks++;
        validVoxels += v.validCount;
      }
    }
    return { validVoxels, activeChunks };
  }
}

function regionContains(r: SamplingRegion, p: Vec3): boolean {
  switch (r.type) {
    case 'full':
      return true;
    case 'heightBand':
      return p[1] >= r.yMin && p[1] <= r.yMax;
    case 'box':
      return (
        p[0] >= r.min[0] && p[0] <= r.max[0] &&
        p[1] >= r.min[1] && p[1] <= r.max[1] &&
        p[2] >= r.min[2] && p[2] <= r.max[2]
      );
  }
}
