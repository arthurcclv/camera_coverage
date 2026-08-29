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
import { aggregateChunkCPU, type AggregateChunkInput, type AggregateResult } from './aggregate.ts';

export interface ComputeBackend {
  readonly capabilities: GpuCapabilities;
  /**
   * Host-heap ceiling on one chunk's readback (§11.1), when the backend has a
   * readback to bound. The CPU reference builds its arrays directly and has no
   * staging step, so it declares none — an absent property is "not applicable",
   * which is why this is optional rather than `Infinity`.
   */
  maxChunkReadbackBytes?: number;
  /** Upload immutable scene data (BVH + triangles). */
  setScene(bvh: Bvh, mesh: CleanMesh): void | Promise<void>;
  computeChunk(input: ChunkComputeInput): ChunkComputeOutput | Promise<ChunkComputeOutput>;
  /**
   * §19.4 standalone aggregation over masks the caller retained. Uploads and
   * releases one chunk at a time (§9.4) and touches neither the BVH nor a ray.
   */
  aggregateChunk(input: AggregateChunkInput): AggregateResult | Promise<AggregateResult>;
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

  aggregateChunk(input: AggregateChunkInput): AggregateResult {
    return aggregateChunkCPU(input);
  }

  dispose(): void {
    this.bvh = null;
  }
}
