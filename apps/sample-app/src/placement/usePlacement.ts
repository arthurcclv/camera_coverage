/**
 * The placement session as React state (`camera_placement.md` §3.4, §5).
 *
 * Owns the six capture slots, the cached pool, the analysis, and the
 * apply/discard lifecycle. Every *decision* comes from `pool.ts`, `analyze.ts`
 * and `mode.ts`; what lives here is the part that has to talk to the engine and
 * to React — the same split `useAimOptimizer.ts` makes.
 *
 * The scene is deliberately **not** written until Apply (§5.3): the proposed
 * layout lives here and the viewport draws it, so Discard is exact rather than
 * an undo.
 */
import { useCallback, useRef, useState } from 'react';
import type { Vec3, WorkspaceGrid } from '@linkervision/camera-coverage-sdk';

import { toCameraConfig, type SceneCamera } from '../cameras/camera.ts';
import type { EngineApi } from '../engine/useEngine.ts';
import type { GroupTarget } from './pool.ts';
import { nextFreeId } from '../scene/entityDuplication.ts';
import { VoxelBitset, leafChunkFrom, leafSetOf, type LeafChunk } from './leafSet.ts';
import {
  bestSample,
  buildStepCameras,
  buildStepSpec,
  classifyBuildStep,
  emptyPool,
  drawBasis,
  soloBasis,
  planDraws,
  poolBlocker,
  poolFingerprint,
  poolSplit,
  replacementDraw,
  repositionBlocker as blockReposition,
  truncatedShares,
  type HeldDraws,
  type Pool,
  type PoolPosition,
  type PositionSample,
} from './pool.ts';
import { DEFAULT_TEMPLATE, type CameraConstraint, type ConstraintGroup } from './region.ts';
import {
  advanceAnalysis,
  advanceGreedy,
  greedyRemaining,
  kneeOf,
  selectedCount,
  newAnalysis,
  type AnalysisState,
  type BestLayout,
} from './analyze.ts';
import { analysisStamp, buildAction, type BuildAction } from './mode.ts';
import type { PlacementPlan } from './assign.ts';
import { describeError } from '../errorText.ts';

/** Trials run between yields, so Cancel and the progress line stay responsive. */
const TRIAL_BATCH = 50;

export interface PlacementProgress {
  phase: 'building' | 'choosing' | 'analyzing';
  done: number;
  total: number;
  /** The constraint being sampled, while building. */
  label: string;
}

export interface PlacementSession {
  /** True while the capture slots are part of the engine's camera list (§3.4). */
  slotsActive: boolean;
  /** The group the panel targets (§5.1). */
  targetGroupId: string | null;
  /** The built pool, or null (§3.3). */
  pool: Pool | null;
  /** Best layout per camera count, index `k − 1` (§4.4). */
  curve: (BestLayout | null)[];
  /** Trials run so far in the open analysis. */
  trialsDone: number;
  /**
   * The §4.5 knee, or null before an analysis. **Derived**, not stored: it is a
   * scan of `curve` under the group's `epsilon`, so the review column's
   * tolerance slider moves it for free (§5.2).
   */
  knee: number | null;
  /**
   * True when the result on screen was produced under a `Size` or strategy the
   * group no longer holds (§5.1). The result stays usable; it is marked, not
   * withdrawn.
   */
  resultStale: boolean;
  /** What pressing Build would do to the pool in hand (§3.3.1, §5.1). */
  buildAction: BuildAction;
  /**
   * The count the slider holds: the live `knee` until the user drags it, that
   * pick afterwards, and back to the knee on the next analysis (§5.2).
   */
  selected: number | null;
  /** The layout the viewport previews and Apply writes (§5.2, §5.3). */
  previewPositions: PoolPosition[];
  running: boolean;
  progress: PlacementProgress | null;
  /** Why the entry points are unavailable, or null (§10). */
  blocker: string | null;
  /**
   * The resolved target zones of the group the panel acts on (§3.1.2), or null
   * with no group.
   *
   * Exposed rather than derived in the panels because the *filter* and the
   * *total* have to come from one resolution: a percentage of the listed zones'
   * score over the enabled zones' denominator is wrong in a way nothing on
   * screen would look wrong about.
   */
  target: GroupTarget | null;
  /** True while the display descriptor must still hide the slots (§3.4). */
  maskSlots: boolean;
  /** True while the app must not start a display run of its own (§3.4, §8.1). */
  busy: boolean;

  setTargetGroup(groupId: string | null): void;
  /**
   * Why the placement mode cannot be opened on this group, or null (§5.1, §10).
   *
   * The panel's own `blocker` speaks for the *resolved* target; this answers for
   * a group the mode has not opened on yet, which is what the entry button
   * needs — the mode is never entered straight into a blocker.
   */
  entryBlocker(group: ConstraintGroup | null): string | null;
  buildPool(): Promise<void>;
  runAnalysis(): Promise<void>;
  cancel(): void;
  setSelected(count: number): void;
  /**
   * Adopt the plan and close the session (§5.3).
   *
   * The plan arrives from the caller rather than being derived here: it is a
   * function of the *live* camera list, which this hook only reads through a
   * ref — so deriving it here would label the button from a stale scene.
   */
  apply(plan: PlacementPlan): void;
  /** Drop the pool and the result and close the session (§5.1). */
  discard(): void;
  /** Called when a full (non-incremental) run has completed (§3.4). */
  noteFullRun(): void;
  /** Why Reposition is unavailable for this camera, or null (§4.6, §10). */
  repositionBlocker(camera: SceneCamera): string | null;
  /**
   * Move a bound camera to the best-scoring position on its **own** constraint
   * (§4.6): a one-camera search, which needs no trials because a one-camera
   * layout's score is just that position's own count.
   */
  reposition(camera: SceneCamera): Promise<void>;
}

export interface UsePlacementArgs {
  engine: EngineApi;
  cameras: () => readonly SceneCamera[];
  constraintGroups: () => readonly ConstraintGroup[];
  constraints: () => readonly CameraConstraint[];
  /** The workspace grid a run is computed on — maps a chunkId to its place. */
  grid: () => WorkspaceGrid;
  /**
   * What one group counts, where it may mount, and what it divides by (§3.1.2).
   *
   * A build step must count the **counted** set, and only this says what that is:
   * `setSampling` bounds what is *computed* with conservative AABBs, so a build
   * step without the filter would count the slop and the disabled zones. With the
   * group's target zones it is those zones' volumes instead, overriding both
   * `useZones` and each zone's `enabled` — the group states its own target.
   *
   * `total` is read from the app's **own display numbers** rather than measured
   * during a build step: a build step is `incremental`, so its `onAggregate`
   * fires only for the chunks that rig reaches, and any total assembled there
   * would be a partial.
   */
  groupTarget: (group: ConstraintGroup) => GroupTarget;
  /** Whether a sampling edit still awaits a run (§3.3). */
  samplingPending: () => boolean;
  /** Whether an aim-optimize session holds the shared capture slots (§3.4). */
  aimSessionOpen: () => boolean;
  /**
   * Whether the engine has loaded the scene and is not in an error state (§10).
   *
   * A build step is the one entry point that does not go through the app's own Run
   * gate, so without this a click during startup reaches a worker holding no
   * engine yet — and the failure arrives as an SDK `INVALID_STATE` naming
   * nothing the user can act on.
   */
  engineReady: () => boolean;
  /** What the pool's cached sets are valid for (§3.3.1). */
  fingerprint: () => { geometryRevision: string | number; voxelSize: number; markedRevision: string | number };
  /** Commit the §5.3 plan to the scene reducer, as one edit. */
  onApply(plan: {
    moves: { cameraId: string; position: Vec3; constraintId: string; near: number; far: number }[];
    creates: SceneCamera[];
    disables: string[];
  }): void;
  /** Commit a repositioned camera's new mount position (§4.6). */
  onReposition(cameraId: string, position: Vec3): void;
  /** Report a failure to the §10 status area. */
  onError(message: string): void;
  /**
   * Mark the coverage result stale because a session closed without applying
   * (§3.4). A build step overwrites the worker's retained chunks with the slots
   * present, so closing without this leaves every panel reading them.
   */
  onNeedsRecompute(): void;
}

interface SessionState {
  slotsActive: boolean;
  targetGroupId: string | null;
  pool: Pool | null;
  curve: (BestLayout | null)[];
  trialsDone: number;
  /**
   * The count the user dragged to, and whether they have. The **knee is not
   * stored**: `epsilon` is a review policy read off the curve (§4.5), so both
   * the knee and the effective count are derived per render — which is what
   * makes a tolerance edit free.
   */
  picked: number | null;
  countPinned: boolean;
  running: boolean;
  progress: PlacementProgress | null;
  blocker: string | null;
  /** `analysisStamp` of the group as the open result was computed (§5.1). */
  analyzedStamp: string | null;
}

const CLOSED: SessionState = {
  slotsActive: false,
  targetGroupId: null,
  pool: null,
  curve: [],
  trialsDone: 0,
  picked: null,
  countPinned: false,
  running: false,
  progress: null,
  blocker: null,
  analyzedStamp: null,
};

export function usePlacement({
  engine,
  cameras,
  constraintGroups,
  constraints,
  grid,
  groupTarget,
  samplingPending,
  aimSessionOpen,
  engineReady,
  fingerprint,
  onApply,
  onReposition,
  onError,
  onNeedsRecompute,
}: UsePlacementArgs): PlacementSession {
  const [state, setState] = useState<SessionState>(CLOSED);
  const abortRef = useRef(false);
  const analysisRef = useRef<AnalysisState | null>(null);
  const [maskSlots, setMaskSlots] = useState(false);

  const groupOf = useCallback(
    (id: string | null) => (id === null ? null : constraintGroups().find((g) => g.id === id) ?? null),
    [constraintGroups],
  );

  /** The group the panel acts on: the explicit target, else the only group. */
  const resolveTarget = useCallback((): ConstraintGroup | null => {
    const groups = constraintGroups();
    const explicit = groupOf(state.targetGroupId);
    if (explicit) return explicit;
    return groups.length > 0 ? groups[0] : null;
  }, [constraintGroups, groupOf, state.targetGroupId]);

  const currentFingerprint = useCallback(
    (group: ConstraintGroup) => {
      const t = groupTarget(group);
      return poolFingerprint({
        ...fingerprint(),
        // A targeted group is invalidated by *its own* zones only, so toggling an
        // unrelated zone to look at something no longer discards a pool (§3.3.1).
        markedRevision: t.zoneNames.length > 0 ? t.markedRevision : fingerprint().markedRevision,
        mountRevision: t.mountRevision,
        near: DEFAULT_TEMPLATE.near,
        far: group.far,
      });
    },
    [fingerprint, groupTarget],
  );

  const closeSession = useCallback(
    (restoreEngine: boolean) => {
      analysisRef.current = null;
      if (restoreEngine) {
        // Handing the engine back the scene's own list is what makes Discard
        // exact rather than an undo: nothing was written to the scene (§5.3).
        engine.setCameras(cameras().map(toCameraConfig));
        onNeedsRecompute();
      }
      setState((s) => ({ ...CLOSED, targetGroupId: s.targetGroupId }));
    },
    [cameras, engine, onNeedsRecompute],
  );

  /**
   * One build step: the six-slot rig at `position`, one incremental `compute()`
   * (§2.1). Returns the reachable set's cubes and the marked total the run saw.
   *
   * `incremental: true` is safe *because* the rig moved: the dirty set is its
   * `old ∪ new` frusta, so every chunk the new position can reach is in it, and
   * a chunk outside holds nothing this rig sees (§2.1).
   */
  const buildStep = useCallback(
    async (group: ConstraintGroup, position: Vec3): Promise<{ chunks: LeafChunk[]; ran: boolean }> => {
      const list = cameras();
      const spec = buildStepSpec(list.length, groupTarget(group).filter);
      if (!engine.setCameras(buildStepCameras(list, group, position))) {
        throw new Error('The engine rejected the capture rig.');
      }
      const chunks: LeafChunk[] = [];
      const g = grid();
      const summary = await engine.compute({
        mode: 1,
        incremental: true,
        aggregate: spec,
        onAggregate: (r) => {
          const chunk = leafChunkFrom(r, g.chunk(r.chunkId));
          if (chunk) chunks.push(chunk);
        },
      });
      // Whether the run *happened* travels separately from what it found: only
      // together do the two say whether this was a failure or a rejection, and
      // `classifyBuildStep` is where they meet (§4.2).
      return { chunks, ran: summary !== null };
    },
    [cameras, engine, grid, groupTarget],
  );

  /**
   * The three session-wide conditions every §10 check shares.
   *
   * A thunk rather than a value because the three are getters: each blocker
   * check has to read them at the moment it runs, or a session that became
   * blocked mid-render would still be reporting the previous answer.
   */
  const blockerOpts = useCallback(
    () => ({
      samplingPending: samplingPending(),
      aimSessionOpen: aimSessionOpen(),
      engineReady: engineReady(),
    }),
    [aimSessionOpen, engineReady, samplingPending],
  );

  const buildPool = useCallback(async () => {
    const group = resolveTarget();
    const blocker = poolBlocker(cameras(), group, constraints(), blockerOpts());
    if (blocker) {
      setState((s) => ({ ...s, blocker }));
      return;
    }
    const target = group!;
    const resolved = groupTarget(target);
    // §4.1.1: with a mount filter the split is by effective measure and a
    // zero-overlap constraint drops out entirely, so the basis — not the raw
    // enabled list — is what everything downstream plans against.
    const basis = drawBasis(target, constraints(), resolved.mountVolumes);
    const active = basis.constraints;
    const shares = poolSplit(basis, target.poolSize);
    const fingerprint = currentFingerprint(target);

    // What of the pool in hand survives this press (§3.3.1). A `rebuild` keeps
    // nothing; an `extend` keeps everything and builds the difference; a
    // `truncate` keeps each constraint's first `share` positions and builds
    // nothing at all.
    const action = buildAction(state.pool, fingerprint, target.poolSize, target.seed);
    const held = action === 'rebuild' ? null : state.pool;
    const keep = action === 'truncate' ? truncatedShares(target, basis) : null;
    const carried: PoolPosition[] = [];
    if (held) {
      const taken = new Map<string, number>();
      for (const p of held.positions) {
        const n = taken.get(p.constraintId) ?? 0;
        if (keep && n >= (keep.get(p.constraintId) ?? 0)) continue;
        taken.set(p.constraintId, n + 1);
        // Re-indexed as it is carried: `index` is the array position every
        // layout's `indices` point at, so a truncation that left gaps would
        // hand the analysis dangling references.
        carried.push({ ...p, index: carried.length });
      }
    }

    // A constraint's share counts **kept** positions, while its sequence has
    // already moved past whatever was rejected (§4.2) — so an extension needs
    // both numbers, or it rebuilds known-bad draws (planning from `kept`) or
    // comes up short by the rejection count (planning from `nextSeq`).
    const heldDraws = new Map<string, HeldDraws>();
    if (held) {
      for (const p of held.positions) {
        const prev = heldDraws.get(p.constraintId) ?? { kept: 0, nextSeq: 0 };
        heldDraws.set(p.constraintId, {
          kept: prev.kept + 1,
          nextSeq: Math.max(prev.nextSeq, p.seqIndex + 1),
        });
      }
      // Carried positions are the ones that count against the share; a
      // truncation's dropped ones do not, but the sequence they consumed still
      // does, so a later extension does not redraw them.
      for (const [id, d] of heldDraws) {
        const kept = carried.filter((p) => p.constraintId === id).length;
        heldDraws.set(id, { kept, nextSeq: d.nextSeq });
      }
    }
    const draws = planDraws(target, basis, heldDraws.size > 0 ? { held: heldDraws } : {});
    const spent = new Map(
      active.map((c, i) => [c.id, Math.max(shares[i], heldDraws.get(c.id)?.nextSeq ?? 0)]),
    );

    abortRef.current = false;
    setMaskSlots(true);
    setState((s) => ({
      ...CLOSED,
      targetGroupId: target.id,
      slotsActive: true,
      running: true,
      // Pressing Build always drops the result: the pool the analysis ran over
      // is exactly what this press is changing (§5.1).
      progress: { phase: 'building', done: 0, total: draws.length, label: '' },
    }));

    const positions: PoolPosition[] = [...carried];
    let rejected = held ? held.rejected : 0;
    const filled = new Map<string, number>();
    for (const p of positions) filled.set(p.constraintId, (filled.get(p.constraintId) ?? 0) + 1);
    const queue = [...draws];

    try {
      while (queue.length > 0) {
        if (abortRef.current) break;
        const draw = queue.shift()!;
        const constraint = active.find((c) => c.id === draw.constraintId)!;
        setState((s) => ({
          ...s,
          progress: {
            // Counted against this press's own work: an extension that builds
            // 60 of 260 reads `43/60`, not `243/60`.
            phase: 'building',
            done: positions.length - carried.length,
            total: draws.length,
            label: constraint.name,
          },
        }));
        const { chunks, ran } = await buildStep(target, draw.position);
        const set = leafSetOf(chunks);
        const outcome = classifyBuildStep(ran, set.count);
        if (outcome === 'failed') {
          throw new Error('The engine could not run the build step — see the status area.');
        }
        if (outcome === 'rejected') {
          // Inside a wall, outside the workspace, sealed in, or beyond every
          // marked zone — all four make the position useless as a mount, so one
          // rule covers them and the sequence advances (§4.2).
          rejected++;
          const share = shares[active.indexOf(constraint)];
          const next = replacementDraw(target, constraint, spent.get(constraint.id) ?? share, share, basis);
          if (next) {
            spent.set(constraint.id, next.seqIndex + 1);
            queue.push(next);
          }
          continue;
        }
        filled.set(constraint.id, (filled.get(constraint.id) ?? 0) + 1);
        positions.push({
          index: positions.length,
          constraintId: draw.constraintId,
          seqIndex: draw.seqIndex,
          position: draw.position,
          set,
          count: set.count,
        });
      }

      // The pool ceiling: what *every* position together reaches, which is what
      // separates "more cameras would not help" from "this pool is too small"
      // (§5.2).
      const bits = new VoxelBitset(grid().gridDims);
      let ceiling = 0;
      for (const p of positions) ceiling += bits.add(p.set);

      const pool: Pool = {
        ...emptyPool(target.id, fingerprint, target.poolSize, target.seed),
        positions,
        rejected,
        emptyConstraints: active.filter((c) => !filled.has(c.id)).map((c) => c.id),
        poolCeiling: ceiling,
        // The app's counted-set size, falling back to the pool's own ceiling
        // before any run has produced one — so a percentage is never divided by
        // zero, and never by a partial.
        markedTotal: resolved.total > 0 ? resolved.total : ceiling,
        overlaps: basis.overlaps,
      };
      setState((s) => ({ ...s, pool, running: false, progress: null }));
    } catch (err) {
      onError(describeError(err));
      closeSession(true);
    }
  }, [
    blockerOpts,
    cameras,
    buildStep,
    closeSession,
    constraints,
    currentFingerprint,
    grid,
    groupTarget,
    onError,
    resolveTarget,
    state.pool,
  ]);

  const runAnalysis = useCallback(async () => {
    const group = resolveTarget();
    const pool = state.pool;
    if (!group || !pool || pool.positions.length === 0) return;

    abortRef.current = false;
    const bits = new VoxelBitset(grid().gridDims);
    const analysis = newAnalysis(pool.positions.length, { maxCount: group.maxCount, seed: group.seed });
    analysisRef.current = analysis;
    // The stamp is taken **now**, from the group the trials are about to run
    // under, so an edit made while they run marks the result stale the moment it
    // lands rather than being silently absorbed (§5.1).
    const stamp = analysisStamp(group);
    setState((s) => ({
      ...s,
      running: true,
      curve: [],
      picked: null,
      // A fresh analysis re-suggests: the count goes back to following the knee
      // whatever the user had dragged to over the last one (§5.2).
      countPinned: false,
      analyzedStamp: stamp,
      progress: { phase: 'choosing', done: 0, total: analysis.maxCount, label: '' },
    }));

    // The greedy pass first, one pick per yield: a step scans the whole pool
    // (§2.3), and running it before the trials is what makes an early Cancel
    // leave a layout with a bound on it rather than a few random draws (§5.1).
    const picks = greedyRemaining(analysis, pool.positions.length);
    for (let done = 0; done < picks; done++) {
      if (abortRef.current) break;
      advanceGreedy(analysis, pool.positions, bits, 1);
      setState((s) => ({
        ...s,
        progress: { phase: 'choosing', done: analysis.greedy.picked.length, total: picks, label: '' },
        // The greedy curve is shown as it fills: it is the answer with the
        // guarantee on it, and a pass over a large pool is not instant.
        curve: [...analysis.best],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Batched with a yield between batches, so Cancel lands and the progress
    // line ticks: a thousand trials is tens of seconds of pure CPU (§2.3).
    for (let done = 0; done < group.trials && !abortRef.current; done += TRIAL_BATCH) {
      const batch = Math.min(TRIAL_BATCH, group.trials - done);
      advanceAnalysis(analysis, pool.positions, bits, batch);
      setState((s) => ({
        ...s,
        progress: { phase: 'analyzing', done: analysis.trialsDone, total: group.trials, label: '' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    setState((s) => ({
      ...s,
      curve: [...analysis.best],
      trialsDone: analysis.trialsDone,
      picked: null,
      countPinned: false,
      running: false,
      progress: null,
    }));
  }, [grid, resolveTarget, state.pool]);

  const cancel = useCallback(() => {
    abortRef.current = true;
  }, []);

  const setTargetGroup = useCallback(
    (groupId: string | null) => {
      // Switching groups drops the pool: it was built at another group's
      // range and drawn from another group's constraints (§3.3.1).
      analysisRef.current = null;
      setState((s) => (s.targetGroupId === groupId ? s : { ...CLOSED, targetGroupId: groupId, slotsActive: s.slotsActive }));
    },
    [],
  );

  const entryBlocker = useCallback(
    (group: ConstraintGroup | null) =>
      poolBlocker(cameras(), group, constraints(), blockerOpts()),
    [blockerOpts, cameras, constraints],
  );

  const setSelected = useCallback((count: number) => {
    // Dragging the slider is the override of §5.2: from here the tolerance moves
    // the marked knee and the readout, and leaves this count alone.
    setState((s) => ({ ...s, picked: count, countPinned: true }));
  }, []);

  const apply = useCallback(
    (plan: PlacementPlan) => {
      const group = resolveTarget();
      if (!group) return;
      if (plan.moves.length === 0 && plan.creates.length === 0 && plan.disables.length === 0) return;
      const ids = cameras().map((c) => c.id);
      const creates: SceneCamera[] = plan.creates.map((c) => {
        const id = nextFreeId('cam', ids);
        ids.push(id);
        return {
          id,
          // Blank when the group has no prefix, which displays as `Camera N`
          // (spec §5.6).
          name: group.namePrefix.trim().length > 0 ? `${group.namePrefix.trim()} ${c.ordinal}` : '',
          enabled: true,
          position: [...c.position] as Vec3,
          // Placement does not aim (§1.3): identity, the same rotation
          // `addCamera` gives a manually added camera.
          rotation: [0, 0, 0, 1],
          fov: group.fov,
          // `aspect`/`near` are placement-wide constants (§3.1.1); only
          // `fov`/`far` come from the group.
          aspect: DEFAULT_TEMPLATE.aspect,
          near: DEFAULT_TEMPLATE.near,
          far: group.far,
          constraintId: c.constraintId,
        };
      });
      onApply({
        // A move writes only what the analysis depended on (§5.3.3): the range
        // is overwritten because the pool was built at it.
        moves: plan.moves.map((m) => ({
          cameraId: m.cameraId,
          position: [...m.position] as Vec3,
          constraintId: m.constraintId,
          near: DEFAULT_TEMPLATE.near,
          far: group.far,
        })),
        creates,
        disables: plan.disables,
      });
      // The camera edit marks the result stale itself, so the session closes
      // without asking for a second recompute (§5.3).
      closeSession(false);
    },
    [cameras, closeSession, onApply, resolveTarget],
  );

  const discard = useCallback(() => {
    abortRef.current = true;
    closeSession(true);
  }, [closeSession]);

  const noteFullRun = useCallback(() => setMaskSlots(false), []);

  const repositionBlocker = useCallback(
    (camera: SceneCamera): string | null =>
      blockReposition(camera, cameras(), constraints(), constraintGroups(), blockerOpts()),
    [blockerOpts, cameras, constraintGroups, constraints],
  );

  const reposition = useCallback(
    async (camera: SceneCamera) => {
      if (repositionBlocker(camera) !== null) return;
      const constraint = constraints().find((c) => c.id === camera.constraintId)!;
      const group = constraintGroups().find((g) => g.id === constraint.groupId)!;
      // One constraint, so `poolSplit` hands it the whole pool budget — and no
      // trials at all: with one camera the layout score *is* the position's own
      // count (§4.6). A reposition honours the group's mount filter for the same
      // reason a build does — it is the same draw (§4.1.1).
      const draws = planDraws(group, soloBasis(constraint, groupTarget(group).mountVolumes));

      abortRef.current = false;
      setMaskSlots(true);
      setState((s) => ({
        ...s,
        slotsActive: true,
        running: true,
        progress: { phase: 'building', done: 0, total: draws.length, label: constraint.name },
      }));

      const samples: PositionSample[] = [];
      try {
        for (const [i, draw] of draws.entries()) {
          if (abortRef.current) break;
          setState((s) => ({
            ...s,
            progress: { phase: 'building', done: i, total: draws.length, label: constraint.name },
          }));
          const { chunks, ran } = await buildStep(group, draw.position);
          const set = leafSetOf(chunks);
          if (classifyBuildStep(ran, set.count) === 'failed') {
            throw new Error('The engine could not run the build step — see the status area.');
          }
          samples.push({ position: draw.position, count: set.count });
        }
      } catch (err) {
        onError(describeError(err));
        closeSession(true);
        return;
      }

      setState((s) => ({ ...s, running: false, progress: null }));
      const best = bestSample(samples);
      if (!best) {
        onError('No sampled position on that constraint could see anything.');
        closeSession(true);
        return;
      }
      onReposition(camera.id, best.position);
      // The camera edit marks the result stale itself, so no second request.
      closeSession(false);
    },
    [
      buildStep,
      closeSession,
      constraintGroups,
      constraints,
      groupTarget,
      onError,
      onReposition,
      repositionBlocker,
    ],
  );

  const group = resolveTarget();
  const blocker =
    state.blocker ??
    poolBlocker(cameras(), group, constraints(), blockerOpts());

  // A pool built before a geometry, resolution, marked-set, or range change
  // describes a scene that no longer exists (§3.3.1). Camera edits are absent
  // from the fingerprint on purpose: they cannot change a reachable set (§1.2).
  // So is `seed` — it changes no scene, so it re-labels Build instead of
  // claiming the one on screen went stale underneath the result (§5.1).
  const stalePool = state.pool !== null && group !== null && state.pool.fingerprint !== currentFingerprint(group);

  // The knee and the count the slider holds, both **derived** (§4.5, §5.2).
  // `epsilon` never entered the trial loop, so this is a scan of the curve
  // already in hand — which is what lets `Knee (pp)` live in the review column
  // and cost nothing: no trials, no GPU, and no stale mark.
  const hasCurve = state.curve.some((b) => b !== null);
  const knee =
    hasCurve && group !== null && state.pool !== null
      ? kneeOf(state.curve, group.epsilon, state.pool.markedTotal)
      : null;
  const selected = selectedCount(state.countPinned, state.picked, knee);

  // A result computed under a `Size` or strategy the group no longer holds is
  // marked, not withdrawn (§5.1): the layout on screen is still a real layout
  // over a real pool, and dropping it would cost a good answer to a nudged Seed.
  const resultStale =
    !state.running &&
    group !== null &&
    state.analyzedStamp !== null &&
    state.curve.some((b) => b !== null) &&
    state.analyzedStamp !== analysisStamp(group);

  // Derived after `selected` rather than memoised beside the state, because the
  // count it reads is itself derived. It is a map over at most `maxCount`
  // indices, so there is nothing here worth memoising.
  const previewPositions =
    state.pool !== null && selected !== null && state.curve[selected - 1]
      ? state.curve[selected - 1]!.indices.map((i) => state.pool!.positions[i]).filter(Boolean)
      : [];

  return {
    slotsActive: state.slotsActive,
    targetGroupId: group?.id ?? null,
    pool: stalePool ? null : state.pool,
    curve: stalePool ? [] : state.curve,
    trialsDone: state.trialsDone,
    knee: stalePool ? null : knee,
    selected: stalePool ? null : selected,
    previewPositions: stalePool ? [] : previewPositions,
    running: state.running,
    progress: state.progress,
    blocker: stalePool && state.pool !== null ? 'The scene changed; rebuild the pool.' : blocker,
    resultStale: stalePool ? false : resultStale,
    // Asked of the pool actually held, not the one the panel is shown: a pool
    // hidden by a moved fingerprint is exactly the one Build must **rebuild**.
    buildAction: group
      ? buildAction(state.pool, currentFingerprint(group), group.poolSize, group.seed)
      : 'build',
    target: group ? groupTarget(group) : null,
    maskSlots,
    busy: state.running || state.slotsActive,
    setTargetGroup,
    entryBlocker,
    buildPool,
    runAnalysis,
    cancel,
    setSelected,
    apply,
    discard,
    noteFullRun,
    repositionBlocker,
    reposition,
  };
}
