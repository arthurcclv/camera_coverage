/**
 * Coverage summary readout (spec §10).
 */
import type { CoverageSummary } from '@linkervision/camera-coverage-sdk';

export interface StatsPanelProps {
  summary: CoverageSummary | null;
  backend: 'webgpu' | 'cpu' | null;
  voxelSize: number;
}

export function StatsPanel({ summary, backend, voxelSize }: StatsPanelProps) {
  return (
    <div className="panel">
      <p className="panel-title">Coverage stats</p>
      <div className="stat-line">
        <span>Backend</span>
        <b>{backend ? (backend === 'webgpu' ? 'WebGPU' : 'CPU') : '—'}</b>
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
            <span>Elapsed</span>
            <b>{summary.elapsedMs.toFixed(0)} ms</b>
          </div>
          <p className="panel-title" style={{ marginTop: 10 }}>
            Per camera
          </p>
          {summary.perCamera.map((c) => (
            <div className="stat-line" key={c.id}>
              <span>{c.id}</span>
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
