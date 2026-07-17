/**
 * Layout, engine lifecycle, and state orchestration (spec §2.2).
 * Three.js runs imperatively inside a ref-driven effect; React owns the
 * CameraConfig[] / overlay-option state and pushes it into the scene.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CameraConfig, CoverageSummary } from '@linkervision/camera-coverage-sdk';

import { buildRoom } from './scene/buildRoom.ts';
import { createViewport, type Viewport } from './scene/viewport.ts';
import { CameraGizmoSet } from './scene/cameraGizmos.ts';
import { CoverageOverlay, type OverlayOptions } from './scene/coverageOverlay.ts';
import { defaultCameras } from './cameras/defaults.ts';
import { useEngine } from './engine/useEngine.ts';

import { CameraList } from './ui/CameraList.tsx';
import { CameraPanel } from './ui/CameraPanel.tsx';
import { OverlayControls } from './ui/OverlayControls.tsx';
import { StatsPanel } from './ui/StatsPanel.tsx';
import { RunBar } from './ui/RunBar.tsx';

const CHUNK_SIZE_XZ = 10;
const DEFAULT_VOXEL_SIZE = 0.5;
const DEBOUNCE_MS = 250;
const AUTO_RUN_MAX_HZ = 10;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const DEFAULT_OVERLAY_OPTIONS: OverlayOptions = {
  maxCameraCount: 10,
  opacity: 0.8,
  hideWellCovered: false,
  wellCoveredThreshold: 3,
  blindSpotsOnly: false,
  visible: true,
};

export function App() {
  const room = useMemo(() => buildRoom(), []);
  const engine = useEngine();

  const [cameras, setCameras] = useState<CameraConfig[]>(() => defaultCameras());
  const [selectedId, setSelectedId] = useState<string | null>(cameras[0]?.id ?? null);
  const [disabledIds, setDisabledIds] = useState<Set<string>>(() => new Set());
  const [overlayOptions, setOverlayOptions] = useState<OverlayOptions>({
    ...DEFAULT_OVERLAY_OPTIONS,
    maxCameraCount: cameras.length,
  });
  const [voxelSize, setVoxelSize] = useState(DEFAULT_VOXEL_SIZE);
  const debouncedVoxelSize = useDebounced(voxelSize, DEBOUNCE_MS);
  const [initializedVoxelSize, setInitializedVoxelSize] = useState<number | null>(null);
  const [summary, setSummary] = useState<CoverageSummary | null>(null);
  const [hasRunOnce, setHasRunOnce] = useState(false);
  const [stale, setStale] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate'>('translate');

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

  const estimatedVoxelCount = useMemo(() => {
    const [x0, y0, z0] = room.worldMin;
    const [x1, y1, z1] = room.worldMax;
    const volume = (x1 - x0) * (y1 - y0) * (z1 - z0);
    return Math.round(volume / voxelSize ** 3);
  }, [room, voxelSize]);

  // --- Three.js scene: created once, torn down on unmount ------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const viewport = createViewport(container);
    const gizmos = new CameraGizmoSet();
    const overlay = new CoverageOverlay();
    viewport.scene.add(room.group);
    viewport.scene.add(gizmos.group);
    viewport.scene.add(overlay.object);

    viewportRef.current = viewport;
    gizmosRef.current = gizmos;
    overlayRef.current = overlay;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onClick = (ev: MouseEvent) => {
      const rect = viewport.renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, viewport.camera);
      const hitId = gizmos.pick(raycaster);
      if (hitId) setSelectedId(hitId);
    };
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

    return () => {
      viewport.renderer.domElement.removeEventListener('click', onClick);
      viewport.transformControls.removeEventListener('objectChange', onObjectChange);
      overlay.dispose();
      gizmos.dispose();
      viewport.dispose();
      viewportRef.current = null;
      gizmosRef.current = null;
      overlayRef.current = null;
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

  // --- push overlay option state into the overlay ---------------------------
  useEffect(() => {
    overlayRef.current?.setOptions(overlayOptions);
  }, [overlayOptions]);

  const enabledCameraCount = cameras.length - disabledIds.size;

  useEffect(() => {
    setOverlayOptions((o) => ({ ...o, maxCameraCount: enabledCameraCount }));
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
              className={`btn secondary${transformMode === 'translate' ? ' active' : ''}`}
              onClick={() => setTransformMode('translate')}
            >
              Move
            </button>
            <button
              className={`btn secondary${transformMode === 'rotate' ? ' active' : ''}`}
              onClick={() => setTransformMode('rotate')}
            >
              Rotate
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
          <p className="panel-title">Cameras</p>
          <CameraList
            cameras={cameras}
            selectedId={selectedId}
            flaggedIds={engine.state.flaggedCameras}
            disabledIds={disabledIds}
            perCamera={summary?.perCamera ?? null}
            onSelect={setSelectedId}
            onToggleEnabled={handleToggleEnabled}
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
          numCameras={enabledCameraCount}
        />
        <StatsPanel summary={summary} backend={engine.state.backend} voxelSize={debouncedVoxelSize} />
      </div>
    </div>
  );
}
