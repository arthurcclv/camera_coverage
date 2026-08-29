/**
 * CoverageRun — the merged store of a run's `AggregateResult`s and its generation
 * guard (spec §3.3, §8, §12.2, §13.4, §14.4; `sampling_volumes.md` §7.2).
 *
 * A `compute()` streams one `AggregateResult` per chunk, each a few kilobytes of
 * accumulators (SDK spec §19.2). This retains them by `chunkId`, merges them on
 * read, and fronts the three panels that consume them — zone coverage, section
 * cells, probe visibility. The **overlay** is the fourth consumer and is not here:
 * it lives inside `SceneView` (created async), so App drives it inline from the
 * same `onAggregate` callback.
 *
 * Merging on read rather than on arrival is deliberate. An incremental run
 * (§8) re-sends only a few chunks, and each must **replace** its predecessor
 * rather than add to it — a running total could not tell the difference, and the
 * failure would look like a plausible over-count rather than an error.
 *
 * **Generation guard (§14.4).** A run is stamped with the current `generation`;
 * `clear()` (scene replaced, from `applyScene`) bumps it so any in-flight run's
 * results are dropped. `handleRun` snapshots `generation` before its first `await`
 * and guards every step with `isCurrent(token)`. `reset()` (start of a run)
 * deliberately does **not** bump — the run snapshotted its token first, so bumping
 * would invalidate itself.
 */
import {
  COLUMN_MIN_EMPTY,
  emptyColumns,
  emptyRegions,
  mergeColumns,
  mergeRegions,
  ProbeHit,
  camWords as camWordsFor,
  type AggregateResult,
  type ColumnAccum,
  type RegionAccum,
  type Vec3,
  type WorkspaceGrid,
} from '@linkervision/camera-coverage-sdk';
import { runCameras, NO_RUN_CAMERAS, type RunCamera, type RunCameras } from './runCameras.ts';
import type { Probe, ProbeVisibilityResult } from './probeVisibility.ts';
import {
  cellGridFromColumns,
  type Section,
  type SectionCellGrid,
} from './sectionHeatmap.ts';
import { summaryFromAccum, type Zone, type ZoneCoverage, type ZoneSummary } from './samplingVolumes.ts';
import { MARKED_GROUP, sectionColumnLength, type AggregateDescriptor } from './aggregateSpec.ts';

export class CoverageRun {
  private results = new Map<number, AggregateResult>();
  /**
   * The descriptor the retained results were produced under (spec §3.3) — both
   * halves, kept together on purpose.
   *
   * Accumulators are laid out *by* a descriptor: which group holds a zone, which
   * slab holds a section. Results from two descriptors cannot be merged, and an
   * index read against the wrong results reports one zone's numbers as another's.
   * So a run reuses the descriptor already held here rather than the newest one,
   * and a descriptor edit replaces results and index together ({@link adopt}).
   */
  private desc: AggregateDescriptor | null = null;
  private grid: WorkspaceGrid | null = null;
  private cams: RunCameras = NO_RUN_CAMERAS;
  /**
   * The **full** camera-list length and its word count — not the enabled count.
   * A disabled camera keeps its mask-bit slot (spec §5.4), so every accumulator
   * the SDK returns is indexed by bit, and `cams.bits` is what bridges back.
   */
  private numCameras = 0;
  private camWords = 1;

  private gen = 0;

  /** The current run generation; `handleRun` snapshots this before its awaits. */
  get generation(): number {
    return this.gen;
  }

  /** Whether `token` still names the current generation (spec §14.4). */
  isCurrent(token: number): boolean {
    return token === this.gen;
  }

  /** Whether any run has been retained yet. */
  hasRun(): boolean {
    return this.desc !== null;
  }

  /**
   * The descriptor the retained results were produced under, or null before any
   * run. `handleRun` reuses this rather than the newest descriptor: an
   * incremental run re-sends only a few chunks, and those must land in the same
   * layout as the ones already held. A newer descriptor is reconciled afterwards
   * by re-reducing *every* retained chunk at once (see {@link adopt}).
   */
  get descriptor(): AggregateDescriptor | null {
    return this.desc;
  }

  /** The snapshotted enabled-camera ids in mask-bit order. */
  get enabledCameraIds(): string[] {
    return this.cams.ids;
  }

  /**
   * Start retaining a fresh run. Does not touch the generation — the caller
   * snapshotted its token first (see class doc).
   *
   * `index` is the descriptor's read-back map (spec §3.3) and is replaced on
   * every reset **and** on every re-aggregation: it is what says which group a
   * zone's numbers are in, and reading last descriptor's index against this
   * descriptor's results is precisely the drift `aggregateSpec.ts` exists to
   * prevent.
   */
  reset(grid: WorkspaceGrid, cameras: readonly RunCamera[], desc: AggregateDescriptor): void {
    this.grid = grid;
    this.cams = runCameras(cameras);
    this.numCameras = cameras.length;
    this.camWords = camWordsFor(Math.max(1, cameras.length));
    this.desc = desc;
    this.results.clear();
  }

  /**
   * Swap in a re-aggregation's results under its descriptor, atomically — the
   * `aggregateRetained` path (spec §3.3), where the masks are unchanged and only
   * what is counted differs.
   *
   * Atomic because the two halves must never be observed apart: an index paired
   * with the previous descriptor's results would read a zone's numbers out of
   * another zone's group, and clearing first would blank every panel for however
   * long the round trip takes. The caller collects the results, then calls this.
   */
  adopt(desc: AggregateDescriptor, results: readonly AggregateResult[]): void {
    this.desc = desc;
    this.results.clear();
    for (const r of results) this.results.set(r.chunkId, r);
  }

  /** Retain one chunk's accumulators, replacing any previously held for it (§8). */
  addResult(result: AggregateResult): void {
    this.results.set(result.chunkId, result);
  }

  /** Discard the retained run and invalidate any in-flight one (spec §14.4). */
  clear(): void {
    this.results.clear();
    this.desc = null;
    this.grid = null;
    this.cams = NO_RUN_CAMERAS;
    this.gen++;
  }

  /**
   * Per-zone + enabled-union coverage (`sampling_volumes.md` §7.2), or null
   * before any run is retained.
   *
   * Every number here comes from a **group**, never from summing regions: a
   * zone's volumes may overlap, and summing them would count the overlap twice
   * (SDK spec §19.2).
   */
  zoneCoverage(zones: Zone[]): ZoneCoverage | null {
    if (!this.desc) return null;
    const groups = this.mergedGroups();
    const perZone = new Map<string, ZoneSummary>();
    for (const z of zones) {
      const g = this.desc.index.zoneGroup.get(z.id);
      perZone.set(z.id, summaryFromAccum(g === undefined ? null : groups[g], this.cams));
    }
    return {
      perZone,
      enabledUnion: summaryFromAccum(this.desc.index.marked ? groups[MARKED_GROUP] : null, this.cams),
    };
  }

  /** Per-section cell grids from the retained run (spec §13.3, §13.4). */
  sectionCells(sections: Section[]): Map<string, SectionCellGrid | null> {
    const map = new Map<string, SectionCellGrid | null>();
    for (const s of sections) map.set(s.id, this.sectionCellsFor(s));
    return map;
  }

  private sectionCellsFor(section: Section): SectionCellGrid | null {
    if (!this.desc || !this.grid) return null;
    const slab = this.desc.index.sectionSlab.get(section.id);
    if (slab === undefined) return null;
    const merged = this.mergedSlab(slab);
    if (!merged) return null;
    return cellGridFromColumns({
      grid: this.grid,
      section,
      acc: merged,
      camWords: this.camWords,
      cams: this.cams,
      columnLength: sectionColumnLength(this.grid, section),
    });
  }

  /** Per-probe visibility from the retained run (spec §12.2). */
  probeQueries(probes: Probe[]): Map<string, ProbeVisibilityResult> {
    const map = new Map<string, ProbeVisibilityResult>();
    for (const p of probes) map.set(p.id, this.probeQuery(p));
    return map;
  }

  private probeQuery(probe: Probe): ProbeVisibilityResult {
    const idx = this.desc?.index.probeIndex.get(probe.id);
    if (idx === undefined) return { status: 'no-data' };
    // Exactly one chunk can contain a given point, so the first hit is the hit.
    for (const r of this.results.values()) {
      if (!r.probeHits || r.probeHits[idx] === ProbeHit.Missed) continue;
      if (r.probeHits[idx] === ProbeHit.Invalid) return { status: 'no-data' };
      const cw = this.camWords;
      const base = idx * cw;
      const visible = this.cams.bits.map((bit) => {
        const w = bit >>> 5;
        return w < cw && ((r.probeMasks![base + w] >>> (bit & 31)) & 1) === 1;
      });
      return {
        status: 'ok',
        cameraIds: this.cams.ids,
        visible,
        seenCount: visible.reduce((n, v) => n + (v ? 1 : 0), 0),
      };
    }
    return { status: 'no-data' };
  }

  // --- merging ------------------------------------------------------------

  private mergedGroups(): RegionAccum[] {
    const totals = emptyRegions(MARKED_GROUP + 1, this.numCameras);
    for (const r of this.results.values()) if (r.groups) mergeRegions(totals, r.groups);
    return totals;
  }

  private mergedSlab(slab: number): ColumnAccum | null {
    let total: ColumnAccum | null = null;
    for (const r of this.results.values()) {
      const part = r.columns?.[slab];
      if (!part) continue;
      if (!total) total = emptyColumns(part.dimsA, part.dimsB, this.camWords);
      mergeColumns(total, part, this.camWords);
    }
    return total;
  }

}


