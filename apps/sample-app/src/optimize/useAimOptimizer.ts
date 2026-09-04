/**
 * The optimize session as React state (`aim_optimization.md` §3.1, §5, §6).
 *
 * Owns the six capture slots, the per-camera panorama, the proposals, and the
 * cancel/apply lifecycle. Every *decision* comes from `greedy.ts` and
 * `search.ts`; what lives here is the part that has to talk to the engine and to
 * React.
 *
 * The scene is deliberately **not** written while a run is in flight (§6.1):
 * proposals accumulate here and reach the reducer only through `applyAll`.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { emptyProjections, mergeProjections, type Quat } from '@linkervision/camera-coverage-sdk';

import { toCameraConfig, type SceneCamera } from '../cameras/camera.ts';
import type { EngineApi } from '../engine/useEngine.ts';
import type { MarkedFilter } from '../scene/aggregateSpec.ts';
import { buildPanorama, type Panorama } from './panorama.ts';
import { optimizeAims, proposeFor, type AimProposal, type GreedyResult } from './greedy.ts';
import { captureSpec, sessionBlocker, sessionCameras, toOptimizable } from './session.ts';
import { describeError } from '../errorText.ts';

export interface OptimizeProgress {
  round: number;
  index: number;
  total: number;
  /** The camera currently being captured. */
  cameraId: string;
}

export interface AimOptimizer {
  /** True while the capture slots are part of the engine's camera list (§3.1). */
  slotsActive: boolean;
  /** The camera the per-camera panel is previewing, or null (§5). */
  mountId: string | null;
  panorama: Panorama | null;
  /** The single-camera proposal shown in the panel (§5). */
  preview: AimProposal | null;
  /** The whole-scene run's proposals, once it finishes (§6.2). */
  result: GreedyResult | null;
  running: boolean;
  progress: OptimizeProgress | null;
  /** Why the entry points are unavailable, or null (§10). */
  blocker: string | null;
  /** Orientation overrides the viewport draws as ghost gizmos (§5, §6.1). */
  overrides: ReadonlyMap<string, Quat>;
  /** True while the display descriptor must still hide the slots (§3.1). */
  maskSlots: boolean;
  /** True while the app must not start a display run of its own (§3.1, §8.1). */
  busy: boolean;
  /**
   * Whether there is anything for Apply to write.
   *
   * The honest gate, because this is literally what `applyAll` writes. Deriving
   * it from a proposal count instead is how Apply came to be disabled while the
   * session held accepted rotations (§6.2).
   */
  hasProposals: boolean;
  /** An orientation picked off the heatmap, overriding the proposal (§5.1). */
  picked: Quat | null;

  openFor(camera: SceneCamera): Promise<void>;
  runAll(): Promise<void>;
  cancel(): void;
  /** Write every proposal into the scene and close the session (§5, §6.2). */
  applyAll(): void;
  /** Drop every proposal and close the session (§5, §6.2). */
  discard(): void;
  /** Score an arbitrary orientation against the open panorama — free (§5). */
  scoreAt(rotation: Quat): AimProposal | null;
  /**
   * Adopt an orientation the user picked off the heatmap, so Apply writes it
   * instead of the proposal (§5.1). `null` reverts to the proposal.
   */
  pick(rotation: Quat | null): void;
  /** Called when a full (non-incremental) run has completed (§3.1). */
  noteFullRun(): void;
}

export interface UseAimOptimizerArgs {
  engine: EngineApi;
  /** The scene's cameras, live. */
  cameras: () => readonly SceneCamera[];
  /**
   * The display descriptor's marked filter, live (§2.2).
   *
   * The optimizer must score the **counted** set, and only this says what that
   * is: `setSampling` bounds what is *computed* with conservative AABBs, so a
   * capture without the filter would count the slop and the disabled zones.
   */
  marked: () => MarkedFilter;
  /** Whether a sampling edit still awaits a run (§3.1). */
  samplingPending: () => boolean;
  /** Commit accepted orientations to the scene reducer. */
  onApply(rotations: Map<string, Quat>): void;
  /** Report a failure to the §11 status area. */
  onError(message: string): void;
  /**
   * Mark the coverage result stale because a session closed without applying
   * anything (§3.1).
   *
   * Not optional housekeeping: a capture recomputes chunks with the six slots
   * *and* with the camera under optimization at its proposed aim, and the worker
   * retains those masks. Closing without this leaves every panel reading a layout
   * the user just rejected — silently, since the numbers stay plausible.
   */
  onNeedsRecompute(): void;
}

interface SessionState {
  slotsActive: boolean;
  mountId: string | null;
  panorama: Panorama | null;
  preview: AimProposal | null;
  result: GreedyResult | null;
  running: boolean;
  progress: OptimizeProgress | null;
  blocker: string | null;
  picked: Quat | null;
}

const CLOSED: SessionState = {
  slotsActive: false,
  mountId: null,
  panorama: null,
  preview: null,
  result: null,
  running: false,
  progress: null,
  blocker: null,
  picked: null,
};

export function useAimOptimizer({
  engine, cameras, marked, samplingPending, onApply, onError, onNeedsRecompute,
}: UseAimOptimizerArgs): AimOptimizer {
  const [state, setState] = useState<SessionState>(CLOSED);
  // Overrides live in a ref *and* in state: the greedy loop reads them back
  // between cameras, where a React state read would still see the render-time
  // copy, while the viewport needs a value that changes identity to re-render.
  const overridesRef = useRef(new Map<string, Quat>());
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Quat>>(new Map());
  const abortRef = useRef(false);
  /**
   * Stays true from the moment slots exist until the next **full** run clears
   * it. A capture overwrites the worker's retained chunks (spec §3.1), so those
   * masks carry the slots' bits until a full run replaces every one of them —
   * and a re-aggregation in between would count the slots as cameras.
   */
  const [maskSlots, setMaskSlots] = useState(false);
  const maskRef = useRef(false);

  const publishOverrides = useCallback(() => setOverrides(new Map(overridesRef.current)), []);

  const closeSession = useCallback(
    (restoreEngine: boolean) => {
      overridesRef.current = new Map();
      setOverrides(new Map());
      // Handing the engine back the scene's own list is what makes Discard exact
      // rather than an undo: nothing was written to the scene, so the engine and
      // the scene simply agree again (§6.1).
      if (restoreEngine) {
        engine.setCameras(cameras().map(toCameraConfig));
        onNeedsRecompute();
      }
      setState(CLOSED);
    },
    [cameras, engine, onNeedsRecompute],
  );

  /** One capture: six cube cameras at `mount`, one `compute()` (§2.1, §2.3). */
  const capture = useCallback(
    async (mount: SceneCamera): Promise<Panorama> => {
      const list = cameras();
      const spec = captureSpec(list, overridesRef.current, mount, marked());
      if (!engine.setCameras(sessionCameras(list, overridesRef.current, mount))) {
        throw new Error('The engine rejected the capture rig.');
      }
      const merged = emptyProjections(spec.projections!);
      await engine.compute({
        mode: 1,
        incremental: true,
        aggregate: spec,
        onAggregate: (r) => {
          if (r.projections) mergeProjections(merged, r.projections);
        },
      });
      return buildPanorama(merged);
    },
    [cameras, engine, marked],
  );

  const openSession = useCallback(() => {
    maskRef.current = true;
    setMaskSlots(true);
  }, []);

  const openFor = useCallback(
    async (camera: SceneCamera) => {
      const blocker = sessionBlocker(cameras(), samplingPending());
      // "Nothing to optimize" does not stop a preview the user explicitly asked
      // for on one camera; a slot-budget or stale-sampling blocker stops both,
      // because either makes the capture itself wrong.
      if (blocker && !blocker.startsWith('No camera')) {
        setState((s) => ({ ...s, blocker }));
        return;
      }
      openSession();
      setState((s) => ({ ...s, slotsActive: true, running: true, mountId: camera.id, blocker: null, result: null }));
      try {
        const pano = await capture(camera);
        const rotation = overridesRef.current.get(camera.id) ?? camera.rotation;
        const preview = proposeFor(toOptimizable(camera, rotation), pano);
        // Only when it actually moves: an override equal to the camera's own
        // rotation would make `hasProposals` true for a no-op apply.
        if (preview.moved) overridesRef.current.set(camera.id, preview.rotation);
        publishOverrides();
        setState((s) => ({ ...s, panorama: pano, preview, running: false, picked: null }));
      } catch (err) {
        onError(describeError(err));
        closeSession(true);
      }
    },
    [cameras, capture, closeSession, onError, openSession, publishOverrides, samplingPending],
  );

  const runAll = useCallback(async () => {
    const blocker = sessionBlocker(cameras(), samplingPending());
    if (blocker) {
      setState((s) => ({ ...s, blocker }));
      return;
    }
    abortRef.current = false;
    overridesRef.current = new Map();
    publishOverrides();
    openSession();
    setState({ ...CLOSED, slotsActive: true, running: true });

    try {
      const result = await optimizeAims(
        () => cameras().map((c) => toOptimizable(c, overridesRef.current.get(c.id) ?? c.rotation)),
        {
          capture: async (_cam, index) => capture(cameras()[index]),
          apply: (cam, rotation) => {
            overridesRef.current.set(cam.id, rotation);
            publishOverrides();
          },
          onProgress: ({ round, index, total, proposal }) => {
            setState((s) => ({ ...s, progress: { round, index, total, cameraId: proposal.cameraId } }));
          },
          aborted: () => abortRef.current,
        },
      );
      if (result.canceled) closeSession(true);
      else setState((s) => ({ ...s, result, running: false, progress: null }));
    } catch (err) {
      onError(describeError(err));
      closeSession(true);
    }
  }, [cameras, capture, closeSession, onError, openSession, publishOverrides, samplingPending]);

  const cancel = useCallback(() => {
    abortRef.current = true;
  }, []);

  const applyAll = useCallback(() => {
    const rotations = new Map(overridesRef.current);
    // Not `closeSession(true)`: the scene write below is about to change the
    // cameras anyway, and the run it marks stale sets them (spec §8.1).
    closeSession(false);
    if (rotations.size > 0) onApply(rotations);
  }, [closeSession, onApply]);

  const discard = useCallback(() => closeSession(true), [closeSession]);

  const scoreAt = useCallback(
    (rotation: Quat): AimProposal | null => {
      const mount = state.mountId ? cameras().find((c) => c.id === state.mountId) : null;
      if (!state.panorama || !mount) return null;
      return proposeFor(toOptimizable(mount, rotation), state.panorama);
    },
    [cameras, state.panorama, state.mountId],
  );

  const pick = useCallback(
    (rotation: Quat | null) => {
      setState((s) => {
        if (!s.mountId) return s;
        if (rotation) overridesRef.current.set(s.mountId, rotation);
        else if (s.preview?.moved) overridesRef.current.set(s.mountId, s.preview.rotation);
        else overridesRef.current.delete(s.mountId);
        setOverrides(new Map(overridesRef.current));
        return { ...s, picked: rotation };
      });
    },
    [],
  );

  const noteFullRun = useCallback(() => {
    if (!maskRef.current) return;
    maskRef.current = false;
    setMaskSlots(false);
  }, []);

  return useMemo(
    () => ({
      ...state,
      overrides,
      // The slots are in the list right now, or their bits are still in the
      // retained chunks — either way the display must not count them.
      maskSlots: maskSlots || state.slotsActive,
      busy: state.running || state.slotsActive,
      hasProposals: overrides.size > 0,
      openFor,
      runAll,
      cancel,
      applyAll,
      discard,
      scoreAt,
      pick,
      noteFullRun,
    }),
    [state, overrides, maskSlots, openFor, runAll, cancel, applyAll, discard, scoreAt, pick, noteFullRun],
  );
}
