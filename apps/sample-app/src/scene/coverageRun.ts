/**
 * CoverageRun — the coordinator for a coverage run's retained-chunk consumers
 * and its generation guard (spec §9, §12–§13, §14.4; `sampling_volumes.md` §7).
 *
 * A `compute()` streams `ChunkResult`s that three pure stores retain in parallel —
 * `ProbeVisibility` (probe sightline decode, §12.2), `SectionHeatmapStore`
 * (per-section column aggregation, §13.4), and `ZoneCoverageStore` (per-zone
 * coverage, §7.2) — each reset at the start of a run and read on demand afterwards.
 * App used to `new` all three, wire the identical reset/addChunk/clear fan-out in
 * `handleRun`/`applyScene`, and read each store from its own `useMemo`. This owns
 * all of that behind one object: the three stores share a `RetainedRun` interface
 * this fans out over, and the reads are fronted so App never touches a store.
 *
 * **Generation guard (§14.4).** A run is stamped with the current `generation`;
 * `clear()` (scene replaced, from `applyScene`) bumps it so any in-flight run's
 * chunks are dropped — the in-scope stand-in for "cancel compute", since the
 * engine exposes no true cancellation. `handleRun` snapshots `generation` before
 * its first `await` and guards every step with `isCurrent(token)`. `reset()`
 * (start of a run) deliberately does **not** bump — the run snapshotted its token
 * first, so bumping would invalidate itself.
 *
 * The **overlay** (the fourth chunk consumer) is not here: it lives inside
 * `SceneView` (created async), so App drives it inline (`resetCoverage()` /
 * `addCoverageChunk()`) right beside these calls.
 */
import type { ChunkResult, WorkspaceGrid } from '@linkervision/camera-coverage-sdk';
import type { RunCamera } from './runCameras.ts';
import { ProbeVisibility, type Probe, type ProbeVisibilityResult } from './probeVisibility.ts';
import {
  SectionHeatmapStore,
  type Section,
  type SectionCellGrid,
} from './sectionHeatmap.ts';
import {
  ZoneCoverageStore,
  type MarkedFilter,
  type SamplingVolume,
  type Zone,
  type ZoneCoverage,
} from './samplingVolumes.ts';

/**
 * One retained-chunk store's run lifecycle: start a fresh run, retain a streamed
 * chunk, discard the retained run. The reads differ per store (decoded on their
 * own domain inputs) so they stay off this interface — `CoverageRun` fronts them.
 */
export interface RetainedRun {
  reset(grid: WorkspaceGrid, cameras: readonly RunCamera[]): void;
  addChunk(result: ChunkResult): void;
  clear(): void;
}

export class CoverageRun {
  private readonly probes = new ProbeVisibility();
  private readonly sections = new SectionHeatmapStore();
  private readonly zones = new ZoneCoverageStore();
  private readonly sinks: readonly RetainedRun[] = [this.probes, this.sections, this.zones];

  private gen = 0;

  /** The current run generation; `handleRun` snapshots this before its awaits. */
  get generation(): number {
    return this.gen;
  }

  /** Whether `token` still names the current generation (spec §14.4). */
  isCurrent(token: number): boolean {
    return token === this.gen;
  }

  /**
   * Start retaining a fresh run's chunks across all three stores (spec §12.2,
   * §13.4; `sampling_volumes.md` §7.2). Does not touch the generation — the caller
   * snapshotted its token first (see class doc).
   */
  reset(grid: WorkspaceGrid, cameras: readonly RunCamera[]): void {
    for (const sink of this.sinks) sink.reset(grid, cameras);
  }

  /** Fan a streamed chunk out to every retained-chunk store. */
  addChunk(result: ChunkResult): void {
    for (const sink of this.sinks) sink.addChunk(result);
  }

  /**
   * Discard the retained run and invalidate any in-flight one (spec §14.4). Called
   * on scene replace (`applyScene`); bumping the generation here is what drops a
   * mid-stream run's later chunks.
   */
  clear(): void {
    for (const sink of this.sinks) sink.clear();
    this.gen++;
  }

  /** Per-section cell grids from the retained run (spec §13.3, §13.4). */
  sectionCells(sections: Section[], marked: MarkedFilter | null): Map<string, SectionCellGrid | null> {
    const map = new Map<string, SectionCellGrid | null>();
    for (const s of sections) map.set(s.id, this.sections.computeCells(s, marked));
    return map;
  }

  /** Per-probe visibility decode from the retained run (spec §12.2). */
  probeQueries(probes: Probe[]): Map<string, ProbeVisibilityResult> {
    const map = new Map<string, ProbeVisibilityResult>();
    for (const p of probes) map.set(p.id, this.probes.query(p.position));
    return map;
  }

  /** Per-zone + enabled-union coverage from the retained run (`sampling_volumes.md` §7.2). */
  zoneCoverage(zones: Zone[], volumes: SamplingVolume[]): ZoneCoverage | null {
    return this.zones.compute(zones, volumes);
  }
}
