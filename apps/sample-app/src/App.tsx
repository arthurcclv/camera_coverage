/**
 * Layout, engine lifecycle, and state orchestration (spec §2.2).
 * Three.js runs imperatively inside a ref-driven effect; React owns the
 * CameraConfig[] / Probe[] / overlay-option state and pushes it into the scene.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  WorkspaceGrid,
  suggestChunkSizeXZ,
  type AggregateResult,
  type CameraConfig,
  type CoverageSummary,
  type Vec3,
} from '@linkervision/camera-coverage-sdk';

import { type RenderBackend } from './scene/viewport.ts';
import { cameraLabel, toCameraConfig, type SceneCamera } from './cameras/camera.ts';
import { type Probe, type ProbeVisibilityResult } from './scene/probeVisibility.ts';
import {
  sectionClipBand,
  sectionLegendVisible,
  type Section,
  type SectionCellGrid,
} from './scene/sectionHeatmap.ts';
import { chooseHeatmapLegend } from './scene/heatmapLegend.ts';
import { DEFAULT_OVERLAY_HUE, type OverlayOptions } from './scene/coverageOverlay.ts';
import { CoverageRun } from './scene/coverageRun.ts';
import { buildAggregateSpec, capWarningMessage } from './scene/aggregateSpec.ts';
import {
  buildSceneBvh,
  DEFAULT_BOX_LEVEL,
  DEFAULT_ZONE_LEVEL,
  extractZonesAndVolumes,
  regionsFromVolumes,
  type SamplingVolume,
  type Zone,
} from './scene/samplingVolumes.ts';
import {
  DEFAULT_TRANSFORM_SPACE,
  spaceIconKind,
  spaceTooltip,
  toggleSpace,
  type TransformSpace,
} from './scene/transformSpace.ts';
import { canPlace, placeTarget, placeTooltip } from './scene/placement.ts';
import { DEFAULT_INTENSITY_SCALE } from './scene/volumetric.ts';
import { defaultGeometry } from './scene/buildRoom.ts';
import { defaultScene, type Scene } from './scene/sceneModel.ts';
import type { GeometryObject } from './scene/geometryModel.ts';
import {
  buildStaticGeometrySync,
  disposeGeometryBuild,
  type GeometryBuild,
} from './scene/sceneGeometryBuild.ts';
import {
  AssetCopyError,
  copyAssets,
  ensureWritePermission,
  exportSceneToDirectory,
  findExistingAssets,
  importSceneFromDirectory,
  sceneJsonExists,
} from './scene/sceneIO.ts';
import {
  SAVED_STATUS_MS,
  SCENE_PICKER_ID,
  describeAssetCopyFailure,
  describeOverwritePrompt,
  describeSaveFailure,
  describeSceneFileStatus,
  nextSaveTarget,
  planAssetCopy,
  resolveSaveAction,
  type LastSave,
  type SaveIntent,
} from './scene/saveTarget.ts';
import { SceneView, type SceneViewState, type TransformChange } from './scene/sceneView/sceneView.ts';
import { initSceneState, sceneReducer, type EntityKind } from './scene/sceneReducer.ts';
import { displayCoverageSummary, hierarchyPerCamera } from './scene/statsDisplay.ts';
import { engineLoadAction, useEngine } from './engine/useEngine.ts';

import {
  clampDetailHeight,
  DETAIL_HEIGHT_STORAGE_KEY,
  MIN_DETAIL_HEIGHT,
  parseStoredDetailHeight,
  serializeDetailHeight,
} from './ui/leftPanelSplit.ts';
import { SceneHierarchy } from './ui/SceneHierarchy.tsx';
import { CameraPanel } from './ui/CameraPanel.tsx';
import { ProbePanel } from './ui/ProbePanel.tsx';
import { SectionPanel } from './ui/SectionPanel.tsx';
import { OverlayControls } from './ui/OverlayControls.tsx';
import { ViewportLayerMenu } from './ui/ViewportLayerMenu.tsx';
import { ViewSelector } from './ui/ViewSelector.tsx';
import { DEFAULT_VIEW, type CameraViewFit, type ViewId } from './scene/viewCameras.ts';
import { HeatmapLegend } from './ui/HeatmapLegend.tsx';
import { StatsPanel } from './ui/StatsPanel.tsx';
import { SectionStatsPanel } from './ui/SectionStatsPanel.tsx';
import { RunBar } from './ui/RunBar.tsx';
import { SceneFileControls } from './ui/SceneFileControls.tsx';
import { VolumePanel } from './ui/VolumePanel.tsx';
import { ZonePanel } from './ui/ZonePanel.tsx';
import { SamplingVolumeControls } from './ui/SamplingVolumeControls.tsx';
import { MAX_CAMERAS, type Bvh, type Quat } from '@linkervision/camera-coverage-sdk';
import { CAPTURE_SLOTS } from './optimize/cubeRig.ts';
import { displayCameraMask } from './optimize/session.ts';
import type { MarkedFilter } from './scene/aggregateSpec.ts';
import {
  compareCoverage,
  snapshotCoverage,
  type CoverageSnapshot,
  type OptimizeComparison,
} from './optimize/comparison.ts';
import { useAimOptimizer } from './optimize/useAimOptimizer.ts';
import { OptimizePanel } from './ui/OptimizePanel.tsx';
import { CandidatePositionsPanel } from './ui/CandidatePositionsPanel.tsx';
import { StrategyPanel } from './ui/StrategyPanel.tsx';
import { NewCameraDefaultsPanel } from './ui/NewCameraDefaultsPanel.tsx';
import { PlacementReviewPanel } from './ui/PlacementReviewPanel.tsx';
import { ConstraintGroupPanel } from './ui/ConstraintGroupPanel.tsx';
import { ConstraintPanel } from './ui/ConstraintPanel.tsx';
import { usePlacement } from './placement/usePlacement.ts';
import { stepMode, type ModeState } from './placement/mode.ts';
import { EMPTY_PLAN, appliedLabel, boundCameras, planApply } from './placement/assign.ts';
import { DEFAULT_TEMPLATE, type CameraConstraint, type ConstraintGroup } from './placement/region.ts';
import type { ConstraintKind } from './placement/region.ts';
import {
  EMPTY_DRAFT,
  appendVertex,
  commitDraft,
  draftAfterDoubleClick,
  draftPolyline,
  effectiveVertex,
  extendEnd,
  extendInsertAt,
  moveCursor,
  removeLastVertex,
  type PolylineDraft,
  type PolylineEnd,
} from './scene/polylineDraw.ts';

/**
 * One shared empty vertex list, so "no draft vertices" keeps a stable reference
 * and `SceneView`'s per-field diff (which compares by reference) skips the
 * overlay rewrite it would otherwise do on every pointer move.
 */
const EMPTY_VERTICES: readonly Vec3[] = [];

/**
 * Chunk footprint, derived per workspace rather than pinned (SDK spec §3).
 *
 * A fixed 10 m describes a room. On a 440 × 201 × 1120 m site at 1.0 m voxels it
 * gives 4,928 chunks of 20,100 voxels — 50× the chunk count, each 100× smaller —
 * and every per-chunk fixed cost (a GPU buffer set, a submission, a mapping, an
 * aggregate message, a leaf merge) is multiplied by 50 for no per-voxel benefit.
 */
function chunkSizeFor(worldMin: Vec3, worldMax: Vec3, voxelSize: number, numCameras: number): number {
  // `numCameras` is not decoration: the SDK's second clamp is §11.1's host-heap
  // readback budget, which is per camera *word*. A site that fits at 32 cameras
  // does not at 96, and without the count the suggestion would hand `compute()`
  // a chunk the backend then has to reject.
  //
  // The six aim-optimizer capture slots are always counted, open session or not
  // (`aim_optimization.md` §3.1). Sizing chunks for the wider list unconditionally
  // is what keeps opening a session from changing `chunkSizeXZ` — which would
  // trigger the whole §6 re-init pipeline for a preview.
  return suggestChunkSizeXZ(worldMin, worldMax, voxelSize, { numCameras: numCameras + CAPTURE_SLOTS });
}
const DEFAULT_VOXEL_SIZE = 0.5;
const DEBOUNCE_MS = 250;
const AUTO_RUN_MAX_HZ = 10;

/** Human-readable message for a scene-file import/export failure (spec §14.8). */
/**
 * What the union row of a §6.3 comparison is called.
 *
 * With zones off there is no union — the counted set is the whole valid volume,
 * and calling it "All enabled zones" would name something the user did not create.
 */
function unionLabel(state: { useZones: boolean; volumes: unknown[] }): string {
  return state.useZones && state.volumes.length > 0 ? 'All enabled zones' : 'Whole workspace';
}

function describeSceneError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Transform-mode toggle icons (spec §2.4): four-way arrows for Move (translate),
// a circular arrow for Rotate.
function MoveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" />
      <polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </svg>
  );
}

function RotateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

// Scale transform-mode icon (`sampling_volumes.md` §5): a corner-drag arrow with
// a small box, shown only while a volume is selected.
function ScaleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 3 14 10" />
      <polyline points="21 9 21 3 15 3" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

// Transform-space toggle icons (spec §2.4): a cube for local space (gizmo aligned
// to the camera's own axes), a globe for global/world space.
function BoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

// "Place on surface" icon (spec §2.4.2): a crosshair over a receding ground
// plane — the click target on the surface it lands on.
function PlaceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20h18l-4-6H7z" />
      <circle cx="12" cy="8" r="3" />
      <line x1="12" y1="1" x2="12" y2="4" />
      <line x1="12" y1="12" x2="12" y2="15" />
      <line x1="5" y1="8" x2="8" y2="8" />
      <line x1="16" y1="8" x2="19" y2="8" />
    </svg>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const DEFAULT_OVERLAY_OPTIONS: OverlayOptions = {
  visible: true,
  mode: 'coverage',
  overlayHue: DEFAULT_OVERLAY_HUE,
  intensityScale: DEFAULT_INTENSITY_SCALE,
  involvedCameraCount: 10,
};

export function App() {
  // The default scene (spec §14.1) is computed once; `geometryObjects`/`room`
  // (its built render+collision artifact) can later be replaced wholesale by
  // Import/Reset (spec §14.4, §14.7) — see `applyScene` below.
  const initialScene = useMemo(() => defaultScene(), []);
  const [geometryObjects, setGeometryObjects] = useState<GeometryObject[]>(initialScene.geometry);
  const [room, setRoom] = useState<GeometryBuild>(() => buildStaticGeometrySync(initialScene.geometry));
  const engine = useEngine();
  // The merged store of the run's per-chunk aggregation results + the run-
  // generation guard, behind one coordinator (spec §3.3, §12–§13, §14.4). App
  // drives its reset/addResult/clear and reads through it; the overlay (the
  // fourth consumer) stays inline below since SceneView owns it.
  const coverageRun = useMemo(() => new CoverageRun(), []);

  // --- cancellation (SDK spec §13.2): the run currently in flight, so an edit
  // that invalidates it can stop it instead of waiting it out ------------------
  const inFlightRef = useRef<{ controller: AbortController; done: Promise<unknown> } | null>(null);
  /**
   * Whether a re-aggregation (spec §3.3) is in flight. A run started while one is
   * would produce accumulators under a descriptor the store is about to replace,
   * and the two sets would be merged; auto-run's 100 ms poll retries shortly.
   */
  const reaggregatingRef = useRef(false);

  /**
   * Abort the in-flight run and wait for it to unwind. Awaiting matters: the
   * engine's `compute()` is not reentrant, so a new run must not start until the
   * cancelled one has actually left it. A cancelled run resolves to `null`
   * (`useEngine` treats `COMPUTE_CANCELED` as a non-error), so there is nothing
   * to catch — but the guard stays in case the run failed for another reason.
   */
  const cancelInFlight = useCallback(async () => {
    const run = inFlightRef.current;
    if (!run) return;
    inFlightRef.current = null;
    run.controller.abort();
    await run.done.catch(() => {});
  }, []);


  const workspaceCenter = useMemo<Vec3>(
    () => [
      (room.worldMin[0] + room.worldMax[0]) / 2,
      (room.worldMin[1] + room.worldMax[1]) / 2,
      (room.worldMin[2] + room.worldMax[2]) / 2,
    ],
    [room],
  );

  // The editable scene document + its stale/dirty machine live in one pure reducer
  // (`scene/sceneReducer.ts`); App holds the geometry build, run outputs, and
  // engine, and dispatches actions. Destructured so the many read sites below stay
  // unchanged. `clipSectionId` (spec §13.9) is scene-level so at most one section
  // clips; zones/volumes (`sampling_volumes.md` §2), `useZones` gating whether they
  // restrict coverage. The generation levels (§3.4) are tool state below, not part
  // of the document.
  const [sceneState, dispatch] = useReducer(sceneReducer, initialScene, initSceneState);
  const { cameras, probes, sections, clipSectionId, zones, volumes, useZones, selection, collapsedIds, stale, hasRunOnce } = sceneState;
  const { constraintGroups, constraints } = sceneState;
  const [zoneLevel, setZoneLevel] = useState(DEFAULT_ZONE_LEVEL);
  const [boxLevel, setBoxLevel] = useState(DEFAULT_BOX_LEVEL);

  // Zones restrict coverage only when enabled and at least one volume exists
  // (`sampling_volumes.md` §2.2); otherwise the full-volume fallback applies.
  const samplingActive = useZones && volumes.length > 0;

  // Enabled zone ids — for dimming volumes of disabled zones in the viewport (§5).
  const enabledZoneIds = useMemo(() => new Set(zones.filter((z) => z.enabled).map((z) => z.id)), [zones]);
  // Master show/hide-all for the section heatmap layer (viewport toolbar, spec §2.4).
  const [sectionsVisible, setSectionsVisible] = useState(true);
  const [overlayOptions, setOverlayOptions] = useState<OverlayOptions>({
    ...DEFAULT_OVERLAY_OPTIONS,
    involvedCameraCount: cameras.length,
  });
  const [renderBackend, setRenderBackend] = useState<RenderBackend | null>(null);
  const [voxelSize, setVoxelSize] = useState(DEFAULT_VOXEL_SIZE);
  const debouncedVoxelSize = useDebounced(voxelSize, DEBOUNCE_MS);
  const [initializedVoxelSize, setInitializedVoxelSize] = useState<number | null>(null);
  // Read by the scene-load effect (spec §8), which keys on `room` alone so that a
  // resolution change doesn't re-voxelize the workspace outside a run (§6).
  const debouncedVoxelSizeRef = useRef(debouncedVoxelSize);
  debouncedVoxelSizeRef.current = debouncedVoxelSize;

  // The workspace grid a run is computed on (spec §4.2). Also what maps a
  // chunkId back to its origin/dims when feeding the overlay, since an
  // `AggregateResult` carries accumulators and an id, not a place.
  const runGrid = useMemo(
    () =>
      new WorkspaceGrid({
        worldMin: room.worldMin,
        worldMax: room.worldMax,
        voxelSize: debouncedVoxelSize,
        chunkSizeXZ: chunkSizeFor(room.worldMin, room.worldMax, debouncedVoxelSize, cameras.length),
      }),
    [room, debouncedVoxelSize, cameras.length],
  );

  /** §10: an optimizer failure reads as a status-area message, never a crash. */
  const [optimizeError, setOptimizeError] = useState<string | null>(null);

  /**
   * `camera_placement.md` §5.3.3: what Apply placed, and that nothing is aimed.
   *
   * It lives here rather than in the review panel because Apply closes the
   * session — the panel that would carry the line unmounts in the same commit.
   * The status area sits directly above **Optimize all aims**, which is where
   * the line sends the user next.
   */
  const [placementNotice, setPlacementNotice] = useState<string | null>(null);

  // --- aim optimization (`aim_optimization.md` §3.1, §5, §6) ------------------
  // The optimizer drives its own `compute()` calls against a camera list that
  // carries six extra capture slots, so it and the display run must never be in
  // flight together: `optimizer.busy` gates auto-run and the Run button, and the
  // session's own close marks the result stale so the next run reconciles it.
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  // Assigned below, once `aggregate` exists — the hook only ever reads it inside
  // a capture, long after the first render.
  const markedFilterRef = useRef<MarkedFilter>({ regions: [], maskRegions: [] });
  const samplingPendingRef = useRef(false);
  samplingPendingRef.current = sceneState.samplingDirty;
  /** The measured figures an apply is about to change (§6.3). */
  const pendingBeforeRef = useRef<CoverageSnapshot | null>(null);
  const [comparison, setComparison] = useState<OptimizeComparison | null>(null);
  const optimizer = useAimOptimizer({
    engine,
    cameras: useCallback(() => camerasRef.current, []),
    // The counted set, read live: a capture must score over the same exact OBBs
    // the panels count, not the conservative AABBs `setSampling` computes over
    // (`aim_optimization.md` §2.2).
    marked: useCallback(() => markedFilterRef.current, []),
    samplingPending: useCallback(() => samplingPendingRef.current, []),
    onApply: useCallback((rotations: Map<string, Quat>) => {
      // Freeze the *measured* per-zone figures before the write, so the run this
      // dispatch triggers can be diffed against them (`aim_optimization.md` §6.3).
      // Taken here rather than at session open because a capture never feeds
      // `coverageRun` — its results carry the capture descriptor, not the display
      // one — so the store still holds the pre-session numbers either way, and
      // apply time is the moment that cannot be reached without an apply.
      pendingBeforeRef.current = snapshotCoverage(coverageRun.zoneCoverage(stateRef.current.zones));
      // The §5.3.3 line asked for exactly this; it has stopped being true.
      setPlacementNotice(null);
      dispatch({ type: 'applyAims', rotations });
    }, [coverageRun]),
    onError: useCallback((message: string) => setOptimizeError(message), []),
    onNeedsRecompute: useCallback(() => dispatch({ type: 'markStale' }), []),
  });
  const optimizerBusyRef = useRef(optimizer.busy);
  optimizerBusyRef.current = optimizer.busy;
  const noteFullRunRef = useRef(optimizer.noteFullRun);
  noteFullRunRef.current = optimizer.noteFullRun;
  const [hoveredAim, setHoveredAim] = useState<Quat | null>(null);

  // What a built pool is only valid for (`camera_placement.md` §3.3.1). Two
  // monotonic revisions stand in for "the geometry changed" and "the counted set
  // changed": both are identity comparisons on values App already holds, and a
  // counter is what lets the pool's fingerprint be a plain string.
  const runGridRef = useRef(runGrid);
  runGridRef.current = runGrid;
  const geometryRevisionRef = useRef(0);
  const lastRoomRef = useRef(room);
  if (lastRoomRef.current !== room) {
    lastRoomRef.current = room;
    geometryRevisionRef.current += 1;
  }
  const markedRevisionRef = useRef(0);
  const lastMarkedRef = useRef<unknown>(null);
  /** Counted voxels in the marked set, as the panels report it (0 before a run). */
  const markedTotalRef = useRef(0);
  /**
   * Whether the engine holds a loaded scene. `computing` counts: the placement
   * tool's own build steps put the engine there, and a readiness check that went
   * false mid-session would disable the session's own controls.
   */
  const engineReadyRef = useRef(false);
  engineReadyRef.current = engine.state.status === 'ready' || engine.state.status === 'computing';

  // --- camera placement (`camera_placement.md` §3.4, §5) ----------------------
  // Shares the aim optimizer's six capture slots, so the two sessions are
  // mutually exclusive (§3.4) — each blocks the other's entry points.
  const constraintsRef = useRef(constraints);
  constraintsRef.current = constraints;
  const constraintGroupsRef = useRef(constraintGroups);
  constraintGroupsRef.current = constraintGroups;
  const [placementError, setPlacementError] = useState<string | null>(null);
  const placement = usePlacement({
    engine,
    cameras: useCallback(() => camerasRef.current, []),
    constraintGroups: useCallback(() => constraintGroupsRef.current, []),
    constraints: useCallback(() => constraintsRef.current, []),
    grid: useCallback(() => runGridRef.current, []),
    marked: useCallback(() => markedFilterRef.current, []),
    samplingPending: useCallback(() => samplingPendingRef.current, []),
    // The counted set's size, from the app's own display numbers — the same
    // denominator the stats panel quotes, so the two rates are comparable
    // (`camera_placement.md` §5.2).
    markedTotal: useCallback(() => markedTotalRef.current, []),
    aimSessionOpen: useCallback(() => optimizerBusyRef.current, []),
    // A build step does not go through the Run gate, so it needs its own readiness
    // check: the engine holds no scene until `initAndLoad` resolves (§10).
    engineReady: useCallback(() => engineReadyRef.current, []),
    // Camera edits are deliberately absent: they cannot change a reachable set,
    // which is what makes place → aim → measure → re-search cheap (§3.3.1).
    fingerprint: useCallback(
      () => ({
        geometryRevision: geometryRevisionRef.current,
        voxelSize: runGridRef.current.voxelSize,
        markedRevision: markedRevisionRef.current,
      }),
      [],
    ),
    onApply: useCallback(
      (plan: {
        moves: { cameraId: string; position: Vec3; constraintId: string; near: number; far: number }[];
        creates: SceneCamera[];
        disables: string[];
      }) => {
        dispatch({ type: 'applyPlacement', ...plan });
      },
      [],
    ),
    onReposition: useCallback((cameraId: string, position: Vec3) => {
      // A plain camera position edit, so the reducer's clamp and its stale rule
      // both apply exactly as they would to a gizmo drag (§4.6, §6.3).
      dispatch({ type: 'changeCamera', id: cameraId, patch: { position } });
    }, []),
    onError: useCallback((message: string) => setPlacementError(message), []),
    onNeedsRecompute: useCallback(() => dispatch({ type: 'markStale' }), []),
  });
  const placementBusyRef = useRef(placement.busy);
  placementBusyRef.current = placement.busy;

  /**
   * The placement **mode** (`camera_placement.md` §5): open on one group, with
   * the tool's inputs replacing the left column and its review the right.
   *
   * The transitions are pure (`placement/mode.ts`) so the close guard and the
   * "a running build step is not closeable" rule are testable without React; this
   * holds the state and carries out the one effect the reducer can ask for.
   */
  const [placementMode, setPlacementMode] = useState<ModeState>(null);
  const placementModeRef = useRef<ModeState>(null);
  placementModeRef.current = placementMode;
  const placementDiscardRef = useRef(placement.discard);
  placementDiscardRef.current = placement.discard;
  const dispatchMode = useCallback(
    (event: Parameters<typeof stepMode>[1]) => {
      const step = stepMode(placementModeRef.current, event);
      if (step.effect === 'closeSession') placementDiscardRef.current();
      placementModeRef.current = step.state;
      setPlacementMode(step.state);
    },
    [],
  );
  const placementNoteFullRunRef = useRef(placement.noteFullRun);
  placementNoteFullRunRef.current = placement.noteFullRun;

  /**
   * The polyline vertex sub-selection (`camera_placement.md` §6.1), carrying the
   * constraint it belongs to.
   *
   * Pairing the index with its polyline is what makes "a sub-selection belongs to
   * one constraint" a property of the data rather than an effect that clears it:
   * an index held from another polyline is simply not this polyline's, so it
   * resolves to the default (its last vertex) with nothing to fire in between.
   * An effect could not do this job — a click that picks a handle on an
   * unselected polyline sets both in one batch, and a clear-on-selection-change
   * effect would run afterwards and undo the half the user aimed at.
   */
  const [vertexSelection, setVertexSelection] = useState<{ id: string; vertex: number } | null>(null);
  /**
   * The armed **Extend** (§6.2): which polyline each click grows, and at which
   * end. Separate from `drawing` because there is no draft — every click is a
   * committed edit on an existing constraint.
   */
  const [extending, setExtending] = useState<{ id: string; end: PolylineEnd } | null>(null);
  /** The armed polyline draw mode and its in-progress draft (§6.2). */
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<PolylineDraft>(EMPTY_DRAFT);
  // Read by the double-click end, which fires before an effect could hand it the
  // newest draft (see `endDrawing`).
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Everything the UI derives from a run, as one SDK aggregation descriptor
  // (spec §3.3) plus the index that reads its results back. Zones, volumes,
  // sections, probes, and the marked filter all live in here — which is what
  // keeps a zone's group index and the group its numbers are read from in step.
  const aggregate = useMemo(
    () => buildAggregateSpec({ grid: runGrid, zones, volumes, sections, probes, samplingActive }),
    [runGrid, zones, volumes, sections, probes, samplingActive],
  );
  // Session-only capture slots hold real mask bits, and `covered`, the column
  // extrema and `leafCounts.count` are SDK-side popcounts the app cannot filter
  // afterwards. So the descriptor names which bits count (`aim_optimization.md`
  // §3.1). Applied to a *copy*: `aggregate` is memoized on the scene, and the
  // mask changes with the session, not with the scene.
  const maskedAggregate = useMemo(() => {
    // Either session's slots must be masked out of every display number: they
    // are the same six bits (`aim_optimization.md` §3.1, `camera_placement.md`
    // §3.4), and a retained chunk carries them until a full run replaces it.
    const cameraMask = displayCameraMask(cameras, optimizer.maskSlots || placement.maskSlots);
    if (!cameraMask) return aggregate;
    return { ...aggregate, spec: { ...aggregate.spec, cameras: cameraMask } };
  }, [aggregate, cameras, optimizer.maskSlots, placement.maskSlots]);
  // `handleRun` reads the descriptor through a ref so it is not re-created on
  // every descriptor edit — it is deliberately non-reentrant, and a new identity
  // per edit would re-arm the auto-run effect that calls it.
  const aggregateRef = useRef(maskedAggregate);
  aggregateRef.current = maskedAggregate;
  markedFilterRef.current = aggregate.index.markedFilter;
  if (lastMarkedRef.current !== aggregate.index.markedFilter) {
    lastMarkedRef.current = aggregate.index.markedFilter;
    markedRevisionRef.current += 1;
  }

  // §3.3 over-cap drops. A warning, never an error (§11): the descriptor is
  // still valid and every other panel still reads, so the run proceeds and the
  // status area names what was left out.
  const capWarnings = useMemo(
    () => aggregate.warnings.map(capWarningMessage),
    [aggregate.warnings],
  );

  const [summary, setSummary] = useState<CoverageSummary | null>(null);
  const [autoRun, setAutoRun] = useState(true);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [transformSpace, setTransformSpace] = useState<TransformSpace>(DEFAULT_TRANSFORM_SPACE);
  // Whether "Place on surface" is armed (spec §2.4.2). Transient viewport state,
  // never persisted; one-shot, so a delivered hit clears it.
  const [placing, setPlacing] = useState(false);
  const [gizmosVisible, setGizmosVisible] = useState(true);
  // Master show/hide-all for the sampling-volume gizmos (viewport toolbar, spec
  // §2.4). Purely visual — independent of `useZones` and per-zone enabled state.
  const [zonesVisible, setZonesVisible] = useState(true);
  // Master show/hide-all for the constraint gizmos and the pool scatter
  // (`camera_placement.md` §5.2, §6.1). Purely visual: constraints are not
  // analysis inputs, so hiding them cannot change a number.
  const [constraintsVisible, setConstraintsVisible] = useState(true);
  // Per-probe visibility queries against the retained run (spec §12.2), keyed by
  // probe id. Recomputed when probes move or a new run's masks arrive.
  const [probeQueries, setProbeQueries] = useState<Map<string, ProbeVisibilityResult>>(new Map());
  // Bumped whenever a completed run replaces the retained masks (spec §12.2).
  const [masksVersion, setMasksVersion] = useState(0);
  // Flips true once the async Three.js viewport setup completes (spec §2.3); a
  // geometry swap (import/reset) needs this in its dependency array so the
  // group-sync effect below can add the initial geometry once the viewport
  // actually exists (see the mount effect further down).
  const [viewportReady, setViewportReady] = useState(false);
  // Active viewport view (top-middle View selector, spec §2.4). Transient UI
  // state — not persisted to the scene file; resets to Perspective on load.
  const [activeView, setActiveView] = useState<ViewId>(DEFAULT_VIEW);
  // The Selected view's frame guide (spec §2.4.1), as fractions of the viewport,
  // published by SceneView from the same fit that set the rendered FOV; null
  // whenever that view is not active.
  const [cameraGuide, setCameraGuide] = useState<CameraViewFit['guide'] | null>(null);
  // Scene-file import/export state (spec §14.7, §14.8).
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [sceneIOBusy, setSceneIOBusy] = useState(false);
  // The save target (spec §14.5): the folder the current scene was opened from
  // (or last saved to via Save As…), so a plain Save round-trips back there
  // instead of following the browser's last-used directory. Session-only — a
  // reload returns to the boot scene with no target (§14.1).
  const [saveTarget, setSaveTarget] = useState<FileSystemDirectoryHandle | null>(null);
  const [lastSave, setLastSave] = useState<LastSave | null>(null);
  const savedStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileSystemAccessAvailable = useMemo(() => typeof window !== 'undefined' && 'showDirectoryPicker' in window, []);

  const selectedCameraId = selection?.kind === 'camera' ? selection.id : null;
  const selectedProbeId = selection?.kind === 'probe' ? selection.id : null;
  const selectedSectionId = selection?.kind === 'section' ? selection.id : null;
  const selectedZoneId = selection?.kind === 'zone' ? selection.id : null;
  const selectedVolumeId = selection?.kind === 'volume' ? selection.id : null;
  const selectedConstraintGroupId = selection?.kind === 'constraintGroup' ? selection.id : null;
  const selectedConstraintId = selection?.kind === 'constraint' ? selection.id : null;

  /**
   * The selected polyline and the vertex every editor acts on (§6.1).
   *
   * A polyline **always has one vertex selected**, so the raw sub-selection is
   * *resolved* here: unset, another polyline's, or out of range all mean its last
   * vertex. One clamp then covers a freshly selected polyline, a deleted vertex
   * (the index falls on whichever vertex took its place, or on the new last), and
   * a scene load that shortened the polyline under a held index — and the panel,
   * the Move gizmo, and Place on surface cannot disagree about which vertex they
   * are on, because there is only this one answer.
   */
  const selectedPolyline = useMemo(() => {
    const c = selectedConstraintId ? constraints.find((x) => x.id === selectedConstraintId) : undefined;
    return c?.kind === 'polyline' ? c : null;
  }, [constraints, selectedConstraintId]);
  const activeVertex = useMemo(() => {
    if (!selectedPolyline) return null;
    const held = vertexSelection?.id === selectedPolyline.id ? vertexSelection.vertex : null;
    return effectiveVertex(selectedPolyline.points.length, held);
  }, [selectedPolyline, vertexSelection]);

  // Left-column hierarchy/detail split (spec §2.2): null = detail at natural
  // height until first dragged; a number pins its height (hierarchy takes the
  // rest). Initialized from and persisted to localStorage.
  const [detailHeight, setDetailHeight] = useState<number | null>(() =>
    parseStoredDetailHeight(
      typeof localStorage === 'undefined' ? null : localStorage.getItem(DETAIL_HEIGHT_STORAGE_KEY),
    ),
  );
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const detailPanelRef = useRef<HTMLDivElement | null>(null);
  const dividerDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const serialized = serializeDetailHeight(detailHeight);
    if (serialized == null) localStorage.removeItem(DETAIL_HEIGHT_STORAGE_KEY);
    else localStorage.setItem(DETAIL_HEIGHT_STORAGE_KEY, serialized);
  }, [detailHeight]);

  const onDividerPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dividerDragRef.current = {
      startY: e.clientY,
      startHeight: detailPanelRef.current?.offsetHeight ?? MIN_DETAIL_HEIGHT,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onDividerPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dividerDragRef.current;
    const column = leftPanelRef.current;
    if (!drag || !column) return;
    // Drag up → taller detail panel; clamp against the column so the hierarchy
    // keeps its minimum height (spec §2.2).
    const raw = drag.startHeight + (drag.startY - e.clientY);
    setDetailHeight(clampDetailHeight(raw, column.clientHeight));
  }, []);

  const onDividerPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dividerDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  // Mirrors `room` for the mount effect's async IIFE (spec §2.3), which reads
  // whatever geometry is current by the time the viewport finishes setting up,
  // and for `applyScene`, which disposes the outgoing build.
  const roomRef = useRef(room);
  roomRef.current = room;
  // The `room` the engine was last `initAndLoad`-ed against; `handleRun` forces
  // a re-init when this no longer matches, so a geometry swap (import/reset)
  // isn't masked by voxel size staying the same (spec §14.4).
  const initializedRoomRef = useRef<GeometryBuild | null>(null);
  // `initializedVoxelSize` as a ref: `ensureLoaded` runs outside render and must
  // see the value its own last call committed, not the one React has re-rendered
  // with — otherwise a run firing in the same tick as the scene-load effect reads
  // `null` and issues a second `init`.
  const initializedVoxelSizeRef = useRef<number | null>(null);
  /**
   * The `initAndLoad` currently in flight, keyed by what it is loading (spec §8).
   *
   * The engine is loaded from two places — the scene-load effect below and
   * `handleRun` — so this is what makes the load single-flight: a second request
   * for the same `(room, voxelSize)` pair awaits the first instead of starting a
   * concurrent `init`.
   */
  const engineLoadRef = useRef<{ epoch: number; room: GeometryBuild; voxelSize: number; promise: Promise<boolean> } | null>(
    null,
  );
  /** The worker instance the two refs above describe (`useEngine`'s epoch, spec §8). */
  const initializedEpochRef = useRef(0);
  // The run-generation guard now lives on `coverageRun`: `applyScene` bumps it via
  // `coverageRun.clear()` and `handleRun` snapshots `coverageRun.generation`,
  // discarding a run whose token is no longer current — the in-scope stand-in for
  // "cancel any in-flight compute" (spec §14.4), since the engine exposes no true
  // cancellation primitive today.
  // The async run path (`handleRun`) reads the latest scene document across
  // awaits; mirror the whole reducer state into one ref (replacing the old
  // per-field mirrors). `samplingDirty` now rides on this state, not a ref.
  const stateRef = useRef(sceneState);
  stateRef.current = sceneState;
  // Cached app-side BVH (§3.1), keyed on the `room` it was built from; rebuilt
  // lazily on the next Generate after a geometry swap (§11).
  const bvhRef = useRef<{ room: GeometryBuild; bvh: Bvh } | null>(null);

  const estimatedVoxelCount = useMemo(() => {
    const [x0, y0, z0] = room.worldMin;
    const [x1, y1, z1] = room.worldMax;
    const volume = (x1 - x0) * (y1 - y0) * (z1 - z0);
    return Math.round(volume / voxelSize ** 3);
  }, [room, voxelSize]);

  // --- per-section cell grids (spec §13.3, §13.4): recomputed from the
  // retained run whenever a section's own fields change or a new run replaces
  // the retained masks. Computed for every section (not just visible ones), so
  // hierarchy badges and the stats panel stay live regardless of the per-
  // section visibility checkbox. ---------------------------------------------
  const sectionCellGrids = useMemo(
    () => coverageRun.sectionCells(sections),
    // `masksVersion` covers the descriptor too: a section or marked-filter edit
    // changes the descriptor, which re-aggregates, which bumps it (spec §3.3).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, masksVersion, coverageRun],
  );

  // --- per-zone coverage aggregation (`sampling_volumes.md` §7.2): recomputed
  // from the retained run whenever zone membership/enabled or a new run replaces
  // the retained masks. Per-zone stats are broken out for every zone; the
  // enabled-union drives the overlay/main stats (§7.3, §7.4). --------------------
  const zoneCoverage = useMemo(
    () => coverageRun.zoneCoverage(zones),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zones, volumes, masksVersion, coverageRun],
  );
  const enabledUnionSummary = zoneCoverage?.enabledUnion ?? null;
  // The placement panel's denominator (`camera_placement.md` §5.2): the enabled
  // zones' union when zones are in use, else the whole run's valid volume — the
  // same figure the stats panel divides by, so the two rates are comparable.
  markedTotalRef.current = samplingActive
    ? enabledUnionSummary?.validVoxels ?? 0
    : summary?.validVoxels ?? 0;

  // Apply a resolved transform edit emitted by SceneView after a drag (spec
  // §12.4, §13.8). Mirrors the old per-kind `onObjectChange` setters; whether an
  // edit marks the result stale is governed by which state it touches (a probe or
  // section never does — spec §12.5, §13.4 — via the stale effects below).
  const applyTransformChange = useCallback((change: TransformChange) => {
    dispatch({ type: 'transformApplied', change });
  }, []);

  // Apply a "Place on surface" hit (spec §2.4.2): the clicked point becomes the
  // selected entity's position, routed through the same action any other position
  // edit uses — so a camera placement marks the result stale (§5.4, §8.1) and a
  // probe placement does not (§12.5), with no rule restated here. The tool is
  // one-shot, so a delivered point disarms it; a miss emits nothing at all and
  // leaves it armed.
  const applyPlacement = useCallback(
    (point: Vec3) => {
      const target = placeTarget(selection, activeVertex);
      if (!target) return;
      switch (target.kind) {
        case 'camera':
          dispatch({ type: 'changeCamera', id: target.id, patch: { position: point } });
          break;
        case 'probe':
          dispatch({ type: 'changeProbe', id: target.id, position: point });
          break;
        // A polyline vertex, the one target that is a sub-selection rather than
        // an entity (`camera_placement.md` §6.2). The same action a handle drag
        // and a numeric commit use, so the §6.3 clamp applies identically.
        case 'vertex':
          dispatch({ type: 'moveConstraintVertex', id: target.id, vertex: target.vertex, position: point });
          break;
        default: {
          // Exhaustive over PlaceTarget: widening that union fails to compile
          // here until the new target is given its own action (spec §2.4.2).
          const unhandled: never = target;
          throw new Error(`unhandled place target: ${JSON.stringify(unhandled)}`);
        }
      }
      setPlacing(false);
    },
    [selection, activeVertex],
  );

  // --- SceneView: the imperative Three.js bridge, created once (spec §2.3).
  // `WebGPURenderer.init()` is async, so creation runs in an async IIFE with a
  // cancel guard. App pushes state in through one `sync()` effect below and gets
  // resolved selection/transform events back via the registered callbacks; the
  // ~21 mirror refs and the fan-out effects this replaced now live in SceneView.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    (async () => {
      const view = await SceneView.create(container, setCameraGuide);
      if (cancelled) {
        view.dispose();
        return;
      }
      // Picking is inert in the placement mode (§5): the inspector that would
      // show the picked entity is hidden, so a selection change there is a
      // silent state edit the user cannot see.
      view.onSelect((next, vertex) => {
        if (placementModeRef.current) return;
        dispatch({ type: 'selectionChanged', selection: next });
        // One click decides both (`camera_placement.md` §6.1): a handle hit names
        // the vertex, a body hit names none and falls back to the last.
        setVertexSelection(
          vertex === null || next?.kind !== 'constraint' ? null : { id: next.id, vertex },
        );
      });
      view.onTransform(applyTransformChange);
      viewRef.current = view;
      setRenderBackend(view.renderBackend);
      setViewportReady(true);
    })();

    return () => {
      cancelled = true;
      viewRef.current?.dispose();
      viewRef.current = null;
      setViewportReady(false);
    };
    // Created once (spec §2.3); state changes are pushed into the running view by
    // the sync effect below instead of re-running this setup.
  }, [applyTransformChange]);

  // --- clip band along the clipping section's normal (spec §13.9), or null.
  // Pure and derived: recomputed on clip selection, section drag, or geometry
  // swap, then applied to the geometry by SceneView.sync (which rebuilds the
  // ClippingGroup on a room swap). Never triggers compute(). -------------------
  const clipBand = useMemo(() => {
    const clipped = clipSectionId ? sections.find((s) => s.id === clipSectionId) : undefined;
    return clipped ? sectionClipBand(clipped, room.worldMin, room.worldMax) : null;
  }, [clipSectionId, sections, room]);

  // --- the Selected view exists only for a selected camera (spec §2.4.1): if the
  // selection stops being one — a probe/section/zone/volume, or a clear — the
  // viewport reverts to Perspective, so an active Selected view always implies a
  // selected camera and there is no empty state to render. -------------------
  useEffect(() => {
    if (activeView === 'camera' && !selectedCameraId) setActiveView(DEFAULT_VIEW);
  }, [activeView, selectedCameraId]);

  // The Selected row is the one view that can be unavailable (spec §2.4.1).
  const disabledViews = useMemo<ReadonlyMap<ViewId, string>>(
    () => (selectedCameraId ? new Map() : new Map([['camera', 'Select a camera to use this view'] as const])),
    [selectedCameraId],
  );

  const enabledCameraCount = cameras.filter((c) => c.enabled).length;

  useEffect(() => {
    setOverlayOptions((o) => ({ ...o, involvedCameraCount: enabledCameraCount }));
  }, [enabledCameraCount]);

  // --- mark results stale when the resolution (debounced voxel size) changes
  // after the first run (spec §8.1). Camera and volume/useZones edits mark stale
  // (and sampling-dirty) inside the reducer transition; only the debounced voxel
  // size is App state outside it, so it dispatches here. `markStale` is a no-op
  // until the first run (`hasRunOnce`), so the initial mount fire is harmless. --
  useEffect(() => {
    dispatch({ type: 'markStale' });
  }, [debouncedVoxelSize]);

  // --- probe visibility queries (spec §12.2): recompute for every probe when a
  // probe moves or a completed run replaces the retained masks -----------------
  useEffect(() => {
    setProbeQueries(coverageRun.probeQueries(probes));
  }, [probes, masksVersion, coverageRun]);

  // --- sightlines from the selected probe to each camera that sees it (§12.4).
  // Derived (recomputed on probe selection, its query, or a camera move) and
  // applied by SceneView.sync; a null result clears them. ---------------------
  const sightlines = useMemo<{ from: Vec3; targets: Vec3[] } | null>(() => {
    if (selection?.kind !== 'probe') return null;
    const probe = probes.find((p) => p.id === selection.id);
    const query = probeQueries.get(selection.id);
    if (!probe || !query || query.status !== 'ok') return null;
    const targets: Vec3[] = [];
    query.cameraIds.forEach((id, n) => {
      if (!query.visible[n]) return;
      const cam = cameras.find((c) => c.id === id);
      if (cam) targets.push(cam.position);
    });
    return { from: probe.position, targets };
  }, [selection, probeQueries, probes, cameras]);

  // --- the SceneView snapshot (spec §2.4, §5, §9, §12.4, §13): one immutable
  // bundle of everything the scene reflects. Every field is stable React state or
  // useMemo output, so SceneView's per-field diff runs each imperative op on
  // exactly the input it used to key its own effect on. -----------------------
  /**
   * The cameras the viewport draws: the scene's, with the optimizer's proposals
   * and any hovered orientation layered over them (`aim_optimization.md` §5,
   * §6.1).
   *
   * Preview is *this*, rather than a second set of ghost gizmos: a camera drawn
   * at its proposed aim is the thing being decided, and drawing both frusta at
   * one position reads as two cameras. The scene state stays untouched either
   * way, which is what makes Discard exact.
   */
  const previewCameras = useMemo(() => {
    if (optimizer.overrides.size === 0 && !hoveredAim) return cameras;
    return cameras.map((c) => {
      if (hoveredAim && c.id === optimizer.mountId) return { ...c, rotation: hoveredAim };
      const rotation = optimizer.overrides.get(c.id);
      return rotation ? { ...c, rotation } : c;
    });
  }, [cameras, optimizer.overrides, optimizer.mountId, hoveredAim]);

  /**
   * The §5.3 plan the Apply button carries and the viewport previews.
   *
   * Derived here rather than inside the session hook because it is a function of
   * the **live** camera list: the hook reads cameras through a ref, so a plan
   * built there would label the button from a stale scene.
   */
  /** The group the mode is open on, or null (`camera_placement.md` §5). */
  const placementGroup = useMemo(
    () => (placementMode ? constraintGroups.find((g) => g.id === placementMode.groupId) ?? null : null),
    [constraintGroups, placementMode],
  );
  const placementOpen = placementMode !== null && placementGroup !== null;

  /**
   * Open the mode on a group (§5.1).
   *
   * Every viewport tool is disarmed on the way in — Place, Draw, and Extend:
   * their toolbar and panel are hidden in the mode, and an armed tool the user
   * cannot see would still consume the first click in the viewport (spec §2.4.2,
   * `camera_placement.md` §6.2).
   */
  const handlePlaceCameras = useCallback(
    (groupId: string) => {
      setPlacing(false);
      setDrawing(false);
      setExtending(null);
      setDraft(EMPTY_DRAFT);
      setPlacementError(null);
      setPlacementNotice(null);
      placement.setTargetGroup(groupId);
      dispatchMode({ type: 'open', groupId });
    },
    [dispatchMode, placement.setTargetGroup],
  );

  // A group deleted or replaced under an open mode (a scene load) leaves nothing
  // to place on, so the mode closes and the session with it.
  useEffect(() => {
    if (placementMode !== null && placementGroup === null) dispatchMode({ type: 'groupGone' });
  }, [dispatchMode, placementGroup, placementMode]);

  const placementPlan = useMemo(() => {
    const group = constraintGroups.find((g) => g.id === placement.targetGroupId);
    if (!group || placement.previewPositions.length === 0) return EMPTY_PLAN;
    const groupConstraintIds = new Set(
      constraints.filter((c) => c.groupId === group.id).map((c) => c.id),
    );
    return planApply(
      boundCameras(cameras, groupConstraintIds).map((c) => ({ id: c.id, position: c.position })),
      placement.previewPositions.map((p) => ({ position: p.position, constraintId: p.constraintId })),
    );
  }, [cameras, constraintGroups, constraints, placement.previewPositions, placement.targetGroupId]);

  /** Where each moved camera stands today → where the plan sends it (§5.2). */
  const placementMoveLines = useMemo(() => {
    const byId = new Map(cameras.map((c) => [c.id, c.position]));
    return placementPlan.moves
      .map((m) => ({ from: byId.get(m.cameraId), to: m.position }))
      .filter((l): l is { from: Vec3; to: Vec3 } => l.from !== undefined);
  }, [cameras, placementPlan]);

  /**
   * The cameras a placement preview adds to the viewport (`camera_placement.md`
   * §5.2): the previewed layout drawn at the group's template, with the app's
   * default rotation — because placement does not aim (§1.3).
   *
   * Not written to the scene until Apply, which is what makes Discard exact.
   */
  const placementPreviewCameras = useMemo<SceneCamera[]>(() => {
    const group = constraintGroups.find((g) => g.id === placement.targetGroupId);
    if (!group || placementPlan.creates.length === 0) return [];
    // Only the **created** cameras are new bodies. A moved camera is one the
    // scene already draws, so it is previewed by moving it (below) rather than
    // by a ghost beside it — at one mount point two bodies read as two cameras.
    return placementPlan.creates.map((c) => ({
      id: `placement-preview-${c.ordinal}`,
      name: group.namePrefix.trim().length > 0 ? `${group.namePrefix.trim()} ${c.ordinal}` : `Proposed ${c.ordinal}`,
      enabled: true,
      position: c.position,
      rotation: [0, 0, 0, 1] as Quat,
      fov: group.fov,
      aspect: DEFAULT_TEMPLATE.aspect,
      near: DEFAULT_TEMPLATE.near,
      far: group.far,
    }));
  }, [constraintGroups, placementPlan, placement.targetGroupId]);

  const poolPositions = useMemo(
    () => placement.pool?.positions.map((p) => ({ position: p.position, count: p.count })) ?? [],
    [placement.pool],
  );
  const chosenPoolIndices = useMemo(
    () => new Set(placement.previewPositions.map((p) => p.index)),
    [placement.previewPositions],
  );
  /**
   * The overlay the armed tool draws (§6.2): a draft polyline while
   * drawing, and while extending the rubber band alone — from the end being
   * grown to the cursor, since the polyline itself is already drawn as a
   * constraint.
   */
  const draftPoints = useMemo(() => {
    if (extending && selectedPolyline) {
      const points = selectedPolyline.points;
      const anchor = extending.end === 'start' ? points[0] : points[points.length - 1];
      return anchor && draft.cursor ? [anchor, draft.cursor] : [];
    }
    return drawing ? draftPolyline(draft) : [];
  }, [drawing, draft, extending, selectedPolyline]);
  /**
   * The vertices the draft draws as dots (§6.2): the ones actually clicked, so
   * the first click is visible before there is a second to draw a line to.
   * Empty while extending — those vertices are committed the moment they are
   * clicked, so the constraint's own handles already draw them.
   */
  const draftVertices = useMemo(
    () => (drawing && !extending ? draft.points : EMPTY_VERTICES),
    [drawing, extending, draft],
  );

  const sceneViewState = useMemo<SceneViewState>(
    () => ({
      room,
      // The proposed layout rides along as extra camera gizmos, so the user can
      // judge it in the viewport before Apply (`camera_placement.md` §5.2).
      cameras: placementPreviewCameras.length > 0 ? [...previewCameras, ...placementPreviewCameras] : previewCameras,
      probes,
      sections,
      volumes,
      // Nothing in the scene is selectable in the placement mode (§5), so the
      // transform gizmo detaches with it — and the selection the mode was
      // entered from comes straight back on exit, unwritten.
      selection: placementOpen ? null : selection,
      flaggedCameras: engine.state.flaggedCameras,
      sectionCellGrids,
      enabledZoneIds,
      overlayOptions,
      transformMode,
      transformSpace,
      activeView,
      gizmosVisible,
      zonesVisible,
      sectionsVisible,
      stale,
      voxelSize,
      clipBand,
      sightlines,
      placing,
      constraints,
      selectedVertex: activeVertex,
      constraintsVisible,
      poolPositions,
      chosenPoolIndices,
      // Extend is the same armed tool as far as the viewport is concerned: the
      // crosshair, the detached gizmo, and the draw-click routing (§6.2).
      drawing: drawing || extending !== null,
      draftPolyline: draftPoints,
      draftVertices,
      placementMoves: placementMoveLines,
    }),
    [
      room, previewCameras, placementPreviewCameras, probes, sections, volumes, selection, placementOpen,
      engine.state.flaggedCameras,
      sectionCellGrids, enabledZoneIds, overlayOptions, transformMode,
      transformSpace, activeView, gizmosVisible, zonesVisible, sectionsVisible, stale,
      voxelSize, clipBand, sightlines, placing,
      constraints, activeVertex, constraintsVisible, poolPositions, chosenPoolIndices,
      drawing, extending, draftPoints, draftVertices, placementMoveLines,
    ],
  );

  useEffect(() => {
    viewRef.current?.sync(sceneViewState);
  }, [sceneViewState, viewportReady]);

  // The placement handler closes over the current selection, so it re-registers
  // on its own rather than joining the create-once mount effect above (spec §2.4.2).
  useEffect(() => {
    viewRef.current?.onPlace(applyPlacement);
  }, [applyPlacement, viewportReady]);

  // --- polyline vertex edits (`camera_placement.md` §6.2) -------------------
  const handleMoveVertex = useCallback((id: string, vertex: number, position: Vec3) => {
    dispatch({ type: 'moveConstraintVertex', id, vertex, position });
  }, []);

  /**
   * Insert a vertex and select it — the panel's "+", and every Extend click.
   *
   * `at` is the new vertex's own index, so selecting it is the whole rule: the
   * panel lands on the vertex the user just made, and a run of Extend clicks
   * keeps growing the same end (§6.2).
   */
  const handleInsertVertex = useCallback((id: string, at: number, position: Vec3) => {
    dispatch({ type: 'insertConstraintVertex', id, at, position });
    setVertexSelection({ id, vertex: at });
  }, []);

  /**
   * Delete the selected vertex. The sub-selection is left alone deliberately: the
   * held index now names whichever vertex took its place, and the §6.1 clamp
   * turns a deleted *last* vertex into the new last — which is exactly the rule,
   * with no follow-up write to get wrong.
   */
  const handleDeleteVertex = useCallback((id: string, vertex: number) => {
    dispatch({ type: 'deleteConstraintVertex', id, vertex });
  }, []);

  /**
   * Arm Extend on the selected polyline, growing the end its vertex names (§6.2).
   * Re-clicking the button disarms it, as every armed tool's does (spec §2.4.2).
   */
  const handleExtendPolyline = useCallback((id: string, vertex: number) => {
    setExtending((armed) => (armed?.id === id ? null : { id, end: extendEnd(vertex) }));
    setDraft(EMPTY_DRAFT);
  }, []);

  // --- polyline draw mode (`camera_placement.md` §6.2) ----------------------
  // A click appends a vertex; a hover moves the rubber band. Both register once:
  // the draft is updated functionally, and the Extend branch reads its state
  // through refs rather than closing over it.
  const extendingRef = useRef(extending);
  extendingRef.current = extending;
  const vertexSelectionRef = useRef(vertexSelection);
  vertexSelectionRef.current = vertexSelection;
  useEffect(() => {
    viewRef.current?.onDraw((point) => {
      const extend = extendingRef.current;
      if (!extend) {
        setDraft((d) => appendVertex(d, point));
        return;
      }
      // Extending a committed polyline: each click is an insert at the end being
      // grown, and the new vertex becomes selected so the next click continues
      // from it (§6.2). `at` is read from the constraint as of the last render —
      // the reducer clamps it into range, so the worst a stale count could do is
      // land the vertex at the end it was already headed for.
      const c = constraintsRef.current.find((x) => x.id === extend.id);
      if (c?.kind !== 'polyline') return;
      handleInsertVertex(extend.id, extendInsertAt(extend.end, c.points.length), point);
    });
    viewRef.current?.onDrawHover((point) => setDraft((d) => moveCursor(d, point)));
  }, [handleInsertVertex, viewportReady]);

  /**
   * End the armed tool (§6.2), by **Enter** or by a **double-click** — which is
   * the whole difference between them: a double-click's own first click landed a
   * vertex, and ending the line is the gesture, so that vertex is taken back out.
   * Enter has no click to take back and commits what is drawn.
   *
   * One vertex commits as a **point** constraint — that is what the user drew,
   * and it beats refusing the commit or creating a degenerate polyline.
   *
   * Everything is read through **refs** so this callback is stable: a
   * double-click's end lands in the same event streak as the click that appended
   * the last vertex, sooner than a re-registered viewport handler could close
   * over it, and acting on a draft one vertex behind is exactly the bug that
   * would cause.
   */
  const endDrawing = useCallback((source: 'key' | 'doubleClick') => {
    const extend = extendingRef.current;
    if (extend) {
      // Extend edits a committed entity, so there is nothing to commit or cancel
      // — but a double-click's first click already *inserted* a vertex, and the
      // same rule says the pair contributes none. Every Extend click selects the
      // vertex it inserted, so the one to take back out is the selected one; the
      // 2-vertex floor cannot bite, since that click had just raised the count.
      const held = vertexSelectionRef.current;
      if (source === 'doubleClick' && held?.id === extend.id) {
        dispatch({ type: 'deleteConstraintVertex', id: extend.id, vertex: held.vertex });
      }
      setExtending(null);
      setDraft(EMPTY_DRAFT);
      return;
    }
    const draw = draftRef.current;
    const committed = commitDraft(source === 'doubleClick' ? draftAfterDoubleClick(draw) : draw);
    setDrawing(false);
    setDraft(EMPTY_DRAFT);
    if (!committed) return;
    dispatch({
      type: 'addConstraint',
      kind: committed.kind,
      position: committed.points[0],
      points: committed.points,
    });
  }, []);

  // The pointer half of the end: a viewport double-click (§6.2). Stable, like the
  // two handlers above.
  useEffect(() => {
    viewRef.current?.onDrawCommit(() => endDrawing('doubleClick'));
  }, [endDrawing, viewportReady]);

  // Enter commits, Escape cancels, Backspace drops the last vertex (§6.2).
  // Mounted only while armed, and it ignores keys aimed at a form field, where
  // Escape is already the numeric fields' revert key (spec §5.2.1).
  useEffect(() => {
    if (!drawing && !extending) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (ev.key === 'Escape') {
        setDrawing(false);
        setExtending(null);
        setDraft(EMPTY_DRAFT);
      } else if (ev.key === 'Enter') {
        endDrawing('key');
      } else if (ev.key === 'Backspace' && drawing) {
        // Not bound while extending (§6.2): every click there is already
        // committed, and the vertex the user regrets is the selected one, which
        // the panel's "−" removes.
        ev.preventDefault();
        setDraft((d) => removeLastVertex(d));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawing, extending, endDrawing]);

  // Arming one viewport tool disarms the other: both consume clicks, and two
  // armed tools would race for the same click (spec §2.4.2, §6.2).
  useEffect(() => {
    if (drawing) {
      setPlacing(false);
      setExtending(null);
    }
  }, [drawing]);
  useEffect(() => {
    if (placing) {
      setDrawing(false);
      setExtending(null);
    }
  }, [placing]);
  useEffect(() => {
    if (extending) {
      setPlacing(false);
      setDrawing(false);
    }
  }, [extending]);

  // Extend is armed on one polyline, so it disarms as soon as the selection
  // leaves it — a deletion included (§2.4.2's rule, for the same reason: an
  // armed click must never edit what the user has moved on from).
  useEffect(() => {
    if (extending && extending.id !== selectedPolyline?.id) setExtending(null);
  }, [extending, selectedPolyline]);

  // Disarm "Place on surface" whenever the selection changes or is cleared (spec
  // §2.4.2) — including a deleted entity — so an armed click can never move an
  // entity the user has moved on from.
  useEffect(() => {
    setPlacing(false);
  }, [selection]);

  // Escape cancels an armed placement (spec §2.4.2). Mounted only while armed, and
  // it ignores keys aimed at a form field, where Escape is already the numeric
  // fields' revert key (§5.2.1).
  useEffect(() => {
    if (!placing) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      const target = ev.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
      setPlacing(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [placing]);

  // Unified enable/disable for the hierarchy row checkboxes (spec §5.4, §13, §7.3):
  // a camera (compute participation), a section (heatmap on/off), or a zone
  // (contributes to the marked set). Toggling a section or zone is a client-side
  // re-filter only — neither marks the coverage result stale.
  const handleToggleEnabled = useCallback(
    (kind: 'camera' | 'section' | 'zone' | 'constraintGroup' | 'constraint', id: string) => {
      dispatch({ type: 'toggleEnabled', kind, id });
    },
    [],
  );

  const handleCameraChange = useCallback((id: string, patch: Partial<CameraConfig>) => {
    dispatch({ type: 'changeCamera', id, patch });
  }, []);

  // The aim lock changes nothing the engine computes, so it never marks the
  // result stale (`aim_optimization.md` §4.5).
  const handleToggleAimLock = useCallback((id: string) => {
    dispatch({ type: 'toggleAimLock', id });
  }, []);

  const handleProbeChange = useCallback((id: string, position: Vec3) => {
    dispatch({ type: 'changeProbe', id, position });
  }, []);

  // Renames (spec §5.6): pure display-label writes — never mark the result stale,
  // for any entity (the reducer excludes them from the coverage-input rules).
  const handleRenameCamera = useCallback((id: string, name: string) => {
    dispatch({ type: 'renameEntity', kind: 'camera', id, name });
  }, []);

  const handleRenameProbe = useCallback((id: string, name: string) => {
    dispatch({ type: 'renameEntity', kind: 'probe', id, name });
  }, []);

  const handleRenameSection = useCallback((id: string, name: string) => {
    dispatch({ type: 'renameEntity', kind: 'section', id, name });
  }, []);

  const handleToggleCollapse = useCallback((nodeId: string) => {
    dispatch({ type: 'toggleCollapse', id: nodeId });
  }, []);

  // --- add / delete entities (spec §5.5, §12.5). New entities spawn at the
  // workspace center (App-derived from the geometry); the reducer allocates the
  // id and auto-selects the new entity. --------------------------------------
  const handleAddCamera = useCallback(() => {
    dispatch({ type: 'addCamera', position: workspaceCenter });
  }, [workspaceCenter]);

  const handleAddProbe = useCallback(() => {
    dispatch({ type: 'addProbe', position: workspaceCenter });
  }, [workspaceCenter]);

  const handleAddSection = useCallback(() => {
    dispatch({ type: 'addSection', worldMin: room.worldMin, worldMax: room.worldMax });
  }, [room]);

  const handleSectionChange = useCallback((id: string, patch: Partial<Section>) => {
    dispatch({ type: 'changeSection', id, patch });
  }, []);

  // Clip toggle (spec §13.9): make this section the sole clip, or turn clipping
  // off if it already is. Selection is irrelevant.
  const handleToggleSectionClip = useCallback((id: string) => {
    dispatch({ type: 'toggleSectionClip', id });
  }, []);

  const handleDeleteCamera = useCallback((id: string) => {
    dispatch({ type: 'deleteEntity', kind: 'camera', id });
  }, []);

  const handleDeleteProbe = useCallback((id: string) => {
    dispatch({ type: 'deleteEntity', kind: 'probe', id });
  }, []);

  // Deleting the clipping section also clears the clip (handled in the reducer, §13.9).
  const handleDeleteSection = useCallback((id: string) => {
    dispatch({ type: 'deleteEntity', kind: 'section', id });
  }, []);

  // --- duplicate entities (spec §5.5): the reducer makes a deep verbatim copy
  // with the next free id, coincident with the original, and selects it. --------
  const handleDuplicateCamera = useCallback((id: string) => {
    dispatch({ type: 'duplicateEntity', kind: 'camera', id });
  }, []);

  const handleDuplicateProbe = useCallback((id: string) => {
    dispatch({ type: 'duplicateEntity', kind: 'probe', id });
  }, []);

  const handleDuplicateSection = useCallback((id: string) => {
    dispatch({ type: 'duplicateEntity', kind: 'section', id });
  }, []);

  // --- zones & volumes (`sampling_volumes.md` §3, §4, §6, §7.3). The reducer
  // owns the empty-vs-non-empty stale rules and the add-volume target-zone logic
  // (selected zone → selected volume's zone → first zone → create "Zone 1"). ----
  const handleAddZone = useCallback(() => {
    dispatch({ type: 'addZone' });
  }, []);

  const handleAddVolume = useCallback(() => {
    dispatch({ type: 'addVolume', position: workspaceCenter });
  }, [workspaceCenter]);

  const handleVolumeChange = useCallback((id: string, patch: Partial<SamplingVolume>) => {
    dispatch({ type: 'changeVolume', id, patch });
  }, []);

  const handleRenameZone = useCallback((id: string, name: string) => {
    dispatch({ type: 'renameEntity', kind: 'zone', id, name });
  }, []);

  const handleToggleUseZones = useCallback((v: boolean) => dispatch({ type: 'toggleUseZones', value: v }), []);

  const handleZoneLevelChange = useCallback((v: number) => {
    setZoneLevel(v);
    setBoxLevel((b) => Math.max(b, v)); // box level clamped ≥ zone level (§3.4)
  }, []);
  const handleBoxLevelChange = useCallback((v: number) => setBoxLevel(Math.max(v, zoneLevel)), [zoneLevel]);

  // Generate replaces the entire zone+volume set from the cached BVH (§3.4),
  // discarding hand-edits, and auto-selects the first new zone (all enabled).
  const handleGenerate = useCallback(() => {
    let cache = bvhRef.current;
    if (!cache || cache.room !== room) {
      cache = { room, bvh: buildSceneBvh(room.sceneMesh) };
      bvhRef.current = cache;
    }
    const { bvh } = cache;
    const { zones: nextZones, volumes: nextVolumes } = extractZonesAndVolumes(
      bvh.f32,
      bvh.u32,
      bvh.nodeCount,
      bvh.triangleCount,
      zoneLevel,
      boxLevel,
      voxelSize,
    );
    dispatch({ type: 'generated', zones: nextZones, volumes: nextVolumes });
  }, [room, zoneLevel, boxLevel, voxelSize]);

  const handleDeleteVolume = useCallback((id: string) => {
    dispatch({ type: 'deleteEntity', kind: 'volume', id });
  }, []);

  // Deleting a zone removes it and all its volumes (§4); the reducer marks stale
  // only when it actually had volumes.
  const handleDeleteZone = useCallback((id: string) => {
    dispatch({ type: 'deleteEntity', kind: 'zone', id });
  }, []);

  const handleDuplicateVolume = useCallback((id: string) => {
    dispatch({ type: 'duplicateEntity', kind: 'volume', id });
  }, []);

  // Duplicating a zone deep-copies the zone and fresh copies of all its volumes
  // (spec §5.5); the reducer marks stale only when it brought volumes.
  const handleDuplicateZone = useCallback((id: string) => {
    dispatch({ type: 'duplicateEntity', kind: 'zone', id });
  }, []);

  // --- camera constraints (`camera_placement.md` §6, §7). No constraint edit
  // marks the coverage result stale: a constraint generates cameras and nothing
  // else (§1.1). The one exception is reshaping a constraint a camera is *bound*
  // to, which re-clamps that camera — a camera move, handled in the reducer. ----
  const handleAddConstraintGroup = useCallback(() => {
    dispatch({ type: 'addConstraintGroup' });
  }, []);

  /**
   * "+ → Point / Polyline / Plane" (§7). A polyline **arms the draw mode**
   * instead of spawning geometry: a polyline with no vertices is not a thing the
   * user wants, and clicking the surface is how one is stated (§6.2).
   */
  const handleAddConstraint = useCallback(
    (kind: ConstraintKind) => {
      if (kind === 'polyline') {
        setDraft(EMPTY_DRAFT);
        setDrawing(true);
        return;
      }
      dispatch({ type: 'addConstraint', kind, position: workspaceCenter });
    },
    [workspaceCenter],
  );

  const handleConstraintGroupChange = useCallback((id: string, patch: Partial<ConstraintGroup>) => {
    dispatch({ type: 'changeConstraintGroup', id, patch });
  }, []);

  const handleConstraintChange = useCallback((id: string, patch: Partial<CameraConstraint>) => {
    dispatch({ type: 'changeConstraint', id, patch });
  }, []);

  const handleRenameConstraintGroup = useCallback((id: string, name: string) => {
    dispatch({ type: 'renameEntity', kind: 'constraintGroup', id, name });
  }, []);

  const handleRenameConstraint = useCallback((id: string, name: string) => {
    dispatch({ type: 'renameEntity', kind: 'constraint', id, name });
  }, []);

  const handleDeleteConstraintGroup = useCallback((id: string) => {
    dispatch({ type: 'deleteEntity', kind: 'constraintGroup', id });
  }, []);

  const handleDeleteConstraint = useCallback((id: string) => {
    dispatch({ type: 'deleteEntity', kind: 'constraint', id });
  }, []);

  const handleDuplicateConstraintGroup = useCallback((id: string) => {
    dispatch({ type: 'duplicateEntity', kind: 'constraintGroup', id });
  }, []);

  const handleDuplicateConstraint = useCallback((id: string) => {
    dispatch({ type: 'duplicateEntity', kind: 'constraint', id });
  }, []);

  const handleBindCamera = useCallback((id: string, constraintId: string | null) => {
    dispatch({ type: 'bindCamera', id, constraintId });
  }, []);

  // Hierarchy drag-reorder (spec §5.5.1). Array order is the display order and
  // round-trips in the scene file, so this is a pure splice: no recompute, no
  // stale/sampling-dirty, and the selection is deliberately left alone.
  const handleReorder = useCallback((kind: EntityKind, id: string, beforeId: string | null) => {
    dispatch({ type: 'reorderEntity', kind, id, beforeId });
  }, []);

  // --- scene file: import / export / reset (spec §14) ------------------------
  // Replaces the whole Scene at once: geometry, cameras, probes, sections, plus
  // every derived/retained-run bit of state, so nothing from the outgoing scene
  // lingers (spec §14.4).
  const applyScene = useCallback(
    (next: {
      geometry: GeometryObject[];
      build: GeometryBuild;
      cameras: SceneCamera[];
      probes: Probe[];
      sections: Section[];
      clipSectionId: string | null;
      zones: Zone[];
      volumes: SamplingVolume[];
      useZones: boolean;
      constraintGroups: ConstraintGroup[];
      constraints: CameraConstraint[];
    }) => {
      // Geometry build + retained-chunk consumers are App-owned side effects; the
      // scene document is reset in one `sceneReplaced` dispatch (the reducer
      // selects the first camera, resets the run flags, forces a sampling re-apply,
      // and keeps collapse state). `coverageRun.clear()` (below) both wipes the
      // retained stores and bumps the generation so any in-flight compute discards
      // its results (spec §14.4).
      disposeGeometryBuild(roomRef.current);
      setRoom(next.build);
      setGeometryObjects(next.geometry);
      // The cached BVH is invalidated (rebuilt lazily on the next Generate).
      bvhRef.current = null;
      dispatch({
        type: 'sceneReplaced',
        doc: {
          cameras: next.cameras,
          probes: next.probes,
          sections: next.sections,
          clipSectionId: next.clipSectionId,
          zones: next.zones,
          volumes: next.volumes,
          useZones: next.useZones,
          constraintGroups: next.constraintGroups,
          constraints: next.constraints,
        },
      });
      setSummary(null);
      setInitializedVoxelSize(null);
      initializedRoomRef.current = null;
      initializedVoxelSizeRef.current = null;
      // A load for the outgoing room is now superseded; clearing this both frees
      // the next `ensureLoaded` to start a fresh one and stops the old flight
      // from committing bookkeeping for geometry that is gone (spec §14.4).
      engineLoadRef.current = null;
      viewRef.current?.clearCoverage(); // the overlay lives in SceneView
      void cancelInFlight(); // spec §14.4 step 4, now an actual cancel (SDK §13.2)
      coverageRun.clear(); // wipes the three stores + invalidates in-flight runs
      setMasksVersion((v) => v + 1);
      setSceneError(null);
    },
    [coverageRun, cancelInFlight],
  );

  // The transient "Saved to <folder>" status (§14.7) is the only signal a silent
  // save gives; drop the pending revert if we unmount first.
  useEffect(
    () => () => {
      if (savedStatusTimerRef.current != null) clearTimeout(savedStatusTimerRef.current);
    },
    [],
  );

  /**
   * Show "Saved to <folder>" for a moment, then fall back to naming the target
   * (spec §14.7).
   */
  const flashSavedStatus = useCallback((saved: LastSave) => {
    if (savedStatusTimerRef.current != null) clearTimeout(savedStatusTimerRef.current);
    setLastSave(saved);
    savedStatusTimerRef.current = setTimeout(() => {
      savedStatusTimerRef.current = null;
      setLastSave(null);
    }, SAVED_STATUS_MS);
  }, []);

  const handleImportScene = useCallback(async () => {
    let dir: FileSystemDirectoryHandle;
    try {
      // Anchored to the current target so Load opens where the scene lives, not
      // wherever a picker was last used in this origin (§14.5).
      dir = await window.showDirectoryPicker({ mode: 'read', id: SCENE_PICKER_ID, startIn: saveTarget ?? undefined });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // user cancelled (§14.8)
      setSceneError(describeSceneError(err));
      return;
    }
    setSceneIOBusy(true);
    try {
      const { scene: imported, build } = await importSceneFromDirectory(dir);
      applyScene({
        geometry: imported.geometry,
        build,
        cameras: imported.cameras,
        probes: imported.probes,
        sections: imported.sections,
        clipSectionId: imported.clipSectionId,
        zones: imported.zones,
        volumes: imported.volumes,
        useZones: imported.useZones,
        constraintGroups: imported.constraintGroups,
        constraints: imported.constraints,
      });
      // The scene now lives in this folder, so Save writes back here (§14.5).
      setSaveTarget((target) => nextSaveTarget(target, { kind: 'imported', folder: dir }));
      setLastSave(null);
    } catch (err) {
      // Nothing above this point touched app state — the current scene *and* the
      // save target are left completely untouched on failure (spec §14.4, §14.8).
      setSceneError(describeSceneError(err));
    } finally {
      setSceneIOBusy(false);
    }
  }, [applyScene, saveTarget]);

  /**
   * Save (spec §14.5): with a target, writes `scene.json` straight back into it;
   * with none — or on Save As… — picks a folder first and adopts it. A picked
   * folder that already holds a scene or referenced assets is confirmed before
   * being replaced, and a save into a *different* folder copies the scene's
   * referenced assets there first, so the destination is self-contained.
   */
  const handleSaveScene = useCallback(
    async (intent: SaveIntent) => {
      const target = saveTarget;
      const action = resolveSaveAction(target != null, intent);
      let dir: FileSystemDirectoryHandle;
      // Assets to copy, and the folder to copy them from — empty for an in-place
      // save, since the bytes are already there.
      let assetSrcs: string[] = [];
      let copyFrom: FileSystemDirectoryHandle | null = null;
      // `action.kind === 'write'` already implies a target; re-narrowing keeps the
      // picker as the fallback rather than trusting an assertion.
      if (action.kind === 'write' && target != null) {
        dir = target;
        // First statement of the await chain, so the click still counts as the
        // user activation `requestPermission` needs (§14.5).
        let granted: boolean;
        try {
          granted = await ensureWritePermission(dir);
        } catch (err) {
          setSceneError(describeSaveFailure(dir.name, describeSceneError(err)));
          return;
        }
        if (!granted) {
          // Target kept, so a retry or Save As… is one click away (§14.8).
          setSceneError(describeSaveFailure(dir.name, 'write permission was denied'));
          return;
        }
      } else {
        try {
          dir = await window.showDirectoryPicker({ mode: 'readwrite', id: SCENE_PICKER_ID, startIn: target ?? undefined });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return; // cancelled (§14.8)
          setSceneError(describeSceneError(err));
          return;
        }
        // Picking the folder the scene already lives in is an in-place save: no
        // copy, and nothing to warn about replacing (§14.5).
        const inPlace = target != null && (await dir.isSameEntry(target));
        if (!inPlace) {
          // The target is the asset source: `gltf` geometry can only arrive by
          // import (§14.9 forbids authoring), and import always sets a target.
          assetSrcs = target == null ? [] : planAssetCopy(geometryObjects);
          copyFrom = assetSrcs.length > 0 ? target : null;
        }
        // The directory picker gives no overwrite warning of its own, so a folder
        // we didn't open is confirmed before its scene or assets are replaced (§14.5).
        if (action.confirmIfExists && !inPlace) {
          const prompt = describeOverwritePrompt(dir.name, {
            sceneExists: await sceneJsonExists(dir),
            assetClashes: (await findExistingAssets(dir, assetSrcs)).length,
          });
          if (prompt != null && !window.confirm(prompt)) return; // nothing written, target unchanged (§14.8)
        }
      }

      setSceneIOBusy(true);
      try {
        const current: Scene = {
          geometry: geometryObjects,
          cameras,
          probes,
          sections,
          clipSectionId,
          zones,
          volumes,
          useZones,
          constraintGroups,
          constraints,
        };
        // Assets first: a destination left without a scene.json is visibly
        // incomplete, whereas one with a scene.json missing its assets is a
        // trap that only fails on the next import (§14.5).
        if (copyFrom != null) await copyAssets(copyFrom, dir, assetSrcs);
        await exportSceneToDirectory(dir, current);
        setSaveTarget((prev) => nextSaveTarget(prev, { kind: 'saved', folder: dir }));
        setSceneError(null);
        flashSavedStatus({ assetsCopied: copyFrom == null ? 0 : assetSrcs.length });
      } catch (err) {
        setSceneError(
          err instanceof AssetCopyError
            ? describeAssetCopyFailure(err.src, err.reason)
            : describeSaveFailure(dir.name, describeSceneError(err)),
        );
      } finally {
        setSceneIOBusy(false);
      }
    },
    [saveTarget, flashSavedStatus, geometryObjects, cameras, probes, sections, clipSectionId, zones, volumes, useZones],
  );

  const handleSave = useCallback(() => void handleSaveScene('save'), [handleSaveScene]);
  const handleSaveAs = useCallback(() => void handleSaveScene('saveAs'), [handleSaveScene]);

  /**
   * Load the engine for `(room, voxelSize)` unless it already holds exactly that,
   * and report whether it does when this resolves (spec §8).
   *
   * **The engine is loaded on scene load, not on the first run.** Both the effect
   * below and `handleRun` come through here, because engine readiness gates the one
   * feature that does not pass the Run gate: a pool build drives `compute()`
   * itself (`camera_placement.md` §4.2, §10). While `initAndLoad` lived only inside
   * `handleRun`, that readiness check could not be satisfied before the first run —
   * the placement tool sat disabled from startup asking the user to wait for a load
   * that would not begin until they pressed Run coverage.
   *
   * Idempotent and single-flight: the `(room, voxelSize)` key both short-circuits a
   * request the engine already satisfies and joins a request already in flight, so
   * a run firing in the same tick as a scene load cannot issue a second `init`.
   *
   * A `voxelSize` change is deliberately *not* eager (spec §8, §6): re-voxelizing
   * the workspace is the session's most expensive operation, and the slider gates
   * nothing — the engine already holds a scene — so it is left to the next run.
   */
  const ensureLoaded = useCallback(
    (target: GeometryBuild, voxelSize: number, cameraCount: number): Promise<boolean> => {
      // The epoch keys every record to the worker instance it describes: a replaced
      // worker (StrictMode's dev remount) leaves behind both a "loaded" fact that no
      // longer holds and an `init` that can never settle.
      const epoch = engine.epoch();
      const action = engineLoadAction(
        { epoch: initializedEpochRef.current, room: initializedRoomRef.current, voxelSize: initializedVoxelSizeRef.current },
        engineLoadRef.current,
        { epoch, room: target, voxelSize },
      );
      if (action === 'satisfied') return Promise.resolve(true);
      if (action === 'join') return engineLoadRef.current!.promise;

      const gen = coverageRun.generation;
      const promise = (async () => {
        const initResult = await engine.initAndLoad(target.sceneMesh, target.worldMin, target.worldMax, voxelSize,
          chunkSizeFor(target.worldMin, target.worldMax, voxelSize, cameraCount));
        // An import landed, or the worker was replaced, while we loaded: what this
        // describes is gone either way, so commit nothing and let the swap's own
        // load take over (§14.4).
        if (!coverageRun.isCurrent(gen) || engine.epoch() !== epoch) return false;
        if (!initResult) {
          setInitializedVoxelSize(null);
          initializedVoxelSizeRef.current = null;
          initializedRoomRef.current = null;
          return false;
        }
        initializedRoomRef.current = target;
        initializedVoxelSizeRef.current = voxelSize;
        initializedEpochRef.current = epoch;
        setInitializedVoxelSize(voxelSize);
        return true;
      })();
      engineLoadRef.current = { epoch, room: target, voxelSize, promise };
      void promise.finally(() => {
        if (engineLoadRef.current?.promise === promise) engineLoadRef.current = null;
      });
      return promise;
    },
    [engine, coverageRun],
  );

  // --- load the engine as soon as the app has geometry (spec §8): at mount and
  // after every import/reset. Keyed on `room` alone — a resolution change is left
  // to the next run (§6) — so the debounced voxel size and camera count are read
  // through refs rather than depended on. Loading is not computing: coverage still
  // waits for an explicit Run or an auto-run tick (§14.4 step 4).
  // A replaced worker holds no scene, so the load has to happen again — and it does
  // without an extra dependency here: the only thing that replaces the worker is a
  // remount, which re-runs this effect too (`useEngine`'s effect, registered first,
  // has already bumped the epoch by then). What the epoch fixes is the *key*: the
  // remount must not join the terminated worker's unsettled `init`.
  useEffect(() => {
    void ensureLoaded(room, debouncedVoxelSizeRef.current, camerasRef.current.length);
  }, [room, ensureLoaded]);

  const handleRun = useCallback(async () => {
    // A re-aggregation is about to replace the whole store under a new descriptor
    // (spec §3.3). Starting a run now would stream accumulators laid out by the
    // old one into results the adopt is about to discard — and, for an
    // incremental run, merge two layouts. Auto-run retries within 100 ms.
    if (reaggregatingRef.current) return;
    // Whether *this run* has to re-apply the sampled region set: a fresh load
    // leaves the engine on the full volume, so the run that follows one restates
    // its zones (`sampling_volumes.md` §8). Read before `ensureLoaded`, since a
    // successful load updates exactly these two.
    const needsReinit =
      initializedVoxelSizeRef.current === null ||
      initializedVoxelSizeRef.current !== debouncedVoxelSize ||
      initializedRoomRef.current !== room;

    // Snapshot the scene "generation": if `applyScene` (import/reset) bumps
    // this while we're mid-run, every check below discards this run's results
    // instead of applying them (spec §14.4; see `coverageRun`'s guard).
    const gen = coverageRun.generation;
    if (needsReinit) {
      const loaded = await ensureLoaded(room, debouncedVoxelSize, cameras.length);
      if (!coverageRun.isCurrent(gen)) return;
      if (!loaded) return;
    }

    // Re-apply the sampled region set when it changed or a re-init reset it to
    // full (`sampling_volumes.md` §8). A sampling change needs no re-init (§6),
    // so this is as cheap as a camera edit.
    if (needsReinit || stateRef.current.samplingDirty) {
      const s = stateRef.current;
      const samplingActiveNow = s.useZones && s.volumes.length > 0;
      const stats = await engine.setSampling(regionsFromVolumes(samplingActiveNow, s.volumes));
      if (!coverageRun.isCurrent(gen)) return;
      if (!stats) return;
      dispatch({ type: 'samplingApplied' });
    }

    // Convert app cameras to plain `CameraConfig` (drop the display `name`) at the
    // SDK boundary — the one place the engine type is required (spec §5.6, §14.1).
    // Disabled cameras are passed too, carrying `enabled: false`: filtering them
    // out would renumber every later camera's mask bit and disqualify the run
    // from incremental recompute (spec §5.4, SDK spec §13.1).
    const runCameras = stateRef.current.cameras;
    const ok = engine.setCameras(runCameras.map(toCameraConfig));
    if (!ok) return;

    // The descriptor this run derives everything from (spec §3.3). When results
    // are already retained the run reuses **their** descriptor, not the newest
    // one: an incremental run re-sends only a few chunks, and accumulators laid
    // out by two different descriptors cannot be merged. A newer descriptor is
    // reconciled right after, by the effect below, which re-reduces every
    // retained chunk at once.
    const grid = runGrid;
    const descriptor = coverageRun.descriptor ?? aggregateRef.current;
    const { spec } = descriptor;
    const controller = new AbortController();
    const runPromise = engine.compute({
      mode: 1,
      // Let the engine decide; it reports back through `onRunStart` (spec §8).
      incremental: true,
      signal: controller.signal,
      aggregate: spec,
      onRunStart: ({ incremental }) => {
        if (!coverageRun.isCurrent(gen)) return;
        // A full run re-sends every chunk, so the stores start empty. An
        // incremental run re-sends only a few — clearing here would blank the
        // rest of the scene, silently (spec §8).
        // A full run replaces every retained chunk, so the capture slots' bits
        // are gone from the masks and the display filter can be dropped
        // (`aim_optimization.md` §3.1).
        if (!incremental) {
          coverageRun.reset(grid, runCameras, descriptor);
          noteFullRunRef.current();
          placementNoteFullRunRef.current();
        }
        viewRef.current?.beginCoverageRun(grid.voxelSize, { incremental });
      },
      onAggregate: (result) => {
        // A newer scene may have replaced (and cleared) the store mid-stream;
        // don't let a stale chunk's accumulators repopulate it (spec §14.4).
        if (!coverageRun.isCurrent(gen)) return;
        const chunk = grid.chunk(result.chunkId);
        viewRef.current?.addCoverageCounts(result, chunk.origin, chunk.dims);
        coverageRun.addResult(result);
      },
    });
    inFlightRef.current = { controller, done: runPromise };
    const result = await runPromise;
    if (inFlightRef.current?.controller === controller) inFlightRef.current = null;
    // One rebuild per run, not one per chunk (spec §9). Unconditional: a run
    // superseded mid-stream still left the overlay in streaming mode, and
    // leaving it there would stall every later rebuild.
    viewRef.current?.flushCoverage();
    if (!coverageRun.isCurrent(gen)) return;
    if (result) {
      setSummary(result);
      dispatch({ type: 'runCompleted' });
      setMasksVersion((v) => v + 1);
      // The run that reconciles an apply is the "after" column (§6.3). Read from
      // the store directly: the `zoneCoverage` memo has not re-derived yet, and
      // the store was filled by this run's own `onAggregate` above.
      const before = pendingBeforeRef.current;
      if (before) {
        pendingBeforeRef.current = null;
        const zones = stateRef.current.zones;
        const after = snapshotCoverage(coverageRun.zoneCoverage(zones));
        setComparison(compareCoverage(before, after, zones, unionLabel(stateRef.current)));
      }
    }
  }, [engine, room, ensureLoaded, debouncedVoxelSize, coverageRun, runGrid]);

  // --- re-aggregation on a descriptor edit (spec §3.3) -----------------------
  // Moving a zone or volume, dragging a section, toggling a zone, or moving a
  // probe changes *what is counted*, never *what is seen* — so none of them can
  // change a mask bit, and none of them recomputes. The worker still holds the
  // run's masks (spec §3.1) and re-reduces them under the new descriptor.
  //
  // Skipped before the first run (nothing retained) and while one is in flight:
  // that run carries the current descriptor already, and racing it would apply
  // an older set of results on top of a newer run's.
  useEffect(() => {
    // Nothing retained yet, or the retained results already describe this
    // descriptor. Identity, not deep equality: `aggregate` is a `useMemo`, so a
    // new object *is* the signal that something it depends on changed.
    if (!coverageRun.hasRun() || coverageRun.descriptor === aggregate) return;
    // A run owns the store while it streams. Re-checked after every run through
    // `masksVersion`, so a descriptor edit that lands mid-run is reconciled as
    // soon as the run ends rather than waiting for an unrelated edit.
    if (inFlightRef.current || reaggregatingRef.current) return;
    const gen = coverageRun.generation;
    let superseded = false;
    reaggregatingRef.current = true;
    void (async () => {
      try {
      // Collected, then applied in one synchronous block below. Feeding them in
      // as they arrive would leave every panel and the overlay blank for the
      // duration of the round trip, and blank on an aborted one.
      const collected: AggregateResult[] = [];
      const ok = await engine.reaggregate(aggregate.spec, (r) => collected.push(r));
      if (superseded || !ok || !coverageRun.isCurrent(gen)) return;
      coverageRun.adopt(aggregate, collected);
      const view = viewRef.current;
      if (view) {
        // A re-aggregation replaces every retained chunk, so it starts like a
        // full run rather than an incremental one.
        view.beginCoverageRun(runGrid.voxelSize, { incremental: false });
        for (const r of collected) {
          const chunk = runGrid.chunk(r.chunkId);
          view.addCoverageCounts(r, chunk.origin, chunk.dims);
        }
        view.flushCoverage();
      }
      setMasksVersion((v) => v + 1);
      } finally {
        reaggregatingRef.current = false;
      }
    })();
    return () => {
      superseded = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregate, masksVersion, coverageRun, runGrid]);

  // --- cancel a superseded run (SDK spec §13.2). A resolution, geometry, or
  // sampling change makes whatever is computing describe a workspace the user has
  // already moved off, and those runs are the long ones — a full re-init at a fine
  // voxel size, not a few dirty chunks. Cancelling here, at the edit, rather than
  // at the next run keeps `handleRun` strictly non-reentrant: the abort lands, the
  // engine goes idle, and the ordinary `!busy` gate below starts the new run.
  //
  // A camera edit is deliberately *not* cancelled. Its run is short (§8) and its
  // result is still applied — one edit stale, reconciled by the next auto-run —
  // so cancelling would throw away finished work to save nothing.
  const pendingHeavyWork =
    initializedVoxelSize === null ||
    initializedVoxelSize !== debouncedVoxelSize ||
    initializedRoomRef.current !== room ||
    sceneState.samplingDirty;
  useEffect(() => {
    if (pendingHeavyWork) void cancelInFlight();
  }, [pendingHeavyWork, cancelInFlight]);

  // --- auto-run: recompute automatically once results go stale, throttled to
  // at most AUTO_RUN_MAX_HZ runs/sec ------------------------------------------
  const busy = engine.state.status === 'initializing' || engine.state.status === 'computing';
  const staleRef = useRef(stale);
  staleRef.current = stale;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const engineStatusRef = useRef(engine.state.status);
  engineStatusRef.current = engine.state.status;
  const handleRunRef = useRef(handleRun);
  handleRunRef.current = handleRun;

  useEffect(() => {
    if (!autoRun) return;
    const id = setInterval(() => {
      // Auto-run is suspended while an optimize *or* placement session is open
      // (spec §8.1, `camera_placement.md` §3.4): that session owns the engine's
      // camera list for the duration, and interleaving would run two computes
      // over two different lists.
      if (
        staleRef.current &&
        !busyRef.current &&
        !optimizerBusyRef.current &&
        !placementBusyRef.current &&
        engineStatusRef.current !== 'error'
      ) {
        handleRunRef.current();
      }
    }, 1000 / AUTO_RUN_MAX_HZ);
    return () => clearInterval(id);
  }, [autoRun]);

  const selectedCamera = cameras.find((c) => c.id === selectedCameraId) ?? null;
  const selectedProbe = probes.find((p) => p.id === selectedProbeId) ?? null;
  const selectedSection = sections.find((s) => s.id === selectedSectionId) ?? null;
  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;
  const selectedVolume = volumes.find((v) => v.id === selectedVolumeId) ?? null;
  const selectedZoneMemberCount = selectedZoneId ? volumes.filter((v) => v.zoneId === selectedZoneId).length : 0;
  const selectedConstraintGroup = constraintGroups.find((g) => g.id === selectedConstraintGroupId) ?? null;
  const selectedConstraint = constraints.find((c) => c.id === selectedConstraintId) ?? null;

  const selectedGroupMemberCount = selectedConstraintGroupId
    ? constraints.filter((c) => c.groupId === selectedConstraintGroupId).length
    : 0;

  // Camera id → display name (spec §5.6), so every per-camera stat list (§10, §13.7,
  // `sampling_volumes.md` §6.2) and the probe visibility list read the camera's name
  // rather than its raw id.
  const cameraNameById = useMemo(
    () => new Map(cameras.map((c) => [c.id, cameraLabel(c)])),
    [cameras],
  );

  // The displayed coverage numbers — the enabled-zones union when zones are
  // active (`sampling_volumes.md` §7.4), the SDK summary otherwise. Both the
  // StatsPanel and the hierarchy's camera badges read this one summary so they
  // can't disagree (§5.5, §7.4).
  const enabledCameraIds = useMemo(
    () => new Set(cameras.filter((c) => c.enabled).map((c) => c.id)),
    [cameras],
  );
  const displaySummary = displayCoverageSummary(
    summary,
    enabledUnionSummary,
    samplingActive,
    enabledCameraIds,
  );
  const hierarchyRates = hierarchyPerCamera(displaySummary);
  // The "Marked voxels" readout — enabled-union size vs full valid volume (§6.3,
  // §7.4). `full` is the workspace's full valid-voxel count from the engine's
  // full-volume sampling (not the retained run, which when active covers only
  // the boxes' neighborhood, §7.1).
  const fullValidVoxels = engine.state.fullValidVoxels;
  const markedReadout =
    enabledUnionSummary && fullValidVoxels !== null && volumes.length > 0
      ? { marked: enabledUnionSummary.validVoxels, full: fullValidVoxels }
      : null;
  const probeSeenCounts = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const p of probes) {
      const q = probeQueries.get(p.id);
      map.set(p.id, q && q.status === 'ok' ? q.seenCount : null);
    }
    return map;
  }, [probes, probeQueries]);

  return (
    // The placement mode keeps this shell and replaces what the two side
    // columns hold (§5) — the widths, the borders and the viewport are the
    // app's, because the mode's claim is exclusion, not screen space.
    <div className="app">
      {placementOpen && placementGroup && (
        <div className="left-panel placement-inputs">
          <CandidatePositionsPanel
            session={placement}
            group={placementGroup}
            constraints={constraints}
            error={placementError}
            onChangeGroup={handleConstraintGroupChange}
          />
          <StrategyPanel session={placement} group={placementGroup} onChangeGroup={handleConstraintGroupChange} />
          {/* The template last (§5.1): three fields set once per group, under the
              two cards whose buttons a session actually presses. */}
          <NewCameraDefaultsPanel group={placementGroup} onChangeGroup={handleConstraintGroupChange} />
        </div>
      )}
      {!placementOpen && (
        <div className="left-panel" ref={leftPanelRef}>
          <SceneFileControls
            fileSystemAccessAvailable={fileSystemAccessAvailable}
            busy={sceneIOBusy}
            error={sceneError}
            status={describeSceneFileStatus(saveTarget, lastSave)}
            onImport={handleImportScene}
            onSave={handleSave}
            onSaveAs={handleSaveAs}
          />
          <div className="panel hierarchy-panel">
            <SceneHierarchy
              cameras={cameras}
              probes={probes}
              sections={sections}
              zones={zones}
              volumes={volumes}
              constraintGroups={constraintGroups}
              constraints={constraints}
              selection={selection}
              flaggedIds={engine.state.flaggedCameras}
              perCamera={hierarchyRates}
              probeSeenCounts={probeSeenCounts}
              sectionCellGrids={sectionCellGrids}
              zoneSummaries={zoneCoverage?.perZone ?? null}
              collapsedIds={collapsedIds}
              onSelect={(next) => dispatch({ type: 'selectionChanged', selection: next })}
              onToggleEnabled={handleToggleEnabled}
              onToggleCollapse={handleToggleCollapse}
              onAddCamera={handleAddCamera}
              onAddProbe={handleAddProbe}
              onAddSection={handleAddSection}
              onAddZone={handleAddZone}
              onAddVolume={handleAddVolume}
              onAddConstraintGroup={handleAddConstraintGroup}
              onAddConstraint={handleAddConstraint}
              onDeleteCamera={handleDeleteCamera}
              onDeleteProbe={handleDeleteProbe}
              onDeleteSection={handleDeleteSection}
              onDeleteZone={handleDeleteZone}
              onDeleteVolume={handleDeleteVolume}
              onDuplicateCamera={handleDuplicateCamera}
              onDuplicateProbe={handleDuplicateProbe}
              onDuplicateSection={handleDuplicateSection}
              onDuplicateZone={handleDuplicateZone}
              onDuplicateVolume={handleDuplicateVolume}
              onDeleteConstraintGroup={handleDeleteConstraintGroup}
              onDeleteConstraint={handleDeleteConstraint}
              onDuplicateConstraintGroup={handleDuplicateConstraintGroup}
              onDuplicateConstraint={handleDuplicateConstraint}
              onReorder={handleReorder}
            />
          </div>
          <div
            className="panel-divider"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize hierarchy and detail panels"
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
          />
          <div
            className="detail-panel"
            ref={detailPanelRef}
            style={detailHeight != null ? { height: detailHeight, flex: '0 0 auto' } : undefined}
          >
            {selectedConstraint ? (
              <ConstraintPanel
                constraint={selectedConstraint}
                groups={constraintGroups}
                selectedVertex={activeVertex}
                extending={extending?.id === selectedConstraint.id}
                onRename={handleRenameConstraint}
                onChange={handleConstraintChange}
                onMoveVertex={handleMoveVertex}
                onInsertVertex={handleInsertVertex}
                onDeleteVertex={handleDeleteVertex}
                onExtend={handleExtendPolyline}
              />
            ) : selectedConstraintGroup ? (
              <ConstraintGroupPanel
                group={selectedConstraintGroup}
                memberCount={selectedGroupMemberCount}
                placementBlocker={placement.entryBlocker(selectedConstraintGroup)}
                onRename={handleRenameConstraintGroup}
                onPlaceCameras={handlePlaceCameras}
              />
            ) : selectedVolume ? (
              <VolumePanel volume={selectedVolume} zones={zones} voxelSize={voxelSize} onChange={handleVolumeChange} />
            ) : selectedZone ? (
              <ZonePanel
                zone={selectedZone}
                memberCount={selectedZoneMemberCount}
                summary={zoneCoverage?.perZone.get(selectedZone.id) ?? null}
                hasRunOnce={hasRunOnce}
                stale={stale}
                onRename={handleRenameZone}
                cameraNameById={cameraNameById}
              />
            ) : selectedSection ? (
              <SectionPanel
                section={selectedSection}
                worldMin={room.worldMin}
                worldMax={room.worldMax}
                onChange={handleSectionChange}
                onRename={handleRenameSection}
                clipActive={clipSectionId === selectedSection.id}
                onToggleClip={handleToggleSectionClip}
              />
            ) : selectedProbe ? (
              <ProbePanel
                probe={selectedProbe}
                query={probeQueries.get(selectedProbe.id)}
                hasRunOnce={hasRunOnce}
                stale={stale}
                onChange={handleProbeChange}
                onRename={handleRenameProbe}
                cameraNameById={cameraNameById}
                onSelectCamera={(id) => dispatch({ type: 'selectionChanged', selection: { kind: 'camera', id } })}
              />
            ) : (
              <CameraPanel
                camera={selectedCamera}
                flagged={selectedCameraId ? engine.state.flaggedCameras.has(selectedCameraId) : false}
                onChange={handleCameraChange}
                onRename={handleRenameCamera}
                onToggleAimLock={handleToggleAimLock}
                constraints={constraints}
                onBind={handleBindCamera}
                onReposition={
                  selectedCamera && placement.repositionBlocker(selectedCamera) === null
                    ? () => void placement.reposition(selectedCamera)
                    : null
                }
                repositionBlocker={selectedCamera ? placement.repositionBlocker(selectedCamera) : null}
              />
            )}
          </div>
        </div>
      )}
      <div className="viewport-col">
        <div
          className={`viewport${placing ? ' placing' : ''}${drawing || extending ? ' drawing' : ''}`}
          ref={containerRef}
        >
          {/* Top-left toolbar (spec §2.4): two groups — transform, then placement —
              separated by the wider between-group gap. Both are gone in the
              placement mode: nothing is selectable there, and drawing a
              constraint mid-session would invalidate the pool under it (§5.1). */}
          {!placementOpen && (
            <div className="viewport-toolbar">
              <div className="toolbar-group">
                <button
                  type="button"
                  className={`btn secondary icon-btn${selection?.kind === 'probe' || transformMode === 'translate' ? ' active' : ''}`}
                  title="Move"
                  aria-label="Move"
                  aria-pressed={selection?.kind === 'probe' || transformMode === 'translate'}
                  onClick={() => setTransformMode('translate')}
                >
                  <MoveIcon />
                </button>
                <button
                  type="button"
                  className={`btn secondary icon-btn${selection?.kind !== 'probe' && transformMode === 'rotate' ? ' active' : ''}`}
                  title="Rotate"
                  aria-label="Rotate"
                  aria-pressed={selection?.kind !== 'probe' && transformMode === 'rotate'}
                  disabled={selection?.kind === 'probe'}
                  onClick={() => setTransformMode('rotate')}
                >
                  <RotateIcon />
                </button>
                <button
                  type="button"
                  className={`btn secondary icon-btn${selection?.kind === 'volume' && transformMode === 'scale' ? ' active' : ''}`}
                  title="Scale"
                  aria-label="Scale"
                  aria-pressed={selection?.kind === 'volume' && transformMode === 'scale'}
                  disabled={selection?.kind !== 'volume'}
                  onClick={() => setTransformMode('scale')}
                >
                  <ScaleIcon />
                </button>
                <button
                  type="button"
                  className="btn secondary icon-btn"
                  title={spaceTooltip(transformSpace)}
                  aria-label={spaceTooltip(transformSpace)}
                  onClick={() => setTransformSpace((s) => toggleSpace(s))}
                >
                  {spaceIconKind(transformSpace) === 'box' ? <BoxIcon /> : <GlobeIcon />}
                </button>
              </div>
              <div className="toolbar-group">
                <button
                  type="button"
                  className={`btn secondary icon-btn${placing ? ' active' : ''}`}
                  title={placeTooltip(selection, activeVertex, placing)}
                  aria-label={placeTooltip(selection, activeVertex, placing)}
                  aria-pressed={placing}
                  disabled={!canPlace(selection, activeVertex)}
                  onClick={() => setPlacing((p) => !p)}
                >
                  <PlaceIcon />
                </button>
              </div>
            </div>
          )}
          <div className="viewport-toolbar-center">
            <ViewSelector activeView={activeView} onSelect={setActiveView} disabledViews={disabledViews} />
          </div>
          {/* Frame guide (spec §2.4.1): outlines the selected camera's true image
              inside the padded render. Percentages come straight from the fit
              that set the rendered FOV, so outline and render always agree. */}
          {cameraGuide && (
            <div
              className="camera-frame-guide"
              aria-hidden="true"
              style={{
                width: `${cameraGuide.widthFrac * 100}%`,
                height: `${cameraGuide.heightFrac * 100}%`,
              }}
            />
          )}
          <div className="viewport-toolbar-right">
            <ViewportLayerMenu
              coverageVisible={overlayOptions.visible}
              sectionsVisible={sectionsVisible}
              camerasVisible={gizmosVisible}
              zonesVisible={zonesVisible}
              constraintsVisible={constraintsVisible}
              onToggleCoverage={() => setOverlayOptions((o) => ({ ...o, visible: !o.visible }))}
              onToggleSections={() => setSectionsVisible((v) => !v)}
              onToggleCameras={() => setGizmosVisible((v) => !v)}
              onToggleZones={() => setZonesVisible((v) => !v)}
              onToggleConstraints={() => setConstraintsVisible((v) => !v)}
            />
          </div>
          {(() => {
            // The bottom-right legend describes the *clipping* section (not the
            // selection) when one is clipping and a run is retained (§13.6), else the
            // coverage-overlay legend when the overlay is visible (§9); hidden otherwise.
            const clipSection =
              sectionLegendVisible(sectionsVisible, sections, clipSectionId)
                ? sections.find((s) => s.id === clipSectionId) ?? null
                : null;
            const clipGrid = clipSection ? sectionCellGrids.get(clipSection.id) ?? null : null;
            const scale = chooseHeatmapLegend(clipSection, clipGrid, {
              visible: overlayOptions.visible,
              overlayHue: overlayOptions.overlayHue,
              mode: overlayOptions.mode,
            });
            if (!scale) return null;
            return (
              <div className="viewport-legend">
                <HeatmapLegend scale={scale} />
              </div>
            );
          })()}
        </div>
      </div>
      {placementOpen && placementGroup && placementMode && (
        <div className="sidebar placement-review-col">
          <PlacementReviewPanel
            session={placement}
            group={placementGroup}
            plan={placementPlan}
            onChangeGroup={handleConstraintGroupChange}
            cameraCount={cameras.length}
            maxCameras={MAX_CAMERAS}
            confirming={placementMode.confirming}
            onRequestClose={() =>
              dispatchMode({
                type: 'requestClose',
                running: placement.running,
                hasPool: placement.pool !== null,
              })
            }
            onConfirmClose={() => dispatchMode({ type: 'confirmClose' })}
            onKeepOpen={() => dispatchMode({ type: 'keepOpen' })}
            onApply={(plan) => {
              placement.apply(plan);
              setPlacementNotice(appliedLabel(plan));
              dispatchMode({ type: 'applied' });
            }}
          />
        </div>
      )}
      {!placementOpen && (
        <div className="sidebar">
          <RunBar
            status={engine.state.status}
            stale={stale}
            backend={engine.state.backend}
            errorMessage={engine.state.errorMessage}
            warnings={[...capWarnings, ...(placementNotice ? [placementNotice] : []), ...(optimizeError ? [optimizeError] : [])]}
            // An open session owns the engine's camera list, so a display run
            // started here would fight it (`aim_optimization.md` §3.1).
            runDisabled={optimizer.busy || placement.busy}
            autoRun={autoRun}
            onAutoRunChange={setAutoRun}
            onRun={handleRun}
          />
          <OverlayControls
            options={overlayOptions}
            onOptionsChange={(patch) => setOverlayOptions((o) => ({ ...o, ...patch }))}
            voxelSize={voxelSize}
            onVoxelSizeChange={setVoxelSize}
            estimatedVoxelCount={estimatedVoxelCount}
          />
          <SamplingVolumeControls
            useZones={useZones}
            onUseZonesChange={handleToggleUseZones}
            zoneLevel={zoneLevel}
            boxLevel={boxLevel}
            onZoneLevelChange={handleZoneLevelChange}
            onBoxLevelChange={handleBoxLevelChange}
            onGenerate={handleGenerate}
            marked={markedReadout}
          />
          <OptimizePanel
            optimizer={optimizer}
            camera={selectedCamera}
            cameras={cameras}
            onHover={setHoveredAim}
            comparison={comparison}
          />
          <StatsPanel
            summary={displaySummary}
            computeBackend={engine.state.backend}
            renderBackend={renderBackend}
            voxelSize={debouncedVoxelSize}
            cameraNameById={cameraNameById}
          />
          {selectedSection && (
            <SectionStatsPanel
              section={selectedSection}
              cellGrid={sectionCellGrids.get(selectedSection.id) ?? null}
              hasRunOnce={hasRunOnce}
              stale={stale}
              cameraNameById={cameraNameById}
            />
          )}
        </div>
      )}
    </div>
  );
}
