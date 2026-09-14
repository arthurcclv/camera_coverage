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
import { useTranslation } from 'react-i18next';
import { zoneLabel, type Zone, type ZoneSummary } from '../scene/samplingVolumes.ts';

export interface ZonePanelProps {
  zone: Zone | null;
  memberCount: number;
  /** The zone's coverage summary over `M(z)`, or null before any usable run. */
  summary: ZoneSummary | null;
  hasRunOnce: boolean;
  stale: boolean;
  onRename(id: string, name: string): void;
  /** Camera id → display name (spec §5.6) for the per-camera list. */
  cameraNameById: Map<string, string>;
}

export function ZonePanel({ zone, memberCount, summary, hasRunOnce, stale, onRename, cameraNameById }: ZonePanelProps) {
  const { t } = useTranslation(['volumes', 'common']);
  if (!zone) return null;

  return (
    <div className="panel">
      <p className="panel-title">{t('zonePanel.title', { label: zoneLabel(zone) })}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="zone-name">{t('common:name')}</label>
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
          <span>{t('zonePanel.memberCount')}</span>
          <b>{memberCount}</b>
        </div>

        <p className="panel-title subhead">{t('zonePanel.coverageTitle')}</p>
        {!hasRunOnce || !summary ? (
          <p className="hint">{t('zonePanel.runHint')}</p>
        ) : summary.validVoxels === 0 ? (
          <p className="hint">{t('zonePanel.noValidVoxels')}</p>
        ) : (
          <ZoneStatsBody summary={summary} stale={stale} cameraNameById={cameraNameById} />
        )}
      </div>
    </div>
  );
}

function ZoneStatsBody({ summary, stale, cameraNameById }: { summary: ZoneSummary; stale: boolean; cameraNameById: Map<string, string> }) {
  const { t } = useTranslation('volumes');
  const blindPct = summary.validVoxels > 0 ? summary.blindVoxels / summary.validVoxels : 0;
  return (
    <>
      <div className="stat-line">
        <span>{t('zonePanel.overallCoverage')}</span>
        <b>{(summary.overallRate * 100).toFixed(1)}%</b>
      </div>
      <div className="stat-line">
        <span>{t('zonePanel.validVoxels')}</span>
        <b>{summary.validVoxels.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>{t('zonePanel.blindSpots')}</span>
        <b>
          {summary.blindVoxels.toLocaleString()} ({(blindPct * 100).toFixed(1)}%)
        </b>
      </div>
      {stale && <p className="hint warn">{t('zonePanel.staleWarning')}</p>}

      <p className="panel-title subhead">{t('zonePanel.perCamera')}</p>
      {summary.perCamera.map((c) => (
        <div className="stat-line" key={c.id}>
          <span>{cameraNameById.get(c.id) ?? c.id}</span>
          <b>{(c.coverageRate * 100).toFixed(1)}%</b>
        </div>
      ))}
    </>
  );
}
