/**
 * Coverage visualization (spec §9): maps streamed coverage data onto the
 * generic voxel volumetric renderer (specs/volumetric_rendering.md). This module
 * owns *which* voxels are drawn and *how* coverage maps to each voxel's
 * `intensity` and `color`; the renderer owns *how* voxels are drawn.
 *
 * Two mutually-exclusive modes (spec §9.1):
 *  - 'coverage'   — every valid voxel, intensity = coverage fraction.
 *  - 'blindspots' — only blind-spot voxels (mask == 0), intensity = 1.
 *
 * Both modes draw with the same user-selected overlay hue (spec §9.2); mode fixes
 * *which* voxels and the intensity mapping, not the color.
 *
 * Input is the run's `leafCounts` aggregation (spec §3.3, §9): **merged uniform
 * cubes** of equal camera count, per chunk. The popcount ran on the GPU inside the
 * chunk pipeline, the octree collapse ran in the worker, and the marked-set filter
 * (`sampling_volumes.md` §7.3) is already applied — a filtered-out voxel simply has
 * no leaf. Chunks are retained by `chunkId` and rebuilt through the renderer's bulk
 * path.
 *
 * The merge is what keeps this affordable. A renderer's cost is per drawn instance,
 * and on a typical room one leaf stands in for ~11 voxels; a cube per voxel instead
 * overruns a GPU device's default 256 MiB buffer limit on a large site and loses the
 * device outright.
 */
import type { AggregateResult, LeafCounts, Vec3 } from '@linkervision/camera-coverage-sdk';
import { VoxelVolumetricRenderer, DEFAULT_INTENSITY_SCALE } from './volumetric.ts';
import { RenderOrder } from './renderOrder.ts';

export type OverlayMode = 'coverage' | 'blindspots';

/** One chunk's contribution: its merged leaves plus where the chunk sits. */
interface ChunkLeaves {
  origin: Vec3;
  dims: [number, number, number];
  voxelSize: number;
  leaves: LeafCounts;
}

export interface OverlayOptions {
  /** Overlay visibility on/off. */
  visible: boolean;
  /** Active visualization mode (spec §9.1). */
  mode: OverlayMode;
  /** Overlay fog hue in degrees (0..360), shared by both modes (spec §9.2). */
  overlayHue: number;
  /** Renderer global brightness multiplier (specs/volumetric_rendering.md §1). */
  intensityScale: number;
  /** Involved (enabled) camera count == denominator of the coverage fraction. */
  involvedCameraCount: number;
}

/** Default overlay hue (spec §9.2): red. */
export const DEFAULT_OVERLAY_HUE = 0;

/**
 * Convert a hue (degrees) to an RGB triple (components 0..1) at full saturation and
 * 50% lightness — `hsl(hue, 100%, 50%)` (spec §9.2). This is the fog color the user
 * picks with the overlay-color slider; full saturation makes the slider a clean
 * rainbow spectrum.
 */
export function hueToRgb(hue: number): [number, number, number] {
  const h = ((((hue % 360) + 360) % 360)) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

/**
 * Coverage fraction (spec §13): the share of the involved (enabled) cameras that
 * see a voxel, `popcount(mask) / involvedCameraCount`, clamped to [0, 1].
 * 0 == blind spot, 1 == seen by every enabled camera.
 */
export function coverageFraction(camCount: number, involvedCameraCount: number): number {
  const denom = Math.max(1, involvedCameraCount);
  return Math.max(0, Math.min(1, camCount / denom));
}

export class CoverageOverlay {
  private readonly renderer = new VoxelVolumetricRenderer();
  readonly object = this.renderer.object;

  constructor() {
    // Draw the fog after the section plane but before the volume fill so depth
    // testing against the plane's depth resolves occlusion (spec §9, §13.5).
    this.renderer.setRenderOrder(RenderOrder.coverageFog);
  }

  /**
   * Retained per-chunk counts **keyed by chunkId** (spec §9), not one flat list:
   * an incremental run (§8) re-sends only a few chunks, and each must replace its
   * predecessor rather than pile on top of it.
   */
  private chunks = new Map<number, ChunkLeaves>();
  /** Whether a run is streaming — while it is, `rebuild()` is deferred to `flush()`. */
  private streaming = false;
  private opts: OverlayOptions = {
    visible: true,
    mode: 'coverage',
    overlayHue: DEFAULT_OVERLAY_HUE,
    intensityScale: DEFAULT_INTENSITY_SCALE,
    involvedCameraCount: 1,
  };

  /**
   * Clear accumulated chunks before a **full** run (spec §8). An incremental run
   * must NOT call this — it streams only a few chunks, so clearing first would
   * blank the rest of the overlay with no error. Call {@link beginRun} instead.
   */
  reset(): void {
    this.chunks.clear();
    // Rebuild straight away rather than waiting for a flush: `reset()` is also
    // how a scene replace empties the overlay (spec §14.4), and that clear has
    // to be visible even when no run follows it.
    this.streaming = true;
    this.rebuild();
  }

  /**
   * Enter streaming mode: `addResult` retains without rebuilding until
   * {@link flush}. `rebuild()` walks every retained chunk and re-uploads the whole
   * renderer, so doing it per arriving chunk is quadratic in chunk count — and on
   * an incremental run it would cost a full-scene rebuild per recomputed chunk,
   * cancelling the saving that run just bought (spec §9).
   */
  beginRun(): void {
    this.streaming = true;
  }

  /** Leave streaming mode and rebuild once, at the end of a run (spec §9). */
  flush(): void {
    this.streaming = false;
    this.rebuild();
  }

  /**
   * Retain one chunk's `leafCounts`, **replacing** any previously held for that
   * chunk so a re-sent chunk does not double up (spec §3.3, §9).
   *
   * The arrays are adopted, not copied: they were transferred across the Worker
   * boundary for this purpose and nothing else holds them.
   */
  addResult(result: AggregateResult, origin: Vec3, dims: [number, number, number], voxelSize: number): void {
    const leaves = result.leafCounts;
    if (!leaves) return;
    this.chunks.set(result.chunkId, { origin, dims, voxelSize, leaves });
    if (!this.streaming) this.rebuild();
  }

  setOptions(opts: Partial<OverlayOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.renderer.setVisible(this.opts.visible);
    this.renderer.setIntensityScale(this.opts.intensityScale);
    this.rebuild();
  }

  dispose(): void {
    this.renderer.dispose();
  }

  /**
   * Leaves the last rebuild could not draw because the renderer's instance cap
   * was reached (spec §9). Non-zero means the overlay on screen is incomplete,
   * which the caller should say rather than let the user read a truncated
   * picture as the answer.
   */
  droppedLeaves = 0;

  /**
   * Map the retained counts onto renderer voxels for the active mode (spec §9.1).
   *
   * The mode is compiled into a pair of 256-entry tables keyed by camera count
   * rather than branched per voxel: at 0.1 m a rebuild touches millions of
   * voxels, and both modes are a pure function of that one byte.
   */
  private rebuild(): void {
    // Both modes share the user-selected overlay hue (spec §9.2).
    const color = hueToRgb(this.opts.overlayHue);
    const { draw, intensity } = countTables(this.opts);
    this.renderer.reset();
    this.droppedLeaves = 0;
    for (const c of this.chunks.values()) {
      const { dropped } = this.renderer.addVoxelLeaves({
        origin: c.origin,
        dims: c.dims,
        voxelSize: c.voxelSize,
        index: c.leaves.index,
        edge: c.leaves.size,
        keys: c.leaves.count,
        draw,
        intensity,
        color,
      });
      this.droppedLeaves += dropped;
    }
  }

  /** Leaves retained across every chunk — the overlay's instance cost (spec §9). */
  get leafCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.leaves.index.length;
    return n;
  }
}

/**
 * The per-mode lookup tables (spec §9.1), indexed by a voxel's camera count.
 *
 * - `coverage` — every valid voxel, intensity = coverage fraction.
 * - `blindspots` — only count 0, at fixed full intensity: its coverage fraction
 *   is 0, so drawing it at that value would make it invisible.
 */
function countTables(opts: OverlayOptions): { draw: Uint8Array; intensity: Float32Array } {
  const draw = new Uint8Array(256);
  const intensity = new Float32Array(256);
  if (opts.mode === 'blindspots') {
    draw[0] = 1;
    intensity[0] = 1;
    return { draw, intensity };
  }
  for (let n = 0; n < 256; n++) {
    draw[n] = 1;
    intensity[n] = coverageFraction(n, opts.involvedCameraCount);
  }
  return { draw, intensity };
}
