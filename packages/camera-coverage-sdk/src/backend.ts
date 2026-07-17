/**
 * Compute backend abstraction. The engine drives chunks through a backend that
 * executes Passes 1–3; the CPU reference and the WebGPU implementation both
 * satisfy this interface.
 */

import type { Bvh } from './geometry/bvh.ts';
import type { CleanMesh } from './geometry/mesh.ts';
import type { GpuCapabilities } from './types.ts';
import type { ChunkComputeInput, ChunkComputeOutput } from './compute/cpu.ts';
import { computeChunkCPU } from './compute/cpu.ts';

export interface ComputeBackend {
  readonly capabilities: GpuCapabilities;
  /** Upload immutable scene data (BVH + triangles). */
  setScene(bvh: Bvh, mesh: CleanMesh): void | Promise<void>;
  computeChunk(input: ChunkComputeInput): ChunkComputeOutput | Promise<ChunkComputeOutput>;
  dispose(): void;
}

export class CpuBackend implements ComputeBackend {
  readonly capabilities: GpuCapabilities = {
    backend: 'cpu',
    maxStorageBufferBindingSize: Number.MAX_SAFE_INTEGER,
    maxComputeWorkgroupsPerDimension: Number.MAX_SAFE_INTEGER,
    maxComputeInvocationsPerWorkgroup: 256,
    triangleCeiling: 20_000_000,
    mode2Available: true,
  };

  private bvh: Bvh | null = null;

  setScene(bvh: Bvh): void {
    this.bvh = bvh;
  }

  computeChunk(input: ChunkComputeInput): ChunkComputeOutput {
    return computeChunkCPU(input);
  }

  dispose(): void {
    this.bvh = null;
  }
}
