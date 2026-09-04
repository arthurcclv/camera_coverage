/**
 * Placement mode, left column, card 1 (`camera_placement.md` §5.1).
 *
 * The two **draw inputs** — `Size` and `Seed` — the Build button, and **Build's
 * own feedback**: its progress line, its pool readout, its blocker, and the
 * Cancel that stops a build step. The card is the boundary that keeps cause and
 * effect adjacent — the reason Build is disabled is read where Build is, not
 * across the window.
 *
 * `Seed` belongs here rather than in *Strategy* because it decides *which*
 * points get built: it offsets every constraint's Halton sub-sequence (§4.1),
 * so it is spent on the GPU with Build, and a change to it forces a **Rebuild**
 * — an extend would append new-seed positions to old-seed ones (§3.3.1). The
 * strategy fields re-run for free over the pool in hand; these two cannot.
 *
 * `Size` stays directly under the readout, which is what tells the user whether
 * the number is worth changing (§5.1), and `Seed` follows it — so both sit
 * immediately above the button that spends them.
 *
 * The button states the *work*, not the noun: the heading already says what is
 * being built, and what the user needs from the label is which of §3.3.1's three
 * cases the press will cost — Build, Extend to N, Truncate to N, or Rebuild.
 * They differ by two orders of magnitude on a real site.
 */
import { poolSummary } from '../placement/pool.ts';
import { buildLabel } from '../placement/mode.ts';
import type { ConstraintGroup, CameraConstraint } from '../placement/region.ts';
import type { PlacementSession } from '../placement/usePlacement.ts';
import { NumberInput } from './NumberInput.tsx';

export interface CandidatePositionsPanelProps {
  session: PlacementSession;
  group: ConstraintGroup;
  constraints: readonly CameraConstraint[];
  /** The last placement error, shown here because the sidebar is hidden (§10). */
  error: string | null;
  onChangeGroup(id: string, patch: Partial<ConstraintGroup>): void;
}

export function CandidatePositionsPanel({
  session,
  group,
  constraints,
  error,
  onChangeGroup,
}: CandidatePositionsPanelProps) {
  const pool = session.pool;
  const building = session.running && session.progress?.phase === 'building';

  return (
    <div className="panel">
      <p className="panel-title">Candidate position pool</p>

      <div className="panel-body">
        {/* The pool in hand, directly under the title: it is what the card is
            *about* once one exists, and reading it above `Size` is what tells
            the user whether the number below is worth changing (§5.1). */}
        {pool && !session.running && (
          <p className="hint readout">
            {poolSummary(pool, constraints)
              .split('\n')
              .map((line, i) => (
                <span key={i}>
                  {line}
                  <br />
                </span>
              ))}
          </p>
        )}

        <div className="row">
          <label>Size</label>
          <NumberInput
            className="number-field"
            value={group.poolSize}
            min={1}
            max={1000}
            digits={0}
            integer
            seed="display"
            disabled={session.running}
            ariaLabel="Pool size"
            onCommit={(poolSize) => onChangeGroup(group.id, { poolSize })}
          />
        </div>

        <div className="row">
          <label>Seed</label>
          <NumberInput
            className="number-field"
            value={group.seed}
            min={0}
            max={2 ** 31 - 1}
            digits={0}
            integer
            seed="display"
            disabled={session.running}
            ariaLabel="Seed"
            onCommit={(seed) => onChangeGroup(group.id, { seed })}
          />
        </div>

        <div className="row button-row">
          <button
            type="button"
            className="btn"
            disabled={session.running || session.blocker !== null}
            onClick={() => void session.buildPool()}
          >
            {buildLabel(session.buildAction, group.poolSize)}
          </button>
          {building && (
            <button type="button" className="btn secondary" onClick={session.cancel}>
              Cancel
            </button>
          )}
        </div>

        {session.blocker && <p className="hint warn">{session.blocker}</p>}
        {error && <p className="hint warn">{error}</p>}

        {building && session.progress && (
          <p className="hint">
            building {session.progress.done}/{session.progress.total}
            {session.progress.label ? ` · ${session.progress.label}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
