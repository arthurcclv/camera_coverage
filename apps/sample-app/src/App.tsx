/**
 * Layout, engine lifecycle, and state orchestration (spec §2.2).
 * Three.js runs imperatively inside a ref-driven effect; React owns the
 * CameraConfig[] / overlay-option state and pushes it into the scene.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CameraConfig, CoverageSummary } from '@linkervision/camera-coverage-sdk';

import { buildRoom } from './scene/buildRoom.ts';
import { createViewport, type RenderBackend, type Viewport } from './scene/viewport.ts';
import { CameraGizmoSet } from './scene/cameraGizmos.ts';
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
import { selectionAfterClick, type PointerPos } from './scene/viewportSelection.ts';
import { defaultCameras } from './cameras/defaults.ts';
import { useEngine } from './engine/useEngine.ts';

import { SceneHierarchy } from './ui/SceneHierarchy.tsx';
import { CameraPanel } from './ui/CameraPanel.tsx';
import { OverlayControls } from './ui/OverlayControls.tsx';
import { StatsPanel } from './ui/StatsPanel.tsx';
import { RunBar } from './ui/RunBar.tsx';

const CHUNK_SIZE_XZ = 10;
const DEFAULT_VOXEL_SIZE = 0.5;
const DEBOUNCE_MS = 250;
const AUTO_RUN_MAX_HZ = 10;

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

  const [cameras, setCameras] = useState<CameraConfig[]>(() => defaultCameras());
  const [selectedId, setSelectedId] = useState<string | null>(cameras[0]?.id ?? null);
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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const gizmosRef = useRef<CameraGizmoSet | null>(null);
  const overlayRef = useRef<CoverageOverlay | null>(null);
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  const disabledIdsRef = useRef(disabledIds);
  disabledIdsRef.current = disabledIds;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
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
      const overlay = new CoverageOverlay();
      viewport.scene.add(room.group);
      viewport.scene.add(gizmos.group);
      viewport.scene.add(overlay.object);

      viewportRef.current = viewport;
      gizmosRef.current = gizmos;
      overlayRef.current = overlay;
      setRenderBackend(viewport.renderBackend);

      // Apply any option/camera state that changed before setup completed
      // (the [overlayOptions]/[cameras]/[selectedId] effects no-op while the
      // refs are still null during async init).
      overlay.setOptions(overlayOptionsRef.current);
      gizmos.update(camerasRef.current, selectedIdRef.current, engineFlaggedRef.current, disabledIdsRef.current);
      gizmos.group.visible = gizmosVisibleRef.current;
      viewport.transformControls.setSpace(threeSpace(transformSpaceRef.current));
      if (selectedIdRef.current) {
        const target = gizmos.getAttachTarget(selectedIdRef.current);
        if (target) viewport.transformControls.attach(target);
      }

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
        const hitId = gizmos.pick(raycaster);
        setSelectedId((prev) => selectionAfterClick(prev, hitId, down, { x: ev.clientX, y: ev.clientY }));
      };
      viewport.renderer.domElement.addEventListener('pointerdown', onPointerDown);
      viewport.renderer.domElement.addEventListener('click', onClick);

      const onObjectChange = () => {
        if (!selectedIdRef.current) return;
        const readback = gizmos.readTransform(selectedIdRef.current);
        if (!readback) return;
        gizmos.syncHelper(selectedIdRef.current);
        setCameras((prev) =>
          prev.map((c) => (c.id === selectedIdRef.current ? { ...c, position: readback.position, rotation: readback.rotation } : c)),
        );
      };
      viewport.transformControls.addEventListener('objectChange', onObjectChange);

      teardown = () => {
        viewport.renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        viewport.renderer.domElement.removeEventListener('click', onClick);
        viewport.transformControls.removeEventListener('objectChange', onObjectChange);
        overlay.dispose();
        gizmos.dispose();
        viewport.dispose();
        viewportRef.current = null;
        gizmosRef.current = null;
        overlayRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // --- push camera state into gizmos + TransformControls attachment --------
  useEffect(() => {
    gizmosRef.current?.update(cameras, selectedId, engine.state.flaggedCameras, disabledIds);
  }, [cameras, selectedId, engine.state.flaggedCameras, disabledIds]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const gizmos = gizmosRef.current;
    if (!viewport || !gizmos) return;
    if (selectedId) {
      const target = gizmos.getAttachTarget(selectedId);
      if (target) viewport.transformControls.attach(target);
    } else {
      viewport.transformControls.detach();
    }
  }, [selectedId]);

  useEffect(() => {
    viewportRef.current?.transformControls.setMode(transformMode);
  }, [transformMode]);

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

  // --- mark results stale on any input change after the first run ----------
  useEffect(() => {
    if (hasRunOnce) setStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, debouncedVoxelSize, disabledIds]);

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

  const handleToggleCollapse = useCallback((nodeId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
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

    overlayRef.current?.reset();
    const result = await engine.compute({
      mode: 1,
      onChunkDone: (_chunkId, chunkResult) => overlayRef.current?.addChunk(chunkResult),
    });
    if (result) {
      setSummary(result);
      setHasRunOnce(true);
      setStale(false);
    }
  }, [engine, room, initializedVoxelSize, debouncedVoxelSize]);

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

  const selectedCamera = cameras.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="app">
      <div className="viewport-col">
        <div className="viewport" ref={containerRef}>
          <div className="viewport-toolbar">
            <button
              type="button"
              className={`btn secondary icon-btn${transformMode === 'translate' ? ' active' : ''}`}
              title="Move"
              aria-label="Move"
              aria-pressed={transformMode === 'translate'}
              onClick={() => setTransformMode('translate')}
            >
              <MoveIcon />
            </button>
            <button
              type="button"
              className={`btn secondary icon-btn${transformMode === 'rotate' ? ' active' : ''}`}
              title="Rotate"
              aria-label="Rotate"
              aria-pressed={transformMode === 'rotate'}
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
        <div className="panel">
          <p className="panel-title">Scene</p>
          <SceneHierarchy
            cameras={cameras}
            selectedId={selectedId}
            flaggedIds={engine.state.flaggedCameras}
            disabledIds={disabledIds}
            perCamera={summary?.perCamera ?? null}
            collapsedIds={collapsedIds}
            onSelectCamera={setSelectedId}
            onToggleEnabled={handleToggleEnabled}
            onToggleCollapse={handleToggleCollapse}
          />
        </div>
        <CameraPanel
          camera={selectedCamera}
          flagged={selectedId ? engine.state.flaggedCameras.has(selectedId) : false}
          onChange={handleCameraChange}
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
