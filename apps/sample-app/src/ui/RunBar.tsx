/**
 * Run button + stale/backend indicators (spec §8, §8.1, §11).
 */
import { useTranslation } from 'react-i18next';
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
  /**
   * Why a run is impossible, already translated, or null (`geometry_assets.md`
   * §5.3). Unlike `runDisabled` this **says so**: a Run button that is simply
   * dead leaves the user guessing, and the fix — re-tick or re-add a geometry
   * row — is not one they would find by staring at the button.
   */
  runBlocker?: string | null;
}

export function RunBar({
  status, stale, backend, errorMessage, warnings, autoRun, onAutoRunChange, onRun, runDisabled, runBlocker,
}: RunBarProps) {
  const { t } = useTranslation('common');
  const busy = status === 'initializing' || status === 'computing';
  return (
    <div className="panel">
      <div className="status-line">
        <button className="btn" disabled={busy || runDisabled || runBlocker != null} title={runBlocker ?? undefined} onClick={onRun}>
          {status === 'computing' ? t('running') : status === 'initializing' ? t('initializing') : t('runCoverage')}
        </button>
        <label className="checkbox-row" style={{ margin: 0 }}>
          <input type="checkbox" checked={autoRun} onChange={(e) => onAutoRunChange(e.target.checked)} />
          {t('autoRun')}
        </label>
        {busy && <span className="spinner" />}
        {backend && (
          <span className={`badge backend-${backend}`}>{backend === 'webgpu' ? 'WebGPU' : 'CPU'}</span>
        )}
        {stale && !busy && runBlocker == null && <span className="badge stale">{t('recomputeInputsChanged')}</span>}
      </div>
      {runBlocker && <div className="warning-banner">{runBlocker}</div>}
      {errorMessage && <div className="error-banner">{errorMessage}</div>}
      {warnings?.map((w) => (
        <div className="warning-banner" key={w}>
          {w}
        </div>
      ))}
    </div>
  );
}
