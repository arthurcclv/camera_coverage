/**
 * Selected-section coverage stats (spec §13.7): the section analog of the
 * coverage `StatsPanel`. Shown in the right sidebar only while a section is
 * selected; guards its own "nothing selected" state too since the spec
 * enumerates it as a first-class no-data state.
 */
import { useTranslation } from 'react-i18next';
import { computeSectionStats, type Section, type SectionCellGrid, type SectionOrientation } from '../scene/sectionHeatmap.ts';

export interface SectionStatsPanelProps {
  section: Section | null;
  /** The selected section's current cell grid, or null before any run (spec §13.4). */
  cellGrid: SectionCellGrid | null;
  hasRunOnce: boolean;
  /** Whether the live scene has diverged from the retained run (spec §8.1, §13.4). */
  stale: boolean;
  /** Camera id → display name (spec §5.6) for the per-camera list. */
  cameraNameById: Map<string, string>;
}

const ORIENTATION_LABEL_KEYS: Record<SectionOrientation, string> = {
  horizontal: 'orientationValue.horizontal',
  'vertical-x': 'orientationValue.verticalX',
  'vertical-z': 'orientationValue.verticalZ',
};

export function SectionStatsPanel({ section, cellGrid, hasRunOnce, stale, cameraNameById }: SectionStatsPanelProps) {
  const { t } = useTranslation('sections');
  return (
    <div className="panel">
      <p className="panel-title">{t('sectionStatsPanel.title')}</p>
      {!section ? (
        <p className="hint">{t('sectionStatsPanel.selectHint')}</p>
      ) : !hasRunOnce || !cellGrid ? (
        <p className="hint">{t('sectionStatsPanel.runHint')}</p>
      ) : (
        <SectionStatsBody section={section} cellGrid={cellGrid} stale={stale} cameraNameById={cameraNameById} />
      )}
    </div>
  );
}

function SectionStatsBody({ section, cellGrid, stale, cameraNameById }: { section: Section; cellGrid: SectionCellGrid; stale: boolean; cameraNameById: Map<string, string> }) {
  const { t } = useTranslation('sections');
  const stats = computeSectionStats(cellGrid);
  return (
    <>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.orientation')}</span>
        <b>{t(ORIENTATION_LABEL_KEYS[section.orientation])}</b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.thickness')}</span>
        <b>
          {section.min.toFixed(2)}–{section.max.toFixed(2)} m
        </b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.footprint')}</span>
        <b>
          {(section.maxA - section.minA).toFixed(1)} × {(section.maxB - section.minB).toFixed(1)} m
        </b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.cells')}</span>
        <b>{stats.totalCells.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.coloredCells')}</span>
        <b>{stats.validCells.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.obstacleCells')}</span>
        <b>{stats.obstacleCells.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.sectionCoverage')}</span>
        <b>{(stats.sectionCoverage * 100).toFixed(1)}%</b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.blindCells')}</span>
        <b>
          {stats.blindCells.toLocaleString()} ({(stats.blindCellsPct * 100).toFixed(1)}%)
        </b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.minCoverage')}</span>
        <b>{(stats.minCoverage * 100).toFixed(1)}%</b>
      </div>
      <div className="stat-line">
        <span>{t('sectionStatsPanel.maxCoverage')}</span>
        <b>{(stats.maxCoverage * 100).toFixed(1)}%</b>
      </div>
      {stale && <p className="hint warn">{t('sectionStatsPanel.staleWarning')}</p>}

      <p className="panel-title" style={{ marginTop: 10 }}>
        {t('sectionStatsPanel.perCamera')}
      </p>
      {stats.perCamera.map((c) => (
        <div className="stat-line" key={c.id}>
          <span>{cameraNameById.get(c.id) ?? c.id}</span>
          <b>{(c.seenFraction * 100).toFixed(1)}%</b>
        </div>
      ))}
    </>
  );
}
