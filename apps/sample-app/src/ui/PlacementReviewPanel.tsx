/**
 * Placement mode, right column (`camera_placement.md` §5.2, §5.3).
 *
 * What the analysis found — the group being placed, the reachable-vs-count
 * curve, the count slider, the knee tolerance, the layout's numbers — with
 * **Apply** and **Close** pinned below the scroll region.
 *
 * **No read-only template summary.** One sat under the title only because the
 * panel that owned the template was hidden for the mode's life; the template is
 * now the left column's third card (§5.1), editable, one column over — and a
 * read-only copy of an editable field on the same screen is a thing to keep in
 * sync rather than a thing to read.
 *
 * `Knee (pp)` is here rather than in `StrategyPanel` because it reads the
 * *finished* curve (§4.5): `epsilon` enters the trial loop nowhere, so the knee
 * is a scan of an answer already in hand. Beside Analyze it was the one field
 * whose edit demanded a re-run to recompute a number derivable from the plot on
 * screen; here it recomputes live, costs nothing, and stales nothing — and it
 * sits directly under the count slider, immediately below the ◉ it moves.
 *
 * The pinning is the §5.1 invariant made structural: a session with no visible
 * exit strands the whole app, and actions that flowed after four stat lines, a
 * disables note and an over-budget warning could scroll out of view on a short
 * window.
 *
 * The curve's axis is labelled **reachable**, never "coverage". It is the
 * aim-free upper bound of §1.3, and reading it against the stats panel's
 * measured rate is the one misreading this feature can cause.
 */
import { useEffect } from 'react';
import { groupLabel, type ConstraintGroup } from '../placement/region.ts';
import { planLabel, type PlacementPlan } from '../placement/assign.ts';
import { CURVE_PLOT, countAtFraction, curveRange, curveX, curveY } from '../placement/curvePlot.ts';
import type { PlacementSession } from '../placement/usePlacement.ts';
import { Slider } from './Slider.tsx';

/**
 * The tolerance row's hover text and accessible name (§5.2).
 *
 * `pp` is not a unit every user knows, and the field is a policy rather than a
 * measurement, so the row says what it does in words. Stated in percentage
 * points rather than `%` because the drop is absolute in the rate the curve's
 * axis is ticked in — `top − epsilon·markedTotal/100` (§4.5) — not a fraction
 * of `top`; the two agree at a 94% ceiling and diverge at a low one.
 */
const KNEE_HINT =
  'How far below the best score found still counts as good enough, in percentage points of the reachable rate. Raise it to accept fewer cameras.';

export interface PlacementReviewPanelProps {
  session: PlacementSession;
  /** The group the mode opened on — fixed for its whole life (§5). */
  group: ConstraintGroup;
  /** The §5.3 plan Apply will adopt — derived in App from the live cameras. */
  plan: PlacementPlan;
  /** The group's knee tolerance, edited here and persisted on the group (§3.1). */
  onChangeGroup(id: string, patch: Partial<ConstraintGroup>): void;
  /** Cameras already in the scene — Apply is gated on the 128 limit (§5.3.4). */
  cameraCount: number;
  maxCameras: number;
  /** True while the §5.1 close guard is up. */
  confirming: boolean;
  /** Close or Escape: the mode decides whether that needs a confirm (§5.1). */
  onRequestClose(): void;
  onConfirmClose(): void;
  onKeepOpen(): void;
  onApply(plan: PlacementPlan): void;
}

export function PlacementReviewPanel({
  session,
  group,
  plan,
  cameraCount,
  maxCameras,
  confirming,
  onChangeGroup,
  onRequestClose,
  onConfirmClose,
  onKeepOpen,
  onApply,
}: PlacementReviewPanelProps) {
  const pool = session.pool;
  const curve = session.curve;
  const hasCurve = curve.some((b) => b !== null);
  const selected = session.selected;
  const layout = selected !== null ? curve[selected - 1] ?? null : null;
  // The count *after* the plan (§5.3.4): a re-arrange consumes no slot, and a
  // disable frees none — a disabled camera stays in the scene and keeps its
  // mask-bit index — so only the creates can push a scene over the limit.
  const overBudget = cameraCount + plan.creates.length > maxCameras;
  // A plan that changes nothing is not worth a state update — and, since Apply
  // leaves the mode, pressing it would silently throw the pool away.
  const emptyPlan =
    plan.moves.length === 0 && plan.creates.length === 0 && plan.disables.length === 0;

  // Escape asks to close, exactly as the button does — so it inherits the pool
  // guard rather than being a second, cheaper way out (§5.1). While the guard is
  // up, Escape is **Keep open**: the safe half of a two-button dialog.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      const target = ev.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (confirming) onKeepOpen();
      else onRequestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirming, onKeepOpen, onRequestClose]);

  // Two names in full, a count past that: the axis has to stay one line.
  const names = session.target?.zoneNames ?? [];
  const targetLabel =
    names.length === 0 ? null : names.length <= 2 ? names.join(', ') : `${names.length} zones`;

  return (
    <div className="panel placement-review">
      <p className="panel-title">
        {groupLabel(group)}
        {session.resultStale && <span className="badge stale">stale</span>}
      </p>

      <div className="panel-body">
        {hasCurve && pool && selected !== null ? (
          <>
            {/* The axis names the target zones when the group has them (§5.2):
                §3.3 borrowed the display descriptor's filter precisely so the two
                panels could not disagree about "counted", and a target set breaks
                that on purpose — so the axis says what it is a percentage *of*. */}
            <p className="panel-title subhead">
              {targetLabel === null
                ? 'Reachable by camera count'
                : `Reachable by camera count — ${targetLabel}`}
            </p>
            <ReachableCurve
              curve={curve}
              markedTotal={pool.markedTotal}
              ceiling={pool.poolCeiling}
              knee={session.knee}
              selected={selected}
              stale={session.resultStale}
              onSelect={session.setSelected}
            />
            {/* Two sliders, one control pattern: the count, then the tolerance
                that suggests one. A bare range beside a slider-plus-field would
                read as two different kinds of control (§5.2). */}
            <Slider
              label="Count"
              value={selected}
              min={1}
              max={curve.length}
              step={1}
              digits={0}
              integer
              onChange={session.setSelected}
            />
            <Slider
              label="Knee (pp)"
              value={group.epsilon}
              min={0}
              max={20}
              step={0.1}
              digits={1}
              title={KNEE_HINT}
              onChange={(epsilon) => onChangeGroup(group.id, { epsilon })}
            />
            {/* Marked, not withdrawn: the layout is still a real layout over a
                real pool, so the stats, the preview and Apply all stay live. */}
            {session.resultStale && (
              <p className="hint warn">Strategy changed — Analyze again.</p>
            )}
            <div className="stat-line">
              <span>Cameras</span>
              <b>{selected}</b>
            </div>
            <div className="stat-line">
              <span>{targetLabel === null ? 'Reachable' : `Reachable — ${targetLabel}`}</span>
              <b>{pct(layout?.score ?? 0, pool.markedTotal)}</b>
            </div>
            <div className="stat-line">
              <span>Pool ceiling</span>
              <b>{pct(pool.poolCeiling, pool.markedTotal)}</b>
            </div>
            <div className="stat-line">
              <span>Apply moves</span>
              <b>
                {plan.moves.length > 0
                  ? `${plan.moves.length} · ${plan.totalDistance.toFixed(1)} m total`
                  : '—'}
              </b>
            </div>
            <p className="hint">
              An upper bound, not a coverage prediction: it assumes each camera could look
              everywhere at once. Place, then <b>Optimize all aims</b>, then read the stats
              panel.
            </p>
            {plan.disables.length > 0 && (
              // Stated, not warned about: the cameras keep everything but their
              // `enabled` flag, and the hierarchy's eye toggle brings any of
              // them back (§5.3.1).
              <p className="hint">
                {plan.disables.length} bound {plan.disables.length === 1 ? 'camera' : 'cameras'} the
                layout does not need will be <b>disabled</b>, not deleted — each keeps its name and
                position, and can be switched back on from the hierarchy.
              </p>
            )}
            {overBudget && (
              <p className="hint warn">
                Placing {layout?.count} cameras would exceed the {maxCameras}-camera limit; the
                scene uses {cameraCount}.
              </p>
            )}
          </>
        ) : (
          <p className="hint">
            Build candidate positions, then Analyze. The curve reports what a layout could
            <b> reach</b> — an aim-free upper bound, not measured coverage.
          </p>
        )}
      </div>

      {/* Pinned below the scroll region, so the exit is on screen however far
          the review has been scrolled (§5.1). */}
      <div className="placement-actions">
        {hasCurve && (
          <button
            type="button"
            className="btn block"
            disabled={session.running || layout === null || overBudget || emptyPlan}
            onClick={() => onApply(plan)}
          >
            {planLabel(plan)}
          </button>
        )}
        <button
          type="button"
          className="btn secondary block"
          disabled={session.running}
          onClick={onRequestClose}
        >
          Close
        </button>

        {confirming && (
          <div
            className="placement-confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Discard the built pool?"
          >
            <p className="panel-title">Discard the built pool?</p>
            <p className="hint">
              {pool?.positions.length ?? 0} positions · rebuilding needs another full pass.
            </p>
            <div className="row">
              <button type="button" className="btn secondary" onClick={onKeepOpen}>
                Keep open
              </button>
              <button type="button" className="btn" onClick={onConfirmClose}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function pct(value: number, total: number): string {
  return total > 0 ? `${((100 * value) / total).toFixed(1)}%` : '—';
}

/**
 * The score-vs-count curve (§5.2): a click or drag picks the count, the knee is
 * marked, and the **pool ceiling** is drawn as a dashed asymptote.
 *
 * The ceiling is what separates "more cameras would not help" from "this pool is
 * too small" — two conclusions a bare curve conflates, and the reason a flat
 * stretch is ambiguous rather than conclusive (§4.4).
 */
function ReachableCurve({
  curve,
  markedTotal,
  ceiling,
  knee,
  selected,
  stale,
  onSelect,
}: {
  curve: (import('../placement/analyze.ts').BestLayout | null)[];
  markedTotal: number;
  ceiling: number;
  knee: number | null;
  selected: number;
  stale: boolean;
  onSelect(count: number): void;
}) {
  const { w, h, axisW, padRight, padBottom, padTop } = CURVE_PLOT;
  const n = curve.length;
  if (n === 0 || markedTotal <= 0) return null;
  const top = Math.max(ceiling, ...curve.map((b) => b?.score ?? 0)) || 1;
  const range = curveRange(top);
  const x = (count: number) => curveX(count, n);
  const y = (score: number) => curveY(score, range);
  const points = curve
    .map((b, i) => (b ? `${x(i + 1).toFixed(1)},${y(b.score).toFixed(1)}` : null))
    .filter(Boolean)
    .join(' ');
  // Three ticks, labelled in the axis's own unit — the **reachable rate**, the
  // same percentage the stats below quote, so the two cannot be read apart.
  const ticks = [0, top / 2, top];

  return (
    <svg
      className={`placement-curve${stale ? ' stale' : ''}`}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="Reachable voxels by camera count"
      onClick={(e) => {
        // The plot starts after the axis gutter, so a click maps from there —
        // `countAtFraction` is the inverse of the `curveX` the polyline is drawn
        // with, otherwise every count would be picked a little to the left.
        const box = e.currentTarget.getBoundingClientRect();
        onSelect(countAtFraction((e.clientX - box.left) / box.width, n));
      }}
    >
      <line x1={axisW} x2={axisW} y1={padTop - 6} y2={h - padBottom} className="curve-axis" />
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={axisW - 3} x2={axisW} y1={y(v)} y2={y(v)} className="curve-axis" />
          <text x={axisW - 6} y={y(v)} className="curve-tick">
            {((100 * v) / markedTotal).toFixed(0)}%
          </text>
        </g>
      ))}
      <line
        x1={axisW}
        x2={w - padRight}
        y1={y(ceiling)}
        y2={y(ceiling)}
        className="curve-ceiling"
        strokeDasharray="4 3"
      />
      <polyline className="curve-line" points={points} fill="none" />
      {curve.map((b, i) =>
        b ? (
          <circle
            key={i}
            cx={x(i + 1)}
            cy={y(b.score)}
            r={i + 1 === selected ? 4 : i + 1 === knee ? 3 : 2}
            className={
              i + 1 === selected ? 'curve-dot selected' : i + 1 === knee ? 'curve-dot knee' : 'curve-dot'
            }
          />
        ) : null,
      )}
    </svg>
  );
}
