/**
 * Coverage summary readout (spec §10): voxel size, overall coverage, valid
 * voxels, the blind-spot count (§13), and the per-camera list.
 *
 * It does **not** name a backend — the compute one is a badge in `RunBar` (§3.2),
 * and the render one is no longer a choice (WebGL2, spec §2.3).
 */
import { useTranslation } from 'react-i18next';
import type { CoverageSummary } from '@linkervision/camera-coverage-sdk';

export interface StatsPanelProps {
  summary: CoverageSummary | null;
  computeBackend: 'webgpu' | 'cpu' | null;
  voxelSize: number;
  /** Camera id → display name (spec §5.6) for the per-camera list. */
  cameraNameById: Map<string, string>;
}

export function StatsPanel({ summary, computeBackend, voxelSize, cameraNameById }: StatsPanelProps) {
  const { t } = useTranslation('scene');
  // Blind spots: valid voxels no enabled camera sees (§13). overallRate is the
  // covered fraction, so (1 − rate) of the valid voxels are blind spots.
  const blindSpots = summary ? Math.round(summary.validVoxels * (1 - summary.overallRate)) : 0;

  return (
    <div className="panel">
      <p className="panel-title">{t('statsPanel.title')}</p>
      <div className="stat-line">
        <span>{t('statsPanel.voxelSize')}</span>
        <b>{voxelSize.toFixed(2)} m</b>
      </div>
      {summary ? (
        <>
          <div className="stat-line">
            <span>{t('statsPanel.overallCoverage')}</span>
            <b>{(summary.overallRate * 100).toFixed(1)}%</b>
          </div>
          <div className="stat-line">
            <span>{t('statsPanel.validVoxels')}</span>
            <b>{summary.validVoxels.toLocaleString()}</b>
          </div>
          <div className="stat-line">
            <span>{t('statsPanel.blindSpots')}</span>
            <b>{blindSpots.toLocaleString()}</b>
          </div>
          <div className="stat-line">
            <span>{t('statsPanel.elapsed')}</span>
            <b>{summary.elapsedMs.toFixed(0)} ms</b>
          </div>
          <p className="panel-title" style={{ marginTop: 10 }}>
            {t('statsPanel.perCamera')}
          </p>
          {summary.perCamera.map((c) => (
            <div className="stat-line" key={c.id}>
              <span>{cameraNameById.get(c.id) ?? c.id}</span>
              <b>{(c.coverageRate * 100).toFixed(1)}%</b>
            </div>
          ))}
        </>
      ) : (
        <p className="hint">{t('statsPanel.emptyHint')}</p>
      )}
    </div>
  );
}
