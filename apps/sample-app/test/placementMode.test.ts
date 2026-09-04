/**
 * The placement **mode** (`camera_placement.md` §5, §5.1, §13).
 *
 * What is pinned here is the lifecycle: which events end a session, which ones
 * must ask first, and which ones are dropped. It is a unit test rather than a
 * UI one because the transitions were deliberately made pure — `mode.ts` decides
 * *when* the session closes, `usePlacement.ts` closes it.
 *
 * The entry gate is the same `poolBlocker` the build step uses, so the mode is
 * never entered straight into a blocker; the cases here are the ones that only
 * the entry point can hit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CAMERAS, type Quat } from '@linkervision/camera-coverage-sdk';
import {
  analysisStamp,
  buildAction,
  buildLabel,
  stepMode,
  type ModeState,
} from '../src/placement/mode.ts';
import { emptyPool, poolBlocker, type Pool } from '../src/placement/pool.ts';
import { CAPTURE_SLOTS } from '../src/optimize/cubeRig.ts';
import type { CameraConstraint, ConstraintGroup } from '../src/placement/region.ts';
import type { SceneCamera } from '../src/cameras/camera.ts';

const IDENTITY: Quat = [0, 0, 0, 1];

function camera(id: string): SceneCamera {
  return {
    id,
    name: '',
    enabled: true,
    position: [1, 2, 3],
    rotation: IDENTITY,
    fov: 60,
    far: 30,
  };
}

function group(over: Partial<ConstraintGroup> = {}): ConstraintGroup {
  return {
    id: 'cg-1',
    name: 'Dock rail',
    enabled: true,
    namePrefix: '',
    fov: 90,
    far: 25,
    poolSize: 200,
    maxCount: 12,
    trials: 2000,
    epsilon: 1,
    seed: 7,
    ...over,
  };
}

function constraint(over: Partial<CameraConstraint> = {}): CameraConstraint {
  return {
    id: 'con-1',
    groupId: 'cg-1',
    name: '',
    enabled: true,
    kind: 'point',
    position: [0, 2, 0],
    rotation: IDENTITY,
    points: [[0, 2, 0]],
    size: [1, 1],
    distance: 0,
    ...over,
  };
}

const OPEN: ModeState = { groupId: 'cg-1', confirming: false };

test('opening targets the group it was pressed on, and only that one', () => {
  const step = stepMode(null, { type: 'open', groupId: 'cg-1' });
  assert.deepEqual(step.state, { groupId: 'cg-1', confirming: false });
  assert.equal(step.effect, 'none');

  // Re-opening on another group replaces the target outright: the mode holds one
  // group for its whole life, which is why it needs no selector (§5).
  const moved = stepMode(step.state, { type: 'open', groupId: 'cg-2' });
  assert.equal(moved.state?.groupId, 'cg-2');
});

test('closing with no pool closes straight through', () => {
  const step = stepMode(OPEN, { type: 'requestClose', running: false, hasPool: false });
  assert.equal(step.state, null);
  assert.equal(step.effect, 'closeSession');
});

test('closing with a pool in hand asks first, and asks only once', () => {
  const asked = stepMode(OPEN, { type: 'requestClose', running: false, hasPool: true });
  assert.deepEqual(asked.state, { groupId: 'cg-1', confirming: true });
  assert.equal(asked.effect, 'none', 'the guard must not close the session behind itself');

  // A second Close (or Escape) while the guard is up is the Discard it is
  // asking for, not a second guard.
  const again = stepMode(asked.state, { type: 'requestClose', running: false, hasPool: true });
  assert.equal(again.state, null);
  assert.equal(again.effect, 'closeSession');
});

test('Keep open leaves the session and its pool exactly as they were', () => {
  const asked = stepMode(OPEN, { type: 'requestClose', running: false, hasPool: true });
  const kept = stepMode(asked.state, { type: 'keepOpen' });
  assert.deepEqual(kept.state, OPEN);
  assert.equal(kept.effect, 'none');
});

test('Discard on the guard closes the session', () => {
  const asked = stepMode(OPEN, { type: 'requestClose', running: false, hasPool: true });
  const done = stepMode(asked.state, { type: 'confirmClose' });
  assert.equal(done.state, null);
  assert.equal(done.effect, 'closeSession');
});

test('a running build step is not closeable — Cancel stops it, Close does not', () => {
  for (const hasPool of [false, true]) {
    const step = stepMode(OPEN, { type: 'requestClose', running: true, hasPool });
    assert.deepEqual(step.state, OPEN, `running with hasPool=${hasPool} must stay open`);
    assert.equal(step.effect, 'none');
  }
});

test('Apply leaves the mode without asking the session to close again', () => {
  // Apply already closed the session (§5.3); a second close would hand the
  // engine back a camera list the reducer has just replaced.
  const step = stepMode(OPEN, { type: 'applied' });
  assert.equal(step.state, null);
  assert.equal(step.effect, 'none');
});

test('a vanished group closes the mode and the session with it', () => {
  const step = stepMode(OPEN, { type: 'groupGone' });
  assert.equal(step.state, null);
  assert.equal(step.effect, 'closeSession');
});

test('events on a closed mode are inert', () => {
  for (const event of [
    { type: 'requestClose', running: false, hasPool: true },
    { type: 'confirmClose' },
    { type: 'keepOpen' },
    { type: 'groupGone' },
  ] as const) {
    const step = stepMode(null, event);
    assert.equal(step.state, null, event.type);
    assert.equal(step.effect, 'none', event.type);
  }
});

test('the entry gate refuses every blocker, in priority order (§10)', () => {
  const g = group();
  const cons = [constraint()];
  const ready = { samplingPending: false, aimSessionOpen: false, engineReady: true };

  assert.equal(poolBlocker([camera('cam-1')], g, cons, ready), null);

  // Engine first: a build step is the one entry point that skips the Run gate.
  assert.match(
    poolBlocker([], g, cons, { ...ready, engineReady: false }) ?? '',
    /engine to finish loading/i,
  );
  // Then the slot budget, then the other session, then sampling, then the group.
  const full = Array.from({ length: MAX_CAMERAS - CAPTURE_SLOTS + 1 }, (_, i) => camera(`cam-${i}`));
  assert.match(poolBlocker(full, g, cons, ready) ?? '', /spare camera slots/i);
  assert.match(poolBlocker([], g, cons, { ...ready, aimSessionOpen: true }) ?? '', /aim optimizer/i);
  assert.match(poolBlocker([], g, cons, { ...ready, samplingPending: true }) ?? '', /Run coverage once/i);
  assert.match(poolBlocker([], null, cons, ready) ?? '', /constraint group/i);
  assert.match(poolBlocker([], g, [], ready) ?? '', /no enabled constraint/i);
  assert.match(
    poolBlocker([], g, [constraint({ enabled: false })], ready) ?? '',
    /no enabled constraint/i,
    'a disabled constraint is not a sampleable one',
  );
});

function pool(over: Partial<Pool> = {}): Pool {
  return { ...emptyPool('cg-1', 'fp-1', 200, 7), ...over };
}

test('Build says which of the three cases the press will cost (§3.3.1)', () => {
  // No pool: nothing to reuse.
  assert.equal(buildAction(null, 'fp-1', 200, 7), 'build');
  // Same fingerprint, larger size: only the difference is built.
  assert.equal(buildAction(pool(), 'fp-1', 260, 7), 'extend');
  // Smaller: no build step at all.
  assert.equal(buildAction(pool(), 'fp-1', 120, 7), 'truncate');
  // A moved fingerprint invalidates every built set, so the size comparison
  // is moot — nothing can be reused whichever way it went.
  assert.equal(buildAction(pool(), 'fp-2', 260, 7), 'rebuild');
  assert.equal(buildAction(pool(), 'fp-2', 120, 7), 'rebuild');
  // Same size, same fingerprint: a deliberate rebuild, not a disabled button
  // — it is the only way to re-roll a pool whose rejections went badly.
  assert.equal(buildAction(pool(), 'fp-1', 200, 7), 'rebuild');
});

test('a moved seed rebuilds whatever Size did — an extend would mix seeds (§3.3.1)', () => {
  // The seed re-offsets every constraint's sub-sequence (§4.1), so position `k`
  // under seed 8 is an unrelated point. Extending would append new-seed
  // positions to old-seed ones and hand the analysis one pool drawn from two.
  assert.equal(buildAction(pool(), 'fp-1', 260, 8), 'rebuild', 'grown');
  assert.equal(buildAction(pool(), 'fp-1', 120, 8), 'rebuild', 'truncated');
  assert.equal(buildAction(pool(), 'fp-1', 200, 8), 'rebuild', 'unchanged');
  // And the pool records what it was drawn from, so the comparison is against
  // the draw rather than against the group's current field.
  assert.equal(pool({ seed: 8 }).seed, 8);
  assert.equal(buildAction(pool({ seed: 8 }), 'fp-1', 260, 8), 'extend');
});

test('the pool records the size it was asked for, not the count it kept', () => {
  // A constraint that exhausts its rejection budget (§4.2) leaves the pool short.
  // Comparing the *kept* count against the field would read `Extend` forever.
  const short = pool({ positions: [], rejected: 40 });
  assert.equal(short.size, 200);
  assert.equal(buildAction(short, 'fp-1', 200, 7), 'rebuild');
});

test('the button names the work and the number', () => {
  assert.equal(buildLabel('build', 200), 'Build');
  assert.equal(buildLabel('extend', 260), 'Extend to 260');
  assert.equal(buildLabel('truncate', 120), 'Truncate to 120');
  assert.equal(buildLabel('rebuild', 200), 'Rebuild');
});

test('a result is stale when the size or any strategy field has moved (§5.1)', () => {
  const base = group();
  const stamp = analysisStamp(base);
  assert.equal(analysisStamp({ ...base }), stamp, 'an unchanged group is not stale');

  for (const patch of [
    { poolSize: 260 },
    { maxCount: 16 },
    { trials: 4000 },
    { seed: 8 },
  ] as const) {
    assert.notEqual(analysisStamp({ ...base, ...patch }), stamp, JSON.stringify(patch));
  }

  // `epsilon` asks for no trials: the knee is a scan of the finished curve
  // (§4.5), recomputed live in the review column, so a tolerance edit produces a
  // new knee rather than an out-of-date result.
  assert.equal(analysisStamp({ ...base, epsilon: 5 }), stamp, 'the tolerance stales nothing');

  // The template is not in the stamp: `fov` cannot change a reachable set at all
  // (§3.1.1), and `far` is caught by the pool's own fingerprint (§3.3.1) — which
  // discards the pool rather than marking a result.
  for (const patch of [{ fov: 120 }, { far: 40 }, { namePrefix: 'x' }] as const) {
    assert.equal(analysisStamp({ ...base, ...patch }), stamp, JSON.stringify(patch));
  }
});

test('a nudged Seed marks the result and re-labels Build, and claims no scene change (§5.1)', () => {
  // The seed is in the stamp and in `buildAction`, and deliberately *not* in the
  // pool's fingerprint: putting it there would dim the curve, disable Apply, and
  // say "the scene changed" about an edit that changed no scene.
  const base = group();
  const held = pool();
  assert.notEqual(analysisStamp({ ...base, seed: 8 }), analysisStamp(base), 'the result is marked');
  assert.equal(buildAction(held, 'fp-1', base.poolSize, 8), 'rebuild', 'Build re-labels');
  // The fingerprint the pool was built under is untouched by the edit, so the
  // §10 `stalePool` blocker — which compares exactly this — stays silent.
  assert.equal(held.fingerprint, 'fp-1');
});
