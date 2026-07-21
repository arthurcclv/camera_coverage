/**
 * Probe model + visibility query (spec §12.1, §12.2).
 *
 * A probe is a user-placed point; its visibility is read from the **most recent
 * completed `compute()` run's per-voxel camera masks** — not a fresh ray cast
 * (the SDK exposes no arbitrary-point query). The world position is mapped to the
 * voxel that contains it and that voxel's mask is decoded against the ordered
 * enabled-camera list that was passed to `setCameras()` for that run.
 *
 * To make the lookup possible we **retain the streamed `ChunkResult`s** (keyed by
 * chunkId) for the current run, reset at the start of each `compute()`. Lookup
 * uses the SDK accessor's own O(depth) descent — no extra spatial index.
 */
import { accessor } from '@linkervision/camera-coverage-sdk';
import type { ChunkResult, Vec3, WorkspaceGrid } from '@linkervision/camera-coverage-sdk';

/** A user-placed point in the scene (spec §12.1). */
export interface Probe {
  id: string;
  position: Vec3;
}

/** Visibility of a probe against the retained run's enabled cameras (spec §12.3). */
export interface ProbeVisibilityOk {
  status: 'ok';
  /** Enabled-camera ids in mask-bit order (bit n ⇒ cameraIds[n]). */
  cameraIds: string[];
  /** Parallel to `cameraIds`: whether that camera sees the probe. */
  visible: boolean[];
  /** popcount of the mask — enabled cameras that see the probe. */
  seenCount: number;
}

/**
 * Query outcome. `no-data` covers an invalid voxel, a point outside the workspace,
 * or no retained chunk covering it — never rendered as "0 of N" (spec §12.3). The
 * "no run yet" state is the caller's concern (there is simply no retained data).
 */
export type ProbeVisibilityResult = { status: 'no-data' } | ProbeVisibilityOk;

/**
 * Map global voxel indices to the retained voxel that contains them:
 * `(gi, gj, gk)` → `(chunkId, i, j, k)`. Returns null when a global index lies
 * outside the logical voxel grid. Shared by {@link locateVoxel} (a single world
 * point) and the section heatmap's column walker (`sectionHeatmap.ts`, spec
 * §13.3), which advances `gi`/`gk` across chunk boundaries one voxel at a time.
 * Pure so it can be unit-tested without a compute run.
 */
export function chunkLocalForGlobalIndex(
  grid: WorkspaceGrid,
  gi: number,
  gj: number,
  gk: number,
): { chunkId: number; i: number; j: number; k: number } | null {
  const { gridDims, chunkVoxels, chunkCountX } = grid;
  if (
    gi < 0 || gj < 0 || gk < 0 ||
    gi >= gridDims[0] || gj >= gridDims[1] || gk >= gridDims[2]
  ) {
    return null;
  }
  const [vpcX, , vpcZ] = chunkVoxels;
  const cx = Math.floor(gi / vpcX);
  const cz = Math.floor(gk / vpcZ);
  return {
    chunkId: cz * chunkCountX + cx,
    i: gi - cx * vpcX,
    j: gj, // chunks span the full Y extent, so the base J is always 0
    k: gk - cz * vpcZ,
  };
}

/**
 * Map a world point to the retained voxel that contains it (spec §12.2):
 * world → global voxel `floor((p − worldMin) / voxelSize)` → `(chunkId, i, j, k)`.
 * Returns null when the point lies outside the logical voxel grid. Pure so it can
 * be unit-tested without a compute run.
 */
export function locateVoxel(
  grid: WorkspaceGrid,
  p: Vec3,
): { chunkId: number; i: number; j: number; k: number } | null {
  const { worldMin, voxelSize } = grid;
  const gi = Math.floor((p[0] - worldMin[0]) / voxelSize);
  const gj = Math.floor((p[1] - worldMin[1]) / voxelSize);
  const gk = Math.floor((p[2] - worldMin[2]) / voxelSize);
  return chunkLocalForGlobalIndex(grid, gi, gj, gk);
}

export class ProbeVisibility {
  private grid: WorkspaceGrid | null = null;
  private chunks = new Map<number, ChunkResult>();
  /** Enabled-camera ids snapshotted from the run, in mask-bit order (spec §12.2). */
  private cameraIds: string[] = [];

  /** Start retaining a new run's chunks; snapshot its ordered enabled-camera list. */
  reset(grid: WorkspaceGrid, cameraIds: string[]): void {
    this.grid = grid;
    this.cameraIds = [...cameraIds];
    this.chunks.clear();
  }

  /** Retain a streamed chunk (in parallel with the overlay, spec §12.2). */
  addChunk(result: ChunkResult): void {
    this.chunks.set(result.chunkId, result);
  }

  /** Discard the retained run so `query()` reads "no-data" until the next run (spec §14.4). */
  clear(): void {
    this.grid = null;
    this.chunks.clear();
  }

  /** Decode the retained mask at the probe's world position (spec §12.2). */
  query(p: Vec3): ProbeVisibilityResult {
    if (!this.grid) return { status: 'no-data' };
    const loc = locateVoxel(this.grid, p);
    if (!loc) return { status: 'no-data' };
    const chunk = this.chunks.get(loc.chunkId);
    if (!chunk) return { status: 'no-data' };

    const acc = accessor(chunk);
    if (!acc.isValid(loc.i, loc.j, loc.k)) return { status: 'no-data' };

    // Decode every mask word (correct up to MAX_CAMERAS = 128, spec §12.2), not
    // just word 0.
    const visible = this.cameraIds.map((_, n) => {
      const word = n >>> 5;
      if (word >= chunk.camWords) return false;
      const bit = n & 31;
      return ((acc.getMaskWord(loc.i, loc.j, loc.k, word) >>> bit) & 1) === 1;
    });
    const seenCount = visible.reduce((sum, v) => sum + (v ? 1 : 0), 0);
    return { status: 'ok', cameraIds: this.cameraIds, visible, seenCount };
  }
}
