/**
 * Compute-kernel abstraction for the CPU-side scene preprocessing that the spec
 * assigns to Rust WASM (§4, §6.2, §9.5, §10): mesh cleaning, BVH build,
 * voxelization + flood fill, and SVO construction.
 *
 * Two implementations satisfy this interface:
 *  - `tsKernels` — the pure-TypeScript port (default; used by the test suite).
 *  - the WASM kernels from `wasm/loader.ts` — the Rust crate compiled to
 *    `wasm32-unknown-unknown`.
 */

import type { SvoChunk } from './types.ts';
import { cleanMesh, type CleanMesh } from './geometry/mesh.ts';
import { buildBvh, type Bvh } from './geometry/bvh.ts';
import { computeOccupancy, type OccupancySource } from './occupancy.ts';
import { buildSvo, type DenseChunk } from './svo.ts';
import type { SceneMesh } from './types.ts';
import type { WorkspaceGrid } from './grid.ts';

export interface Kernels {
  cleanMesh(mesh: SceneMesh): CleanMesh;
  buildBvh(clean: CleanMesh): Bvh;
  computeOccupancy(grid: WorkspaceGrid, clean: CleanMesh, solidDetection: boolean): OccupancySource;
  buildSvo(chunkId: number, dense: DenseChunk): SvoChunk | null;
}

export const tsKernels: Kernels = {
  cleanMesh,
  buildBvh,
  computeOccupancy,
  buildSvo,
};
