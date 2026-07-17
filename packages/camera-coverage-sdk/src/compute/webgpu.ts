/**
 * WebGPU compute backend (§11, §12).
 *
 * Implements the per-chunk pipeline with the WGSL shaders in `../shaders.ts`.
 * Scene buffers (BVH + triangles) are uploaded once and kept immutable; per-chunk
 * buffers are created and destroyed around each dispatch so only one chunk is
 * ever GPU-resident (§9.4). This module is imported lazily and only runs where
 * `navigator.gpu` exists.
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

export class WebGpuBackend {
  private device: GPUDevice;
  private caps: GpuCapabilities;

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
    this.triBuf = this.upload(
      bvh.triData.buffer.slice(bvh.triData.byteOffset, bvh.triData.byteOffset + bvh.triData.byteLength),
      GPUBufferUsage.STORAGE,
    );
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
    const { p1, p2, p3 } = this.getPipelines(cw);

    if (Math.ceil(voxelCount / WG) > this.caps.maxComputeWorkgroupsPerDimension) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Chunk has ${voxelCount} voxels; exceeds 1D dispatch limit. Reduce chunkSizeXZ.`,
      );
    }

    // --- buffers ------------------------------------------------------------
    const chunkInfo = this.upload(buildChunkInfo(input, voxelCount), GPUBufferUsage.UNIFORM);
    const camBuf = this.upload(packCameras(input.cameras.slice(0, input.numCameras)).buffer, GPUBufferUsage.STORAGE);
    const validityBuf = this.upload(input.validity.buffer, GPUBufferUsage.STORAGE);
    const candidates = this.storage(voxelCount * 4);
    const candMasks = this.storage(voxelCount * cw * 4);
    const candidateCount = this.storage(4);
    const visibility = this.storage(voxelCount * cw * 4);
    const coverage = this.storage(Math.max(4, (input.mode === 2 ? voxelCount * 4 * cw : 1) * 4));
    const statsBuf = this.storage((2 + input.numCameras) * 4);

    // clear counters / result buffers
    const enc = d.createCommandEncoder();
    enc.clearBuffer(candidateCount);
    enc.clearBuffer(visibility);
    enc.clearBuffer(statsBuf);
    if (input.mode === 2) enc.clearBuffer(coverage);

    // --- Pass 1 -------------------------------------------------------------
    const bg1 = d.createBindGroup({
      layout: p1.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: chunkInfo } },
        { binding: 1, resource: { buffer: camBuf } },
        { binding: 2, resource: { buffer: validityBuf } },
        { binding: 3, resource: { buffer: candidates } },
        { binding: 4, resource: { buffer: candMasks } },
        { binding: 5, resource: { buffer: candidateCount } },
      ],
    });
    const pass1 = enc.beginComputePass();
    pass1.setPipeline(p1);
    pass1.setBindGroup(0, bg1);
    pass1.dispatchWorkgroups(Math.ceil(voxelCount / WG));
    pass1.end();
    d.queue.submit([enc.finish()]);

    // Read candidate count to size Pass 2 (§11: 1-thread pass or CPU readback).
    const count = new Uint32Array(await this.read(candidateCount, 4))[0];

    if (count > 0) {
      const enc2 = d.createCommandEncoder();
      const bg2 = d.createBindGroup({
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
      });
      const pass2 = enc2.beginComputePass();
      pass2.setPipeline(p2);
      pass2.setBindGroup(0, bg2);
      pass2.dispatchWorkgroups(Math.ceil(count / WG));
      pass2.end();
      d.queue.submit([enc2.finish()]);
    }

    // --- Pass 3 -------------------------------------------------------------
    const enc3 = d.createCommandEncoder();
    const bg3 = d.createBindGroup({
      layout: p3.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: chunkInfo } },
        { binding: 1, resource: { buffer: validityBuf } },
        { binding: 2, resource: { buffer: visibility } },
        { binding: 3, resource: { buffer: statsBuf } },
      ],
    });
    const pass3 = enc3.beginComputePass();
    pass3.setPipeline(p3);
    pass3.setBindGroup(0, bg3);
    pass3.dispatchWorkgroups(Math.ceil(voxelCount / WG));
    pass3.end();
    d.queue.submit([enc3.finish()]);

    // --- readback -----------------------------------------------------------
    const visOut = new Uint32Array(await this.read(visibility, voxelCount * cw * 4));
    const covOut =
      input.mode === 2
        ? new Uint32Array(await this.read(coverage, voxelCount * 4 * cw * 4))
        : undefined;
    const statsArr = new Uint32Array(await this.read(statsBuf, (2 + input.numCameras) * 4));

    // release per-chunk buffers (§9.4)
    for (const b of [chunkInfo, camBuf, validityBuf, candidates, candMasks, candidateCount, visibility, coverage, statsBuf]) {
      b.destroy();
    }

    const visibleCount = Array.from(statsArr.subarray(2, 2 + input.numCameras));
    return {
      visibility: visOut,
      coverage: covOut,
      stats: { validCount: statsArr[0], coveredCount: statsArr[1], visibleCount },
    };
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

  private upload(data: ArrayBufferLike, usage: GPUBufferUsageFlags): GPUBuffer {
    const buf = this.device.createBuffer({
      size: Math.max(4, alignUp(data.byteLength, 4)),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buf, 0, data as ArrayBuffer);
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

  private async read(src: GPUBuffer, size: number): Promise<ArrayBuffer> {
    const sz = Math.max(4, alignUp(size, 4));
    const staging = this.device.createBuffer({
      size: sz,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, sz);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0, size);
    staging.unmap();
    staging.destroy();
    return copy;
  }
}

function alignUp(v: number, a: number): number {
  return Math.ceil(v / a) * a;
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
