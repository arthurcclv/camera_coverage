/**
 * Run button + stale/backend indicators (spec §8, §8.1, §11).
 */
import type { EngineStatus } from '../engine/useEngine.ts';

export interface RunBarProps {
  status: EngineStatus;
  stale: boolean;
  backend: 'webgpu' | 'cpu' | null;
  errorMessage: string | null;
  /** Non-fatal §3.3 cap drops (§11). Shown alongside, never instead of, results. */
  warnings?: string[];
  autoRun: boolean;
  onAutoRunChange(autoRun: boolean): void;
  onRun(): void;
  /**
   * Suppress the Run button for a reason that is not engine status — an open
   * aim-optimize session, which owns the engine's camera list for its duration
   * (`aim_optimization.md` §3.1, §8.1).
   */
  runDisabled?: boolean;
}

export function RunBar({
  status, stale, backend, errorMessage, warnings, autoRun, onAutoRunChange, onRun, runDisabled,
}: RunBarProps) {
  const busy = status === 'initializing' || status === 'computing';
  return (
    <div className="panel">
      <div className="status-line">
        <button className="btn" disabled={busy || runDisabled} onClick={onRun}>
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
      {warnings?.map((w) => (
        <div className="warning-banner" key={w}>
          {w}
        </div>
      ))}
    </div>
  );
}
