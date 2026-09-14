/**
 * Placement mode, left column, card 2 (`camera_placement.md` §5.1).
 *
 * The group's **strategy** — how the analysis searches the pool — and the
 * Analyze button, with its own trial progress and Cancel. Persisted on the group
 * (§3.1) so the same file re-runs to the same layout, but only ever shown here,
 * beside the button that consumes it.
 *
 * Three kinds of field could have landed here and only two did. `Size` and
 * `Seed` are the *draw* inputs (§4.1): they size and shape the pool rather than
 * the search over it, are spent on the GPU rather than on trials, and each
 * resolves into Build's own label (§3.3.1) — so they sit in
 * `CandidatePositionsPanel`, one card up. `Knee (pp)` is the opposite case: it
 * reads the *finished* curve (§4.5), so the card whose button re-runs the trials
 * is the one place it should not be, and it lives beside the plot it describes
 * in `PlacementReviewPanel` (§5.2).
 *
 * What is left is exactly the two fields a press of **Analyze** consumes.
 */
import { useTranslation } from 'react-i18next';
import { TRIALS_MAX } from '../placement/analyze.ts';
import type { ConstraintGroup } from '../placement/region.ts';
import type { PlacementSession } from '../placement/usePlacement.ts';
import { NumberInput } from './NumberInput.tsx';

export interface StrategyPanelProps {
  session: PlacementSession;
  group: ConstraintGroup;
  onChangeGroup(id: string, patch: Partial<ConstraintGroup>): void;
}

export function StrategyPanel({ session, group, onChangeGroup }: StrategyPanelProps) {
  const { t } = useTranslation(['placement', 'common']);
  const set = (patch: Partial<ConstraintGroup>) => onChangeGroup(group.id, patch);
  const pool = session.pool;
  // Both halves of an analysis (§4.4) share this card's progress line and its
  // one Cancel, and the line names which is running: they stall differently, so
  // a line that stopped moving has to say what is slow (§5.1).
  const phase = session.progress?.phase;
  const analyzing = session.running && (phase === 'choosing' || phase === 'analyzing');
  const hasResult = session.curve.some((b) => b !== null);

  return (
    <div className="panel">
      <p className="panel-title">{t('placement:strategyPanel.title')}</p>

      <div className="panel-body">
        {/* What the last analysis produced, directly under the title — the
            counterpart of the pool readout in the card above, and the one place
            the trial count and the knee are stated as *results* rather than as
            the fields that asked for them (§5.1). */}
        {hasResult && !session.running && (
          <p className={`hint readout${session.resultStale ? ' warn' : ''}`}>
            {t('placement:strategyPanel.trialsCount', { count: session.trialsDone })}
            {session.knee !== null && ` · ${t('placement:strategyPanel.kneeCount', { count: session.knee })}`}
            {session.resultStale && ` · ${t('placement:strategyPanel.staleSuffix')}`}
          </p>
        )}

        <Field
          label={t('placement:strategyPanel.maxCamsLabel')}
          value={group.maxCount}
          min={1}
          max={64}
          disabled={session.running}
          onCommit={(maxCount) => set({ maxCount })}
        />
        <Field
          label={t('placement:strategyPanel.trialsLabel')}
          value={group.trials}
          min={1}
          max={TRIALS_MAX}
          disabled={session.running}
          onCommit={(trials) => set({ trials })}
        />

        <div className="row button-row">
          <button
            type="button"
            className="btn"
            disabled={session.running || pool === null || pool.positions.length === 0}
            onClick={() => void session.runAnalysis()}
          >
            {t('placement:strategyPanel.analyzeButton')}
          </button>
          {analyzing && (
            <button type="button" className="btn secondary" onClick={session.cancel}>
              {t('common:cancel')}
            </button>
          )}
        </div>

        {analyzing && session.progress && (
          <p className="hint">
            {phase === 'choosing'
              ? t('placement:strategyPanel.choosingProgress', { done: session.progress.done, total: session.progress.total })
              : t('placement:strategyPanel.analyzingProgress', { done: session.progress.done, total: session.progress.total })}
          </p>
        )}
        {!session.running && pool === null && (
          <p className="hint">{t('placement:strategyPanel.buildFirstHint')}</p>
        )}
      </div>
    </div>
  );
}

/** One strategy row: label left, narrow numeric field right (`spec.md` §5.2.1). */
function Field({
  label,
  value,
  min,
  max,
  digits = 0,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  digits?: number;
  disabled?: boolean;
  onCommit(value: number): void;
}) {
  return (
    <div className="row">
      <label>{label}</label>
      <NumberInput
        className="number-field"
        value={value}
        min={min}
        max={max}
        digits={digits}
        integer={digits === 0}
        seed="display"
        disabled={disabled}
        ariaLabel={label}
        onCommit={onCommit}
      />
    </div>
  );
}
