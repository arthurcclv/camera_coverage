/**
 * Selected-zone panel (`sampling_volumes.md` §6.2): an editable name field, a
 * member count, and the zone's own coverage stats over `M(z)` (§7.2) — the
 * per-zone analog of the §10 stats panel. Whether the zone is enabled (i.e.
 * contributes to the marked set) is controlled from the hierarchy row's checkbox
 * (§4.1, §7.3), not here.
 *
 * Renaming writes back to `Zone.name` live (no confirm step) and is **not** a
 * coverage input — it never marks the result stale (§6.2).
 */
import { zoneLabel, type Zone, type ZoneSummary } from '../scene/samplingVolumes.ts';

export interface ZonePanelProps {
  zone: Zone | null;
  memberCount: number;
  /** The zone's coverage summary over `M(z)`, or null before any usable run. */
  summary: ZoneSummary | null;
  hasRunOnce: boolean;
  stale: boolean;
  onRename(id: string, name: string): void;
}

export function ZonePanel({ zone, memberCount, summary, hasRunOnce, stale, onRename }: ZonePanelProps) {
  if (!zone) return null;

  return (
    <div className="panel">
      <p className="panel-title">Zone — {zoneLabel(zone)}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="zone-name">Name</label>
          <input
            id="zone-name"
            type="text"
            className="text-input"
            value={zone.name}
            placeholder={zoneLabel(zone)}
            onChange={(e) => onRename(zone.id, e.target.value)}
          />
        </div>

        <div className="stat-line">
          <span>Volumes</span>
          <b>{memberCount}</b>
        </div>

        <p className="panel-title subhead">Zone coverage</p>
        {!hasRunOnce || !summary ? (
          <p className="hint">Run coverage to see results.</p>
        ) : summary.validVoxels === 0 ? (
          <p className="hint">This zone marks no valid voxels.</p>
        ) : (
          <ZoneStatsBody summary={summary} stale={stale} />
        )}
      </div>
    </div>
  );
}

function ZoneStatsBody({ summary, stale }: { summary: ZoneSummary; stale: boolean }) {
  const blindPct = summary.validVoxels > 0 ? summary.blindVoxels / summary.validVoxels : 0;
  return (
    <>
      <div className="stat-line">
        <span>Overall coverage</span>
        <b>{(summary.overallRate * 100).toFixed(1)}%</b>
      </div>
      <div className="stat-line">
        <span>Valid voxels</span>
        <b>{summary.validVoxels.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>Blind spots</span>
        <b>
          {summary.blindVoxels.toLocaleString()} ({(blindPct * 100).toFixed(1)}%)
        </b>
      </div>
      {stale && <p className="hint warn">⚠ Coverage out of date — recompute</p>}

      <p className="panel-title subhead">Per camera</p>
      {summary.perCamera.map((c) => (
        <div className="stat-line" key={c.id}>
          <span>{c.id}</span>
          <b>{(c.coverageRate * 100).toFixed(1)}%</b>
        </div>
      ))}
    </>
  );
}
