/**
 * Layout, engine lifecycle, and state orchestration (spec §2.2).
 * Three.js runs imperatively inside a ref-driven effect; React owns the
 * CameraConfig[] / Probe[] / overlay-option state and pushes it into the scene.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { WorkspaceGrid, type CameraConfig, type CoverageSummary, type Vec3 } from '@linkervision/camera-coverage-sdk';

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
import {
  buildSceneBvh,
  DEFAULT_BOX_LEVEL,
  DEFAULT_ZONE_LEVEL,
  extractZonesAndVolumes,
  makeMarkedFilter,
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
import { DEFAULT_INTENSITY_SCALE } from './scene/volumetric.ts';
import { defaultGeometry } from './scene/buildRoom.ts';
import { defaultScene, type Scene } from './scene/sceneModel.ts';
import type { GeometryObject } from './scene/geometryModel.ts';
import {
  buildStaticGeometrySync,
  disposeGeometryBuild,
  type GeometryBuild,
} from './scene/sceneGeometryBuild.ts';
import { exportSceneToDirectory, importSceneFromDirectory } from './scene/sceneIO.ts';
import { SceneView, type SceneViewState, type TransformChange } from './scene/sceneView/sceneView.ts';
import { initSceneState, sceneReducer } from './scene/sceneReducer.ts';
import { useEngine } from './engine/useEngine.ts';

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
import { DEFAULT_VIEW, type ViewId } from './scene/viewCameras.ts';
import { HeatmapLegend } from './ui/HeatmapLegend.tsx';
import { StatsPanel } from './ui/StatsPanel.tsx';
import { SectionStatsPanel } from './ui/SectionStatsPanel.tsx';
import { RunBar } from './ui/RunBar.tsx';
import { SceneFileControls } from './ui/SceneFileControls.tsx';
import { VolumePanel } from './ui/VolumePanel.tsx';
import { ZonePanel } from './ui/ZonePanel.tsx';
import { SamplingVolumeControls } from './ui/SamplingVolumeControls.tsx';
import type { Bvh } from '@linkervision/camera-coverage-sdk';

const CHUNK_SIZE_XZ = 10;
const DEFAULT_VOXEL_SIZE = 0.5;
const DEBOUNCE_MS = 250;
const AUTO_RUN_MAX_HZ = 10;

/** Human-readable message for a scene-file import/export failure (spec §14.8). */
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
  // The retained-chunk consumers (probe visibility, section heatmap, zone
  // coverage) + the run-generation guard, behind one coordinator (spec §9,
  // §12–§13, §14.4). App drives its reset/addChunk/clear and reads through it; the
  // overlay (the fourth consumer) stays inline below since SceneView owns it.
  const coverageRun = useMemo(() => new CoverageRun(), []);

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
  const [zoneLevel, setZoneLevel] = useState(DEFAULT_ZONE_LEVEL);
  const [boxLevel, setBoxLevel] = useState(DEFAULT_BOX_LEVEL);

  // Zones restrict coverage only when enabled and at least one volume exists
  // (`sampling_volumes.md` §2.2); otherwise the full-volume fallback applies.
  const samplingActive = useZones && volumes.length > 0;
  // The marked-set filter for the overlay/sections (§7.3): union of enabled
  // zones' volumes, or null ⇒ full volume. A pure client-side re-filter —
  // recomputed on volume/zone (enable) change without any recompute.
  const markedFilter = useMemo(
    () => makeMarkedFilter(samplingActive, volumes, zones),
    [samplingActive, volumes, zones],
  );
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
  const [summary, setSummary] = useState<CoverageSummary | null>(null);
  const [autoRun, setAutoRun] = useState(true);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [transformSpace, setTransformSpace] = useState<TransformSpace>(DEFAULT_TRANSFORM_SPACE);
  const [gizmosVisible, setGizmosVisible] = useState(true);
  // Master show/hide-all for the sampling-volume gizmos (viewport toolbar, spec
  // §2.4). Purely visual — independent of `useZones` and per-zone enabled state.
  const [zonesVisible, setZonesVisible] = useState(true);
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
  // Scene-file import/export state (spec §14.7, §14.8).
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [sceneIOBusy, setSceneIOBusy] = useState(false);
  const fileSystemAccessAvailable = useMemo(() => typeof window !== 'undefined' && 'showDirectoryPicker' in window, []);

  const selectedCameraId = selection?.kind === 'camera' ? selection.id : null;
  const selectedProbeId = selection?.kind === 'probe' ? selection.id : null;
  const selectedSectionId = selection?.kind === 'section' ? selection.id : null;
  const selectedZoneId = selection?.kind === 'zone' ? selection.id : null;
  const selectedVolumeId = selection?.kind === 'volume' ? selection.id : null;

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
    // The marked filter blacks out columns outside the enabled zones' union
    // (spec §7.3); a volume/zone-enable change re-filters here, no recompute.
    () => coverageRun.sectionCells(sections, markedFilter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, masksVersion, coverageRun, markedFilter],
  );

  // --- per-zone coverage aggregation (`sampling_volumes.md` §7.2): recomputed
  // from the retained run whenever zone membership/enabled or a new run replaces
  // the retained masks. Per-zone stats are broken out for every zone; the
  // enabled-union drives the overlay/main stats (§7.3, §7.4). --------------------
  const zoneCoverage = useMemo(
    () => coverageRun.zoneCoverage(zones, volumes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zones, volumes, masksVersion, coverageRun],
  );
  const enabledUnionSummary = zoneCoverage?.enabledUnion ?? null;

  // Apply a resolved transform edit emitted by SceneView after a drag (spec
  // §12.4, §13.8). Mirrors the old per-kind `onObjectChange` setters; whether an
  // edit marks the result stale is governed by which state it touches (a probe or
  // section never does — spec §12.5, §13.4 — via the stale effects below).
  const applyTransformChange = useCallback((change: TransformChange) => {
    dispatch({ type: 'transformApplied', change });
  }, []);

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
      const view = await SceneView.create(container);
      if (cancelled) {
        view.dispose();
        return;
      }
      view.onSelect((next) => dispatch({ type: 'selectionChanged', selection: next }));
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
  const sceneViewState = useMemo<SceneViewState>(
    () => ({
      room,
      cameras,
      probes,
      sections,
      volumes,
      selection,
      flaggedCameras: engine.state.flaggedCameras,
      sectionCellGrids,
      enabledZoneIds,
      markedFilter,
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
    }),
    [
      room, cameras, probes, sections, volumes, selection, engine.state.flaggedCameras,
      sectionCellGrids, enabledZoneIds, markedFilter, overlayOptions, transformMode,
      transformSpace, activeView, gizmosVisible, zonesVisible, sectionsVisible, stale,
      voxelSize, clipBand, sightlines,
    ],
  );

  useEffect(() => {
    viewRef.current?.sync(sceneViewState);
  }, [sceneViewState, viewportReady]);

  // Unified enable/disable for the hierarchy row checkboxes (spec §5.4, §13, §7.3):
  // a camera (compute participation), a section (heatmap on/off), or a zone
  // (contributes to the marked set). Toggling a section or zone is a client-side
  // re-filter only — neither marks the coverage result stale.
  const handleToggleEnabled = useCallback((kind: 'camera' | 'section' | 'zone', id: string) => {
    dispatch({ type: 'toggleEnabled', kind, id });
  }, []);

  const handleCameraChange = useCallback((id: string, patch: Partial<CameraConfig>) => {
    dispatch({ type: 'changeCamera', id, patch });
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
        },
      });
      setSummary(null);
      setInitializedVoxelSize(null);
      initializedRoomRef.current = null;
      viewRef.current?.resetCoverage(); // the overlay lives in SceneView
      coverageRun.clear(); // wipes the three stores + invalidates in-flight runs
      setMasksVersion((v) => v + 1);
      setSceneError(null);
    },
    [coverageRun],
  );

  const handleImportScene = useCallback(async () => {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ mode: 'read' });
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
      });
    } catch (err) {
      // Nothing above this point touched app state, so the current scene is
      // left completely untouched on failure (spec §14.4, §14.8).
      setSceneError(describeSceneError(err));
    } finally {
      setSceneIOBusy(false);
    }
  }, [applyScene]);

  const handleExportScene = useCallback(async () => {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setSceneError(describeSceneError(err));
      return;
    }
    setSceneIOBusy(true);
    try {
      const current: Scene = { geometry: geometryObjects, cameras, probes, sections, clipSectionId, zones, volumes, useZones };
      await exportSceneToDirectory(dir, current);
      setSceneError(null);
    } catch (err) {
      setSceneError(describeSceneError(err));
    } finally {
      setSceneIOBusy(false);
    }
  }, [geometryObjects, cameras, probes, sections, clipSectionId, zones, volumes, useZones]);

  const handleRun = useCallback(async () => {
    // Snapshot the scene "generation": if `applyScene` (import/reset) bumps
    // this while we're mid-run, every check below discards this run's results
    // instead of applying them — the in-scope stand-in for "cancel any
    // in-flight compute" (spec §14.4; see `coverageRun`'s guard).
    const gen = coverageRun.generation;
    const needsReinit =
      initializedVoxelSize === null || initializedVoxelSize !== debouncedVoxelSize || initializedRoomRef.current !== room;
    if (needsReinit) {
      const initResult = await engine.initAndLoad(room.sceneMesh, room.worldMin, room.worldMax, debouncedVoxelSize, CHUNK_SIZE_XZ);
      if (!coverageRun.isCurrent(gen)) return;
      if (!initResult) {
        setInitializedVoxelSize(null);
        return;
      }
      setInitializedVoxelSize(debouncedVoxelSize);
      initializedRoomRef.current = room;
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
    const enabledCameras = stateRef.current.cameras.filter((c) => c.enabled);
    const ok = engine.setCameras(enabledCameras.map(toCameraConfig));
    if (!ok) return;

    // Retain this run's chunks + ordered enabled-camera ids for probe lookup
    // (spec §12.2), in parallel with the overlay (which SceneView owns).
    const grid = new WorkspaceGrid({
      worldMin: room.worldMin,
      worldMax: room.worldMax,
      voxelSize: debouncedVoxelSize,
      chunkSizeXZ: CHUNK_SIZE_XZ,
    });
    coverageRun.reset(grid, enabledCameras.map((c) => c.id));
    viewRef.current?.resetCoverage();
    const result = await engine.compute({
      mode: 1,
      onChunkDone: (_chunkId, chunkResult) => {
        // A newer scene may have replaced (and cleared) the stores mid-stream;
        // don't let a stale chunk repopulate them (spec §14.4).
        if (!coverageRun.isCurrent(gen)) return;
        viewRef.current?.addCoverageChunk(chunkResult);
        coverageRun.addChunk(chunkResult);
      },
    });
    if (!coverageRun.isCurrent(gen)) return;
    if (result) {
      setSummary(result);
      dispatch({ type: 'runCompleted' });
      setMasksVersion((v) => v + 1);
    }
  }, [engine, room, initializedVoxelSize, debouncedVoxelSize, coverageRun]);

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
      if (staleRef.current && !busyRef.current && engineStatusRef.current !== 'error') {
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

  // Camera id → display name (spec §5.6), so every per-camera stat list (§10, §13.7,
  // `sampling_volumes.md` §6.2) and the probe visibility list read the camera's name
  // rather than its raw id.
  const cameraNameById = useMemo(
    () => new Map(cameras.map((c) => [c.id, cameraLabel(c)])),
    [cameras],
  );

  // The main StatsPanel reflects the enabled-zones union when zones are active
  // (`sampling_volumes.md` §7.4): overriding the SDK summary's coverage numbers
  // with the union's, while keeping its elapsed time.
  const displaySummary =
    samplingActive && enabledUnionSummary && summary
      ? {
          ...summary,
          overallRate: enabledUnionSummary.overallRate,
          validVoxels: enabledUnionSummary.validVoxels,
          perCamera: enabledUnionSummary.perCamera,
        }
      : summary;
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
    <div className="app">
      <div className="left-panel" ref={leftPanelRef}>
        <SceneFileControls
          fileSystemAccessAvailable={fileSystemAccessAvailable}
          busy={sceneIOBusy}
          error={sceneError}
          onImport={handleImportScene}
          onExport={handleExportScene}
        />
        <div className="panel hierarchy-panel">
          <SceneHierarchy
            cameras={cameras}
            probes={probes}
            sections={sections}
            zones={zones}
            volumes={volumes}
            selection={selection}
            flaggedIds={engine.state.flaggedCameras}
            perCamera={summary?.perCamera ?? null}
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
          {selectedVolume ? (
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
            />
          )}
        </div>
      </div>
      <div className="viewport-col">
        <div className="viewport" ref={containerRef}>
          <div className="viewport-toolbar">
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
          <div className="viewport-toolbar-center">
            <ViewSelector activeView={activeView} onSelect={setActiveView} />
          </div>
          <div className="viewport-toolbar-right">
            <ViewportLayerMenu
              coverageVisible={overlayOptions.visible}
              sectionsVisible={sectionsVisible}
              camerasVisible={gizmosVisible}
              zonesVisible={zonesVisible}
              onToggleCoverage={() => setOverlayOptions((o) => ({ ...o, visible: !o.visible }))}
              onToggleSections={() => setSectionsVisible((v) => !v)}
              onToggleCameras={() => setGizmosVisible((v) => !v)}
              onToggleZones={() => setZonesVisible((v) => !v)}
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
      <div className="sidebar">
        <RunBar
          status={engine.state.status}
          stale={stale}
          backend={engine.state.backend}
          errorMessage={engine.state.errorMessage}
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
    </div>
  );
}
