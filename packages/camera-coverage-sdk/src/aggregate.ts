/**
 * Aggregation (§19): domain-neutral reductions the engine evaluates where the
 * masks live, so a caller never has to scan per-voxel data itself.
 *
 * Four primitives — oriented boxes, voxel columns, per-voxel popcounts, and
 * point lookups. The SDK deliberately knows nothing about what a caller calls
 * them (§19). Everything here is plain data so the descriptor crosses a Worker
 * boundary unchanged; a caller predicate could not (§16.1).
 *
 * This module owns three things the two backends share:
 *  - the descriptor's validation (§19.6),
 *  - `packAggregate`, the GPU-side byte layout, which is also the layout the
 *    CPU reference reads so both start from the *same f32 values* (a region the
 *    CPU tested at f64 precision would classify boundary voxels differently),
 *  - `aggregateChunkCPU`, the scalar reduction, which is the CPU backend's
 *    implementation and the reference the WebGPU passes are asserted against
 *    (§18, 6l/6m).
 */

import { EngineError, EngineErrorCode, type Quat, type Vec3 } from './types.ts';
import type { ChunkPlacement } from './grid.ts';

// ---------------------------------------------------------------------------
// §19.1 Descriptor
// ---------------------------------------------------------------------------

/** §19.6 caps. Each is a buffer-layout bound, not a taste judgement. */
export const MAX_AGGREGATE_REGIONS = 64;
export const MAX_AGGREGATE_SLABS = 32;
export const MAX_AGGREGATE_PROBES = 256;
/** Group indices are a single `u32` mask word, so `0..31` (§19.2). */
export const MAX_AGGREGATE_GROUPS = 32;

/**
 * An oriented box, not the AABB of §7.1's `SamplingRegion`: sampling regions
 * bound what is *computed* and may be conservative, aggregation regions decide
 * what is *counted* and must be exact.
 */
export interface AggregateRegion {
  center: Vec3;
  rotation: Quat; // identity ⇒ axis-aligned
  halfSize: Vec3; // all components > 0
  /**
   * Group indices (`0..31`) this region feeds. A voxel increments a group once
   * however many of that group's regions contain it — which is the only way to
   * total a domain object made of overlapping boxes (§19.2).
   */
  groups: number[];
}

export interface AggregateSlab {
  /** Collapse axis: this slab's columns run along it and reduce to one cell. */
  axis: 0 | 1 | 2;
  /** Inclusive global voxel-index range per axis, in workspace grid coordinates. */
  range: [[number, number], [number, number], [number, number]];
  /** Count only voxels inside the union of these region indices; empty ⇒ no filter. */
  maskRegions: number[];
}

export interface AggregateLeafCounts {
  /** Report voxels outside the union of these region indices as invalid; empty ⇒ no filter. */
  maskRegions: number[];
}

export interface AggregateSpec {
  regions?: AggregateRegion[];
  columns?: AggregateSlab[];
  leafCounts?: AggregateLeafCounts;
  probes?: Vec3[];
}

// ---------------------------------------------------------------------------
// §19.2 Outputs
// ---------------------------------------------------------------------------

export interface RegionAccum {
  valid: number;
  covered: number;
  blind: number;
  /** `numCameras` entries: per-camera hit counts inside this region. */
  seen: Uint32Array;
}

export interface ColumnAccum {
  dimsA: number;
  dimsB: number;
  /** All arrays are `dimsA * dimsB`, row-major: index = a + dimsA * b. */
  camCountSum: Uint32Array;
  camCountMax: Uint8Array;
  /** `0xFF` where the cell counted nothing — see {@link COLUMN_MIN_EMPTY}. */
  camCountMin: Uint8Array;
  blindCount: Uint32Array;
  validCount: Uint32Array;
  obstacleCount: Uint32Array;
  filteredCount: Uint32Array;
  /** `dimsA * dimsB * camWords`, OR of every counted voxel's mask. */
  seenWords: Uint32Array;
}

/**
 * `camCountMin` sentinel for a cell that counted no voxel (§19.2). A cell that
 * merged in a chunk contributing nothing must not have its minimum dragged to
 * 0 — that is the difference between "every voxel here is blind" and "no voxel
 * here was counted", and the caller classifies them differently (§13.3).
 */
export const COLUMN_MIN_EMPTY = 0xff;

/** Merged uniform cubes of equal camera count (§19.2, §19.3). */
export interface LeafCounts {
  /** Per leaf: linear index of its minimum corner, chunk-local order. */
  index: Uint32Array;
  /** Per leaf: cube edge length in voxels — a power of two; 1 is a single voxel. */
  size: Uint16Array;
  /** Per leaf: the camera count shared by every voxel it covers. */
  count: Uint8Array;
}

/** Per-probe placement in a chunk (§19.2). */
export const ProbeHit = {
  Missed: 0,
  Valid: 1,
  Invalid: 2,
} as const;

export interface AggregateResult {
  chunkId: number;
  /** One per descriptor region. */
  regions?: RegionAccum[];
  /** {@link MAX_AGGREGATE_GROUPS} entries; an index nothing declared is all zeros. */
  groups?: RegionAccum[];
  /** One per slab, in descriptor order. */
  columns?: ColumnAccum[];
  /**
   * Merged uniform cubes (§19.3), **not** one entry per voxel. A renderer's cost
   * is per drawn instance, so the collapse is done here rather than left to the
   * caller — on a typical room it is an order of magnitude fewer instances.
   */
  leafCounts?: LeafCounts;
  /** `probes.length × camWords`; zero where the probe missed this chunk. */
  probeMasks?: Uint32Array;
  /** One {@link ProbeHit} per probe. */
  probeHits?: Uint8Array;
}

// ---------------------------------------------------------------------------
// §19.6 Validation
// ---------------------------------------------------------------------------

function tooLarge(what: string, got: number, cap: number): never {
  throw new EngineError(
    EngineErrorCode.AGGREGATE_TOO_LARGE,
    `Aggregation descriptor has ${got} ${what}; the limit is ${cap} (§19.6).`,
    { what, got, cap },
  );
}

function invalid(message: string, detail?: unknown): never {
  throw new EngineError(EngineErrorCode.INVALID_AGGREGATE, message, detail);
}

function finite3(v: readonly number[] | undefined, label: string): void {
  if (!v || v.length < 3 || !v.every(Number.isFinite)) invalid(`${label} must be three finite numbers.`);
}

/** Validate a descriptor against §19.6. Throws; returns nothing on success. */
export function validateAggregateSpec(spec: AggregateSpec): void {
  const regions = spec.regions ?? [];
  if (regions.length > MAX_AGGREGATE_REGIONS) tooLarge('regions', regions.length, MAX_AGGREGATE_REGIONS);
  regions.forEach((r, i) => {
    finite3(r.center, `regions[${i}].center`);
    finite3(r.halfSize, `regions[${i}].halfSize`);
    if (!r.rotation || r.rotation.length < 4 || !r.rotation.every(Number.isFinite)) {
      invalid(`regions[${i}].rotation must be four finite numbers.`);
    }
    if (r.halfSize.some((h) => !(h > 0))) {
      invalid(`regions[${i}].halfSize must be positive on every axis; got [${r.halfSize.join(', ')}].`);
    }
    for (const g of r.groups ?? []) {
      if (!Number.isInteger(g) || g < 0 || g >= MAX_AGGREGATE_GROUPS) {
        invalid(`regions[${i}].groups holds ${g}; group indices are 0..${MAX_AGGREGATE_GROUPS - 1}.`);
      }
    }
  });

  const checkMask = (mask: number[] | undefined, label: string): void => {
    for (const idx of mask ?? []) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= regions.length) {
        invalid(`${label} references region ${idx}, outside the ${regions.length} declared regions.`);
      }
    }
  };

  const slabs = spec.columns ?? [];
  if (slabs.length > MAX_AGGREGATE_SLABS) tooLarge('column slabs', slabs.length, MAX_AGGREGATE_SLABS);
  slabs.forEach((s, i) => {
    if (s.axis !== 0 && s.axis !== 1 && s.axis !== 2) {
      invalid(`columns[${i}].axis must be 0, 1, or 2; got ${s.axis}.`);
    }
    if (!s.range || s.range.length !== 3) invalid(`columns[${i}].range must cover three axes.`);
    s.range.forEach((r, d) => {
      if (r.length !== 2 || !r.every(Number.isInteger)) {
        invalid(`columns[${i}].range[${d}] must be two integers.`);
      }
      if (r[1] < r[0]) invalid(`columns[${i}].range[${d}] is empty: [${r[0]}, ${r[1]}].`);
    });
    checkMask(s.maskRegions, `columns[${i}].maskRegions`);
  });

  checkMask(spec.leafCounts?.maskRegions, 'leafCounts.maskRegions');

  const probes = spec.probes ?? [];
  if (probes.length > MAX_AGGREGATE_PROBES) tooLarge('probes', probes.length, MAX_AGGREGATE_PROBES);
  probes.forEach((p, i) => finite3(p, `probes[${i}]`));
}

/** Whether a descriptor asks for anything at all (§19.6, last row). */
export function aggregateIsEmpty(spec: AggregateSpec | undefined): boolean {
  if (!spec) return true;
  return (
    !spec.regions?.length &&
    !spec.columns?.length &&
    !spec.leafCounts &&
    !spec.probes?.length
  );
}

// ---------------------------------------------------------------------------
// Packing — the layout both backends read
// ---------------------------------------------------------------------------

/** f32 per packed region: center.xyz + groupMask (bitcast u32), halfSize.xyz + pad, conj rotation. */
export const REGION_STRIDE_F32 = 12;
/** u32 per packed slab: lo.xyzw, hi.xyzw, maskLo, maskHi, cellOffset, dimsA, dimsB, axis, pad×6. */
export const SLAB_STRIDE_U32 = 20;

export interface PackedAggregate {
  spec: AggregateSpec;
  regionCount: number;
  /** `regionCount * REGION_STRIDE_F32`; rotation stored **conjugated** (§19.3). */
  regionData: Float32Array;
  /** The same bytes as `regionData`, for the group mask that rides in `center.w`. */
  regionGroups: Uint32Array;
  slabCount: number;
  /** `slabCount * SLAB_STRIDE_U32`. */
  slabData: Uint32Array;
  /** Per-slab `{ dimsA, dimsB, cellOffset, axisA, axisB }`, in descriptor order. */
  slabCells: { dimsA: number; dimsB: number; cellOffset: number; axisA: number; axisB: number }[];
  /** Total cells across every slab — the column accumulator's first dimension. */
  totalCells: number;
  /** {@link MAX_AGGREGATE_GROUPS} when any region declared a group, else 0. */
  groupCount: number;
  /** Two-word bitmask of the regions `leafCounts` filters by; both 0 ⇒ no filter. */
  leafMask: [number, number];
  wantLeafCounts: boolean;
  probeCount: number;
  probeData: Float32Array; // probeCount * 3
}

/**
 * The two non-collapse axes, in ascending order. `dimsA` runs along the lower
 * one — the same convention the caller's own in-plane mapping must use, and the
 * reason `axis` alone determines the cell layout.
 */
export function planeAxes(axis: number): [number, number] {
  if (axis === 0) return [1, 2];
  if (axis === 1) return [0, 2];
  return [0, 1];
}

/** Group indices → one `u32` mask. Indices are validated to `0..31` (§19.6). */
function groupMask(indices: number[] | undefined): number {
  let m = 0;
  for (const g of indices ?? []) m |= 1 << g;
  return m >>> 0;
}

function maskWords(indices: number[] | undefined): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const i of indices ?? []) {
    if (i < 32) lo |= 1 << i;
    else hi |= 1 << (i - 32);
  }
  return [lo >>> 0, hi >>> 0];
}

/**
 * Lay the descriptor out for the GPU. Also used by the CPU reference: reading
 * the same `Float32Array` is what keeps a voxel exactly on a region face from
 * classifying one way in WGSL and the other in JavaScript.
 */
export function packAggregate(spec: AggregateSpec): PackedAggregate {
  const regions = spec.regions ?? [];
  const regionData = new Float32Array(regions.length * REGION_STRIDE_F32);
  const groupBits = new Uint32Array(regionData.buffer);
  let declaredGroups = 0;
  regions.forEach((r, i) => {
    const o = i * REGION_STRIDE_F32;
    regionData[o + 0] = r.center[0];
    regionData[o + 1] = r.center[1];
    regionData[o + 2] = r.center[2];
    // The group mask rides in `center.w` as raw bits: the shader bitcasts it back,
    // which keeps a region one 48-byte record instead of needing a parallel array.
    groupBits[o + 3] = groupMask(r.groups);
    regionData[o + 4] = r.halfSize[0];
    regionData[o + 5] = r.halfSize[1];
    regionData[o + 6] = r.halfSize[2];
    regionData[o + 7] = 0;
    // Stored conjugated: the shader rotates world→local, which is the inverse of
    // the box's own orientation. Conjugating here keeps it out of the inner loop.
    regionData[o + 8] = -r.rotation[0];
    regionData[o + 9] = -r.rotation[1];
    regionData[o + 10] = -r.rotation[2];
    regionData[o + 11] = r.rotation[3];
    declaredGroups |= groupBits[o + 3];
  });

  const slabs = spec.columns ?? [];
  const slabData = new Uint32Array(slabs.length * SLAB_STRIDE_U32);
  const slabCells: PackedAggregate['slabCells'] = [];
  let cellOffset = 0;
  slabs.forEach((s, i) => {
    const [axisA, axisB] = planeAxes(s.axis);
    const dimsA = s.range[axisA][1] - s.range[axisA][0] + 1;
    const dimsB = s.range[axisB][1] - s.range[axisB][0] + 1;
    const [mLo, mHi] = maskWords(s.maskRegions);
    const o = i * SLAB_STRIDE_U32;
    for (let d = 0; d < 3; d++) {
      slabData[o + d] = s.range[d][0];
      slabData[o + 4 + d] = s.range[d][1];
    }
    slabData[o + 8] = mLo;
    slabData[o + 9] = mHi;
    slabData[o + 10] = cellOffset;
    slabData[o + 11] = dimsA;
    slabData[o + 12] = dimsB;
    slabData[o + 13] = s.axis;
    slabCells.push({ dimsA, dimsB, cellOffset, axisA, axisB });
    cellOffset += dimsA * dimsB;
  });

  const probes = spec.probes ?? [];
  const probeData = new Float32Array(probes.length * 3);
  probes.forEach((p, i) => {
    probeData[i * 3] = p[0];
    probeData[i * 3 + 1] = p[1];
    probeData[i * 3 + 2] = p[2];
  });

  return {
    spec,
    regionCount: regions.length,
    regionData,
    regionGroups: groupBits,
    slabCount: slabs.length,
    slabData,
    slabCells,
    totalCells: cellOffset,
    groupCount: declaredGroups === 0 ? 0 : MAX_AGGREGATE_GROUPS,
    leafMask: maskWords(spec.leafCounts?.maskRegions),
    wantLeafCounts: !!spec.leafCounts,
    probeCount: probes.length,
    probeData,
  };
}

/** u32 per column cell in the flat GPU accumulator; see {@link COLUMN_FIELD}. */
export const COLUMN_BASE_FIELDS = 7;
export const COLUMN_FIELD = {
  sum: 0,
  blind: 1,
  valid: 2,
  obstacle: 3,
  filtered: 4,
  /**
   * `255 - camCount`, accumulated with `atomicMax`. WGSL has no "atomicMin
   * initialized to 255", and a zero-cleared buffer would make every untouched
   * cell's minimum 0. Storing the complement means the cleared state *is* the
   * §19.2 empty sentinel, with no separate initialization pass.
   */
  minInv: 5,
  max: 6,
} as const;

/** u32 per region entry in the flat GPU accumulator: valid, covered, blind, seen[]. */
export const REGION_BASE_FIELDS = 3;

// ---------------------------------------------------------------------------
// §19.2 Unpacking — flat GPU buffers → the public result
// ---------------------------------------------------------------------------

export function unpackRegions(
  flat: Uint32Array,
  first: number,
  count: number,
  numCameras: number,
): RegionAccum[] {
  const stride = REGION_BASE_FIELDS + numCameras;
  const out: RegionAccum[] = [];
  for (let e = first; e < first + count; e++) {
    const o = e * stride;
    out.push({
      valid: flat[o],
      covered: flat[o + 1],
      blind: flat[o + 2],
      seen: flat.slice(o + REGION_BASE_FIELDS, o + stride),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §19.3 Leaf merging
// ---------------------------------------------------------------------------

/** A cell whose subtree is not uniform: its children were emitted individually. */
const CELL_MIXED = -1;
/** A cell with no valid voxel anywhere in it — including the region past `dims`. */
const CELL_EMPTY = -2;

/**
 * Collapse a dense per-voxel count field into merged uniform cubes (§19.3).
 *
 * Bottom-up, one level at a time: a 2×2×2 block whose eight children are all
 * present and share one count becomes a single cell at the next level up; any
 * block that is not uniform emits whichever of its children *were* uniform and
 * marks itself mixed. Padding beyond `dims` reads as {@link CELL_EMPTY}, so it
 * neither blocks a merge nor produces a leaf.
 *
 * Merging on the **count** rather than on the mask (as §9.5's SVO does) is
 * strictly coarser and therefore strictly better here: two regions seen by
 * different camera sets of the same size collapse together, and the overlay
 * cannot tell them apart anyway.
 *
 * `O(voxels)` in both time and scratch — the level sizes are a geometric series
 * summing to ~1.14× the chunk's voxel count.
 */
export function mergeLeafCounts(
  counts: Uint8Array,
  validity: Uint32Array,
  dims: Vec3,
): LeafCounts {
  const [nx, ny, nz] = dims;
  // Levels are the chunk's own dimensions, halved with a ceiling — *not* a
  // padded power-of-two cube. A cube is the textbook shape, and it was the first
  // cut here, but its scratch is `maxDim³` rather than `voxels`: a 100×400×100
  // chunk pads to 512³, which is 268 MiB of `Int16Array` for 4M voxels and the
  // one allocation large enough to fail outright. Reading an out-of-range child
  // as {@link CELL_EMPTY} is the same semantics padding gave — padding was never
  // anything but empty — at ~1.14× the voxel count (§19.3).
  let lx = nx;
  let ly = ny;
  let lz = nz;
  let cur = new Int16Array(lx * ly * lz).fill(CELL_EMPTY);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const li = i + nx * (j + ny * k);
        if (((validity[li >> 5] >>> (li & 31)) & 1) === 0) continue;
        cur[li] = counts[li];
      }
    }
  }

  const sink = new LeafSink();
  let cellSize = 1; // voxels per cell edge at this level

  // A 2×2×2 block needs two cells on every axis, so the collapse ends as soon as
  // any axis is down to one cell. Nothing is lost by stopping there: a cube of
  // that level's edge would have to reach past the short axis's extent, and the
  // padding it would cover reads as empty, so such a block is never uniform.
  while (lx > 1 && ly > 1 && lz > 1) {
    const hx = (lx + 1) >> 1;
    const hy = (ly + 1) >> 1;
    const hz = (lz + 1) >> 1;
    const next = new Int16Array(hx * hy * hz);
    const prev = cur;
    const px = lx;
    const py = ly;
    const pz = lz;
    // Odd level dimensions leave a block with children past the edge; they read
    // empty, exactly as the padded cube's did. Declared once per level, not per
    // cell — this runs `voxels` times and a per-cell closure would be `voxels`
    // allocations.
    const child = (x: number, y: number, z: number): number =>
      x >= px || y >= py || z >= pz ? CELL_EMPTY : prev[x + px * (y + py * z)];
    for (let k = 0; k < hz; k++) {
      for (let j = 0; j < hy; j++) {
        for (let i = 0; i < hx; i++) {
          const x0 = 2 * i;
          const y0 = 2 * j;
          const z0 = 2 * k;
          const c0 = child(x0, y0, z0);
          let uniform = c0 !== CELL_MIXED;
          if (uniform) {
            for (let o = 1; o < 8 && uniform; o++) {
              if (child(x0 + (o & 1), y0 + ((o >> 1) & 1), z0 + ((o >> 2) & 1)) !== c0) {
                uniform = false;
              }
            }
          }
          if (uniform) {
            next[i + hx * (j + hy * k)] = c0;
            continue;
          }
          // Not uniform: this block stops here, so emit the children that were.
          next[i + hx * (j + hy * k)] = CELL_MIXED;
          for (let o = 0; o < 8; o++) {
            const x = x0 + (o & 1);
            const y = y0 + ((o >> 1) & 1);
            const z = z0 + ((o >> 2) & 1);
            const c = child(x, y, z);
            if (c < 0) continue;
            sink.push(x * cellSize, y * cellSize, z * cellSize, cellSize, c, dims);
          }
        }
      }
    }
    cur = next;
    lx = hx;
    ly = hy;
    lz = hz;
    cellSize *= 2;
  }

  // Whatever survived the last level is uniform over its own cube. With a cube
  // root that was a single cell; with per-axis levels it is `lx·ly·lz` of them.
  for (let k = 0; k < lz; k++) {
    for (let j = 0; j < ly; j++) {
      for (let i = 0; i < lx; i++) {
        const c = cur[i + lx * (j + ly * k)];
        if (c < 0) continue;
        sink.push(i * cellSize, j * cellSize, k * cellSize, cellSize, c, dims);
      }
    }
  }

  return sink.finish();
}

/**
 * Growable {@link LeafCounts} under construction.
 *
 * The obvious `number[]` triple costs ~8 bytes per entry per array and then a
 * second full copy to convert; a chunk whose coverage field barely merges emits
 * a leaf per voxel, so that is tens of MiB of boxed doubles for a result whose
 * final form is 7 bytes per leaf. Doubling typed arrays keeps the transient
 * within a small factor of the output.
 */
class LeafSink {
  private cap = 1024;
  private n = 0;
  private index = new Uint32Array(this.cap);
  private size = new Uint16Array(this.cap);
  private count = new Uint8Array(this.cap);

  push(i: number, j: number, k: number, edge: number, value: number, dims: Vec3): void {
    if (this.n === this.cap) this.grow();
    this.index[this.n] = i + dims[0] * (j + dims[1] * k);
    this.size[this.n] = edge;
    this.count[this.n] = value;
    this.n++;
  }

  finish(): LeafCounts {
    return {
      index: this.index.slice(0, this.n),
      size: this.size.slice(0, this.n),
      count: this.count.slice(0, this.n),
    };
  }

  private grow(): void {
    this.cap *= 2;
    const index = new Uint32Array(this.cap);
    const size = new Uint16Array(this.cap);
    const count = new Uint8Array(this.cap);
    index.set(this.index);
    size.set(this.size);
    count.set(this.count);
    this.index = index;
    this.size = size;
    this.count = count;
  }
}

// ---------------------------------------------------------------------------
// §19.5 CPU reference reduction
// ---------------------------------------------------------------------------

export interface AggregateChunkInput extends ChunkPlacement {
  chunkId: number;
  camWords: number;
  numCameras: number;
  validity: Uint32Array;
  /**
   * `voxelCount * camWords`, or **null** when every mask word is zero (§19.4).
   *
   * A chunk that pre-cull left with no active cameras is in exactly that state,
   * and in a large workspace those are most chunks. Allocating a dense array of
   * zeros just to say so is several MiB of churn per chunk, so it is not
   * allocated: readers treat an absent buffer as all-zero.
   */
  visibility: Uint32Array | null;
  packed: PackedAggregate;
}

function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * Which regions contain a world point, as a two-word bitmask. Mirrors the WGSL
 * `regionMask` exactly — same conjugated-quaternion rotation, same `<=` on the
 * half-extent, same operand order — because a disagreement here is the one
 * failure mode of §19.5 parity that would surface as a plausible wrong number
 * rather than a crash.
 */
export function regionMask(packed: PackedAggregate, x: number, y: number, z: number): [number, number] {
  const d = packed.regionData;
  let lo = 0;
  let hi = 0;
  for (let r = 0; r < packed.regionCount; r++) {
    const o = r * REGION_STRIDE_F32;
    const px = x - d[o + 0];
    const py = y - d[o + 1];
    const pz = z - d[o + 2];
    // Rotate by the stored (already conjugated) quaternion: v' = v + 2q × (q × v + w v).
    const qx = d[o + 8];
    const qy = d[o + 9];
    const qz = d[o + 10];
    const qw = d[o + 11];
    const tx = 2 * (qy * pz - qz * py);
    const ty = 2 * (qz * px - qx * pz);
    const tz = 2 * (qx * py - qy * px);
    const lx = px + qw * tx + (qy * tz - qz * ty);
    const ly = py + qw * ty + (qz * tx - qx * tz);
    const lz = pz + qw * tz + (qx * ty - qy * tx);
    if (Math.abs(lx) <= d[o + 4] && Math.abs(ly) <= d[o + 5] && Math.abs(lz) <= d[o + 6]) {
      if (r < 32) lo |= 1 << r;
      else hi |= 1 << (r - 32);
    }
  }
  return [lo >>> 0, hi >>> 0];
}

/**
 * OR of the group masks of every region containing this voxel (§19.3 Pass 4).
 * Collecting them before accumulating is what makes a group count a voxel once
 * however many of its regions overlap here.
 */
function groupsOf(packed: PackedAggregate, lo: number, hi: number): number {
  const g = packed.regionGroups;
  let m = 0;
  for (let r = 0; r < packed.regionCount; r++) {
    const bit = r < 32 ? (lo >>> r) & 1 : (hi >>> (r - 32)) & 1;
    if (bit) m |= g[r * REGION_STRIDE_F32 + 3];
  }
  return m >>> 0;
}

function maskAllows(filterLo: number, filterHi: number, lo: number, hi: number): boolean {
  if (filterLo === 0 && filterHi === 0) return true;
  return ((filterLo & lo) | (filterHi & hi)) !== 0;
}

/**
 * The scalar reduction (§19.5). One pass over the chunk, evaluating every
 * primitive the descriptor asked for — the region test is the expensive part and
 * is computed once per voxel, then reused by the column filter and the leaf
 * filter, which is why they take region *indices* rather than their own boxes.
 */
export function aggregateChunkCPU(input: AggregateChunkInput): AggregateResult {
  const { packed, dims, origin, base, voxelSize, camWords, numCameras, validity, visibility } = input;
  const [nx, ny, nz] = dims;
  const voxelCount = nx * ny * nz;
  const wantRegions = packed.regionCount > 0;
  const wantColumns = packed.slabCount > 0;
  const wantLeaves = packed.wantLeafCounts;
  const needMask = wantRegions || wantColumns || wantLeaves;

  const regionStride = REGION_BASE_FIELDS + numCameras;
  const entryCount = packed.regionCount + packed.groupCount;
  const regionFlat = wantRegions ? new Uint32Array(entryCount * regionStride) : null;
  const colFlat = wantColumns ? new Uint32Array(packed.totalCells * COLUMN_BASE_FIELDS) : null;
  const colSeen = wantColumns ? new Uint32Array(packed.totalCells * camWords) : null;
  const counts = wantLeaves ? new Uint8Array(voxelCount) : null;
  const leafValid = wantLeaves ? new Uint32Array((voxelCount + 31) >> 5) : null;


  if (needMask) {
    for (let k = 0; k < nz; k++) {
      const cz = origin[2] + (k + 0.5) * voxelSize;
      for (let j = 0; j < ny; j++) {
        const cy = origin[1] + (j + 0.5) * voxelSize;
        for (let i = 0; i < nx; i++) {
          const li = i + nx * (j + ny * k);
          const isValid = ((validity[li >> 5] >>> (li & 31)) & 1) === 1;
          const cx = origin[0] + (i + 0.5) * voxelSize;

          // Columns classify invalid voxels too (they are obstacles, §19.2), so
          // the region test cannot be skipped on validity alone.
          const wantHere = isValid || wantColumns;
          if (!wantHere) continue;
          const [rLo, rHi] = wantRegions ? regionMask(packed, cx, cy, cz) : [0, 0];

          let camCount = 0;
          if (isValid && visibility) {
            for (let w = 0; w < camWords; w++) camCount += popcount32(visibility[li * camWords + w]);
          }

          if (wantRegions && isValid) {
            for (let r = 0; r < packed.regionCount; r++) {
              const inR = r < 32 ? (rLo >>> r) & 1 : (rHi >>> (r - 32)) & 1;
              if (!inR) continue;
              addRegion(regionFlat!, r * regionStride, camCount, li, camWords, visibility, numCameras);
            }
            let groups = packed.groupCount > 0 ? groupsOf(packed, rLo, rHi) : 0;
            while (groups !== 0) {
              const g = 31 - Math.clz32(groups & -groups);
              groups &= groups - 1;
              addRegion(
                regionFlat!,
                (packed.regionCount + g) * regionStride,
                camCount,
                li,
                camWords,
                visibility,
                numCameras,
              );
            }
          }

          if (wantLeaves && isValid) {
            if (maskAllows(packed.leafMask[0], packed.leafMask[1], rLo, rHi)) {
              counts![li] = Math.min(255, camCount);
              leafValid![li >> 5] |= 1 << (li & 31);
            }
          }

          if (wantColumns) {
            const g = [base[0] + i, base[1] + j, base[2] + k];
            for (let s = 0; s < packed.slabCount; s++) {
              const o = s * SLAB_STRIDE_U32;
              const sd = packed.slabData;
              if (
                g[0] < sd[o] || g[0] > sd[o + 4] ||
                g[1] < sd[o + 1] || g[1] > sd[o + 5] ||
                g[2] < sd[o + 2] || g[2] > sd[o + 6]
              ) {
                continue;
              }
              const cell = packed.slabCells[s];
              const a = g[cell.axisA] - sd[o + cell.axisA];
              const b = g[cell.axisB] - sd[o + cell.axisB];
              const ci = cell.cellOffset + a + cell.dimsA * b;
              const co = ci * COLUMN_BASE_FIELDS;
              if (!maskAllows(sd[o + 8], sd[o + 9], rLo, rHi)) {
                colFlat![co + COLUMN_FIELD.filtered] += 1;
                continue;
              }
              if (!isValid) {
                colFlat![co + COLUMN_FIELD.obstacle] += 1;
                continue;
              }
              colFlat![co + COLUMN_FIELD.valid] += 1;
              colFlat![co + COLUMN_FIELD.sum] += camCount;
              if (camCount === 0) colFlat![co + COLUMN_FIELD.blind] += 1;
              const inv = COLUMN_MIN_EMPTY - Math.min(255, camCount);
              if (inv > colFlat![co + COLUMN_FIELD.minInv]) colFlat![co + COLUMN_FIELD.minInv] = inv;
              const cap = Math.min(255, camCount);
              if (cap > colFlat![co + COLUMN_FIELD.max]) colFlat![co + COLUMN_FIELD.max] = cap;
              if (visibility) {
                for (let w = 0; w < camWords; w++) {
                  colSeen![ci * camWords + w] |= visibility[li * camWords + w];
                }
              }
            }
          }
        }
      }
    }
  }

  const result: AggregateResult = { chunkId: input.chunkId };
  if (wantRegions) {
    result.regions = unpackRegions(regionFlat!, 0, packed.regionCount, numCameras);
    if (packed.groupCount > 0) {
      result.groups = unpackRegions(regionFlat!, packed.regionCount, packed.groupCount, numCameras);
    }
  }
  if (wantColumns) result.columns = assembleColumns(colFlat!, colSeen!, packed, camWords);
  if (wantLeaves) result.leafCounts = mergeLeafCounts(counts!, leafValid!, dims);
  if (packed.probeCount > 0) {
    const { probeMasks, probeHits } = resolveProbes(input);
    result.probeMasks = probeMasks;
    result.probeHits = probeHits;
  }
  return result;
}

function addRegion(
  flat: Uint32Array,
  o: number,
  camCount: number,
  li: number,
  camWords: number,
  visibility: Uint32Array | null,
  numCameras: number,
): void {
  flat[o] += 1;
  if (camCount > 0) flat[o + 1] += 1;
  else flat[o + 2] += 1;
  if (!visibility) return;
  for (let w = 0; w < camWords; w++) {
    let word = visibility[li * camWords + w] >>> 0;
    while (word !== 0) {
      const bit = 31 - Math.clz32(word & -word);
      word &= word - 1;
      const c = w * 32 + bit;
      if (c < numCameras) flat[o + REGION_BASE_FIELDS + c] += 1;
    }
  }
}

/** Flat column buffers → the public {@link ColumnAccum}s. Shared by both backends. */
export function assembleColumns(
  flat: Uint32Array,
  seen: Uint32Array,
  packed: PackedAggregate,
  camWords: number,
): ColumnAccum[] {
  return packed.slabCells.map(({ dimsA, dimsB, cellOffset }) => {
    const n = dimsA * dimsB;
    const acc: ColumnAccum = {
      dimsA,
      dimsB,
      camCountSum: new Uint32Array(n),
      camCountMax: new Uint8Array(n),
      camCountMin: new Uint8Array(n),
      blindCount: new Uint32Array(n),
      validCount: new Uint32Array(n),
      obstacleCount: new Uint32Array(n),
      filteredCount: new Uint32Array(n),
      seenWords: seen.slice(cellOffset * camWords, (cellOffset + n) * camWords),
    };
    for (let c = 0; c < n; c++) {
      const o = (cellOffset + c) * COLUMN_BASE_FIELDS;
      acc.camCountSum[c] = flat[o + COLUMN_FIELD.sum];
      acc.blindCount[c] = flat[o + COLUMN_FIELD.blind];
      acc.validCount[c] = flat[o + COLUMN_FIELD.valid];
      acc.obstacleCount[c] = flat[o + COLUMN_FIELD.obstacle];
      acc.filteredCount[c] = flat[o + COLUMN_FIELD.filtered];
      acc.camCountMin[c] = COLUMN_MIN_EMPTY - flat[o + COLUMN_FIELD.minInv];
      acc.camCountMax[c] = flat[o + COLUMN_FIELD.max];
    }
    return acc;
  });
}

/**
 * Probe lookups (§19.3): resolved on the CPU on both backends. A handful of
 * `O(1)` reads do not repay a dispatch and a staging segment; they are an
 * aggregation output so a caller's probes stop being a reason to ship per-voxel
 * data across a Worker boundary.
 */
export function resolveProbes(input: AggregateChunkInput): {
  probeMasks: Uint32Array;
  probeHits: Uint8Array;
} {
  const { packed, dims, origin, voxelSize, camWords, validity, visibility } = input;
  const [nx, ny, nz] = dims;
  const probeMasks = new Uint32Array(packed.probeCount * camWords);
  const probeHits = new Uint8Array(packed.probeCount);
  for (let p = 0; p < packed.probeCount; p++) {
    const i = Math.floor((packed.probeData[p * 3] - origin[0]) / voxelSize);
    const j = Math.floor((packed.probeData[p * 3 + 1] - origin[1]) / voxelSize);
    const k = Math.floor((packed.probeData[p * 3 + 2] - origin[2]) / voxelSize);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const li = i + nx * (j + ny * k);
    if (((validity[li >> 5] >>> (li & 31)) & 1) === 0) {
      probeHits[p] = ProbeHit.Invalid;
      continue;
    }
    probeHits[p] = ProbeHit.Valid;
    if (!visibility) continue; // all-zero masks: the probe is valid and seen by nobody
    for (let w = 0; w < camWords; w++) probeMasks[p * camWords + w] = visibility[li * camWords + w];
  }
  return { probeMasks, probeHits };
}

// ---------------------------------------------------------------------------
// §19.2 Merging — the caller's, but the arithmetic belongs here
// ---------------------------------------------------------------------------

/** Sum a chunk's region accumulators into a running total, in place. */
export function mergeRegions(into: RegionAccum[], from: readonly RegionAccum[]): void {
  for (let r = 0; r < into.length && r < from.length; r++) {
    into[r].valid += from[r].valid;
    into[r].covered += from[r].covered;
    into[r].blind += from[r].blind;
    for (let c = 0; c < into[r].seen.length; c++) into[r].seen[c] += from[r].seen[c];
  }
}

/** Merge a chunk's column accumulator into a running total, in place (§19.2). */
export function mergeColumns(into: ColumnAccum, from: ColumnAccum, camWords: number): void {
  for (let c = 0; c < into.camCountSum.length; c++) {
    into.camCountSum[c] += from.camCountSum[c];
    into.blindCount[c] += from.blindCount[c];
    into.validCount[c] += from.validCount[c];
    into.obstacleCount[c] += from.obstacleCount[c];
    into.filteredCount[c] += from.filteredCount[c];
    if (from.camCountMax[c] > into.camCountMax[c]) into.camCountMax[c] = from.camCountMax[c];
    // The sentinel is the maximum byte value, so a chunk that counted nothing
    // loses this comparison and cannot pull the minimum down (§19.2).
    if (from.camCountMin[c] < into.camCountMin[c]) into.camCountMin[c] = from.camCountMin[c];
    for (let w = 0; w < camWords; w++) into.seenWords[c * camWords + w] |= from.seenWords[c * camWords + w];
  }
}

/** A zeroed `dimsA × dimsB` accumulator to merge into. */
export function emptyColumns(dimsA: number, dimsB: number, camWords: number): ColumnAccum {
  const n = dimsA * dimsB;
  return {
    dimsA,
    dimsB,
    camCountSum: new Uint32Array(n),
    camCountMax: new Uint8Array(n),
    camCountMin: new Uint8Array(n).fill(COLUMN_MIN_EMPTY),
    blindCount: new Uint32Array(n),
    validCount: new Uint32Array(n),
    obstacleCount: new Uint32Array(n),
    filteredCount: new Uint32Array(n),
    seenWords: new Uint32Array(n * camWords),
  };
}

/** A zeroed region-accumulator set of `count` entries. */
export function emptyRegions(count: number, numCameras: number): RegionAccum[] {
  return Array.from({ length: count }, () => ({
    valid: 0,
    covered: 0,
    blind: 0,
    seen: new Uint32Array(numCameras),
  }));
}
