/**
 * The single source of the displayed coverage numbers (spec §10, §5.5,
 * `sampling_volumes.md` §7.4).
 *
 * Two readouts show per-camera rates — the stats panel's "Per camera" list and
 * the scene hierarchy's camera badge/dot — and they must never disagree. Both
 * derive from `displayCoverageSummary` here rather than picking their own
 * summary at the call site.
 */
import type { CoverageSummary } from '@linkervision/camera-coverage-sdk';
import type { ZoneSummary } from './samplingVolumes.ts';

/**
 * The summary the UI reports: the enabled-zones union when zones are active
 * (`sampling_volumes.md` §7.4), the SDK's own full-volume summary otherwise.
 * The union is a client-side aggregation with no timing of its own, so the
 * SDK summary's `elapsedMs` is kept either way.
 */
export function displayCoverageSummary(
  summary: CoverageSummary | null,
  enabledUnion: ZoneSummary | null,
  samplingActive: boolean,
  enabledCameraIds: ReadonlySet<string>,
): CoverageSummary | null {
  if (!summary) return null;
  // Since spec §5.4 the SDK summary carries an entry for every camera, disabled
  // ones included (always 0). Drop them here — the one derivation point — rather
  // than in each readout, so a new readout inherits the rule instead of having to
  // remember it. The zone path already lists only enabled cameras.
  if (!samplingActive || !enabledUnion) {
    return { ...summary, perCamera: summary.perCamera.filter((c) => enabledCameraIds.has(c.id)) };
  }
  return {
    ...summary,
    overallRate: enabledUnion.overallRate,
    validVoxels: enabledUnion.validVoxels,
    perCamera: enabledUnion.perCamera,
  };
}

/**
 * Per-camera rates for the hierarchy rows (spec §5.5), or `null` when no rate
 * is meaningful. With an empty marked set every rate finalizes to 0
 * (`samplingVolumes.ts`, §7.2), which would read as "sees nothing" rather than
 * "nothing to see" — so the badge is dropped, as when there is no run.
 */
export function hierarchyPerCamera(
  display: CoverageSummary | null,
): CoverageSummary['perCamera'] | null {
  if (!display || display.validVoxels === 0) return null;
  return display.perCamera;
}
