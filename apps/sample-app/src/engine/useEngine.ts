/**
 * WorkerClient lifecycle + init/loadScene/compute wrappers (spec §3).
 * Runs the SDK inside a Web Worker; falls back auto -> cpu on init failure
 * (§3.2) and surfaces CAMERA_INSIDE_GEOMETRY warnings (§11) via a side-channel
 * 'warning' message posted by worker.ts (the public VisibilityEngine
 * interface has no warning channel of its own).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EngineError,
  EngineErrorCode,
  WorkerClient,
  type CameraConfig,
  type ComputeOptions,
  type CoverageSummary,
  type SamplingRegion,
  type SamplingStats,
  type SceneMesh,
  type SceneStats,
  type Vec3,
  type AggregateResult,
  type AggregateSpec,
} from '@linkervision/camera-coverage-sdk';

export type EngineStatus = 'idle' | 'initializing' | 'ready' | 'computing' | 'error';

export interface EngineState {
  status: EngineStatus;
  backend: 'webgpu' | 'cpu' | null;
  errorMessage: string | null;
  flaggedCameras: Set<string>;
  sceneStats: SceneStats | null;
  samplingStats: SamplingStats | null;
  /**
   * Valid voxels in the whole workspace — the SDK's full-volume
   * `SamplingStats.validVoxels`, captured at init/re-init and NOT overwritten by
   * the box-restricted `setSampling` of an active run (whose regions cover only
   * the boxes' neighborhood, `sampling_volumes.md` §7.1). This is the "% of full"
   * denominator (§6.3, §7.4).
   */
  fullValidVoxels: number | null;
}

export interface InitResult {
  backend: 'webgpu' | 'cpu';
  sceneStats: SceneStats;
  samplingStats: SamplingStats;
}

/**
 * Build the `WorkerClient.init` config (spec §3.2, §4.2).
 *
 * `solidDetection` is hard-coded `false`: the SDK's flood-fill SOLID detection
 * assumes closed objects float in reachable open space, but a watertight
 * imported room (§14) inverts that and its whole interior — cameras included —
 * would be marked `SOLID_GEOMETRY` (every in-room camera flagged
 * `CAMERA_INSIDE_GEOMETRY`, coverage zeroed). Visibility is unaffected: it always
 * comes from BVH ray casting, never occupancy.
 *
 * It is also what keeps occupancy off the worker's heap: SDK §6.2 materializes
 * occupancy per chunk and retains nothing unless solid detection is on, whose
 * global flood fill needs the whole workspace grid. At this app's resolutions
 * that is the difference between ~0 and ~95 MiB held for the session.
 */
export function initConfig(
  worldMin: Vec3,
  worldMax: Vec3,
  voxelSize: number,
  chunkSizeXZ: number,
  backend: 'auto' | 'cpu',
) {
  return { worldMin, worldMax, voxelSize, chunkSizeXZ, solidDetection: false, backend };
}

const INITIAL_STATE: EngineState = {
  status: 'idle',
  backend: null,
  errorMessage: null,
  flaggedCameras: new Set(),
  sceneStats: null,
  samplingStats: null,
  fullValidVoxels: null,
};

export function useEngine() {
  const [state, setState] = useState<EngineState>(INITIAL_STATE);
  const clientRef = useRef<WorkerClient | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    clientRef.current = WorkerClient.fromWorker(worker);

    worker.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data as { kind?: string; code?: string; detail?: { cameraId?: string } };
      if (data?.kind === 'warning' && data.code === 'CAMERA_INSIDE_GEOMETRY' && data.detail?.cameraId) {
        setState((s) => ({ ...s, flaggedCameras: new Set(s.flaggedCameras).add(data.detail!.cameraId!) }));
      }
    });

    return () => {
      clientRef.current?.dispose();
      worker.terminate();
    };
  }, []);

  /** init -> loadScene -> setSampling(full). Falls back to backend:'cpu' on any init failure. */
  const initAndLoad = useCallback(
    async (mesh: SceneMesh, worldMin: Vec3, worldMax: Vec3, voxelSize: number, chunkSizeXZ: number): Promise<InitResult | null> => {
      const client = clientRef.current;
      if (!client) return null;
      setState((s) => ({ ...s, status: 'initializing', errorMessage: null }));

      let backend: 'webgpu' | 'cpu';
      try {
        const caps = await client.init(initConfig(worldMin, worldMax, voxelSize, chunkSizeXZ, 'auto'));
        backend = caps.backend;
      } catch {
        try {
          const caps = await client.init(initConfig(worldMin, worldMax, voxelSize, chunkSizeXZ, 'cpu'));
          backend = caps.backend;
        } catch (err) {
          setState((s) => ({ ...s, status: 'error', errorMessage: describeError(err) }));
          return null;
        }
      }

      try {
        // Clone: loadScene transfers the underlying buffers (detaches them).
        const sceneStats = await client.loadScene({
          positions: mesh.positions.slice(),
          indices: mesh.indices.slice(),
        });
        const samplingStats = await client.setSampling({ regions: [{ type: 'full' }] });
        setState((s) => ({
          ...s,
          status: 'ready',
          backend,
          errorMessage: null,
          sceneStats,
          samplingStats,
          // Full-volume sampling ⇒ this is the whole-workspace valid count (the
          // "% of full" denominator). Box-restricted runs won't overwrite it.
          fullValidVoxels: samplingStats.validVoxels,
        }));
        return { backend, sceneStats, samplingStats };
      } catch (err) {
        setState((s) => ({ ...s, status: 'error', errorMessage: describeError(err) }));
        return null;
      }
    },
    [],
  );

  const setCameras = useCallback((cameras: CameraConfig[]): boolean => {
    const client = clientRef.current;
    if (!client) return false;
    setState((s) => ({ ...s, flaggedCameras: new Set(), errorMessage: null }));
    try {
      client.setCameras(cameras);
      return true;
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', errorMessage: describeError(err) }));
      return false;
    }
  }, []);

  /**
   * Update the sampled region set (`sampling_volumes.md` §8). Mirrors
   * `setCameras`: no re-init needed (only a `voxelSize` change requires that,
   * spec §6), so volume edits are as cheap as camera edits. Returns the
   * `SamplingStats` (valid-voxel count for the new set), or null on failure.
   */
  const setSampling = useCallback(async (regions: SamplingRegion[]): Promise<SamplingStats | null> => {
    const client = clientRef.current;
    if (!client) return null;
    try {
      const samplingStats = await client.setSampling({ regions });
      setState((s) => ({ ...s, samplingStats }));
      return samplingStats;
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', errorMessage: describeError(err) }));
      return null;
    }
  }, []);

  /**
   * Re-reduce the worker's retained masks under a new descriptor (spec §3.3) —
   * the path a zone move, a section drag, or an overlay-mode switch takes. No
   * ray cast: none of those edits can change a mask bit.
   *
   * Deliberately does **not** touch `status`. A recompute is a run the user is
   * waiting on and the UI says so; a re-aggregation is a panel catching up within
   * a frame, and flashing 'computing' for it would read as work that isn't
   * happening. Failures are swallowed for the same reason a superseded compute's
   * cancellation is (§11): the previous numbers stay on screen, and the next
   * edit or run reconciles them.
   */
  const reaggregate = useCallback(
    async (spec: AggregateSpec, onAggregate: (r: AggregateResult) => void): Promise<boolean> => {
      const client = clientRef.current;
      if (!client) return false;
      try {
        await client.aggregateRetained(spec, { onAggregate });
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const compute = useCallback(
    async (opts: ComputeOptions): Promise<CoverageSummary | null> => {
      const client = clientRef.current;
      if (!client) return null;
      setState((s) => ({ ...s, status: 'computing', errorMessage: null }));
      try {
        const summary = await client.compute(opts);
        setState((s) => ({ ...s, status: 'ready' }));
        return summary;
      } catch (err) {
        // A cancellation is this app asking the engine to stop (SDK spec §13.2),
        // not a failure: surfacing it would show an error banner for a run the
        // user's own edit superseded, and stop Auto-run from retrying (§11).
        if (err instanceof EngineError && err.code === EngineErrorCode.COMPUTE_CANCELED) {
          setState((s) => ({ ...s, status: 'ready' }));
          return null;
        }
        setState((s) => ({ ...s, status: 'error', errorMessage: describeError(err) }));
        return null;
      }
    },
    [],
  );

  return useMemo(
    () => ({ state, initAndLoad, setCameras, setSampling, compute, reaggregate }),
    [state, initAndLoad, setCameras, setSampling, compute, reaggregate],
  );
}

function describeError(err: unknown): string {
  if (err instanceof EngineError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
