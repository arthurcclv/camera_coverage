/**
 * Public types for the 3D Camera Coverage Analysis engine.
 * Mirrors the interfaces defined in specs/spec.md.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // xyzw

// ---------------------------------------------------------------------------
// §3 Spatial model
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  /** Minimum corner of the workspace AABB (m). Default [0,0,0]. */
  worldMin: Vec3;
  /** Maximum corner of the workspace AABB (m). Default [100,20,100] (Y is height). */
  worldMax: Vec3;
  /** Voxel edge length (m). Default 0.1. */
  voxelSize: number;
  /** Horizontal (XZ) chunk edge length (m). Default 10. Chunk height = full workspace height. */
  chunkSizeXZ: number;
}

export interface EngineOptions {
  /**
   * Flood-fill SOLID detection for interiors of closed objects. Default true.
   * When false, every non-MIXED voxel is treated as EMPTY (§6.2 fallback).
   */
  solidDetection?: boolean;
  /**
   * Compute backend.
   *  - 'auto'   : WebGPU if available, otherwise reject `init` with WEBGPU_UNAVAILABLE (§16.4)
   *  - 'webgpu' : force WebGPU (reject if unavailable)
   *  - 'cpu'    : reference implementation (headless / testing; not for production scale)
   * Default 'auto'.
   */
  backend?: 'auto' | 'webgpu' | 'cpu';
}

// ---------------------------------------------------------------------------
// §5 Input data
// ---------------------------------------------------------------------------

export interface SceneMesh {
  /** xyz interleaved, world space, meters. */
  positions: Float32Array;
  /** Triangle indices, length a multiple of 3. */
  indices: Uint32Array;
}

export interface CameraConfig {
  id: string;
  position: Vec3;
  rotation: Quat; // quaternion xyzw
  fov: number; // vertical FOV, degrees, (0, 180)
  aspect?: number; // default 16/9
  near?: number; // default 0.1
  far?: number; // effective detection range, default 50
}

// ---------------------------------------------------------------------------
// §6.3 Sampling
// ---------------------------------------------------------------------------

export type SamplingRegion =
  | { type: 'full' }
  | { type: 'heightBand'; yMin: number; yMax: number }
  | { type: 'box'; min: Vec3; max: Vec3 };

export interface SamplingConfig {
  /** Union of regions. */
  regions: SamplingRegion[];
  /** L2 voxel sampling stride. Default 1. */
  stride?: 1 | 2 | 4;
}

// ---------------------------------------------------------------------------
// Occupancy cell classification (§6.2)
// ---------------------------------------------------------------------------

export const CellType = {
  EmptySpace: 0,
  MixedSpace: 1,
  SolidGeometry: 2,
} as const;
export type CellType = (typeof CellType)[keyof typeof CellType];

// ---------------------------------------------------------------------------
// Results (§9, §16.1)
// ---------------------------------------------------------------------------

export interface SvoChunk {
  chunkId: number;
  rootSize: number; // 256
  depth: number; // log2(rootSize)
  /** Grid dimensions of the *actual* chunk extent (X,Y,Z voxels). */
  dims: Vec3;
  camWords: number;
  mode: 1 | 2;
  nodeChild: Uint32Array; // internal: first child index; leaf: LEAF (0xFFFFFFFF)
  nodeKey: Uint32Array; // leaf: mask word (CAM_WORDS==1 & mode 1) or palette index; internal: 0
  nodeValid: Uint8Array; // leaf: 0/1; internal: 0
  palette?: Uint32Array; // CAM_WORDS>1 or Mode 2: dedup mask/coverage values
}

export interface ChunkResult {
  chunkId: number;
  encoding: 'svo' | 'dense';
  /** Dimensions of the chunk voxel grid (X,Y,Z). */
  dims: Vec3;
  /** World-space minimum corner of the chunk (m). */
  origin: Vec3;
  voxelSize: number;
  camWords: number;
  mode: 1 | 2;

  // encoding === 'svo'
  svo?: SvoChunk;

  // encoding === 'dense'
  visibility?: Uint32Array; // CAM_WORDS words per voxel
  validity?: Uint32Array; // 1 word per 32 voxels
  coverage?: Uint32Array; // Mode 2: 4 × CAM_WORDS words per voxel

  stats: { validCount: number; coveredCount: number; visibleCount: number[] };
}

export interface CoverageSummary {
  perCamera: { id: string; coverageRate: number }[];
  overallRate: number; // fraction visible to ≥ 1 camera
  validVoxels: number;
  elapsedMs: number;
}

export interface GpuCapabilities {
  backend: 'webgpu' | 'cpu';
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupsPerDimension: number;
  maxComputeInvocationsPerWorkgroup: number;
  /** Highest triangle count the current binding size supports. */
  triangleCeiling: number;
  /** Whether Mode 2 dense buffers fit for the configured chunk size. */
  mode2Available: boolean;
}

export interface SceneStats {
  triangles: number;
  /** Triangles removed at load (degenerate / NaN). */
  removedTriangles: number;
  bvhNodes: number;
  aabb: { min: Vec3; max: Vec3 };
}

export interface SamplingStats {
  /** Number of valid sampling voxels across the whole workspace. */
  validVoxels: number;
  /** Chunks that contain at least one valid voxel. */
  activeChunks: number;
}

export interface ComputeOptions {
  mode?: 1 | 2;
  threshold?: number; // Mode 2, default 1
  chunks?: number[]; // omitted = all
  onChunkDone?: (chunkId: number, result: ChunkResult) => void;
  /**
   * Chunk-level camera pre-cull (§7.2). Default true. Toggling it must never
   * change the output (acceptance test §18.5a) — exposed for that test.
   */
  precull?: boolean;
}

export interface VisibilityEngine {
  init(config: WorkspaceConfig & EngineOptions): Promise<GpuCapabilities>;
  loadScene(mesh: SceneMesh): Promise<SceneStats>;
  setSampling(config: SamplingConfig): Promise<SamplingStats>;
  setCameras(cameras: CameraConfig[]): void;
  compute(opts?: ComputeOptions): Promise<CoverageSummary>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// §17 Errors
// ---------------------------------------------------------------------------

export const EngineErrorCode = {
  WEBGPU_UNAVAILABLE: 'WEBGPU_UNAVAILABLE',
  SCENE_TOO_LARGE: 'SCENE_TOO_LARGE',
  TOO_MANY_CAMERAS: 'TOO_MANY_CAMERAS',
  CAMERA_INSIDE_GEOMETRY: 'CAMERA_INSIDE_GEOMETRY',
  DEVICE_LOST: 'DEVICE_LOST',
  INVALID_STATE: 'INVALID_STATE',
} as const;
export type EngineErrorCode = (typeof EngineErrorCode)[keyof typeof EngineErrorCode];

export class EngineError extends Error {
  code: EngineErrorCode;
  detail?: unknown;
  constructor(code: EngineErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

export const MAX_CAMERAS = 128;
