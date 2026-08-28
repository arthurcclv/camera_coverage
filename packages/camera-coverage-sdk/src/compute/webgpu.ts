/**
 * WebGPU compute backend (§11, §11.1, §12).
 *
 * Implements the per-chunk pipeline with the WGSL shaders in `../shaders.ts`.
 * Scene buffers (BVH + triangles) are uploaded once and kept immutable; per-chunk
 * buffers are created and destroyed around each dispatch so only one chunk is
 * ever GPU-resident (§9.4). This module is imported lazily and only runs where
 * `navigator.gpu` exists.
 *
 * Submission contract (§11.1): every pass for one chunk goes into a single
 * command encoder and a single `submit()`, followed by exactly one GPU→CPU
 * synchronization. Nothing is read back to size a dispatch — Pass 2's bound
 * comes from the CPU-side `validCount` of the §6.4 validity cache.
 */

/// <reference types="@webgpu/types" />

import type { Bvh } from '../geometry/bvh.ts';
import type { CleanMesh } from '../geometry/mesh.ts';
import type { GpuCapabilities } from '../types.ts';
import { EngineError, EngineErrorCode } from '../types.ts';
import type { ChunkComputeInput, ChunkComputeOutput } from './cpu.ts';
import { packCameras } from '../camera.ts';
import { PASS1_FRUSTUM, PASS2_VISIBILITY, PASS3_STATS } from '../shaders.ts';

const WG = 64;

/**
 * Module-level observability for §18.6c / §18.6d. `submits` and `maps` must each
 * advance by exactly 1 per computed chunk, and `bytesRead` must exclude the
 * per-voxel buffers on a stats-only run. Not exported from `index.ts` — tests
 * import this module directly.
 */
export const gpuCounters = {
  chunks: 0,
  submits: 0,
  maps: 0,
  bytesRead: 0,
  reset(): void {
    gpuCounters.chunks = 0;
    gpuCounters.submits = 0;
    gpuCounters.maps = 0;
    gpuCounters.bytesRead = 0;
  },
};

export class WebGpuBackend {
  private device: GPUDevice;
  private caps: GpuCapabilities;
  /**
   * `device.limits.maxBufferSize`, the ceiling on the §11.1 staging buffer.
   * Not part of `GpuCapabilities` — it constrains readback, not scene size, and
   * every public limit there is one a caller can act on.
   */
  private maxBufferSize: number;

  private bvhBuf: GPUBuffer | null = null;
  private triBuf: GPUBuffer | null = null;
  private nodeCount = 0;

  private pipelineCache = new Map<number, {
    p1: GPUComputePipeline;
    p2: GPUComputePipeline;
    p3: GPUComputePipeline;
  }>();

  private constructor(device: GPUDevice, caps: GpuCapabilities) {
    this.device = device;
    this.caps = caps;
    this.maxBufferSize = device.limits.maxBufferSize;
  }

  get capabilities(): GpuCapabilities {
    return this.caps;
  }

  static async create(): Promise<WebGpuBackend> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new EngineError(EngineErrorCode.WEBGPU_UNAVAILABLE, 'No WebGPU adapter available.');
    }
    const maxBinding = adapter.limits.maxStorageBufferBindingSize;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: maxBinding,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });

    const caps: GpuCapabilities = {
      backend: 'webgpu',
      maxStorageBufferBindingSize: maxBinding,
      maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
      // BVH ≈ 2× tris @ 32 B, triangles @ 48 B → ~112 B/tri budget on the larger binding.
      triangleCeiling: Math.floor(maxBinding / 48),
      mode2Available: maxBinding >= 64 * 1024 * 1024,
    };

    const backend = new WebGpuBackend(device, caps);
    device.lost.then((info) => {
      backend.onDeviceLost?.(info);
    });
    return backend;
  }

  onDeviceLost?: (info: GPUDeviceLostInfo) => void;

  setScene(bvh: Bvh, _mesh: CleanMesh): void {
    this.disposeScene();
    this.nodeCount = bvh.nodeCount;
    this.bvhBuf = this.upload(bvh.nodes, GPUBufferUsage.STORAGE);
    // bvh.triData is the leaf-reordered 12-f32/tri array the shader indexes.
    // `upload` honours the view's byteOffset/byteLength, so no manual slice.
    this.triBuf = this.upload(bvh.triData, GPUBufferUsage.STORAGE);
  }

  private getPipelines(camWords: number) {
    let cached = this.pipelineCache.get(camWords);
    if (cached) return cached;
    const d = this.device;
    const constants = { CAM_WORDS: camWords, WG_SIZE: WG };
    const mk = (code: string) =>
      d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code }), entryPoint: 'main', constants },
      });
    cached = {
      p1: mk(PASS1_FRUSTUM),
      p2: mk(PASS2_VISIBILITY),
      p3: mk(PASS3_STATS),
    };
    this.pipelineCache.set(camWords, cached);
    return cached;
  }

  async computeChunk(input: ChunkComputeInput): Promise<ChunkComputeOutput> {
    const d = this.device;
    const cw = input.camWords;
    const voxelCount = input.dims[0] * input.dims[1] * input.dims[2];
    const mode2 = input.mode === 2;
    const { p1, p2, p3 } = this.getPipelines(cw);

    const voxelGroups = Math.ceil(voxelCount / WG);
    if (voxelGroups > this.caps.maxComputeWorkgroupsPerDimension) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Chunk has ${voxelCount} voxels; exceeds 1D dispatch limit. Reduce chunkSizeXZ.`,
      );
    }

    // --- buffers ------------------------------------------------------------
    const visBytes = voxelCount * cw * 4;
    const covBytes = mode2 ? voxelCount * 4 * cw * 4 : 0;
    const statsBytes = (2 + input.numCameras) * 4;

    const chunkInfo = this.upload(buildChunkInfo(input, voxelCount), GPUBufferUsage.UNIFORM);
    const camBuf = this.upload(
      packCameras(input.cameras.slice(0, input.numCameras)),
      GPUBufferUsage.STORAGE,
    );
    const validityBuf = this.upload(input.validity, GPUBufferUsage.STORAGE);
    const candidates = this.storage(voxelCount * 4);
    const candMasks = this.storage(voxelCount * cw * 4);
    const candidateCount = this.storage(4);
    const visibility = this.storage(visBytes);
    const coverage = this.storage(Math.max(4, covBytes));
    const statsBuf = this.storage(statsBytes);

    const perChunk = [
      chunkInfo, camBuf, validityBuf, candidates, candMasks,
      candidateCount, visibility, coverage, statsBuf,
    ];

    // --- staging plan (§11.1: one buffer, one map) ---------------------------
    const plan = planStaging(statsBytes, input.emitVoxels ? visBytes : -1,
      input.emitVoxels && mode2 ? covBytes : -1);

    // The segments are resident together, so the peak is their sum (§11.1). A
    // device whose per-buffer ceiling they exceed would otherwise surface this
    // as a swallowed GPUValidationError and a rejected `mapAsync`.
    if (plan.size > this.maxBufferSize) {
      for (const b of perChunk) b.destroy();
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Chunk readback needs a ${mib(plan.size)} staging buffer; device maxBufferSize is ` +
          `${mib(this.maxBufferSize)}. Reduce chunkSizeXZ, raise voxelSize, or omit ` +
          `onChunkDone to read stats only.`,
      );
    }

    const bufferOf: Record<number, GPUBuffer> = { 0: statsBuf, 1: visibility, 2: coverage };
    const segments = plan.segments.map((seg) => ({ ...seg, src: bufferOf[seg.slot]! }));
    const [statsOffset, visOffset, covOffset] = plan.offsets;

    const staging = d.createBuffer({
      size: Math.max(4, plan.size),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      // --- one encoder, one submit (§11.1) ------------------------------------
      const enc = d.createCommandEncoder();
      enc.clearBuffer(candidateCount);
      enc.clearBuffer(visibility);
      enc.clearBuffer(statsBuf);
      if (mode2) enc.clearBuffer(coverage);

      const pass1 = enc.beginComputePass();
      pass1.setPipeline(p1);
      pass1.setBindGroup(
        0,
        d.createBindGroup({
          layout: p1.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: chunkInfo } },
            { binding: 1, resource: { buffer: camBuf } },
            { binding: 2, resource: { buffer: validityBuf } },
            { binding: 3, resource: { buffer: candidates } },
            { binding: 4, resource: { buffer: candMasks } },
            { binding: 5, resource: { buffer: candidateCount } },
          ],
        }),
      );
      pass1.dispatchWorkgroups(voxelGroups);
      pass1.end();

      // Pass 2 is bounded by validCount, not by a read-back candidateCount
      // (§11 Pass 2): a candidate must be a valid voxel, so
      // candidateCount <= validCount, and the shader's `slot >= candidateCount`
      // guard retires the surplus threads.
      const pass2 = enc.beginComputePass();
      pass2.setPipeline(p2);
      pass2.setBindGroup(
        0,
        d.createBindGroup({
          layout: p2.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: chunkInfo } },
            { binding: 1, resource: { buffer: camBuf } },
            { binding: 2, resource: { buffer: this.bvhBuf! } },
            { binding: 3, resource: { buffer: this.triBuf! } },
            { binding: 4, resource: { buffer: candidates } },
            { binding: 5, resource: { buffer: candMasks } },
            { binding: 6, resource: { buffer: candidateCount } },
            { binding: 7, resource: { buffer: visibility } },
            { binding: 8, resource: { buffer: coverage } },
          ],
        }),
      );
      pass2.dispatchWorkgroups(Math.ceil(input.validCount / WG));
      pass2.end();

      const pass3 = enc.beginComputePass();
      pass3.setPipeline(p3);
      pass3.setBindGroup(
        0,
        d.createBindGroup({
          layout: p3.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: chunkInfo } },
            { binding: 1, resource: { buffer: validityBuf } },
            { binding: 2, resource: { buffer: visibility } },
            { binding: 3, resource: { buffer: statsBuf } },
          ],
        }),
      );
      pass3.dispatchWorkgroups(voxelGroups);
      pass3.end();

      for (const seg of segments) {
        enc.copyBufferToBuffer(seg.src, 0, staging, seg.offset, seg.size);
      }
      d.queue.submit([enc.finish()]);
      gpuCounters.submits++;
      gpuCounters.chunks++;

      // --- one synchronization (§11.1) ----------------------------------------
      await staging.mapAsync(GPUMapMode.READ);
      gpuCounters.maps++;
      for (const seg of segments) gpuCounters.bytesRead += seg.size;

      const statsArr = new Uint32Array(staging.getMappedRange(statsOffset, statsBytes).slice(0));
      const visOut =
        visOffset >= 0
          ? new Uint32Array(staging.getMappedRange(visOffset, visBytes).slice(0))
          : undefined;
      const covOut =
        covOffset >= 0
          ? new Uint32Array(staging.getMappedRange(covOffset, covBytes).slice(0))
          : undefined;
      staging.unmap();

      const visibleCount = Array.from(statsArr.subarray(2, 2 + input.numCameras));
      return {
        visibility: visOut,
        coverage: covOut,
        stats: { validCount: statsArr[0], coveredCount: statsArr[1], visibleCount },
      };
    } finally {
      // release per-chunk buffers (§9.4) — including on a mapAsync rejection or
      // a device loss part-way through, which would otherwise strand them.
      staging.destroy();
      for (const b of perChunk) b.destroy();
    }
  }

  dispose(): void {
    this.disposeScene();
    this.pipelineCache.clear();
    this.device.destroy();
  }

  private disposeScene(): void {
    this.bvhBuf?.destroy();
    this.triBuf?.destroy();
    this.bvhBuf = null;
    this.triBuf = null;
  }

  // --- buffer helpers -------------------------------------------------------

  /**
   * Upload an ArrayBuffer or a typed-array **view**. Views are uploaded over
   * their own `byteOffset`/`byteLength`, never the whole backing buffer — the
   * validity mask (§6.4) and `bvh.triData` may both be views into a larger
   * allocation, and uploading `.buffer` wholesale would silently send the wrong
   * bytes on the GPU path only, where the CPU reference still reads correctly.
   */
  private upload(data: ArrayBuffer | ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const buf = this.device.createBuffer({
      size: Math.max(4, alignUp(data.byteLength, 4)),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) {
      this.device.queue.writeBuffer(buf, 0, data as GPUAllowSharedBufferSource);
    }
    return buf;
  }

  private storage(size: number): GPUBuffer {
    return this.device.createBuffer({
      size: Math.max(4, alignUp(size, 4)),
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });
  }
}

function alignUp(v: number, a: number): number {
  return Math.ceil(v / a) * a;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Lay out the §11.1 staging buffer: `stats` always, then `visibility` and
 * `coverage` when the caller consumes them (a negative size means "omitted").
 * Segment offsets are padded to 8 bytes for `getMappedRange`; `size` is the sum
 * of what is actually carried, which is what the `maxBufferSize` check needs.
 *
 * Pure and exported so §18.6f can assert the arithmetic without a GPU. `slot`
 * indexes stats/visibility/coverage; `offsets` is that same triple, `-1` where
 * the segment is omitted.
 */
export function planStaging(
  statsBytes: number,
  visBytes: number,
  covBytes: number,
): { size: number; segments: { slot: number; offset: number; size: number }[]; offsets: [number, number, number] } {
  const segments: { slot: number; offset: number; size: number }[] = [];
  const offsets: [number, number, number] = [-1, -1, -1];
  let size = 0;
  [statsBytes, visBytes, covBytes].forEach((bytes, slot) => {
    if (bytes < 0) return;
    offsets[slot] = size;
    segments.push({ slot, offset: size, size: bytes });
    size = alignUp(size + bytes, 8);
  });
  return { size, segments, offsets };
}

/** Build the 64-byte ChunkInfo uniform matching the WGSL struct. */
function buildChunkInfo(input: ChunkComputeInput, voxelCount: number): ArrayBuffer {
  const buf = new ArrayBuffer(64);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  // origin vec4 (0..3)
  f[0] = input.origin[0];
  f[1] = input.origin[1];
  f[2] = input.origin[2];
  // dims vec4<u32> (4..7)
  u[4] = input.dims[0];
  u[5] = input.dims[1];
  u[6] = input.dims[2];
  u[7] = voxelCount;
  // voxelSize, mode, threshold, numCameras (8..11)
  f[8] = input.voxelSize;
  u[9] = input.mode;
  u[10] = input.threshold;
  u[11] = input.numCameras;
  // activeMask vec4<u32> (12..15)
  for (let w = 0; w < 4; w++) u[12 + w] = input.activeMask[w] ?? 0;
  return buf;
}
