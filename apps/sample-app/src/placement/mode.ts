/**
 * The placement mode's lifecycle, pure (`camera_placement.md` §5, §5.1).
 *
 * Camera placement is a **mode**, not a panel: opening it keeps the app's three
 * -column shell and **replaces what the two side columns hold** — the left
 * column becomes the tool's inputs, the right its review, and the viewport keeps
 * the middle (§5). The session lives and dies with the mode (§3.4), which makes
 * the mode's state machine the thing that decides when a session ends — and that
 * is exactly the part worth keeping out of React.
 *
 * So the transitions live here as a reducer over `ModeState`, and the caller
 * carries out the one side effect it can ask for. `usePlacement.ts` owns the
 * session; this owns *when* the session is asked to close.
 */
import type { Pool } from './pool.ts';
import type { ConstraintGroup } from './region.ts';

/** Open on one group, or closed. `confirming` is the §5.1 close guard. */
export type ModeState = { groupId: string; confirming: boolean } | null;

export type ModeEvent =
  /** `Place cameras` on a group's panel (§5.1). */
  | { type: 'open'; groupId: string }
  /** Close or Escape. The session's own flags decide what that means. */
  | { type: 'requestClose'; running: boolean; hasPool: boolean }
  /** The guard's **Discard**. */
  | { type: 'confirmClose' }
  /** The guard's **Keep open**, or Escape while it is up. */
  | { type: 'keepOpen' }
  /** Apply (§5.3): the session closes itself, so the mode just leaves. */
  | { type: 'applied' }
  /** The targeted group is gone (a scene load, a delete) — nothing to place on. */
  | { type: 'groupGone' };

/**
 * What the caller must do about the session, alongside the next state.
 *
 * `closeSession` is `discard()`; `none` covers both "stay open" and the cases
 * where the session has already closed itself.
 */
export type ModeEffect = 'none' | 'closeSession';

export interface ModeStep {
  state: ModeState;
  effect: ModeEffect;
}

/**
 * One transition (§5.1).
 *
 * Two rules carry the design:
 *
 * - **A running build step is not closeable.** It is stopped by its own Cancel, so
 *   a Close pressed mid-build is dropped rather than racing the engine.
 * - **A built pool asks first.** A pool is minutes of GPU on a real site
 *   (§2.3) and every search after it is milliseconds, so the confirm sits where
 *   the cost is, not where the click is.
 */
export function stepMode(state: ModeState, event: ModeEvent): ModeStep {
  switch (event.type) {
    case 'open':
      return { state: { groupId: event.groupId, confirming: false }, effect: 'none' };
    case 'requestClose': {
      if (!state) return { state, effect: 'none' };
      if (event.running) return { state, effect: 'none' };
      if (event.hasPool && !state.confirming) {
        return { state: { ...state, confirming: true }, effect: 'none' };
      }
      return { state: null, effect: 'closeSession' };
    }
    case 'confirmClose':
      return state ? { state: null, effect: 'closeSession' } : { state, effect: 'none' };
    case 'keepOpen':
      return state ? { state: { ...state, confirming: false }, effect: 'none' } : { state, effect: 'none' };
    case 'applied':
      // Apply already closed the session (§5.3), so asking again would hand the
      // engine a camera list the reducer has just replaced.
      return { state: null, effect: 'none' };
    case 'groupGone':
      return state ? { state: null, effect: 'closeSession' } : { state, effect: 'none' };
  }
}

/**
 * What pressing **Build** will do to the pool in hand (`camera_placement.md`
 * §3.3.1, §5.1).
 *
 * The button says which, because the three differ by two orders of magnitude on
 * the real site — a rebuild is minutes of GPU, an extension is the difference
 * only, a truncation is free — and both draw inputs sit directly above it, so
 * they are the fields a user nudges. One label for all three would make the
 * cheap edit and the expensive one look identical.
 */
export type BuildAction = 'build' | 'extend' | 'truncate' | 'rebuild';

export function buildAction(
  pool: Pool | null,
  fingerprint: string,
  poolSize: number,
  seed: number,
): BuildAction {
  if (!pool) return 'build';
  // A moved fingerprint invalidates every built set (§3.3.1), so the size
  // comparison is moot: nothing in the pool can be reused whichever way it went.
  if (pool.fingerprint !== fingerprint) return 'rebuild';
  // A moved seed re-offsets every constraint's sub-sequence (§4.1), so position
  // `k` is now an unrelated point. Extending would hand the analysis one pool
  // drawn from two seeds, so this is a rebuild whatever `Size` did (§3.3.1).
  if (pool.seed !== seed) return 'rebuild';
  if (poolSize > pool.size) return 'extend';
  if (poolSize < pool.size) return 'truncate';
  // Same size, same fingerprint: a rebuild. Deliberately not disabled — a
  // button that does nothing is worse than one that redoes the work, and this is
  // the only way to re-roll a pool whose rejections went badly.
  return 'rebuild';
}

/** The button's label for each action (§5.1). */
export function buildLabel(action: BuildAction, poolSize: number): string {
  switch (action) {
    case 'build':
      return 'Build';
    case 'extend':
      return `Extend to ${poolSize}`;
    case 'truncate':
      return `Truncate to ${poolSize}`;
    case 'rebuild':
      return 'Rebuild';
  }
}

/**
 * Everything an analysis result depends on (§5.1).
 *
 * Compared against the group's live values to decide whether a result on screen
 * is **stale**. It is a derived comparison rather than an effect that clears the
 * curve: the fields now sit permanently beside the result, so a silent
 * disagreement between them would be visible and unexplained — while dropping
 * the result outright would throw away a good layout because someone nudged
 * `Seed`.
 *
 * `poolSize` is in the stamp even though it is not part of the strategy: an
 * extension or a truncation changes the set of layouts the analysis could have
 * found. `seed` is in it for the same reason and one more — it also picks each
 * trial's subset (§4.4) — and it is *only* here and in `buildAction`, never in
 * the pool's fingerprint, so a nudged `Seed` marks the result rather than
 * declaring the scene changed (§3.3.1).
 *
 * `epsilon` is **not** in it. It asks for no trials at all: the knee is a scan
 * of the finished curve (§4.5), recomputed live in the review column, so a
 * tolerance edit produces a new knee rather than an out-of-date result. Staling
 * on it would have demanded an Analyze to recompute a number already derivable
 * from the plot on screen.
 */
export function analysisStamp(group: ConstraintGroup): string {
  return [group.poolSize, group.maxCount, group.trials, group.seed].join('/');
}
