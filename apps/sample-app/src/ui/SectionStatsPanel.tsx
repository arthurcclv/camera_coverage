/**
 * Selected-section coverage stats (spec §13.7): the section analog of the
 * coverage `StatsPanel`. Shown in the right sidebar only while a section is
 * selected; guards its own "nothing selected" state too since the spec
 * enumerates it as a first-class no-data state.
 */
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

const ORIENTATION_LABELS: Record<SectionOrientation, string> = {
  horizontal: 'Horizontal',
  'vertical-x': 'Vertical X',
  'vertical-z': 'Vertical Z',
};

export function SectionStatsPanel({ section, cellGrid, hasRunOnce, stale, cameraNameById }: SectionStatsPanelProps) {
  return (
    <div className="panel">
      <p className="panel-title">Section stats</p>
      {!section ? (
        <p className="hint">Select a section to see its stats.</p>
      ) : !hasRunOnce || !cellGrid ? (
        <p className="hint">Run coverage to see section stats.</p>
      ) : (
        <SectionStatsBody section={section} cellGrid={cellGrid} stale={stale} cameraNameById={cameraNameById} />
      )}
    </div>
  );
}

function SectionStatsBody({ section, cellGrid, stale, cameraNameById }: { section: Section; cellGrid: SectionCellGrid; stale: boolean; cameraNameById: Map<string, string> }) {
  const stats = computeSectionStats(cellGrid);
  return (
    <>
      <div className="stat-line">
        <span>Orientation</span>
        <b>{ORIENTATION_LABELS[section.orientation]}</b>
      </div>
      <div className="stat-line">
        <span>Range</span>
        <b>
          {section.min.toFixed(2)}–{section.max.toFixed(2)} m
        </b>
      </div>
      <div className="stat-line">
        <span>Cells</span>
        <b>{stats.totalCells.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>Valid cells</span>
        <b>{stats.validCells.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>Invalid cells</span>
        <b>{stats.invalidCells.toLocaleString()}</b>
      </div>
      <div className="stat-line">
        <span>Section coverage</span>
        <b>{(stats.sectionCoverage * 100).toFixed(1)}%</b>
      </div>
      <div className="stat-line">
        <span>Blind cells</span>
        <b>
          {stats.blindCells.toLocaleString()} ({(stats.blindCellsPct * 100).toFixed(1)}%)
        </b>
      </div>
      <div className="stat-line">
        <span>Min coverage</span>
        <b>{(stats.minCoverage * 100).toFixed(1)}%</b>
      </div>
      <div className="stat-line">
        <span>Max coverage</span>
        <b>{(stats.maxCoverage * 100).toFixed(1)}%</b>
      </div>
      {stale && <p className="hint warn">⚠ Coverage out of date — recompute</p>}

      <p className="panel-title" style={{ marginTop: 10 }}>
        Per camera
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
