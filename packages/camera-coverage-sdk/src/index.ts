/**
 * @linkervision/camera-coverage
 * GPU-accelerated 3D camera visibility / coverage analysis engine.
 *
 * See specs/spec.md for the full technical specification.
 */

export { CoverageEngine } from './engine.ts';
export type { EngineInternalOptions } from './engine.ts';

import { CoverageEngine } from './engine.ts';
import type { VisibilityEngine } from './types.ts';

/** Convenience factory returning a fresh engine instance. */
export function createEngine(): VisibilityEngine {
  return new CoverageEngine();
}

// Public types
export type {
  WorkspaceConfig,
  EngineOptions,
  SceneMesh,
  CameraConfig,
  SamplingRegion,
  SamplingConfig,
  ChunkResult,
  SvoChunk,
  CoverageSummary,
  GpuCapabilities,
  SceneStats,
  SamplingStats,
  ComputeOptions,
  RunStart,
  VisibilityEngine,
  Vec3,
  Quat,
} from './types.ts';

export { CellType, EngineError, EngineErrorCode, MAX_CAMERAS } from './types.ts';

// Accessors + lower-level building blocks (useful for visualization / testing)
export { accessor, denseAccessor } from './results.ts';
export { buildSvo, svoAccessor, LEAF } from './svo.ts';
export type { VoxelAccessor, DenseChunk } from './svo.ts';
export { WorkspaceGrid, voxelCenter, localIndex, placementOf, suggestChunkSizeXZ } from './grid.ts';
export type { ChunkGrid, ChunkPlacement } from './grid.ts';
export { prepareCamera, packCameras, camWords, pointInFrustum, frustumIntersectsAabb } from './camera.ts';
export type { PreparedCamera } from './camera.ts';
export { buildBvh } from './geometry/bvh.ts';
export type { Bvh } from './geometry/bvh.ts';
export { cleanMesh } from './geometry/mesh.ts';
export type { CleanMesh } from './geometry/mesh.ts';
export { computeOccupancy } from './occupancy.ts';
export type { OccupancySource } from './occupancy.ts';
export { ChunkOccupancy, DenseOccupancy, occupancyCounters } from './occupancy.ts';

// WGSL shader sources (for advanced / custom pipelines)
export {
  PASS1_FRUSTUM,
  PASS2_VISIBILITY,
  PASS3_STATS,
  PASS4_REGIONS,
  PASS5_COLUMNS,
  PASS6_LEAFCOUNTS,
} from './shaders.ts';

// Aggregation (§19)
export type {
  AggregateSpec,
  AggregateRegion,
  AggregateSlab,
  AggregateLeafCounts,
  AggregateProjection,
  ProjectionAccum,
  AggregateResult,
  RegionAccum,
  ColumnAccum,
  LeafCounts,
  AggregateChunkInput,
  PackedAggregate,
} from './aggregate.ts';
export {
  COLUMN_MIN_EMPTY,
  ProbeHit,
  MAX_AGGREGATE_REGIONS,
  MAX_AGGREGATE_SLABS,
  MAX_AGGREGATE_PROBES,
  MAX_AGGREGATE_GROUPS,
  MAX_AGGREGATE_PROJECTIONS,
  MAX_PROJECTION_RESOLUTION,
  MAX_PROJECTION_PLANES,
  aggregateChunkCPU,
  aggregateIsEmpty,
  emptyColumns,
  mergeLeafCounts,
  emptyRegions,
  mergeColumns,
  mergeProjections,
  emptyProjections,
  mergeRegions,
  packAggregate,
  projectionBin,
  planeAxes,
  regionMask,
  validateAggregateSpec,
} from './aggregate.ts';

// Compute kernels: pure-TS (default) and the Rust WASM loader
export { tsKernels } from './kernels.ts';
export type { Kernels } from './kernels.ts';
export { createWasmKernels } from './wasm/loader.ts';
export { buildSvo as buildSvoTs } from './svo.ts';

// Web Worker host / client (§16)
export { WorkerClient } from './worker/client.ts';
export { installHost, type HostOptions } from './worker/host.ts';
export { messageTransport, loopback } from './worker/protocol.ts';
export type { Transport } from './worker/protocol.ts';
