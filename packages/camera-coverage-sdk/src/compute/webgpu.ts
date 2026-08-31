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
import type { GpuCapabilities, Vec3 } from '../types.ts';
import { EngineError, EngineErrorCode } from '../types.ts';
import type { ChunkComputeInput, ChunkComputeOutput } from './cpu.ts';
import { packCameras } from '../camera.ts';
import {
  PASS1_FRUSTUM,
  PASS2_VISIBILITY,
  PASS3_STATS,
  PASS4_REGIONS,
  PASS5_COLUMNS,
  PASS6_LEAFCOUNTS,
  PASS7_PROJECTIONS,
} from '../shaders.ts';
import {
  assembleColumns,
  mergeLeafCounts,
  resolveProbes,
  assembleProjections,
  unpackRegions,
  COLUMN_BASE_FIELDS,
  REGION_BASE_FIELDS,
  type AggregateChunkInput,
  type AggregateResult,
  type PackedAggregate,
} from '../aggregate.ts';

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
  /**
   * `GPUBuffer`s created since the last reset (§11.1). Pooled per-chunk buffers
   * make this **constant** in chunk count rather than ~18 per chunk; §18 6y
   * asserts it, because the results alone cannot tell the two apart.
   */
  buffersCreated: 0,
  /** Bytes currently held by the per-chunk pool — the §9.4 residency, measured. */
  poolBytes: 0,
  /**
   * High-water mark of {@link poolBytes} since the last reset — the "peak
   * concurrent buffer bytes" §11.1 asks for. `poolBytes` alone cannot answer it:
   * it is a live gauge, and a run's largest chunk has usually been grown past
   * and freed by the time anyone reads it.
   */
  peakPoolBytes: 0,
  reset(): void {
    gpuCounters.chunks = 0;
    gpuCounters.submits = 0;
    gpuCounters.maps = 0;
    gpuCounters.bytesRead = 0;
    gpuCounters.buffersCreated = 0;
    // Not `poolBytes`: that is a gauge of what is resident *now*, and a reset
    // between runs does not free a buffer. The peak restarts from it.
    gpuCounters.peakPoolBytes = gpuCounters.poolBytes;
  },
};

/** Charge `bytes` to the pool gauge and carry the §11.1 high-water mark with it. */
function addPoolBytes(bytes: number): void {
  gpuCounters.poolBytes += bytes;
  if (gpuCounters.poolBytes > gpuCounters.peakPoolBytes) {
    gpuCounters.peakPoolBytes = gpuCounters.poolBytes;
  }
}

// Functions, not constants: `unit.test.ts` imports `planStaging` from this
// module with no `navigator.gpu` and therefore no `GPUBufferUsage` global, and a
// module-level constant would fail at import time rather than at use.
const STORAGE_USAGE = () =>
  GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
const STAGING_USAGE = () => GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;

/**
 * The per-chunk GPU buffers of §11.1, pooled by slot.
 *
 * §9.4 allows one chunk resident at a time, and creating ~18 buffers per chunk
 * and destroying them satisfies that — but it is a poor way to honour it. A
 * driver releases a destroyed buffer's mappable shared memory *asynchronously*;
 * a 4,928-chunk run doing ~88,700 create/destroy cycles outruns reclamation and
 * fails as a bare allocation error inside the readback, naming nothing. One set
 * grown to the largest chunk makes residency bounded and constant instead.
 *
 * Buffers only ever grow. Chunk dimensions are uniform except at the workspace
 * edge, where they are *smaller*, so the first chunk sizes the pool and nothing
 * reallocates after it.
 */
/**
 * The fixed set of per-chunk pool slots (§11.1). A union rather than a `string`
 * because the pool's whole guarantee is *one* buffer per role for the run's
 * life: a mistyped slot name would not fail, it would quietly open a second
 * residency and double the bytes the §9.4 claim is measured in.
 */
type PoolSlot =
  | 'chunkInfo'
  | 'cameras'
  | 'validity'
  | 'candidates'
  | 'candMasks'
  | 'candidateCount'
  | 'visibility'
  | 'coverage'
  | 'stats'
  | 'staging'
  | 'aggInfo'
  | 'regions'
  | 'slabs'
  | 'regionAccum'
  | 'cellAccum'
  | 'cellSeen'
  | 'leafCounts'
  | 'leafValid'
  | 'projections'
  | 'projWeights'
  | 'projAccum';

class ChunkBufferPool {
  private device: GPUDevice;
  private slots = new Map<PoolSlot, { buf: GPUBuffer; size: number }>();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * The buffer for `slot`, at least `size` bytes. **Contents are undefined** —
   * a reused buffer holds the previous chunk's bytes, so every caller either
   * overwrites it fully or clears it in the chunk's encoder (§11.1).
   */
  get(slot: PoolSlot, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    const need = Math.max(4, alignUp(size, 4));
    const cur = this.slots.get(slot);
    if (cur && cur.size >= need) return cur.buf;
    if (cur) {
      cur.buf.destroy();
      gpuCounters.poolBytes -= cur.size;
    }
    const buf = this.device.createBuffer({ size: need, usage });
    this.slots.set(slot, { buf, size: need });
    gpuCounters.buffersCreated++;
    addPoolBytes(need);
    return buf;
  }

  /** As {@link get}, then upload `data` into it. The rest of the buffer is stale. */
  write(
    slot: PoolSlot,
    data: ArrayBuffer | ArrayBufferView,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer {
    const buf = this.get(slot, data.byteLength, usage | GPUBufferUsage.COPY_DST);
    if (data.byteLength > 0) {
      this.device.queue.writeBuffer(buf, 0, data as GPUAllowSharedBufferSource);
    }
    return buf;
  }

  /** Discard one slot, so the next `get` builds it fresh. */
  drop(slot: PoolSlot): void {
    const cur = this.slots.get(slot);
    if (!cur) return;
    cur.buf.destroy();
    gpuCounters.poolBytes -= cur.size;
    this.slots.delete(slot);
  }

  destroyAll(): void {
    for (const s of this.slots.values()) {
      s.buf.destroy();
      gpuCounters.poolBytes -= s.size;
    }
    this.slots.clear();
  }
}

export class WebGpuBackend {
  private device: GPUDevice;
  private caps: GpuCapabilities;
  /**
   * `device.limits.maxBufferSize`, the ceiling on the §11.1 staging buffer.
   * Not part of `GpuCapabilities` — it constrains readback, not scene size, and
   * every public limit there is one a caller can act on.
   */
  private maxBufferSize: number;
  /**
   * Host-memory ceiling on one chunk's readback (§11.1). Unrelated to
   * `maxBufferSize`: that bounds what the *device* will allocate, this bounds
   * what the JS heap can copy out of the mapped range.
   */
  maxChunkReadbackBytes = 256 * 1024 * 1024;

  private bvhBuf: GPUBuffer | null = null;
  private triBuf: GPUBuffer | null = null;
  private nodeCount = 0;
  /** §11.1 per-chunk buffers, reused across chunks rather than churned. */
  private pool: ChunkBufferPool;

  private pipelineCache = new Map<number, {
    p1: GPUComputePipeline;
    p2: GPUComputePipeline;
    p3: GPUComputePipeline;
    /** §19.3 passes. Built with the same `CAM_WORDS` override as Passes 1–3. */
    p4: GPUComputePipeline;
    p5: GPUComputePipeline;
    p6: GPUComputePipeline;
    p7: GPUComputePipeline;
  }>();

  private constructor(device: GPUDevice, caps: GpuCapabilities) {
    this.device = device;
    this.caps = caps;
    this.maxBufferSize = device.limits.maxBufferSize;
    this.pool = new ChunkBufferPool(device);
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
      p4: mk(PASS4_REGIONS),
      p5: mk(PASS5_COLUMNS),
      p6: mk(PASS6_LEAFCOUNTS),
      p7: mk(PASS7_PROJECTIONS),
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
    const agg = input.aggregate;
    // Probes are resolved from the masks on the CPU (§19.3), so a descriptor that
    // asks for them needs the visibility segment even on an otherwise stats-only
    // run. Internal to this chunk: it does not make the chunk *emitted* (§11.1).
    const needVis = input.emitVoxels || (agg ? agg.probeCount > 0 : false);

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

    // Pooled, not created per chunk (§11.1). Every one of these holds the
    // previous chunk's bytes: the uploads overwrite theirs, and the accumulators
    // are cleared in this chunk's encoder below.
    const pool = this.pool;
    const chunkInfo = pool.write('chunkInfo', buildChunkInfo(input, voxelCount), GPUBufferUsage.UNIFORM);
    const camBuf = pool.write(
      'cameras',
      packCameras(input.cameras.slice(0, input.numCameras)),
      GPUBufferUsage.STORAGE,
    );
    const validityBuf = pool.write('validity', input.validity, GPUBufferUsage.STORAGE);
    const candidates = pool.get('candidates', voxelCount * 4, STORAGE_USAGE());
    const candMasks = pool.get('candMasks', voxelCount * cw * 4, STORAGE_USAGE());
    const candidateCount = pool.get('candidateCount', 4, STORAGE_USAGE());
    const visibility = pool.get('visibility', visBytes, STORAGE_USAGE());
    const coverage = pool.get('coverage', Math.max(4, covBytes), STORAGE_USAGE());
    const statsBuf = pool.get('stats', statsBytes, STORAGE_USAGE());

    const aggBufs = agg
      ? this.createAggregateBuffers(agg, voxelCount, cw, input.numCameras, input.base)
      : null;

    // --- staging plan (§11.1: one buffer, one map) ---------------------------
    // Aggregation segments join this same plan and this same map, which is what
    // keeps the one-submit/one-map contract true with §19 live (§18, 6o).
    const aggSegments = aggBufs?.segments ?? [];
    const plan = planStaging([
      { key: 'stats', bytes: statsBytes },
      { key: 'visibility', bytes: needVis ? visBytes : 0 },
      { key: 'coverage', bytes: input.emitVoxels && mode2 ? covBytes : 0 },
      ...aggSegments.map(({ key, bytes }) => ({ key, bytes })),
    ]);

    // Every segment is copied into a JS TypedArray after the map, so the readback
    // has to fit the host heap too — a limit the device knows nothing about, and
    // the one a tall workspace at a fine voxel size hits first (§11.1).
    if (plan.size > this.maxChunkReadbackBytes) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Chunk ${input.dims.join('×')} needs ${mib(plan.size)} of readback per chunk; the ` +
          `budget is ${mib(this.maxChunkReadbackBytes)}. Reduce chunkSizeXZ or raise voxelSize ` +
          `(chunk height is the full workspace height, so chunkSizeXZ is the effective knob).`,
        { required: plan.size, budget: this.maxChunkReadbackBytes, dims: input.dims },
      );
    }

    // The segments are resident together, so the peak is their sum (§11.1). A
    // device whose per-buffer ceiling they exceed would otherwise surface this
    // as a swallowed GPUValidationError and a rejected `mapAsync`.
    if (plan.size > this.maxBufferSize) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Chunk readback needs a ${mib(plan.size)} staging buffer; device maxBufferSize is ` +
          `${mib(this.maxBufferSize)}. Reduce chunkSizeXZ, raise voxelSize, or omit ` +
          `onChunkDone to read stats only.`,
      );
    }

    const srcOf = new Map<StagingKey, GPUBuffer>([
      ['stats', statsBuf],
      ['visibility', visibility],
      ['coverage', coverage],
      ...aggSegments.map(({ key, src }) => [key, src] as const),
    ]);
    const segments = plan.segments.map((seg) => ({ ...seg, src: srcOf.get(seg.key)! }));

    const staging = pool.get('staging', plan.size, STAGING_USAGE());

    {
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

      // §19.3 Passes 4–6, in the same encoder, after Pass 2 has filled `visibility`.
      if (aggBufs) {
        this.recordAggregate(enc, cw, aggBufs, chunkInfo, validityBuf, visibility, voxelGroups);
      }

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

      let statsArr: Uint32Array;
      let visOut: Uint32Array | undefined;
      let covOut: Uint32Array | undefined;
      let aggOut: AggregateResult | undefined;
      try {
        const read = (key: StagingKey): Uint32Array | undefined =>
          plan.has(key)
            ? new Uint32Array(staging.getMappedRange(plan.offsetOf(key), plan.sizeOf(key)).slice(0))
            : undefined;
        statsArr = read('stats')!;
        visOut = read('visibility');
        covOut = read('coverage');
        // Not gated on `visOut`: only probe resolution (§19.3) reads the masks on
        // the CPU, and a descriptor with no probes never asks for them. Gating
        // here dropped the whole `AggregateResult` on a stats-only run — Passes
        // 4–6 ran, the accumulators were read into the staging buffer, and
        // `onAggregate` never fired, while the CPU backend returned it (§19.5).
        aggOut =
          aggBufs
            ? readAggregate(staging, plan, aggBufs, agg!, {
                chunkId: -1,
                dims: input.dims,
                origin: input.origin,
                base: input.base,
                voxelSize: input.voxelSize,
                camWords: cw,
                numCameras: input.numCameras,
                validity: input.validity,
                visibility: visOut ?? null,
                packed: agg!,
              })
            : undefined;
      } catch (err) {
        // The staging buffer is still mapped and the pool would hand it back in
        // that state, so it is surrendered rather than reused (§11.1).
        pool.drop('staging');
        // `ChunkComputeInput` carries no chunk id — the engine holds it — so the
        // run's chunk counter is what identifies where this stopped.
        throw readbackFailure(err, plan, input.dims, cw, gpuCounters.chunks);
      }
      staging.unmap();

      const visibleCount = Array.from(statsArr.subarray(2, 2 + input.numCameras));
      return {
        // A stats-only run that only read `visibility` to resolve probes must not
        // hand it back — that would silently make it an emitted chunk (§11.1).
        visibility: input.emitVoxels ? visOut : undefined,
        coverage: covOut,
        stats: { validCount: statsArr[0], coveredCount: statsArr[1], visibleCount },
        aggregate: aggOut,
      };
    }
  }

  /**
   * §19.4 standalone aggregation. Uploads one retained chunk's validity and
   * masks, runs Passes 4–6 alone, reads the accumulators back, and releases —
   * §9.4's one-chunk-resident rule, unchanged, with no BVH and no ray.
   */
  async aggregateChunk(input: AggregateChunkInput): Promise<AggregateResult> {
    const d = this.device;
    const cw = input.camWords;
    const voxelCount = input.dims[0] * input.dims[1] * input.dims[2];
    const voxelGroups = Math.ceil(voxelCount / WG);
    if (voxelGroups > this.caps.maxComputeWorkgroupsPerDimension) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Chunk has ${voxelCount} voxels; exceeds 1D dispatch limit. Reduce chunkSizeXZ.`,
      );
    }

    const pool = this.pool;
    const chunkInfo = pool.write(
      'chunkInfo',
      buildAggChunkInfo(input.dims, input.origin, input.voxelSize, voxelCount, input.numCameras),
      GPUBufferUsage.UNIFORM,
    );
    const validityBuf = pool.write('validity', input.validity, GPUBufferUsage.STORAGE);
    // An absent buffer means every mask word is zero (§19.4). The pooled buffer
    // holds the previous chunk's masks, so this path *must* clear it — which
    // `recordAggregate`'s caller does below — rather than relying on WebGPU's
    // zero-initialization, which applies at creation only (§11.1).
    const visibility = input.visibility
      ? pool.write('visibility', input.visibility, GPUBufferUsage.STORAGE)
      : pool.get('visibility', voxelCount * cw * 4, STORAGE_USAGE());
    const zeroVisibility = !input.visibility;
    const aggBufs = this.createAggregateBuffers(
      input.packed,
      voxelCount,
      cw,
      input.numCameras,
      input.base,
    );

    const plan = planStaging(aggBufs.segments.map(({ key, bytes }) => ({ key, bytes })));
    // The host-heap budget binds here exactly as it does in `computeChunk`
    // (§11.1): every segment below is copied out of the mapped range into a JS
    // `TypedArray`, and `leafCounts` over a tall chunk is the segment that
    // reaches it first. A standalone aggregation is not exempt from the limit
    // just because it casts no ray.
    if (plan.size > this.maxChunkReadbackBytes) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Aggregating chunk ${input.dims.join('×')} needs ${mib(plan.size)} of readback; the ` +
          `budget is ${mib(this.maxChunkReadbackBytes)}. Reduce chunkSizeXZ, raise voxelSize, ` +
          `or drop leafCounts from the descriptor.`,
        { required: plan.size, budget: this.maxChunkReadbackBytes, dims: input.dims },
      );
    }
    if (plan.size > this.maxBufferSize) {
      throw new EngineError(
        EngineErrorCode.SCENE_TOO_LARGE,
        `Aggregation readback needs a ${mib(plan.size)} staging buffer; device maxBufferSize ` +
          `is ${mib(this.maxBufferSize)}. Reduce chunkSizeXZ or drop leafCounts.`,
      );
    }
    const staging = pool.get('staging', plan.size, STAGING_USAGE());

    {
      const enc = d.createCommandEncoder();
      // A pooled `visibility` carries the previous chunk's masks, so "all zero"
      // has to be written, not assumed (§11.1).
      if (zeroVisibility) enc.clearBuffer(visibility);
      this.recordAggregate(enc, cw, aggBufs, chunkInfo, validityBuf, visibility, voxelGroups);
      const aggSrcOf = new Map(aggBufs.segments.map(({ key, src }) => [key, src]));
      for (const seg of plan.segments) {
        enc.copyBufferToBuffer(aggSrcOf.get(seg.key)!, 0, staging, seg.offset, seg.size);
      }
      d.queue.submit([enc.finish()]);
      gpuCounters.submits++;
      await staging.mapAsync(GPUMapMode.READ);
      gpuCounters.maps++;
      for (const seg of plan.segments) gpuCounters.bytesRead += seg.size;
      let out: AggregateResult;
      try {
        out = readAggregate(staging, plan, aggBufs, input.packed, input);
      } catch (err) {
        pool.drop('staging');
        throw readbackFailure(err, plan, input.dims, cw, input.chunkId);
      }
      staging.unmap();
      out.chunkId = input.chunkId;
      return out;
    }
  }

  /**
   * Allocate the §19 accumulators for one chunk. `readback` is indexed by the
   * staging plan's slot, and `sizes` carries `-1` for every primitive the
   * descriptor did not ask for — so an unused pass costs no segment at all.
   */
  private createAggregateBuffers(
    packed: PackedAggregate,
    voxelCount: number,
    camWords: number,
    numCameras: number,
    base: [number, number, number],
  ): AggregateBuffers {
    const regionEntries = packed.regionCount > 0 ? packed.regionCount + packed.groupCount : 0;
    const regionBytes = regionEntries * (REGION_BASE_FIELDS + numCameras) * 4;
    const cellBytes = packed.totalCells * COLUMN_BASE_FIELDS * 4;
    const seenBytes = packed.totalCells * camWords * 4;
    const countsWords = (voxelCount + 3) >> 2;
    const validWords = (voxelCount + 31) >> 5;
    const countsBytes = packed.wantLeafCounts ? countsWords * 4 : 0;
    const validBytes = packed.wantLeafCounts ? validWords * 4 : 0;

    // Pooled like the rest (§11.1). Every accumulator below is cleared in
    // `recordAggregate`, which is what makes reuse safe.
    const pool = this.pool;
    const aggInfo = pool.write(
      'aggInfo',
      buildAggInfo(packed, numCameras, base),
      GPUBufferUsage.UNIFORM,
    );
    // A zero-length storage binding is invalid, so an unused primitive still gets
    // a 16-byte stub rather than a conditional bind-group layout per descriptor.
    const regionBuf = pool.write(
      'regions',
      packed.regionCount > 0 ? packed.regionData : new Float32Array(4),
      GPUBufferUsage.STORAGE,
    );
    const slabBuf = pool.write(
      'slabs',
      packed.slabCount > 0 ? packed.slabData : new Uint32Array(4),
      GPUBufferUsage.STORAGE,
    );
    const regionAccum = pool.get('regionAccum', Math.max(4, regionBytes), STORAGE_USAGE());
    const cellAccum = pool.get('cellAccum', Math.max(4, cellBytes), STORAGE_USAGE());
    const cellSeen = pool.get('cellSeen', Math.max(4, seenBytes), STORAGE_USAGE());
    const leafCounts = pool.get('leafCounts', Math.max(4, countsBytes), STORAGE_USAGE());
    const leafValid = pool.get('leafValid', Math.max(4, validBytes), STORAGE_USAGE());
    const projBuf = pool.write(
      'projections',
      packed.projectionCount > 0 ? packed.projectionData : new Float32Array(4),
      GPUBufferUsage.STORAGE,
    );
    const projWeights = pool.write(
      'projWeights',
      packed.projectionCount > 0 ? packed.projectionWeights : new Uint32Array(4),
      GPUBufferUsage.STORAGE,
    );
    const projBytes = packed.projectionBins * 4;
    const projAccum = pool.get('projAccum', Math.max(4, projBytes), STORAGE_USAGE());

    const wantColumns = packed.totalCells > 0;
    const segments: AggregateBuffers['segments'] = [];
    if (regionEntries > 0) {
      segments.push({ key: 'regionAccum', bytes: regionBytes, src: regionAccum });
    }
    if (wantColumns) {
      segments.push({ key: 'cellAccum', bytes: cellBytes, src: cellAccum });
      segments.push({ key: 'cellSeen', bytes: seenBytes, src: cellSeen });
    }
    if (packed.wantLeafCounts) {
      segments.push({ key: 'leafCounts', bytes: countsBytes, src: leafCounts });
      segments.push({ key: 'leafValid', bytes: validBytes, src: leafValid });
    }
    if (packed.projectionCount > 0) {
      segments.push({ key: 'projAccum', bytes: projBytes, src: projAccum });
    }

    return {
      segments,
      wantColumns,
      wantLeafCounts: packed.wantLeafCounts,
      aggInfo,
      regionBuf,
      slabBuf,
      regionAccum,
      cellAccum,
      cellSeen,
      leafCounts,
      leafValid,
      projBuf,
      projWeights,
      projAccum,
      projBins: packed.projectionBins,
      regionEntries,
      voxelCount,
      camWords,
      numCameras,
    };
  }

  /** Record §19.3 Passes 4–6 into an existing encoder. Clears precede the passes. */
  private recordAggregate(
    enc: GPUCommandEncoder,
    camWords: number,
    b: AggregateBuffers,
    chunkInfo: GPUBuffer,
    validityBuf: GPUBuffer,
    visibility: GPUBuffer,
    voxelGroups: number,
  ): void {
    const d = this.device;
    const { p4, p5, p6, p7 } = this.getPipelines(camWords);
    enc.clearBuffer(b.regionAccum);
    enc.clearBuffer(b.cellAccum);
    enc.clearBuffer(b.cellSeen);
    enc.clearBuffer(b.leafCounts);
    enc.clearBuffer(b.leafValid);
    enc.clearBuffer(b.projAccum);

    const run = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]): void => {
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      );
      pass.dispatchWorkgroups(voxelGroups);
      pass.end();
    };

    if (b.regionEntries > 0) {
      run(p4, [chunkInfo, validityBuf, visibility, b.regionBuf, b.regionAccum, b.aggInfo]);
    }
    if (b.wantColumns) {
      run(p5, [
        chunkInfo, validityBuf, visibility, b.regionBuf, b.slabBuf,
        b.cellAccum, b.cellSeen, b.aggInfo,
      ]);
    }
    if (b.wantLeafCounts) {
      run(p6, [chunkInfo, validityBuf, visibility, b.regionBuf, b.leafCounts, b.leafValid, b.aggInfo]);
    }
    if (b.projBins > 0) {
      run(p7, [
        chunkInfo, validityBuf, visibility, b.regionBuf,
        b.projBuf, b.projWeights, b.projAccum, b.aggInfo,
      ]);
    }
  }

  dispose(): void {
    this.disposeScene();
    this.pool.destroyAll();
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

/**
 * Name a readback allocation that failed (§11.1, §17).
 *
 * `getMappedRange(...).slice(0)` is a host allocation the device knows nothing
 * about, so it fails as a bare `Array buffer allocation failed` — which crosses
 * the Worker boundary as an anonymous `INVALID_STATE` naming neither the size
 * nor the chunk. Everything a caller could act on is right here; carrying it is
 * the difference between a diagnosable report and a guess.
 */
function readbackFailure(
  err: unknown,
  plan: { size: number; segments: { size: number }[] },
  dims: Vec3,
  camWords: number,
  chunkId: number,
): unknown {
  if (err instanceof EngineError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new EngineError(
    EngineErrorCode.SCENE_TOO_LARGE,
    `Readback of chunk ${chunkId} (${dims.join('×')}, CAM_WORDS=${camWords}) failed after ` +
      `${gpuCounters.chunks} chunks: ${message}. It asked for ${mib(plan.size)} across ` +
      `${plan.segments.length} segments (${plan.segments.map((x) => mib(x.size)).join(', ')}); ` +
      `${mib(gpuCounters.bytesRead)} read and ${gpuCounters.buffersCreated} GPU buffers created ` +
      `this run, pool holding ${mib(gpuCounters.poolBytes)}. Reduce chunkSizeXZ or raise voxelSize.`,
    {
      chunkId,
      dims,
      camWords,
      requestedBytes: plan.size,
      segmentBytes: plan.segments.map((x) => x.size),
      chunksDone: gpuCounters.chunks,
      bytesRead: gpuCounters.bytesRead,
      buffersCreated: gpuCounters.buffersCreated,
      poolBytes: gpuCounters.poolBytes,
      cause: message,
    },
  );
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
/**
 * What a staging segment holds. Named rather than positional because the plan is
 * built from a *conditional* list — a stats-only run plans one segment, a Mode 2
 * run with every §19 primitive plans eight — so a segment's index is a function
 * of which others were requested. Reading one back by position is a bug waiting
 * for the first descriptor that omits an earlier primitive.
 */
export type StagingKey =
  | 'stats'
  | 'visibility'
  | 'coverage'
  | 'regionAccum'
  | 'cellAccum'
  | 'cellSeen'
  | 'leafCounts'
  | 'leafValid'
  | 'projAccum';

/** One segment asked for. `bytes <= 0` is "not wanted" and is dropped. */
export interface StagingRequest {
  key: StagingKey;
  bytes: number;
}

export interface StagingSegment {
  key: StagingKey;
  offset: number;
  size: number;
}

export interface StagingPlan {
  /** Total staging-buffer bytes, segments 8-byte aligned. */
  size: number;
  segments: StagingSegment[];
  has(key: StagingKey): boolean;
  /** Byte offset of `key`, or `-1` when it was not planned. */
  offsetOf(key: StagingKey): number;
  /** Byte length of `key`, or `0` when it was not planned. */
  sizeOf(key: StagingKey): number;
}

export function planStaging(requests: StagingRequest[]): StagingPlan {
  const segments: StagingSegment[] = [];
  const byKey = new Map<StagingKey, StagingSegment>();
  let size = 0;
  for (const { key, bytes } of requests) {
    if (bytes <= 0) continue;
    const seg = { key, offset: size, size: bytes };
    segments.push(seg);
    byKey.set(key, seg);
    size = alignUp(size + bytes, 8);
  }
  return {
    size,
    segments,
    has: (key) => byKey.has(key),
    offsetOf: (key) => byKey.get(key)?.offset ?? -1,
    sizeOf: (key) => byKey.get(key)?.size ?? 0,
  };
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

/**
 * Per-chunk §19 accumulator buffers. `segments` lists only what the descriptor
 * actually asked for, so an unused primitive never reaches the staging buffer —
 * and the readback names each one rather than counting positions to it.
 */
interface AggregateBuffers {
  /** Exactly the accumulators this descriptor asked for, each with its source. */
  segments: { key: StagingKey; bytes: number; src: GPUBuffer }[];
  /** Whether Pass 5 / Pass 6 have anything to write — the passes are skipped otherwise. */
  wantColumns: boolean;
  wantLeafCounts: boolean;
  aggInfo: GPUBuffer;
  regionBuf: GPUBuffer;
  slabBuf: GPUBuffer;
  regionAccum: GPUBuffer;
  cellAccum: GPUBuffer;
  cellSeen: GPUBuffer;
  leafCounts: GPUBuffer;
  leafValid: GPUBuffer;
  projBuf: GPUBuffer;
  projWeights: GPUBuffer;
  projAccum: GPUBuffer;
  /** Total accumulator entries across every projection and plane; 0 ⇒ no Pass 7. */
  projBins: number;
  /** `regionCount + groupCount`, or 0 when no regions were requested. */
  regionEntries: number;
  voxelCount: number;
  camWords: number;
  numCameras: number;
}

/** The 64-byte AggInfo uniform matching the WGSL struct (§19.3). */
function buildAggInfo(
  packed: PackedAggregate,
  numCameras: number,
  base: [number, number, number],
): ArrayBuffer {
  const buf = new ArrayBuffer(64);
  const u = new Uint32Array(buf);
  u[0] = packed.regionCount;
  u[1] = packed.groupCount;
  u[2] = packed.slabCount;
  u[3] = numCameras;
  u[4] = packed.leafMask[0];
  u[5] = packed.leafMask[1];
  u[6] = base[0];
  u[7] = base[1];
  u[8] = base[2];
  u[9] = packed.projectionCount;
  u[10] = packed.anyProjectionFilter ? 1 : 0;
  // `camMask` is a vec4<u32>, so it starts at the struct's next 16-byte
  // boundary — words 12..15, not 10..13.
  u.set(packed.cameraMask, 12);
  return buf;
}

/**
 * A ChunkInfo uniform for a standalone aggregation (§19.4). Aggregation reads
 * only the geometry fields; `mode`/`threshold`/`activeMask` are inert here, and
 * filling them with a pretend camera configuration would be worse than zeroing
 * them — it would look like state that mattered.
 */
function buildAggChunkInfo(
  dims: Vec3,
  origin: Vec3,
  voxelSize: number,
  voxelCount: number,
  numCameras: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(64);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  f[0] = origin[0];
  f[1] = origin[1];
  f[2] = origin[2];
  u[4] = dims[0];
  u[5] = dims[1];
  u[6] = dims[2];
  u[7] = voxelCount;
  f[8] = voxelSize;
  u[9] = 1;
  u[10] = 1;
  u[11] = numCameras;
  return buf;
}

/**
 * Decode the mapped §19 accumulator segments into the public result. Probes are
 * resolved here from the CPU-side masks (§19.3) rather than by a pass of their
 * own, so this needs the same `AggregateChunkInput` the CPU reference takes.
 */
function readAggregate(
  staging: GPUBuffer,
  plan: StagingPlan,
  b: AggregateBuffers,
  packed: PackedAggregate,
  cpuInput: AggregateChunkInput,
): AggregateResult {
  const out: AggregateResult = { chunkId: cpuInput.chunkId };
  const seg = (key: StagingKey): Uint32Array | null =>
    plan.has(key)
      ? new Uint32Array(staging.getMappedRange(plan.offsetOf(key), plan.sizeOf(key)).slice(0))
      : null;

  const regionFlat = seg('regionAccum');
  if (regionFlat) {
    out.regions = unpackRegions(regionFlat, 0, packed.regionCount, b.numCameras);
    if (packed.groupCount > 0) {
      out.groups = unpackRegions(regionFlat, packed.regionCount, packed.groupCount, b.numCameras);
    }
  }

  const cellFlat = seg('cellAccum');
  const seenFlat = seg('cellSeen');
  if (cellFlat && seenFlat) out.columns = assembleColumns(cellFlat, seenFlat, packed, b.camWords);

  const countWords = seg('leafCounts');
  const validWords = seg('leafValid');
  if (countWords && validWords) {
    // Pass 6 packs four voxels per word, low byte first — which on every
    // little-endian target (all of them, for WebGPU) is exactly the byte order a
    // Uint8Array view gives, so unpacking is a view, not a loop. The dense form
    // is intermediate: what leaves here is the merged leaf list (§19.3).
    out.leafCounts = mergeLeafCounts(
      new Uint8Array(countWords.buffer, 0, b.voxelCount),
      validWords,
      cpuInput.dims,
    );
  }

  const projFlat = seg('projAccum');
  if (projFlat) out.projections = assembleProjections(projFlat, packed);

  if (packed.probeCount > 0) {
    const { probeMasks, probeHits } = resolveProbes(cpuInput);
    out.probeMasks = probeMasks;
    out.probeHits = probeHits;
  }
  return out;
}
