/**
 * Run button + stale/backend indicators (spec §8, §8.1, §11).
 */
import type { EngineStatus } from '../engine/useEngine.ts';

export interface RunBarProps {
  status: EngineStatus;
  stale: boolean;
  backend: 'webgpu' | 'cpu' | null;
  errorMessage: string | null;
  autoRun: boolean;
  onAutoRunChange(autoRun: boolean): void;
  onRun(): void;
}

export function RunBar({ status, stale, backend, errorMessage, autoRun, onAutoRunChange, onRun }: RunBarProps) {
  const busy = status === 'initializing' || status === 'computing';
  return (
    <div className="panel">
      <div className="status-line">
        <button className="btn" disabled={busy} onClick={onRun}>
          {status === 'computing' ? 'Running…' : status === 'initializing' ? 'Initializing…' : 'Run coverage'}
        </button>
        <label className="checkbox-row" style={{ margin: 0 }}>
          <input type="checkbox" checked={autoRun} onChange={(e) => onAutoRunChange(e.target.checked)} />
          Auto-run
        </label>
        {busy && <span className="spinner" />}
        {backend && (
          <span className={`badge backend-${backend}`}>{backend === 'webgpu' ? 'WebGPU' : 'CPU'}</span>
        )}
        {stale && !busy && <span className="badge stale">Recompute — inputs changed</span>}
      </div>
      {errorMessage && <div className="error-banner">{errorMessage}</div>}
    </div>
  );
}
