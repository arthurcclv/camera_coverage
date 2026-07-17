/**
 * Layout, engine lifecycle, and state orchestration (spec §2.2).
 * Three.js runs imperatively inside a ref-driven effect; React owns the
 * CameraConfig[] / Probe[] / overlay-option state and pushes it into the scene.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { WorkspaceGrid, type CameraConfig, type CoverageSummary, type Vec3 } from '@linkervision/camera-coverage-sdk';

import { buildRoom } from './scene/buildRoom.ts';
import { createViewport, type RenderBackend, type Viewport } from './scene/viewport.ts';
import { CameraGizmoSet } from './scene/cameraGizmos.ts';
import { ProbeGizmoSet } from './scene/probeGizmos.ts';
import { ProbeVisibility, type Probe, type ProbeVisibilityResult } from './scene/probeVisibility.ts';
import { CoverageOverlay, DEFAULT_OVERLAY_HUE, type OverlayOptions } from './scene/coverageOverlay.ts';
import {
  DEFAULT_TRANSFORM_SPACE,
  spaceIconKind,
  spaceTooltip,
  threeSpace,
  toggleSpace,
  type TransformSpace,
} from './scene/transformSpace.ts';
import { DEFAULT_INTENSITY_SCALE } from './scene/volumetric.ts';
import { selectionAfterClick, type PointerPos, type Selection } from './scene/viewportSelection.ts';
import { defaultCameras } from './cameras/defaults.ts';
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
import { OverlayControls } from './ui/OverlayControls.tsx';
import { StatsPanel } from './ui/StatsPanel.tsx';
import { RunBar } from './ui/RunBar.tsx';

const CHUNK_SIZE_XZ = 10;
const DEFAULT_VOXEL_SIZE = 0.5;
const DEBOUNCE_MS = 250;
const AUTO_RUN_MAX_HZ = 10;

// Defaults for a camera spawned from the "+" menu (spec §5.5), matching the
// default rig's optics (cameras/defaults.ts).
const NEW_CAMERA = { fov: 60, aspect: 16 / 9, near: 0.1, far: 30 };

/** Next free `prefix-N` id given the existing ids (spec §5.5). */
function nextFreeId(prefix: string, ids: string[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

// Viewport top-right toolbar icons (spec §2.4): stacked-planes for the coverage
// overlay, a camera body for the frustum gizmos.
function LayersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
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
  const room = useMemo(() => buildRoom(), []);
  const engine = useEngine();
  const probeVisibility = useMemo(() => new ProbeVisibility(), []);

  const workspaceCenter = useMemo<Vec3>(
    () => [
      (room.worldMin[0] + room.worldMax[0]) / 2,
      (room.worldMin[1] + room.worldMax[1]) / 2,
      (room.worldMin[2] + room.worldMax[2]) / 2,
    ],
    [room],
  );

  const [cameras, setCameras] = useState<CameraConfig[]>(() => defaultCameras());
  const [probes, setProbes] = useState<Probe[]>([]);
  const [selection, setSelection] = useState<Selection>(() =>
    cameras[0] ? { kind: 'camera', id: cameras[0].id } : null,
  );
  const [disabledIds, setDisabledIds] = useState<Set<string>>(() => new Set());
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
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate'>('translate');
  const [transformSpace, setTransformSpace] = useState<TransformSpace>(DEFAULT_TRANSFORM_SPACE);
  const [gizmosVisible, setGizmosVisible] = useState(true);
  // Per-probe visibility queries against the retained run (spec §12.2), keyed by
  // probe id. Recomputed when probes move or a new run's masks arrive.
  const [probeQueries, setProbeQueries] = useState<Map<string, ProbeVisibilityResult>>(new Map());
  // Bumped whenever a completed run replaces the retained masks (spec §12.2).
  const [masksVersion, setMasksVersion] = useState(0);

  const selectedCameraId = selection?.kind === 'camera' ? selection.id : null;
  const selectedProbeId = selection?.kind === 'probe' ? selection.id : null;

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
  const overlayRef = useRef<CoverageOverlay | null>(null);
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  const probesRef = useRef(probes);
  probesRef.current = probes;
  const disabledIdsRef = useRef(disabledIds);
  disabledIdsRef.current = disabledIds;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const overlayOptionsRef = useRef(overlayOptions);
  overlayOptionsRef.current = overlayOptions;
  const gizmosVisibleRef = useRef(gizmosVisible);
  gizmosVisibleRef.current = gizmosVisible;
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
      const overlay = new CoverageOverlay();
      viewport.scene.add(room.group);
      viewport.scene.add(gizmos.group);
      viewport.scene.add(probeGizmos.group);
      viewport.scene.add(overlay.object);

      viewportRef.current = viewport;
      gizmosRef.current = gizmos;
      probeGizmosRef.current = probeGizmos;
      overlayRef.current = overlay;
      setRenderBackend(viewport.renderBackend);

      // Apply any option/camera/probe state that changed before setup completed.
      overlay.setOptions(overlayOptionsRef.current);
      const sel = selectionRef.current;
      gizmos.update(camerasRef.current, sel?.kind === 'camera' ? sel.id : null, engineFlaggedRef.current, disabledIdsRef.current);
      gizmos.group.visible = gizmosVisibleRef.current;
      probeGizmos.update(probesRef.current, sel?.kind === 'probe' ? sel.id : null);
      viewport.transformControls.setSpace(threeSpace(transformSpaceRef.current));
      attachForSelection(viewport, gizmos, probeGizmos, sel);

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
        raycaster.setFromCamera(pointer, viewport.camera);
        // Nearest hit across cameras and probes (spec §5.2, §12.4). Hidden camera
        // gizmos are not clickable (spec §2.4).
        const camHit = gizmosVisibleRef.current ? gizmos.pickHit(raycaster) : null;
        const probeHit = probeGizmos.pickHit(raycaster);
        let hit: Selection = null;
        if (camHit && (!probeHit || camHit.distance <= probeHit.distance)) hit = { kind: 'camera', id: camHit.id };
        else if (probeHit) hit = { kind: 'probe', id: probeHit.id };
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
        } else {
          // Moving a probe never marks results stale (spec §12.5).
          const position = probeGizmos.readPosition(sel.id);
          if (!position) return;
          setProbes((prev) => prev.map((p) => (p.id === sel.id ? { ...p, position } : p)));
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
        viewport.dispose();
        viewportRef.current = null;
        gizmosRef.current = null;
        probeGizmosRef.current = null;
        overlayRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // --- push camera/probe state into gizmos ---------------------------------
  useEffect(() => {
    gizmosRef.current?.update(cameras, selectedCameraId, engine.state.flaggedCameras, disabledIds);
  }, [cameras, selectedCameraId, engine.state.flaggedCameras, disabledIds]);

  useEffect(() => {
    probeGizmosRef.current?.update(probes, selectedProbeId);
  }, [probes, selectedProbeId]);

  // --- TransformControls attachment + mode per selection kind (spec §12.4) ---
  useEffect(() => {
    const viewport = viewportRef.current;
    const gizmos = gizmosRef.current;
    const probeGizmos = probeGizmosRef.current;
    if (!viewport || !gizmos || !probeGizmos) return;
    attachForSelection(viewport, gizmos, probeGizmos, selection);
  }, [selection]);

  useEffect(() => {
    // A probe is a point — translate only, ignoring the rotate mode (spec §12.4).
    const mode = selection?.kind === 'probe' ? 'translate' : transformMode;
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

  const enabledCameraCount = cameras.length - disabledIds.size;

  useEffect(() => {
    setOverlayOptions((o) => ({ ...o, involvedCameraCount: enabledCameraCount }));
  }, [enabledCameraCount]);

  // --- mark results stale on any camera/resolution change after the first run.
  // Probe edits are intentionally excluded (spec §12.5). ----------------------
  useEffect(() => {
    if (hasRunOnce) setStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, debouncedVoxelSize, disabledIds]);

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

  const handleToggleEnabled = useCallback((id: string) => {
    setDisabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCameraChange = useCallback((id: string, patch: Partial<CameraConfig>) => {
    setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const handleProbeChange = useCallback((id: string, position: Vec3) => {
    setProbes((prev) => prev.map((p) => (p.id === id ? { ...p, position } : p)));
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
    setCameras((prev) => [...prev, { id, position: [...workspaceCenter] as Vec3, rotation: [0, 0, 0, 1], ...NEW_CAMERA }]);
    setSelection({ kind: 'camera', id });
  }, [workspaceCenter]);

  const handleAddProbe = useCallback(() => {
    const id = nextFreeId('probe', probesRef.current.map((p) => p.id));
    setProbes((prev) => [...prev, { id, position: [...workspaceCenter] as Vec3 }]);
    setSelection({ kind: 'probe', id });
  }, [workspaceCenter]);

  const handleDeleteCamera = useCallback((id: string) => {
    setCameras((prev) => prev.filter((c) => c.id !== id));
    setDisabledIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSelection((prev) => (prev?.kind === 'camera' && prev.id === id ? null : prev));
  }, []);

  const handleDeleteProbe = useCallback((id: string) => {
    setProbes((prev) => prev.filter((p) => p.id !== id));
    setSelection((prev) => (prev?.kind === 'probe' && prev.id === id ? null : prev));
  }, []);

  const handleRun = useCallback(async () => {
    const needsReinit = initializedVoxelSize === null || initializedVoxelSize !== debouncedVoxelSize;
    if (needsReinit) {
      const initResult = await engine.initAndLoad(room.sceneMesh, room.worldMin, room.worldMax, debouncedVoxelSize, CHUNK_SIZE_XZ);
      if (!initResult) {
        setInitializedVoxelSize(null);
        return;
      }
      setInitializedVoxelSize(debouncedVoxelSize);
    }

    const enabledCameras = camerasRef.current.filter((c) => !disabledIdsRef.current.has(c.id));
    const ok = engine.setCameras(enabledCameras);
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
    overlayRef.current?.reset();
    const result = await engine.compute({
      mode: 1,
      onChunkDone: (_chunkId, chunkResult) => {
        overlayRef.current?.addChunk(chunkResult);
        probeVisibility.addChunk(chunkResult);
      },
    });
    if (result) {
      setSummary(result);
      setHasRunOnce(true);
      setStale(false);
      setMasksVersion((v) => v + 1);
    }
  }, [engine, room, initializedVoxelSize, debouncedVoxelSize, probeVisibility]);

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
        <div className="panel hierarchy-panel">
          <SceneHierarchy
            cameras={cameras}
            probes={probes}
            selection={selection}
            flaggedIds={engine.state.flaggedCameras}
            disabledIds={disabledIds}
            perCamera={summary?.perCamera ?? null}
            probeSeenCounts={probeSeenCounts}
            collapsedIds={collapsedIds}
            onSelect={setSelection}
            onToggleEnabled={handleToggleEnabled}
            onToggleCollapse={handleToggleCollapse}
            onAddCamera={handleAddCamera}
            onAddProbe={handleAddProbe}
            onDeleteCamera={handleDeleteCamera}
            onDeleteProbe={handleDeleteProbe}
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
          {selectedProbe ? (
            <ProbePanel
              probe={selectedProbe}
              query={probeQueries.get(selectedProbe.id)}
              hasRunOnce={hasRunOnce}
              stale={stale}
              onChange={handleProbeChange}
              onSelectCamera={(id) => setSelection({ kind: 'camera', id })}
            />
          ) : (
            <CameraPanel
              camera={selectedCamera}
              flagged={selectedCameraId ? engine.state.flaggedCameras.has(selectedCameraId) : false}
              onChange={handleCameraChange}
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
              className="btn secondary icon-btn"
              title={spaceTooltip(transformSpace)}
              aria-label={spaceTooltip(transformSpace)}
              onClick={() => setTransformSpace((s) => toggleSpace(s))}
            >
              {spaceIconKind(transformSpace) === 'box' ? <BoxIcon /> : <GlobeIcon />}
            </button>
          </div>
          <div className="viewport-toolbar-right">
            <button
              type="button"
              className={`btn secondary icon-btn${overlayOptions.visible ? ' active' : ''}`}
              title={overlayOptions.visible ? 'Hide coverage overlay' : 'Show coverage overlay'}
              aria-pressed={overlayOptions.visible}
              onClick={() => setOverlayOptions((o) => ({ ...o, visible: !o.visible }))}
            >
              <LayersIcon />
            </button>
            <button
              type="button"
              className={`btn secondary icon-btn${gizmosVisible ? ' active' : ''}`}
              title={gizmosVisible ? 'Hide camera gizmos' : 'Show camera gizmos'}
              aria-pressed={gizmosVisible}
              onClick={() => setGizmosVisible((v) => !v)}
            >
              <CameraIcon />
            </button>
          </div>
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
        <StatsPanel
          summary={summary}
          computeBackend={engine.state.backend}
          renderBackend={renderBackend}
          voxelSize={debouncedVoxelSize}
        />
      </div>
    </div>
  );
}

/** Attach TransformControls to the selected entity's target, or detach (spec §12.4). */
function attachForSelection(
  viewport: Viewport,
  gizmos: CameraGizmoSet,
  probeGizmos: ProbeGizmoSet,
  selection: Selection,
): void {
  const target =
    selection?.kind === 'camera'
      ? gizmos.getAttachTarget(selection.id)
      : selection?.kind === 'probe'
        ? probeGizmos.getAttachTarget(selection.id)
        : undefined;
  if (target) viewport.transformControls.attach(target);
  else viewport.transformControls.detach();
}
