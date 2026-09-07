/**
 * A pool position's cached reachable set, and the union arithmetic the trials
 * run on (`camera_placement.md` §2.1, §2.2, §4.4).
 *
 * The set is kept in the form the SDK already returns it — `leafCounts`' merged
 * **power-of-two cubes** (SDK spec §19.2) — and never expanded. That is what
 * keeps a 200-position pool in megabytes on a site where a bitset per position
 * would be gigabytes.
 *
 * A build step reads `leafCounts` with `AggregateSpec.cameras` set to the six
 * capture-rig bits and the marked filter applied, so `count > 0` means exactly
 * "valid, inside the marked set, and reachable from this position" (§2.1) — the
 * one predicate this module reads.
 *
 * A trial rasterizes its layout's cubes into one accumulating bitset, counting
 * **only newly-set bits**. That makes the running score exact at every prefix
 * and costs `Σ|R(p)|` writes rather than `maxCount × |U|` (§4.4).
 */
import type { AggregateResult, ChunkGrid, Vec3 } from '@linkervision/camera-coverage-sdk';

/** One chunk's worth of a reachable set, in that chunk's local index space. */
export interface LeafChunk {
  /** Global voxel index of the chunk's minimum corner (`ChunkGrid.base`). */
  base: readonly [number, number, number];
  /** Chunk voxel dims, needed to decode a local linear index (X fastest). */
  dims: readonly [number, number, number];
  /** Local linear index of each cube's minimum corner. */
  index: Uint32Array;
  /** Each cube's edge length in voxels (a power of two; 1 = a single voxel). */
  size: Uint16Array;
}

/** A whole reachable set: its cubes, and how many voxels they cover. */
export interface LeafSet {
  chunks: LeafChunk[];
  /** `Σ edge³` over every cube — SVO leaves partition, so this is exact. */
  count: number;
}

export const EMPTY_LEAF_SET: LeafSet = { chunks: [], count: 0 };

/**
 * The scratch bitset a trial accumulates into, sized for the whole workspace
 * grid. 64 MiB covers ~536M voxels; beyond that the placement tool asks for a
 * coarser resolution rather than allocating half a gigabyte behind the user's
 * back.
 */
const MAX_SCRATCH_BYTES = 64 * 1024 * 1024;

/** Voxels the scratch bitset can address at all. */
export const MAX_SCRATCH_VOXELS = MAX_SCRATCH_BYTES * 8;

function popcount32(n: number): number {
  let v = n - ((n >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0x3f;
}

/**
 * Extract one chunk's reachable cubes from an aggregation result.
 *
 * Leaves with `count === 0` are dropped here rather than at rasterize time:
 * most of a chunk is typically unreachable, and carrying those cubes would
 * multiply both the cache and every trial's inner loop by the whole chunk.
 *
 * Returns `null` when the chunk contributes nothing, so a caller can skip it
 * entirely (§2.1: an absent chunk reads as zero, which is correct).
 */
export function leafChunkFrom(result: AggregateResult, chunk: ChunkGrid): LeafChunk | null {
  const leaves = result.leafCounts;
  if (!leaves) return null;
  const total = leaves.index.length;
  let kept = 0;
  for (let n = 0; n < total; n++) if (leaves.count[n] > 0) kept++;
  if (kept === 0) return null;

  const index = new Uint32Array(kept);
  const size = new Uint16Array(kept);
  let w = 0;
  for (let n = 0; n < total; n++) {
    if (leaves.count[n] === 0) continue;
    index[w] = leaves.index[n];
    size[w] = leaves.size[n];
    w++;
  }
  return { base: chunk.base as readonly [number, number, number], dims: chunk.dims, index, size };
}

/** `Σ edge³` over a set's cubes — the number of voxels it covers. */
export function leafSetCount(chunks: LeafChunk[]): number {
  let n = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.size.length; i++) {
      const e = c.size[i];
      n += e * e * e;
    }
  }
  return n;
}

/** Assemble a set from per-chunk cubes, deriving its voxel count. */
export function leafSetOf(chunks: LeafChunk[]): LeafSet {
  return { chunks, count: leafSetCount(chunks) };
}

/**
 * A bitset over the workspace's global voxel index, reused across trials.
 *
 * `clear()` is a `fill(0)` rather than a generation stamp: a stamp needs a byte
 * or two **per voxel** where this needs a bit, and clearing 12 MiB costs about
 * a millisecond against a trial's tens (§2.3).
 */
export class VoxelBitset {
  readonly dims: readonly [number, number, number];
  private readonly bits: Uint32Array;

  constructor(gridDims: Vec3 | readonly [number, number, number]) {
    const voxels = gridDims[0] * gridDims[1] * gridDims[2];
    if (!(voxels > 0)) throw new Error('VoxelBitset needs a non-empty grid');
    if (voxels > MAX_SCRATCH_VOXELS) {
      throw new Error(
        `The workspace has ${voxels.toLocaleString()} voxels; camera placement can search up to ` +
          `${MAX_SCRATCH_VOXELS.toLocaleString()}. Use a coarser resolution.`,
      );
    }
    this.dims = [gridDims[0], gridDims[1], gridDims[2]];
    this.bits = new Uint32Array(Math.ceil(voxels / 32));
  }

  clear(): void {
    this.bits.fill(0);
  }

  /** Bits currently set — the union's voxel count. */
  count(): number {
    let n = 0;
    for (let i = 0; i < this.bits.length; i++) n += popcount32(this.bits[i]);
    return n;
  }

  /** Is the global voxel at `(i, j, k)` set? For tests and probes. */
  has(i: number, j: number, k: number): boolean {
    const [nx, ny] = this.dims;
    const g = i + nx * (j + ny * k);
    return ((this.bits[g >>> 5] >>> (g & 31)) & 1) === 1;
  }

  /** Count the bits in the run of `len` from `start` that are **not** set. */
  private countRun(start: number, len: number): number {
    let missing = 0;
    let i = start;
    const end = start + len;
    while (i < end) {
      const w = i >>> 5;
      const bit = i & 31;
      const room = Math.min(32 - bit, end - i);
      const mask = room === 32 ? 0xffffffff : (((1 << room) - 1) << bit) >>> 0;
      missing += popcount32((~this.bits[w] & mask) >>> 0);
      i += room;
    }
    return missing;
  }

  /** Set the run of `len` bits from global index `start`; returns how many were new. */
  private setRun(start: number, len: number): number {
    let added = 0;
    let i = start;
    const end = start + len;
    while (i < end) {
      const w = i >>> 5;
      const bit = i & 31;
      const room = Math.min(32 - bit, end - i);
      const mask = room === 32 ? 0xffffffff : (((1 << room) - 1) << bit) >>> 0;
      const cur = this.bits[w];
      const add = (~cur & mask) >>> 0;
      if (add !== 0) {
        this.bits[w] = (cur | mask) >>> 0;
        added += popcount32(add);
      }
      i += room;
    }
    return added;
  }

  /**
   * OR a reachable set in, returning the voxels it added that were not already
   * covered — its **marginal** contribution to the union so far (§4.4).
   *
   * A cube's rows run along X, which is also the fastest axis of the global
   * index, so each row is one contiguous bit run rather than `edge` separate
   * test-and-sets.
   */
  add(set: LeafSet): number {
    return this.rasterize(set, true);
  }

  /**
   * What `add(set)` *would* return, without setting anything — the position's
   * **gain** against the union so far (§4.4).
   *
   * The greedy pass asks this of many candidates per pick and commits one, so
   * the read and the write have to walk the cubes identically or the layout it
   * builds would not be the layout it scored. One walk, one flag.
   */
  gain(set: LeafSet): number {
    return this.rasterize(set, false);
  }

  private rasterize(set: LeafSet, write: boolean): number {
    const [gnx, gny] = this.dims;
    let added = 0;
    for (const c of set.chunks) {
      const [nx, ny, nz] = c.dims;
      const [i0, j0, k0] = c.base;
      for (let n = 0; n < c.index.length; n++) {
        const li = c.index[n];
        const e = c.size[n];
        const li0 = li % nx;
        const lj0 = Math.floor(li / nx) % ny;
        const lk0 = Math.floor(li / (nx * ny));
        // A cube is contained in its chunk, but clamp anyway: a malformed leaf
        // must not write into a neighbouring chunk's voxels.
        const ex = Math.min(e, nx - li0);
        const ey = Math.min(e, ny - lj0);
        const ez = Math.min(e, nz - lk0);
        for (let dk = 0; dk < ez; dk++) {
          for (let dj = 0; dj < ey; dj++) {
            const g = i0 + li0 + gnx * (j0 + lj0 + dj + gny * (k0 + lk0 + dk));
            added += write ? this.setRun(g, ex) : this.countRun(g, ex);
          }
        }
      }
    }
    return added;
  }
}
