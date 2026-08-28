/**
 * Incremental recompute (§13.1): the baseline of the last completed `compute()`,
 * the eligibility check, and the dirty-chunk diff.
 *
 * The engine's default path re-runs Passes 1–3 for every chunk on every call.
 * That is correct and, under a gizmo drag firing ~10 runs/sec, almost entirely
 * redundant — one camera moved a few centimetres and the other N−1 produced the
 * same answer they produced last frame. This module answers "which chunks can
 * possibly have changed", so `compute()` can skip the rest and re-sum their
 * retained statistics instead.
 *
 * Two invariants carry the correctness of the whole feature; both are stated in
 * `ai/ARCHITECTURE.md` and pinned by §18.6g–6i:
 *
 * 1. **The dirty set may over-approximate, never under-approximate.** It is built
 *    from the same conservative frustum–AABB test as pre-cull (`camera.ts`),
 *    which has false positives only.
 * 2. **A chunk's mask never mixes camera generations.** A dirty chunk is
 *    recomputed over *all* cameras, not just the changed ones — the retained
 *    per-voxel mask belongs to the caller, and the engine has nothing to merge
 *    a single camera's bit into.
 *
 * The baseline holds **statistics only, never voxel masks** — a `visibleCount`
 * per chunk per camera, kilobytes in total. Retaining `ChunkResult`s here would
 * duplicate the megabytes-per-chunk payload (§9.4) that whoever consumed
 * `onChunkDone` is already holding.
 */

import { frustumIntersectsAabb, type PreparedCamera } from './camera.ts';
import type { Vec3 } from './types.ts';

/** The per-chunk totals a run reports, retained so a partial run can still sum the scene. */
export interface ChunkStats {
  validCount: number;
  coveredCount: number;
  visibleCount: number[];
}

/**
 * The run options a retained result describes. Retained statistics are only
 * meaningful for the options that produced them, so a run that differs in any of
 * these cannot reuse them (§13.1 Eligibility). `precull` is deliberately absent:
 * §7.2 requires it to be lossless, so toggling it invalidates nothing.
 */
export interface RunOptions {
  mode: 1 | 2;
  threshold: number;
  /** Whether per-voxel output was emitted (§11.1) — i.e. whether `onChunkDone` was set. */
  emitVoxels: boolean;
}

/** A chunk's world-space AABB, as the grid reports it. */
export type ChunkAabb = (chunkId: number) => { min: Vec3; max: Vec3 };

function sameOptions(a: RunOptions, b: RunOptions): boolean {
  return a.mode === b.mode && a.threshold === b.threshold && a.emitVoxels === b.emitVoxels;
}

/**
 * Whether two prepared cameras describe the same view. `viewProj` already folds
 * in position, rotation, fov, aspect, near and far, but position/near/far are
 * compared explicitly too: they also drive the ray cast (§8), and an exact
 * comparison is cheap enough that there is no reason to reason about whether the
 * matrix alone is sufficient.
 */
function sameCamera(a: PreparedCamera, b: PreparedCamera): boolean {
  if (a.enabled !== b.enabled) return false;
  if (a.near !== b.near || a.far !== b.far) return false;
  for (let i = 0; i < 3; i++) if (a.position[i] !== b.position[i]) return false;
  for (let i = 0; i < 16; i++) if (a.viewProj[i] !== b.viewProj[i]) return false;
  return true;
}

/**
 * The retained baseline. Owned by the engine, one instance for its lifetime;
 * `drop()` is what every invalidating lifecycle call goes through.
 */
export class IncrementalState {
  /** Cameras as of the last *completed* run — not the last `setCameras()`. */
  private cameras: PreparedCamera[] | null = null;
  /**
   * Each camera's *effective* enabled state at that point: the config flag AND
   * not-inside-geometry (§17). Kept beside the cameras because the old side of
   * the dirty set needs the frustum a camera contributed *then*.
   */
  private effective: boolean[] = [];
  private options: RunOptions | null = null;
  private readonly stats = new Map<number, ChunkStats>();

  /**
   * Discard everything. Called by `loadScene()`, `setSampling()`, `init()`, and
   * by a `compute()` that threw — anything that changes what a retained chunk
   * result means, plus anything that leaves the run half-finished.
   *
   * Direction matters: whatever drops the §6.4 validity cache must also drop
   * this, never the reverse. The failure mode of getting it backwards is not a
   * crash but a plausible-looking coverage number computed against a stale chunk.
   */
  drop(): void {
    this.cameras = null;
    this.effective = [];
    this.options = null;
    this.stats.clear();
  }

  get hasBaseline(): boolean {
    return this.cameras !== null;
  }

  /**
   * The chunks an incremental run must recompute, or `null` if it cannot run
   * incrementally and the caller must run every chunk.
   *
   * Returning an empty array is meaningful and distinct from `null`: nothing
   * changed, so there is no work to do and the retained statistics already are
   * the answer.
   */
  plan(
    cameras: PreparedCamera[],
    effective: boolean[],
    options: RunOptions,
    chunkCount: number,
    chunkAabb: ChunkAabb,
  ): number[] | null {
    const prev = this.cameras;
    if (!prev || !this.options) return null;
    if (!sameOptions(this.options, options)) return null;

    // Index stability (§13.1): a mask bit *is* an array position, so any change
    // to the ordered id list renumbers every camera after it and invalidates
    // every retained mask — including the ones the caller is holding.
    if (prev.length !== cameras.length) return null;
    for (let c = 0; c < prev.length; c++) if (prev[c].id !== cameras[c].id) return null;

    // Every chunk must have a retained stat line, or the merged summary would be
    // missing a chunk the run is not going to recompute.
    if (this.stats.size !== chunkCount) return null;

    const changed: number[] = [];
    for (let c = 0; c < prev.length; c++) {
      if (this.effective[c] !== effective[c] || !sameCamera(prev[c], cameras[c])) changed.push(c);
    }
    if (changed.length === 0) return [];

    const dirty: number[] = [];
    for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
      const { min, max } = chunkAabb(chunkId);
      for (const c of changed) {
        // A camera that was (or is) disabled contributed no frustum in that
        // state, so it dirties nothing on that side.
        const wasSeen = this.effective[c] && frustumIntersectsAabb(prev[c], min, max);
        const isSeen = effective[c] && frustumIntersectsAabb(cameras[c], min, max);
        if (wasSeen || isSeen) {
          dirty.push(chunkId);
          break;
        }
      }
    }
    return dirty;
  }

  /**
   * Retain a chunk's totals. Every chunk a non-scoped run visits records exactly
   * once — including one with no valid voxels, which records a zero line rather
   * than nothing (see `plan`'s per-chunk requirement).
   */
  record(chunkId: number, stats: ChunkStats): void {
    this.stats.set(chunkId, stats);
  }

  /** Adopt this run's cameras and options as the new baseline. */
  commit(cameras: PreparedCamera[], effective: boolean[], options: RunOptions): void {
    this.cameras = cameras;
    this.effective = effective.slice();
    this.options = options;
  }

  /** Whole-scene totals across every retained chunk (§13.1 step 4). */
  totals(numCameras: number): {
    totalValid: number;
    totalCovered: number;
    totalVisible: number[];
  } {
    let totalValid = 0;
    let totalCovered = 0;
    const totalVisible = new Array<number>(numCameras).fill(0);
    for (const s of this.stats.values()) {
      totalValid += s.validCount;
      totalCovered += s.coveredCount;
      for (let c = 0; c < numCameras; c++) totalVisible[c] += s.visibleCount[c] ?? 0;
    }
    return { totalValid, totalCovered, totalVisible };
  }
}
