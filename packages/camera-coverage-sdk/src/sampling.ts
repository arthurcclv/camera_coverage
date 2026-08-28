/**
 * Sampling policy → per-chunk validity mask (§6.3, §9.2) and its cache (§6.4).
 *
 * Final valid sampling points = (union of regions) ∩ EMPTY voxels ∩ stride.
 * The validity mask is 1 bit per voxel packed into u32 words (one word per 32
 * voxels, §9.2).
 *
 * A `SamplingState` instance *is* one cache generation (§6.4): the engine
 * constructs a fresh one on `loadScene()` / `setSampling()` and never mutates
 * the config afterwards, so "at most one build per chunk per generation" falls
 * out of memoizing on the instance. Construction builds nothing — `loadScene()`
 * must not pay for a config the caller is about to replace.
 */

import type { SamplingConfig, SamplingRegion, Vec3 } from './types.ts';
import { CellType } from './types.ts';
import type { ChunkGrid, WorkspaceGrid } from './grid.ts';
import type { Occupancy } from './occupancy.ts';

export interface ChunkValidity {
  validity: Uint32Array; // ceil(voxelCount/32) words, or zero-length when validCount is 0
  validCount: number;
}

/**
 * Module-level observability for §18.6a. `builds` counts per-chunk mask builds;
 * a cache hit must not increment it. Not exported from `index.ts` — tests import
 * this module directly.
 */
export const samplingCounters = {
  builds: 0,
  reset(): void {
    samplingCounters.builds = 0;
  },
};

export class SamplingState {
  private regions: SamplingRegion[];
  private stride: number;
  private grid: WorkspaceGrid;
  private occ: Occupancy;

  /**
   * Per-chunk cache (§6.4). `null` = built and empty (validCount 0, no words);
   * absent = not built yet.
   */
  private cache = new Map<number, ChunkValidity | null>();

  /** World-space AABB of the region union; ±Infinity where unbounded. */
  private lo: Vec3;
  private hi: Vec3;
  /**
   * True when the index bounds derived from `lo`/`hi` are *exact*, so no
   * per-voxel region test is needed. A single region of any kind qualifies: the
   * bounds are that region's own. A union of two or more does not.
   */
  private boundsExact: boolean;

  constructor(grid: WorkspaceGrid, occ: Occupancy, config: SamplingConfig) {
    this.grid = grid;
    this.occ = occ;
    this.regions = config.regions.length ? config.regions : [{ type: 'full' }];
    this.stride = config.stride ?? 1;

    this.lo = [Infinity, Infinity, Infinity];
    this.hi = [-Infinity, -Infinity, -Infinity];
    for (const r of this.regions) {
      const { min, max } = regionAabb(r);
      for (let d = 0; d < 3; d++) {
        if (min[d] < this.lo[d]) this.lo[d] = min[d];
        if (max[d] > this.hi[d]) this.hi[d] = max[d];
      }
    }
    this.boundsExact = this.regions.length === 1;
  }

  private inRegions(x: number, y: number, z: number): boolean {
    for (const r of this.regions) {
      if (regionContains(r, x, y, z)) return true;
    }
    return false;
  }

  /**
   * Cached per-chunk validity (§6.4). Builds on a miss, never rebuilds. The
   * returned array is **cache-owned**: read it, never retain or transfer it —
   * consumers that take ownership must copy (see `assembleChunkResult`).
   */
  chunkValidity(chunk: ChunkGrid): ChunkValidity {
    const hit = this.cache.get(chunk.chunkId);
    if (hit !== undefined) return hit ?? EMPTY;

    const built = this.build(chunk);
    this.cache.set(chunk.chunkId, built.validCount > 0 ? built : null);
    return built;
  }

  /** Build one chunk's mask. The only place that walks voxels. */
  private build(chunk: ChunkGrid): ChunkValidity {
    samplingCounters.builds++;

    const [nx, ny, nz] = chunk.dims;
    const voxelCount = nx * ny * nz;
    const vs = this.grid.voxelSize;
    const [gx, gy] = this.occ.dims;
    const cells = this.occ.cells;
    const [i0, j0, k0] = chunk.base;
    const s = this.stride;
    const [ox, oy, oz] = chunk.origin;
    const exact = this.boundsExact;

    // Restrict the loops to the region union's index range instead of testing
    // every voxel center (§6.4 Build). Voxel `i` has center
    // `origin + (i + 0.5) * vs`, so `center >= lo` ⇔ `i >= (lo - origin)/vs - 0.5`.
    //
    // Only the *inward* side is clamped. A bound that falls past the far edge of
    // the chunk must leave `lo > hi` so the loop runs zero times; clamping both
    // sides into [0, n-1] would instead collapse it onto the edge index and —
    // since `boundsExact` skips the per-voxel region test — hand back a plane of
    // valid voxels for a chunk the region never reaches (§6.4 Build).
    const loIdx = (bound: number, origin: number) =>
      bound === -Infinity ? 0 : Math.max(0, Math.ceil((bound - origin) / vs - 0.5));
    const hiIdx = (bound: number, origin: number, n: number) =>
      bound === Infinity ? n - 1 : Math.min(n - 1, Math.floor((bound - origin) / vs - 0.5));

    const iLo = loIdx(this.lo[0], ox);
    const iHi = hiIdx(this.hi[0], ox, nx);
    const jLo = loIdx(this.lo[1], oy);
    const jHi = hiIdx(this.hi[1], oy, ny);
    const kLo = loIdx(this.lo[2], oz);
    const kHi = hiIdx(this.hi[2], oz, nz);

    // The union misses this chunk entirely on at least one axis.
    if (iLo > iHi || jLo > jHi || kLo > kHi) return EMPTY;

    const validity = new Uint32Array((voxelCount + 31) >> 5);

    // Stride is applied in global index space so chunk seams stay aligned; walk
    // the aligned indices directly rather than testing `gi % s` per voxel.
    const start = (lo: number, base: number) =>
      s === 1 ? lo : Math.ceil((base + lo) / s) * s - base;

    let count = 0;
    for (let k = start(kLo, k0); k <= kHi; k += s) {
      const gk = k0 + k;
      const cz = oz + (k + 0.5) * vs;
      const kBase = gy * gk;
      for (let j = start(jLo, j0); j <= jHi; j += s) {
        const gj = j0 + j;
        const cy = oy + (j + 0.5) * vs;
        const rowBase = gx * (gj + kBase);
        const localRow = nx * (j + ny * k);
        for (let i = start(iLo, i0); i <= iHi; i += s) {
          if (cells[i0 + i + rowBase] !== CellType.EmptySpace) continue;
          if (!exact && !this.inRegions(ox + (i + 0.5) * vs, cy, cz)) continue;

          const li = localRow + i;
          validity[li >> 5] |= 1 << (li & 31);
          count++;
        }
      }
    }
    // §6.4 Build: `validCount === 0` carries a zero-length mask on every call,
    // so the building call and the cached call agree. Consumers gate on
    // `validCount`; the words allocated above are dropped.
    return count > 0 ? { validity, validCount: count } : EMPTY;
  }

  /**
   * Total valid voxels + number of chunks with ≥1 valid voxel. Builds every
   * chunk, which is unavoidable for these two numbers — and is exactly the
   * single pass §6.4 requires `setSampling()` to derive its stats from.
   */
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

/**
 * The one answer for a chunk with no valid voxels (§6.4: "caches no words"),
 * returned by `build()` and by every subsequent cache hit alike so the two never
 * disagree. `validity` is deliberately zero-length — `compute()` skips a chunk
 * the moment `validCount` is 0, so these words are never read, and allocating
 * `voxelCount / 8` bytes per call just to hand back zeros would defeat the point
 * of the null entry.
 */
const EMPTY: ChunkValidity = { validity: new Uint32Array(0), validCount: 0 };

function regionAabb(r: SamplingRegion): { min: Vec3; max: Vec3 } {
  switch (r.type) {
    case 'full':
      return { min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity] };
    case 'heightBand':
      return { min: [-Infinity, r.yMin, -Infinity], max: [Infinity, r.yMax, Infinity] };
    case 'box':
      return { min: r.min, max: r.max };
  }
}

function regionContains(r: SamplingRegion, x: number, y: number, z: number): boolean {
  switch (r.type) {
    case 'full':
      return true;
    case 'heightBand':
      return y >= r.yMin && y <= r.yMax;
    case 'box':
      return (
        x >= r.min[0] && x <= r.max[0] &&
        y >= r.min[1] && y <= r.max[1] &&
        z >= r.min[2] && z <= r.max[2]
      );
  }
}
