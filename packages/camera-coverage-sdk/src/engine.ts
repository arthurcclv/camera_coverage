/**
 * VisibilityEngine orchestration (§16.1).
 *
 * Lifecycle: init → loadScene → setSampling → setCameras → compute.
 * Chunks are processed one at a time; per-chunk GPU buffers (in the WebGPU
 * backend) are released immediately after readback (§9.4).
 */

import {
  EngineError,
  EngineErrorCode,
  MAX_CAMERAS,
  type CameraConfig,
  type ChunkResult,
  type ComputeOptions,
  type CoverageSummary,
  type EngineOptions,
  type GpuCapabilities,
  type SamplingConfig,
  type SamplingStats,
  type SceneMesh,
  type SceneStats,
  type Vec3,
  type VisibilityEngine,
  type WorkspaceConfig,
} from './types.ts';
import { CellType } from './types.ts';
import { WorkspaceGrid } from './grid.ts';
import type { CleanMesh } from './geometry/mesh.ts';
import type { Bvh } from './geometry/bvh.ts';
import type { Occupancy } from './occupancy.ts';
import { SamplingState } from './sampling.ts';
import {
  camWords as computeCamWords,
  frustumIntersectsAabb,
  prepareCamera,
  type PreparedCamera,
} from './camera.ts';
import { assembleChunkResult } from './results.ts';
import { CpuBackend, type ComputeBackend } from './backend.ts';
import { tsKernels, type Kernels } from './kernels.ts';

export interface EngineInternalOptions {
  /** Emit warnings (default via console.warn). */
  onWarning?: (code: EngineErrorCode, message: string, detail?: unknown) => void;
  /**
   * Scene-preprocessing kernels (mesh clean / BVH / occupancy / SVO). Defaults
   * to the pure-TS port; pass the Rust WASM kernels from `createWasmKernels`
   * for the spec's WASM path.
   */
  kernels?: Kernels;
}

const DEFAULT_WORKSPACE: WorkspaceConfig = {
  worldMin: [0, 0, 0],
  worldMax: [100, 20, 100],
  voxelSize: 0.1,
  chunkSizeXZ: 10,
};

export class CoverageEngine implements VisibilityEngine {
  private grid!: WorkspaceGrid;
  private backend: ComputeBackend | null = null;
  private solidDetection = true;
  private onWarning: NonNullable<EngineInternalOptions['onWarning']>;
  private kernels: Kernels;

  private mesh: CleanMesh | null = null;
  private bvh: Bvh | null = null;
  private occupancy: Occupancy | null = null;
  private sampling: SamplingState | null = null;

  private cameraConfigs: CameraConfig[] = [];
  private cameras: PreparedCamera[] = [];
  private cameraEnabled: boolean[] = [];

  private disposed = false;

  constructor(opts?: EngineInternalOptions) {
    this.onWarning =
      opts?.onWarning ??
      ((code, msg) => console.warn(`[camera-coverage] ${code}: ${msg}`));
    this.kernels = opts?.kernels ?? tsKernels;
  }

  async init(config: WorkspaceConfig & EngineOptions): Promise<GpuCapabilities> {
    const cfg: WorkspaceConfig = {
      worldMin: config.worldMin ?? DEFAULT_WORKSPACE.worldMin,
      worldMax: config.worldMax ?? DEFAULT_WORKSPACE.worldMax,
      voxelSize: config.voxelSize ?? DEFAULT_WORKSPACE.voxelSize,
      chunkSizeXZ: config.chunkSizeXZ ?? DEFAULT_WORKSPACE.chunkSizeXZ,
    };
    this.grid = new WorkspaceGrid(cfg);
    this.solidDetection = config.solidDetection ?? true;

    const backendKind = config.backend ?? 'auto';
    this.backend = await createBackend(backendKind);
    this.disposed = false;
    return this.backend.capabilities;
  }

  async loadScene(mesh: SceneMesh): Promise<SceneStats> {
    this.assertReady();
    const clean = this.kernels.cleanMesh(mesh);

    const ceiling = this.backend!.capabilities.triangleCeiling;
    if (clean.triangleCount > ceiling) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Scene has ${clean.triangleCount} triangles; backend ceiling is ${ceiling}.`,
        { suggestedCeiling: ceiling },
      );
    }

    this.mesh = clean;
    this.bvh = this.kernels.buildBvh(clean);
    this.occupancy = this.kernels.computeOccupancy(this.grid, clean, this.solidDetection);
    await this.backend!.setScene(this.bvh, clean);

    // Re-derive sampling if it was set before the scene.
    if (this.sampling) this.recomputeSamplingState();
    this.refreshCameraEnabled();

    return {
      triangles: clean.triangleCount,
      removedTriangles: clean.removed,
      bvhNodes: this.bvh.nodeCount,
      aabb: clean.aabb,
    };
  }

  private samplingConfig: SamplingConfig | null = null;
  private recomputeSamplingState(): void {
    if (!this.occupancy || !this.samplingConfig) return;
    this.sampling = new SamplingState(this.grid, this.occupancy, this.samplingConfig);
  }

  async setSampling(config: SamplingConfig): Promise<SamplingStats> {
    this.assertReady();
    this.samplingConfig = config;
    if (!this.occupancy) {
      throw new EngineError(
        EngineErrorCode.INVALID_STATE,
        'setSampling requires loadScene first',
      );
    }
    this.recomputeSamplingState();
    const summary = this.sampling!.summarize();
    return { validVoxels: summary.validVoxels, activeChunks: summary.activeChunks };
  }

  setCameras(cameras: CameraConfig[]): void {
    this.assertReady();
    if (cameras.length > MAX_CAMERAS) {
      throw new EngineError(
        EngineErrorCode.TOO_MANY_CAMERAS,
        `${cameras.length} cameras exceeds the ${MAX_CAMERAS} limit.`,
      );
    }
    this.cameraConfigs = cameras;
    this.cameras = cameras.map(prepareCamera);
    this.refreshCameraEnabled();
  }

  /** Flag cameras positioned inside geometry (§17 CAMERA_INSIDE_GEOMETRY). */
  private refreshCameraEnabled(): void {
    this.cameraEnabled = this.cameras.map(() => true);
    if (!this.occupancy) return;
    const [nx, ny, nz] = this.occupancy.dims;
    const vs = this.grid.voxelSize;
    const wm = this.grid.worldMin;
    for (let c = 0; c < this.cameras.length; c++) {
      const p = this.cameras[c].position;
      const i = Math.floor((p[0] - wm[0]) / vs);
      const j = Math.floor((p[1] - wm[1]) / vs);
      const k = Math.floor((p[2] - wm[2]) / vs);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const cell = this.occupancy.cells[i + nx * (j + ny * k)];
      // Only a camera enclosed in SOLID interior is "inside geometry"; a camera
      // merely adjacent to a wall sits in a MIXED voxel and stays active (§18.3).
      if (cell === CellType.SolidGeometry) {
        this.cameraEnabled[c] = false;
        this.onWarning(
          EngineErrorCode.CAMERA_INSIDE_GEOMETRY,
          `Camera '${this.cameras[c].id}' is inside geometry; its coverage is recorded as 0.`,
          { cameraId: this.cameras[c].id },
        );
      }
    }
  }

  async compute(opts?: ComputeOptions): Promise<CoverageSummary> {
    this.assertReady();
    if (!this.bvh || !this.sampling || !this.occupancy) {
      throw new EngineError(
        EngineErrorCode.INVALID_STATE,
        'compute requires loadScene, setSampling, and setCameras first',
      );
    }
    const mode = opts?.mode ?? 1;
    const threshold = opts?.threshold ?? 1;
    const precull = opts?.precull ?? true;
    // §11.1: omitting `onChunkDone` declares a stats-only run, so the backend
    // skips per-voxel readback entirely. `CoverageSummary` is unaffected.
    const emitVoxels = !!opts?.onChunkDone;
    const numCameras = this.cameras.length;
    const cw = computeCamWords(Math.max(1, numCameras));

    const chunkIds =
      opts?.chunks ?? Array.from({ length: this.grid.chunkCount }, (_, i) => i);

    const totalVisible = new Array<number>(numCameras).fill(0);
    let totalValid = 0;
    let totalCovered = 0;

    const start = now();

    for (const chunkId of chunkIds) {
      const chunk = this.grid.chunk(chunkId);
      const { validity, validCount } = this.sampling.chunkValidity(chunk);
      if (validCount === 0) continue;

      const activeMask = this.chunkActiveMask(chunk, cw, precull);
      if (allZero(activeMask)) {
        // Still emit a result so downstream sees the (all-zero) chunk. The dense
        // zero buffers are only materialized when someone consumes them (§11.1).
        const empty = {
          visibility: emitVoxels ? new Uint32Array(chunk.voxelCount * cw) : undefined,
          coverage:
            emitVoxels && mode === 2 ? new Uint32Array(chunk.voxelCount * 4 * cw) : undefined,
          stats: {
            validCount,
            coveredCount: 0,
            visibleCount: new Array<number>(numCameras).fill(0),
          },
        };
        totalValid += validCount;
        this.emitChunk(chunkId, chunk.dims, chunk.origin, cw, mode, validity, empty, opts);
        continue;
      }

      const out = await this.backend!.computeChunk({
        dims: chunk.dims,
        origin: chunk.origin,
        voxelSize: this.grid.voxelSize,
        validity,
        validCount,
        emitVoxels,
        cameras: this.cameras,
        numCameras,
        camWords: cw,
        activeMask,
        bvh: this.bvh,
        mode,
        threshold,
      });

      totalValid += out.stats.validCount;
      totalCovered += out.stats.coveredCount;
      for (let c = 0; c < numCameras; c++) totalVisible[c] += out.stats.visibleCount[c];

      this.emitChunk(chunkId, chunk.dims, chunk.origin, cw, mode, validity, out, opts);
    }

    const elapsedMs = now() - start;

    return {
      perCamera: this.cameras.map((cam, c) => ({
        id: cam.id,
        coverageRate: totalValid > 0 ? totalVisible[c] / totalValid : 0,
      })),
      overallRate: totalValid > 0 ? totalCovered / totalValid : 0,
      validVoxels: totalValid,
      elapsedMs,
    };
  }

  private emitChunk(
    chunkId: number,
    dims: Vec3,
    origin: Vec3,
    cw: number,
    mode: 1 | 2,
    validity: Uint32Array,
    out: { visibility?: Uint32Array; coverage?: Uint32Array; stats: ChunkResult['stats'] },
    opts?: ComputeOptions,
  ): void {
    if (!opts?.onChunkDone || !out.visibility) return;
    const result = assembleChunkResult(
      chunkId,
      dims,
      origin,
      this.grid.voxelSize,
      cw,
      mode,
      validity,
      out,
      this.kernels.buildSvo,
    );
    opts?.onChunkDone?.(chunkId, result);
  }

  private chunkActiveMask(
    chunk: { origin: Vec3; dims: Vec3 },
    cw: number,
    precull: boolean,
  ): Uint32Array {
    const mask = new Uint32Array(cw);
    const vs = this.grid.voxelSize;
    const min = chunk.origin;
    const max: Vec3 = [
      chunk.origin[0] + chunk.dims[0] * vs,
      chunk.origin[1] + chunk.dims[1] * vs,
      chunk.origin[2] + chunk.dims[2] * vs,
    ];
    for (let c = 0; c < this.cameras.length; c++) {
      if (!this.cameraEnabled[c]) continue;
      if (precull && !frustumIntersectsAabb(this.cameras[c], min, max)) continue;
      mask[c >> 5] |= 1 << (c & 31);
    }
    return mask;
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
    this.mesh = null;
    this.bvh = null;
    this.occupancy = null;
    this.sampling = null;
    this.cameras = [];
    this.disposed = true;
  }

  private assertReady(): void {
    if (this.disposed) {
      throw new EngineError(EngineErrorCode.INVALID_STATE, 'Engine is disposed; call init again.');
    }
    if (!this.backend) {
      throw new EngineError(EngineErrorCode.INVALID_STATE, 'Engine not initialized; call init first.');
    }
  }
}

async function createBackend(kind: 'auto' | 'webgpu' | 'cpu'): Promise<ComputeBackend> {
  if (kind === 'cpu') return new CpuBackend();

  const hasWebGpu =
    typeof navigator !== 'undefined' && !!(navigator as { gpu?: unknown }).gpu;
  if (!hasWebGpu) {
    if (kind === 'webgpu' || kind === 'auto') {
      throw new EngineError(
        EngineErrorCode.WEBGPU_UNAVAILABLE,
        'WebGPU is not available. Use a supported browser (Chrome/Edge 113+), ' +
          "or pass backend: 'cpu' for headless/reference computation.",
      );
    }
  }
  const { WebGpuBackend } = await import('./compute/webgpu.ts');
  return WebGpuBackend.create();
}

function allZero(a: Uint32Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
