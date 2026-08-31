/**
 * Measured before/after coverage, per sampling zone (`aim_optimization.md` §6.3).
 *
 * The optimizer's own figure is ΔΦ over the marked set — one number for the whole
 * counted volume. That is the right thing to *maximize* (§1.2) and the wrong
 * thing to *report*: a zoned site is zoned precisely because its parts are not
 * interchangeable, and "Φ went up" does not say whether the loading bay improved
 * or paid for the corridor.
 *
 * Nothing here is predicted. Both columns come from real runs — the app already
 * computes a `ZoneSummary` per zone on every run (`sampling_volumes.md` §7.2) —
 * so a regression is reported as measured fact rather than inferred from the
 * panorama, whose 1.4° quantization (§2.3) would make a small delta unreliable.
 */
import type { Zone, ZoneCoverage, ZoneSummary } from '../scene/samplingVolumes.ts';

/** The three figures a zone's improvement is judged on. */
export interface ZoneFigures {
  validVoxels: number;
  /** Fraction covered by ≥ 1 enabled camera. */
  coverageRate: number;
  blindVoxels: number;
}

export interface CoverageSnapshot {
  /** Zone id → figures. Every zone the run knew about, enabled or not. */
  perZone: Map<string, ZoneFigures>;
  /** The enabled-zones union — or the whole valid volume when zones are off. */
  union: ZoneFigures;
}

export interface ZoneDelta {
  /** `null` for the union row. */
  zoneId: string | null;
  label: string;
  before: ZoneFigures;
  after: ZoneFigures;
  /** `after.coverageRate − before.coverageRate`. */
  rateDelta: number;
  /** `before.blindVoxels − after.blindVoxels` — positive means blind spots removed. */
  blindRemoved: number;
  /** Coverage fell. The one outcome the optimizer's own score cannot rule out (§1.3). */
  regressed: boolean;
}

export interface OptimizeComparison {
  union: ZoneDelta;
  /** Zones with marked voxels, regressions first, then by improvement. */
  zones: ZoneDelta[];
  regressedCount: number;
}

const ZERO: ZoneFigures = { validVoxels: 0, coverageRate: 0, blindVoxels: 0 };

function figures(s: ZoneSummary | undefined | null): ZoneFigures {
  if (!s) return ZERO;
  return { validVoxels: s.validVoxels, coverageRate: s.overallRate, blindVoxels: s.blindVoxels };
}

/** Freeze what a run measured, so a later run can be compared against it. */
export function snapshotCoverage(coverage: ZoneCoverage | null): CoverageSnapshot {
  const perZone = new Map<string, ZoneFigures>();
  if (coverage) for (const [id, s] of coverage.perZone) perZone.set(id, figures(s));
  return { perZone, union: figures(coverage?.enabledUnion) };
}

/**
 * A rate delta below this is noise, not a change.
 *
 * Coverage is a ratio of integer voxel counts, so it does move by a voxel or two
 * for reasons unrelated to aim — a chunk boundary, a validity tie. Flagging a
 * 0.01-percentage-point drop as a regression would cry wolf on every run.
 */
export const RATE_EPSILON = 0.0005;

function delta(
  zoneId: string | null,
  label: string,
  before: ZoneFigures,
  after: ZoneFigures,
): ZoneDelta {
  const rateDelta = after.coverageRate - before.coverageRate;
  return {
    zoneId,
    label,
    before,
    after,
    rateDelta,
    blindRemoved: before.blindVoxels - after.blindVoxels,
    regressed: rateDelta < -RATE_EPSILON,
  };
}

/**
 * Diff two snapshots (§6.3).
 *
 * A zone is listed when *either* snapshot found marked voxels in it, so a zone
 * that was emptied or newly filled still appears rather than silently dropping
 * out. Ordering puts **regressions first** — they are the finding the user has to
 * act on, and burying them under a list of wins is how a sacrifice goes unnoticed.
 */
export function compareCoverage(
  before: CoverageSnapshot,
  after: CoverageSnapshot,
  zones: readonly Zone[],
  unionLabel: string,
): OptimizeComparison {
  const rows: ZoneDelta[] = [];
  for (const z of zones) {
    const b = before.perZone.get(z.id) ?? ZERO;
    const a = after.perZone.get(z.id) ?? ZERO;
    if (b.validVoxels === 0 && a.validVoxels === 0) continue;
    rows.push(delta(z.id, z.name, b, a));
  }

  rows.sort((x, y) => {
    if (x.regressed !== y.regressed) return x.regressed ? -1 : 1;
    return x.regressed ? x.rateDelta - y.rateDelta : y.rateDelta - x.rateDelta;
  });

  return {
    union: delta(null, unionLabel, before.union, after.union),
    zones: rows,
    regressedCount: rows.filter((r) => r.regressed).length,
  };
}
