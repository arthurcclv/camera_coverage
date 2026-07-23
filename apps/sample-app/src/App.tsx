/**
 * Layout, engine lifecycle, and state orchestration (spec §2.2).
 * Three.js runs imperatively inside a ref-driven effect; React owns the
 * CameraConfig[] / Probe[] / overlay-option state and pushes it into the scene.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { WorkspaceGrid, type CameraConfig, type CoverageSummary, type Vec3 } from '@linkervision/camera-coverage-sdk';

import { createViewport, type RenderBackend, type Viewport } from './scene/viewport.ts';
import { CameraGizmoSet } from './scene/cameraGizmos.ts';
import { ProbeGizmoSet } from './scene/probeGizmos.ts';
import { cameraLabel, toCameraConfig, type SceneCamera } from './cameras/camera.ts';
import { ProbeVisibility, type Probe, type ProbeVisibilityResult } from './scene/probeVisibility.ts';
import { SectionGizmoSet } from './scene/sectionGizmos.ts';
import {
  axisMapping,
  defaultSection,
  sectionClipBand,
  SectionHeatmapStore,
  type Section,
  type SectionCellGrid,
} from './scene/sectionHeatmap.ts';
import { CoverageOverlay, DEFAULT_OVERLAY_HUE, type OverlayOptions } from './scene/coverageOverlay.ts';
import { SamplingVolumeGizmoSet } from './scene/samplingVolumeGizmos.ts';
import {
  buildSceneBvh,
  DEFAULT_BOX_LEVEL,
  DEFAULT_ZONE_LEVEL,
  defaultZoneName,
  extractZonesAndVolumes,
  makeMarkedFilter,
  minVolumeSize,
  regionsFromVolumes,
  ZoneCoverageStore,
  type SamplingVolume,
  type Zone,
} from './scene/samplingVolumes.ts';
import {
  DEFAULT_TRANSFORM_SPACE,
  spaceIconKind,
  spaceTooltip,
  threeSpace,
  toggleSpace,
  type TransformSpace,
} from './scene/transformSpace.ts';
import { DEFAULT_INTENSITY_SCALE } from './scene/volumetric.ts';
import {
  duplicateCamera,
  duplicateProbe,
  duplicateSection,
  duplicateVolume,
  duplicateZone,
  nextFreeId,
} from './scene/entityDuplication.ts';
import { selectionAfterClick, type PointerPos, type Selection } from './scene/viewportSelection.ts';
import { defaultGeometry } from './scene/buildRoom.ts';
import { defaultScene, type Scene } from './scene/sceneModel.ts';
import type { GeometryObject } from './scene/geometryModel.ts';
import {
  buildStaticGeometrySync,
  clipBandPlanes,
  disposeGeometryBuild,
  setGeometryClippingPlanes,
  type GeometryBuild,
} from './scene/sceneGeometryBuild.ts';
import { exportSceneToDirectory, importSceneFromDirectory } from './scene/sceneIO.ts';
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
import { SectionHeatmapControls } from './ui/SectionHeatmapControls.tsx';
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

// Defaults for a camera spawned from the "+" menu (spec §5.5), matching the
// default rig's optics (cameras/defaults.ts).
const NEW_CAMERA = { fov: 60, aspect: 16 / 9, near: 0.1, far: 30 };

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
  const probeVisibility = useMemo(() => new ProbeVisibility(), []);
  const sectionHeatmapStore = useMemo(() => new SectionHeatmapStore(), []);
  // Fourth retained-run consumer (`sampling_volumes.md` §7.2): per-zone coverage
  // aggregation over the same masks that back probes and sections.
  const zoneCoverageStore = useMemo(() => new ZoneCoverageStore(), []);

  const workspaceCenter = useMemo<Vec3>(
    () => [
      (room.worldMin[0] + room.worldMax[0]) / 2,
      (room.worldMin[1] + room.worldMax[1]) / 2,
      (room.worldMin[2] + room.worldMax[2]) / 2,
    ],
    [room],
  );

  const [cameras, setCameras] = useState<SceneCamera[]>(initialScene.cameras);
  const [probes, setProbes] = useState<Probe[]>(initialScene.probes);
  const [sections, setSections] = useState<Section[]>(initialScene.sections);
  // Which section clips the scene geometry (spec §13.9), or null. Scene-level so
  // at most one section ever clips; independent of selection.
  const [clipSectionId, setClipSectionId] = useState<string | null>(initialScene.clipSectionId);
  // Sampling zones/volumes (`sampling_volumes.md` §2). `useZones` gates whether
  // they restrict coverage; each zone's `enabled` flag picks what the visualizers
  // show (the union of enabled zones, §7.3). The generation levels (§3.4) are tool
  // state and don't persist.
  const [zones, setZones] = useState<Zone[]>(initialScene.zones);
  const [volumes, setVolumes] = useState<SamplingVolume[]>(initialScene.volumes);
  const [useZones, setUseZones] = useState(initialScene.useZones);
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
  const [selection, setSelection] = useState<Selection>(() =>
    cameras[0] ? { kind: 'camera', id: cameras[0].id } : null,
  );
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [overlayOptions, setOverlayOptions] = useState<OverlayOptions>({
    ...DEFAULT_OVERLAY_OPTIONS,
    involvedCameraCount: cameras.length,
  });
  const [renderBackend, setRenderBackend] = useState<RenderBackend | null>(null);
  const [voxelSize, setVoxelSize] = useState(DEFAULT_VOXEL_SIZE);
  const debouncedVoxelSize = useDebounced(voxelSize, DEBOUNCE_MS);
  const [initializedVoxelSize, setInitializedVoxelSize] = useState<number | null>(null);
  const [summary, setSummary] = useState<CoverageSummary | null>(null);
  const [hasRunOnce, setHasRunOnce] = useState(false);
  const [stale, setStale] = useState(false);
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
  const viewportRef = useRef<Viewport | null>(null);
  const gizmosRef = useRef<CameraGizmoSet | null>(null);
  const probeGizmosRef = useRef<ProbeGizmoSet | null>(null);
  const sectionGizmosRef = useRef<SectionGizmoSet | null>(null);
  const volumeGizmosRef = useRef<SamplingVolumeGizmoSet | null>(null);
  const overlayRef = useRef<CoverageOverlay | null>(null);
  // Mirrors `room` for the mount effect's async IIFE (spec §2.3), which reads
  // whatever geometry is current by the time the viewport finishes setting up,
  // and for `applyScene`, which disposes the outgoing build.
  const roomRef = useRef(room);
  roomRef.current = room;
  // The `room` the engine was last `initAndLoad`-ed against; `handleRun` forces
  // a re-init when this no longer matches, so a geometry swap (import/reset)
  // isn't masked by voxel size staying the same (spec §14.4).
  const initializedRoomRef = useRef<GeometryBuild | null>(null);
  // Bumped by `applyScene`; `handleRun` discards a run's results if this no
  // longer matches the generation it started with — the in-scope interpretation
  // of "cancel any in-flight compute" (spec §14.4), since the engine/worker
  // exposes no true cancellation primitive today.
  const runGenerationRef = useRef(0);
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  const probesRef = useRef(probes);
  probesRef.current = probes;
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const volumesRef = useRef(volumes);
  volumesRef.current = volumes;
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const enabledZoneIdsRef = useRef(enabledZoneIds);
  enabledZoneIdsRef.current = enabledZoneIds;
  const samplingActiveRef = useRef(samplingActive);
  samplingActiveRef.current = samplingActive;
  const voxelSizeRef = useRef(voxelSize);
  voxelSizeRef.current = voxelSize;
  const markedFilterRef = useRef(markedFilter);
  markedFilterRef.current = markedFilter;
  // Set whenever the sampled region set changes (volume add/delete/transform,
  // `zoneId`, non-empty zone deletion, `useZones`), so the next run re-applies
  // `setSampling` (`sampling_volumes.md` §8). Cleared inside `handleRun`.
  const samplingDirtyRef = useRef(false);
  // Cached app-side BVH (§3.1), keyed on the `room` it was built from; rebuilt
  // lazily on the next Generate after a geometry swap (§11).
  const bvhRef = useRef<{ room: GeometryBuild; bvh: Bvh } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const overlayOptionsRef = useRef(overlayOptions);
  overlayOptionsRef.current = overlayOptions;
  const gizmosVisibleRef = useRef(gizmosVisible);
  gizmosVisibleRef.current = gizmosVisible;
  const zonesVisibleRef = useRef(zonesVisible);
  zonesVisibleRef.current = zonesVisible;
  const sectionsVisibleRef = useRef(sectionsVisible);
  sectionsVisibleRef.current = sectionsVisible;
  const transformSpaceRef = useRef(transformSpace);
  transformSpaceRef.current = transformSpace;
  const engineFlaggedRef = useRef(engine.state.flaggedCameras);
  engineFlaggedRef.current = engine.state.flaggedCameras;

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
  const sectionCellGrids = useMemo(() => {
    const map = new Map<string, SectionCellGrid | null>();
    // The marked filter blacks out columns outside the enabled zones' union
    // (spec §7.3); a volume/zone-enable change re-filters here, no recompute.
    for (const s of sections) map.set(s.id, sectionHeatmapStore.computeCells(s, markedFilter));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, masksVersion, sectionHeatmapStore, markedFilter]);

  // --- per-zone coverage aggregation (`sampling_volumes.md` §7.2): recomputed
  // from the retained run whenever zone membership/enabled or a new run replaces
  // the retained masks. Per-zone stats are broken out for every zone; the
  // enabled-union drives the overlay/main stats (§7.3, §7.4). --------------------
  const zoneCoverage = useMemo(
    () => zoneCoverageStore.compute(zones, volumes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zones, volumes, masksVersion, zoneCoverageStore],
  );
  const enabledUnionSummary = zoneCoverage?.enabledUnion ?? null;

  // --- Three.js scene: created once, torn down on unmount ------------------
  // WebGPURenderer.init() is async (spec §2.3), so setup runs in an async IIFE
  // and teardown is deferred until (or cancels) that setup.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let teardown: (() => void) | null = null;

    (async () => {
      const viewport = await createViewport(container);
      if (cancelled) {
        viewport.dispose();
        return;
      }
      const gizmos = new CameraGizmoSet();
      const probeGizmos = new ProbeGizmoSet();
      const sectionGizmos = new SectionGizmoSet();
      const volumeGizmos = new SamplingVolumeGizmoSet();
      const overlay = new CoverageOverlay();
      // The geometry group itself is added by the dedicated sync effect below
      // (keyed on `[room, viewportReady]`) once this flips true, so the initial
      // add and every later import/reset swap go through one code path.
      viewport.scene.add(gizmos.group);
      viewport.scene.add(probeGizmos.group);
      viewport.scene.add(sectionGizmos.group);
      viewport.scene.add(volumeGizmos.group);
      viewport.scene.add(overlay.object);

      viewportRef.current = viewport;
      gizmosRef.current = gizmos;
      probeGizmosRef.current = probeGizmos;
      sectionGizmosRef.current = sectionGizmos;
      volumeGizmosRef.current = volumeGizmos;
      overlayRef.current = overlay;
      setRenderBackend(viewport.renderBackend);
      setViewportReady(true);

      // Apply any option/camera/probe/section state that changed before setup completed.
      overlay.setOptions(overlayOptionsRef.current);
      overlay.setMarkedFilter(markedFilterRef.current);
      const sel = selectionRef.current;
      gizmos.update(camerasRef.current, sel?.kind === 'camera' ? sel.id : null, engineFlaggedRef.current);
      gizmos.group.visible = gizmosVisibleRef.current;
      probeGizmos.update(probesRef.current, sel?.kind === 'probe' ? sel.id : null);
      volumeGizmos.update(
        volumesRef.current,
        sel?.kind === 'volume' ? sel.id : null,
        enabledZoneIdsRef.current,
      );
      volumeGizmos.group.visible = zonesVisibleRef.current;
      sectionGizmos.update(sectionsRef.current, new Map(), sectionsVisibleRef.current, false);
      viewport.transformControls.setSpace(threeSpace(transformSpaceRef.current));
      attachForSelection(viewport, gizmos, probeGizmos, sectionGizmos, volumeGizmos, sel);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      // A genuine click selects the picked gizmo (or deselects on a miss); the
      // click that fires at the end of an orbit/TransformControls drag leaves
      // the selection unchanged (spec §5.2, see scene/viewportSelection.ts).
      const down: PointerPos = { x: 0, y: 0 };
      const onPointerDown = (ev: PointerEvent) => {
        down.x = ev.clientX;
        down.y = ev.clientY;
      };
      const onClick = (ev: MouseEvent) => {
        const rect = viewport.renderer.domElement.getBoundingClientRect();
        pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, viewport.activeCamera);
        // Nearest hit across cameras, probes, and volumes (spec §5.2, §12.4;
        // `sampling_volumes.md` §5). Hidden camera gizmos are not clickable (spec
        // §2.4). Zones/sections have no viewport body.
        const candidates: { sel: Selection; distance: number }[] = [];
        const camHit = gizmosVisibleRef.current ? gizmos.pickHit(raycaster) : null;
        if (camHit) candidates.push({ sel: { kind: 'camera', id: camHit.id }, distance: camHit.distance });
        const probeHit = probeGizmos.pickHit(raycaster);
        if (probeHit) candidates.push({ sel: { kind: 'probe', id: probeHit.id }, distance: probeHit.distance });
        const volumeHit = volumeGizmos.pickHit(raycaster);
        if (volumeHit) candidates.push({ sel: { kind: 'volume', id: volumeHit.id }, distance: volumeHit.distance });
        const hit: Selection = candidates.length
          ? candidates.reduce((best, c) => (c.distance < best.distance ? c : best)).sel
          : null;
        setSelection((prev) => selectionAfterClick(prev, hit, down, { x: ev.clientX, y: ev.clientY }));
      };
      viewport.renderer.domElement.addEventListener('pointerdown', onPointerDown);
      viewport.renderer.domElement.addEventListener('click', onClick);

      const onObjectChange = () => {
        const sel = selectionRef.current;
        if (!sel) return;
        if (sel.kind === 'camera') {
          const readback = gizmos.readTransform(sel.id);
          if (!readback) return;
          gizmos.syncHelper(sel.id);
          setCameras((prev) =>
            prev.map((c) => (c.id === sel.id ? { ...c, position: readback.position, rotation: readback.rotation } : c)),
          );
        } else if (sel.kind === 'probe') {
          // Moving a probe never marks results stale (spec §12.5).
          const position = probeGizmos.readPosition(sel.id);
          if (!position) return;
          setProbes((prev) => prev.map((p) => (p.id === sel.id ? { ...p, position } : p)));
        } else if (sel.kind === 'volume') {
          // Translate/rotate/scale a volume; scale is floored per axis (≥ a voxel)
          // so a box never degenerates (`sampling_volumes.md` §5). Marks stale
          // (§4.2) via the volumes effect below.
          const t = volumeGizmos.readTransform(sel.id);
          if (!t) return;
          const minSize = minVolumeSize(voxelSizeRef.current);
          const size: Vec3 = [
            Math.max(minSize, t.size[0]),
            Math.max(minSize, t.size[1]),
            Math.max(minSize, t.size[2]),
          ];
          setVolumes((prev) => prev.map((v) => (v.id === sel.id ? { ...v, position: t.position, rotation: t.rotation, size } : v)));
        } else if (sel.kind === 'section') {
          // Free 3-axis translate (spec §13.8): the target's position is the box's
          // new center; thickness/width/height stay fixed (each bound-pair moves as
          // a unit). Never marks results stale (spec §13.4).
          const current = sectionsRef.current.find((s) => s.id === sel.id);
          if (!current) return;
          const { collapseAxis, axisA, axisB } = axisMapping(current.orientation);
          const mid = sectionGizmos.readAxisPosition(sel.id, collapseAxis);
          const centerA = sectionGizmos.readAxisPosition(sel.id, axisA);
          const centerB = sectionGizmos.readAxisPosition(sel.id, axisB);
          if (mid === undefined || centerA === undefined || centerB === undefined) return;
          const halfThickness = (current.max - current.min) / 2;
          const halfA = (current.maxA - current.minA) / 2;
          const halfB = (current.maxB - current.minB) / 2;
          setSections((prev) =>
            prev.map((s) =>
              s.id === sel.id
                ? {
                    ...s,
                    min: mid - halfThickness,
                    max: mid + halfThickness,
                    minA: centerA - halfA,
                    maxA: centerA + halfA,
                    minB: centerB - halfB,
                    maxB: centerB + halfB,
                  }
                : s,
            ),
          );
        }
      };
      viewport.transformControls.addEventListener('objectChange', onObjectChange);

      teardown = () => {
        viewport.renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        viewport.renderer.domElement.removeEventListener('click', onClick);
        viewport.transformControls.removeEventListener('objectChange', onObjectChange);
        overlay.dispose();
        gizmos.dispose();
        probeGizmos.dispose();
        sectionGizmos.dispose();
        volumeGizmos.dispose();
        viewport.dispose();
        viewportRef.current = null;
        gizmosRef.current = null;
        probeGizmosRef.current = null;
        sectionGizmosRef.current = null;
        volumeGizmosRef.current = null;
        overlayRef.current = null;
        setViewportReady(false);
      };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
    // Created once (spec §2.3); geometry/camera/probe/section state changes are
    // pushed into the running viewport by the effects below instead of re-running
    // this setup.
  }, []);

  // --- keep the geometry group in sync with `room` (import/reset, spec §14.4):
  // owns adding/removing it from the scene so a geometry swap never tears down
  // the viewport itself, only the geometry within it. ------------------------
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scene.add(room.group);
    return () => {
      viewport.scene.remove(room.group);
    };
  }, [room, viewportReady]);

  // --- clip cross-section (spec §13.9): clip scene geometry to the band of the
  // section named by `clipSectionId` (at most one; independent of selection).
  // Never triggers compute(). Re-runs on drag (`sections`) and on geometry swap
  // (`room`), which rebuilds the ClippingGroup the planes attach to. -----------
  useEffect(() => {
    const clipped = clipSectionId ? sections.find((s) => s.id === clipSectionId) : undefined;
    const band = clipped ? sectionClipBand(clipped, room.worldMin, room.worldMax) : null;
    setGeometryClippingPlanes(room, band ? clipBandPlanes(band) : []);
  }, [clipSectionId, sections, room]);

  // --- push camera/probe state into gizmos ---------------------------------
  useEffect(() => {
    gizmosRef.current?.update(cameras, selectedCameraId, engine.state.flaggedCameras);
  }, [cameras, selectedCameraId, engine.state.flaggedCameras]);

  useEffect(() => {
    probeGizmosRef.current?.update(probes, selectedProbeId);
  }, [probes, selectedProbeId]);

  useEffect(() => {
    sectionGizmosRef.current?.update(sections, sectionCellGrids, sectionsVisible, stale);
  }, [sections, sectionCellGrids, sectionsVisible, stale]);

  // --- push volume state into gizmos; dim volumes of disabled zones (spec §5) --
  useEffect(() => {
    volumeGizmosRef.current?.update(volumes, selectedVolumeId, enabledZoneIds);
  }, [volumes, selectedVolumeId, enabledZoneIds]);

  // --- push the marked-set filter into the overlay (spec §7.3): a pure
  // client-side re-filter of the retained leaves, no recompute -----------------
  useEffect(() => {
    overlayRef.current?.setMarkedFilter(markedFilter);
  }, [markedFilter]);

  // --- TransformControls attachment + mode per selection kind (spec §12.4, §13.8) ---
  useEffect(() => {
    const viewport = viewportRef.current;
    const gizmos = gizmosRef.current;
    const probeGizmos = probeGizmosRef.current;
    const sectionGizmos = sectionGizmosRef.current;
    const volumeGizmos = volumeGizmosRef.current;
    if (!viewport || !gizmos || !probeGizmos || !sectionGizmos || !volumeGizmos) return;
    attachForSelection(viewport, gizmos, probeGizmos, sectionGizmos, volumeGizmos, selection);
  }, [selection]);

  useEffect(() => {
    // A probe is a point and a section slides along one axis — both translate
    // only (spec §12.4, §13.8). Scale is a volume-only mode (`sampling_volumes.md`
    // §5); on a non-volume selection it falls back to translate.
    let mode: 'translate' | 'rotate' | 'scale' = transformMode;
    if (selection?.kind === 'probe' || selection?.kind === 'section') mode = 'translate';
    else if (transformMode === 'scale' && selection?.kind !== 'volume') mode = 'translate';
    viewportRef.current?.transformControls.setMode(mode);
  }, [transformMode, selection]);

  useEffect(() => {
    viewportRef.current?.transformControls.setSpace(threeSpace(transformSpace));
  }, [transformSpace]);

  // --- push overlay option state into the overlay ---------------------------
  useEffect(() => {
    overlayRef.current?.setOptions(overlayOptions);
  }, [overlayOptions]);

  // --- gizmos visibility toggle (viewport top-right toolbar, spec §2.4) ------
  useEffect(() => {
    if (gizmosRef.current) gizmosRef.current.group.visible = gizmosVisible;
  }, [gizmosVisible]);

  // --- active view (top-middle View selector, spec §2.4). Transient viewport
  // state: defaults to Perspective and is never persisted to the scene file. ---
  useEffect(() => {
    viewportRef.current?.setActiveView(activeView);
  }, [activeView, viewportReady]);

  // --- zones (sampling-volume gizmos) visibility toggle (spec §2.4) ----------
  useEffect(() => {
    if (volumeGizmosRef.current) volumeGizmosRef.current.group.visible = zonesVisible;
  }, [zonesVisible]);

  const enabledCameraCount = cameras.filter((c) => c.enabled).length;

  useEffect(() => {
    setOverlayOptions((o) => ({ ...o, involvedCameraCount: enabledCameraCount }));
  }, [enabledCameraCount]);

  // --- mark results stale on any camera/resolution change after the first run.
  // Probe edits are intentionally excluded (spec §12.5). ----------------------
  useEffect(() => {
    if (hasRunOnce) setStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, debouncedVoxelSize]);

  // --- volumes/useZones are coverage input (`sampling_volumes.md` §4.2, §8):
  // any change marks the result stale *and* the sampled region set dirty, so the
  // next run re-applies `setSampling`. Adding an empty zone or renaming a zone
  // touches only `zones`, so neither marks stale (§4.2). --------------------------
  useEffect(() => {
    samplingDirtyRef.current = true;
    if (hasRunOnce) setStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumes, useZones]);

  // --- probe visibility queries (spec §12.2): recompute for every probe when a
  // probe moves or a completed run replaces the retained masks -----------------
  useEffect(() => {
    const map = new Map<string, ProbeVisibilityResult>();
    for (const p of probes) map.set(p.id, probeVisibility.query(p.position));
    setProbeQueries(map);
  }, [probes, masksVersion, probeVisibility]);

  // --- sightlines from the selected probe to each camera that sees it (§12.4) -
  useEffect(() => {
    const probeGizmos = probeGizmosRef.current;
    if (!probeGizmos) return;
    if (selection?.kind !== 'probe') {
      probeGizmos.setSightlines(null);
      return;
    }
    const probe = probes.find((p) => p.id === selection.id);
    const query = probeQueries.get(selection.id);
    if (!probe || !query || query.status !== 'ok') {
      probeGizmos.setSightlines(null);
      return;
    }
    const targets: Vec3[] = [];
    query.cameraIds.forEach((id, n) => {
      if (!query.visible[n]) return;
      const cam = cameras.find((c) => c.id === id);
      if (cam) targets.push(cam.position);
    });
    probeGizmos.setSightlines(probe.position, targets);
  }, [selection, probeQueries, probes, cameras]);

  // Unified enable/disable for the hierarchy row checkboxes (spec §5.4, §13, §7.3):
  // a camera (compute participation), a section (heatmap on/off), or a zone
  // (contributes to the marked set). Toggling a section or zone is a client-side
  // re-filter only — neither marks the coverage result stale.
  const handleToggleEnabled = useCallback((kind: 'camera' | 'section' | 'zone', id: string) => {
    if (kind === 'camera') {
      // `enabled` rides on the camera entity (spec §5.4), so the toggle is a plain
      // entity edit — the cameras stale effect marks the result stale.
      setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
    } else if (kind === 'section') {
      setSections((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
    } else {
      setZones((prev) => prev.map((z) => (z.id === id ? { ...z, enabled: !z.enabled } : z)));
    }
  }, []);

  const handleCameraChange = useCallback((id: string, patch: Partial<CameraConfig>) => {
    setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const handleProbeChange = useCallback((id: string, position: Vec3) => {
    setProbes((prev) => prev.map((p) => (p.id === id ? { ...p, position } : p)));
  }, []);

  // Renames (spec §5.6): pure display-label writes — like a zone rename they never
  // touch the engine or mark the result stale (§8.1).
  const handleRenameCamera = useCallback((id: string, name: string) => {
    setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
  }, []);

  const handleRenameProbe = useCallback((id: string, name: string) => {
    setProbes((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
  }, []);

  const handleRenameSection = useCallback((id: string, name: string) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  const handleToggleCollapse = useCallback((nodeId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  // --- add / delete entities (spec §5.5, §12.5) ------------------------------
  const handleAddCamera = useCallback(() => {
    const id = nextFreeId('cam', camerasRef.current.map((c) => c.id));
    setCameras((prev) => [...prev, { id, name: '', enabled: true, position: [...workspaceCenter] as Vec3, rotation: [0, 0, 0, 1], ...NEW_CAMERA }]);
    setSelection({ kind: 'camera', id });
  }, [workspaceCenter]);

  const handleAddProbe = useCallback(() => {
    const id = nextFreeId('probe', probesRef.current.map((p) => p.id));
    setProbes((prev) => [...prev, { id, position: [...workspaceCenter] as Vec3, name: '' }]);
    setSelection({ kind: 'probe', id });
  }, [workspaceCenter]);

  const handleAddSection = useCallback(() => {
    const id = nextFreeId('section', sectionsRef.current.map((s) => s.id));
    setSections((prev) => [...prev, defaultSection(id, room.worldMin, room.worldMax)]);
    setSelection({ kind: 'section', id });
  }, [room]);

  const handleSectionChange = useCallback((id: string, patch: Partial<Section>) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  // Clip toggle (spec §13.9): make this section the sole clip, or turn clipping
  // off if it already is the clipping section. Selection is irrelevant.
  const handleToggleSectionClip = useCallback((id: string) => {
    setClipSectionId((prev) => (prev === id ? null : id));
  }, []);

  const handleDeleteCamera = useCallback((id: string) => {
    setCameras((prev) => prev.filter((c) => c.id !== id));
    setSelection((prev) => (prev?.kind === 'camera' && prev.id === id ? null : prev));
  }, []);

  const handleDeleteProbe = useCallback((id: string) => {
    setProbes((prev) => prev.filter((p) => p.id !== id));
    setSelection((prev) => (prev?.kind === 'probe' && prev.id === id ? null : prev));
  }, []);

  const handleDeleteSection = useCallback((id: string) => {
    setSections((prev) => prev.filter((s) => s.id !== id));
    // Deleting the clipping section clears the clip (spec §13.9).
    setClipSectionId((prev) => (prev === id ? null : prev));
    setSelection((prev) => (prev?.kind === 'section' && prev.id === id ? null : prev));
  }, []);

  // --- duplicate entities (spec §5.5) ----------------------------------------
  // A deep verbatim copy with the next free id, coincident with the original and
  // auto-selected. Stale-marking is handled by the cameras/volumes effects above.
  const handleDuplicateCamera = useCallback((id: string) => {
    const copy = duplicateCamera(camerasRef.current, id);
    if (!copy) return;
    // The verbatim copy inherits the original's `enabled` state on the entity (spec §5.5).
    setCameras((prev) => [...prev, copy]);
    setSelection({ kind: 'camera', id: copy.id });
  }, []);

  const handleDuplicateProbe = useCallback((id: string) => {
    const copy = duplicateProbe(probesRef.current, id);
    if (!copy) return;
    setProbes((prev) => [...prev, copy]);
    setSelection({ kind: 'probe', id: copy.id });
  }, []);

  // The copy is created not clipping — clipping is a scene-level selection, not a
  // section property, so it never transfers (spec §5.5, §13.9).
  const handleDuplicateSection = useCallback((id: string) => {
    const copy = duplicateSection(sectionsRef.current, id);
    if (!copy) return;
    setSections((prev) => [...prev, copy]);
    setSelection({ kind: 'section', id: copy.id });
  }, []);

  // --- zones & volumes (`sampling_volumes.md` §3, §4, §6, §7.3) --------------
  // Creating an empty zone does not mark stale (an empty zone marks no voxels, §4).
  // New zones are enabled by default (§7.3).
  const handleAddZone = useCallback(() => {
    const id = nextFreeId('zone', zonesRef.current.map((z) => z.id));
    setZones((prev) => [...prev, { id, name: defaultZoneName(id), enabled: true }]);
    setSelection({ kind: 'zone', id });
  }, []);

  // Adds a 1 m cube at the workspace center into the target zone (the selected
  // zone, or the selected volume's zone, or the first zone; creating "Zone 1"
  // first if none exist). Marks stale via the volumes effect (§4).
  const handleAddVolume = useCallback(() => {
    const currentZones = zonesRef.current;
    const currentVolumes = volumesRef.current;
    const sel = selectionRef.current;
    let targetZoneId =
      sel?.kind === 'zone'
        ? sel.id
        : sel?.kind === 'volume'
          ? currentVolumes.find((v) => v.id === sel.id)?.zoneId ?? null
          : null;
    let nextZones = currentZones;
    if (targetZoneId === null || !currentZones.some((z) => z.id === targetZoneId)) {
      targetZoneId = currentZones[0]?.id ?? null;
    }
    if (targetZoneId === null) {
      const zoneId = nextFreeId('zone', currentZones.map((z) => z.id));
      nextZones = [...currentZones, { id: zoneId, name: defaultZoneName(zoneId), enabled: true }];
      targetZoneId = zoneId;
      setZones(nextZones);
    }
    const id = nextFreeId('volume', currentVolumes.map((v) => v.id));
    setVolumes((prev) => [
      ...prev,
      { id, zoneId: targetZoneId!, position: [...workspaceCenter] as Vec3, rotation: [0, 0, 0, 1], size: [1, 1, 1] },
    ]);
    setSelection({ kind: 'volume', id });
  }, [workspaceCenter]);

  const handleVolumeChange = useCallback((id: string, patch: Partial<SamplingVolume>) => {
    setVolumes((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }, []);

  // Renaming is a pure display-label edit: never marks stale (§6.2).
  const handleRenameZone = useCallback((id: string, name: string) => {
    setZones((prev) => prev.map((z) => (z.id === id ? { ...z, name } : z)));
  }, []);

  const handleToggleUseZones = useCallback((v: boolean) => setUseZones(v), []);

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
    setZones(nextZones);
    setVolumes(nextVolumes);
    setSelection(nextZones[0] ? { kind: 'zone', id: nextZones[0].id } : null);
  }, [room, zoneLevel, boxLevel, voxelSize]);

  // Deleting a volume marks stale (§4). Clears selection if it was selected.
  const handleDeleteVolume = useCallback((id: string) => {
    setVolumes((prev) => prev.filter((v) => v.id !== id));
    setSelection((prev) => (prev?.kind === 'volume' && prev.id === id ? null : prev));
  }, []);

  // Deleting a zone removes it and all its volumes (§4); the volumes removal
  // marks stale when it had any.
  const handleDeleteZone = useCallback((id: string) => {
    setVolumes((prev) => prev.filter((v) => v.zoneId !== id));
    setZones((prev) => prev.filter((z) => z.id !== id));
    setSelection((prev) => (prev?.kind === 'zone' && prev.id === id ? null : prev));
  }, []);

  // Duplicating a volume adds a verbatim copy into the *same* zone (spec §5.5).
  const handleDuplicateVolume = useCallback((id: string) => {
    const copy = duplicateVolume(volumesRef.current, id);
    if (!copy) return;
    setVolumes((prev) => [...prev, copy]);
    setSelection({ kind: 'volume', id: copy.id });
  }, []);

  // Duplicating a zone deep-copies the zone *and* fresh copies of all its volumes
  // (each with a new id, referencing the new zone) (spec §5.5). Marks stale via the
  // volumes effect when the zone had any.
  const handleDuplicateZone = useCallback((id: string) => {
    const copy = duplicateZone(zonesRef.current, volumesRef.current, id);
    if (!copy) return;
    setZones((prev) => [...prev, copy.zone]);
    if (copy.volumes.length > 0) setVolumes((prev) => [...prev, ...copy.volumes]);
    setSelection({ kind: 'zone', id: copy.zone.id });
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
      runGenerationRef.current += 1;
      disposeGeometryBuild(roomRef.current);
      setRoom(next.build);
      setGeometryObjects(next.geometry);
      setCameras(next.cameras);
      setProbes(next.probes);
      setSections(next.sections);
      setClipSectionId(next.clipSectionId);
      // Import replaces zones/volumes from the file (may be empty, §11); the
      // cached BVH is invalidated (rebuilt lazily on the next Generate). The
      // sampled set must be re-applied on the next run.
      setZones(next.zones);
      setVolumes(next.volumes);
      setUseZones(next.useZones);
      bvhRef.current = null;
      samplingDirtyRef.current = true;
      setSelection(next.cameras[0] ? { kind: 'camera', id: next.cameras[0].id } : null);
      setSummary(null);
      setHasRunOnce(false);
      setStale(false);
      setInitializedVoxelSize(null);
      initializedRoomRef.current = null;
      overlayRef.current?.reset();
      probeVisibility.clear();
      sectionHeatmapStore.clear();
      zoneCoverageStore.clear();
      setMasksVersion((v) => v + 1);
      setSceneError(null);
    },
    [probeVisibility, sectionHeatmapStore, zoneCoverageStore],
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
    // in-flight compute" (spec §14.4; see `runGenerationRef`'s declaration).
    const gen = runGenerationRef.current;
    const needsReinit =
      initializedVoxelSize === null || initializedVoxelSize !== debouncedVoxelSize || initializedRoomRef.current !== room;
    if (needsReinit) {
      const initResult = await engine.initAndLoad(room.sceneMesh, room.worldMin, room.worldMax, debouncedVoxelSize, CHUNK_SIZE_XZ);
      if (gen !== runGenerationRef.current) return;
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
    if (needsReinit || samplingDirtyRef.current) {
      const stats = await engine.setSampling(regionsFromVolumes(samplingActiveRef.current, volumesRef.current));
      if (gen !== runGenerationRef.current) return;
      if (!stats) return;
      samplingDirtyRef.current = false;
    }

    // Convert app cameras to plain `CameraConfig` (drop the display `name`) at the
    // SDK boundary — the one place the engine type is required (spec §5.6, §14.1).
    const enabledCameras = camerasRef.current.filter((c) => c.enabled);
    const ok = engine.setCameras(enabledCameras.map(toCameraConfig));
    if (!ok) return;

    // Retain this run's chunks + ordered enabled-camera ids for probe lookup
    // (spec §12.2), in parallel with the overlay.
    const grid = new WorkspaceGrid({
      worldMin: room.worldMin,
      worldMax: room.worldMax,
      voxelSize: debouncedVoxelSize,
      chunkSizeXZ: CHUNK_SIZE_XZ,
    });
    probeVisibility.reset(grid, enabledCameras.map((c) => c.id));
    sectionHeatmapStore.reset(grid, enabledCameras.map((c) => c.id));
    zoneCoverageStore.reset(enabledCameras.map((c) => c.id));
    overlayRef.current?.reset();
    const result = await engine.compute({
      mode: 1,
      onChunkDone: (_chunkId, chunkResult) => {
        // A newer scene may have replaced (and cleared) these stores mid-stream;
        // don't let a stale chunk repopulate them (spec §14.4).
        if (gen !== runGenerationRef.current) return;
        overlayRef.current?.addChunk(chunkResult);
        probeVisibility.addChunk(chunkResult);
        sectionHeatmapStore.addChunk(chunkResult);
        zoneCoverageStore.addChunk(chunkResult);
      },
    });
    if (gen !== runGenerationRef.current) return;
    if (result) {
      setSummary(result);
      setHasRunOnce(true);
      setStale(false);
      setMasksVersion((v) => v + 1);
    }
  }, [engine, room, initializedVoxelSize, debouncedVoxelSize, probeVisibility, sectionHeatmapStore, zoneCoverageStore]);

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
            onSelect={setSelection}
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
              onSelectCamera={(id) => setSelection({ kind: 'camera', id })}
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
          {sectionsVisible && sections.length > 0 && (
            <div className="viewport-legend">
              <SectionHeatmapControls
                aggregation={selectedSection?.aggregation ?? null}
                cameraCount={selectedSection ? (sectionCellGrids.get(selectedSection.id)?.cameraIds.length ?? null) : null}
              />
            </div>
          )}
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

/**
 * Attach TransformControls to the selected entity's target, or detach (spec
 * §12.4, §13.8; `sampling_volumes.md` §5). A zone is a container with no viewport
 * body, so selecting one detaches.
 */
function attachForSelection(
  viewport: Viewport,
  gizmos: CameraGizmoSet,
  probeGizmos: ProbeGizmoSet,
  sectionGizmos: SectionGizmoSet,
  volumeGizmos: SamplingVolumeGizmoSet,
  selection: Selection,
): void {
  const target =
    selection?.kind === 'camera'
      ? gizmos.getAttachTarget(selection.id)
      : selection?.kind === 'probe'
        ? probeGizmos.getAttachTarget(selection.id)
        : selection?.kind === 'section'
          ? sectionGizmos.getAttachTarget(selection.id)
          : selection?.kind === 'volume'
            ? volumeGizmos.getAttachTarget(selection.id)
            : undefined;
  if (target) viewport.transformControls.attach(target);
  else viewport.transformControls.detach();
}
