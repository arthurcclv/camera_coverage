/**
 * Coverage summary readout (spec §10). Reports both the compute backend
 * (WebGPU / CPU, §3.2) and the render backend (WebGPU / WebGL2, §2.3), which are
 * selected independently, plus the blind-spot count (§13).
 */
import type { CoverageSummary } from '@linkervision/camera-coverage-sdk';
import type { RenderBackend } from '../scene/viewport.ts';

export interface StatsPanelProps {
  summary: CoverageSummary | null;
  computeBackend: 'webgpu' | 'cpu' | null;
  renderBackend: RenderBackend | null;
  voxelSize: number;
  /** Camera id → display name (spec §5.6) for the per-camera list. */
  cameraNameById: Map<string, string>;
}

function renderBackendLabel(b: RenderBackend): string {
  return b === 'webgpu' ? 'WebGPU' : 'WebGL2';
}

export function StatsPanel({ summary, computeBackend, renderBackend, voxelSize, cameraNameById }: StatsPanelProps) {
  // Blind spots: valid voxels no enabled camera sees (§13). overallRate is the
  // covered fraction, so (1 − rate) of the valid voxels are blind spots.
  const blindSpots = summary ? Math.round(summary.validVoxels * (1 - summary.overallRate)) : 0;

  return (
    <div className="panel">
      <p className="panel-title">Coverage stats</p>
      <div className="stat-line">
        <span>Compute backend</span>
        <b>{computeBackend ? (computeBackend === 'webgpu' ? 'WebGPU' : 'CPU') : '—'}</b>
      </div>
      <div className="stat-line">
        <span>Render backend</span>
        <b>{renderBackend ? renderBackendLabel(renderBackend) : '—'}</b>
      </div>
      <div className="stat-line">
        <span>Voxel size</span>
        <b>{voxelSize.toFixed(2)} m</b>
      </div>
      {summary ? (
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
            <b>{blindSpots.toLocaleString()}</b>
          </div>
          <div className="stat-line">
            <span>Elapsed</span>
            <b>{summary.elapsedMs.toFixed(0)} ms</b>
          </div>
          <p className="panel-title" style={{ marginTop: 10 }}>
            Per camera
          </p>
          {summary.perCamera.map((c) => (
            <div className="stat-line" key={c.id}>
              <span>{cameraNameById.get(c.id) ?? c.id}</span>
              <b>{(c.coverageRate * 100).toFixed(1)}%</b>
            </div>
          ))}
        </>
      ) : (
        <p className="hint">Press "Run coverage" to compute results.</p>
      )}
    </div>
  );
}
