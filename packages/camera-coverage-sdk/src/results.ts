/**
 * ChunkResult assembly (SVO vs dense selection, §9.5) and the encoding-agnostic
 * VoxelAccessor (§16.1).
 */

import type { ChunkResult, SvoChunk, Vec3 } from './types.ts';
import { buildSvo as defaultBuildSvo, svoAccessor, type DenseChunk, type VoxelAccessor } from './svo.ts';
import type { ChunkComputeOutput } from './compute/cpu.ts';

export function assembleChunkResult(
  chunkId: number,
  dims: Vec3,
  origin: Vec3,
  voxelSize: number,
  camWords: number,
  mode: 1 | 2,
  validity: Uint32Array,
  out: ChunkComputeOutput,
  buildSvo: (chunkId: number, dense: DenseChunk) => SvoChunk | null = defaultBuildSvo,
): ChunkResult {
  const base = {
    chunkId,
    dims,
    origin,
    voxelSize,
    camWords,
    mode,
    stats: out.stats,
  };

  const dense: DenseChunk = { dims, camWords, visibility: out.visibility!, validity };
  const svo = buildSvo(chunkId, dense);

  if (svo) {
    // The SVO encodes the validity bits into `nodeValid` and carries no
    // `validity` array, so the cache's mask is only read here — no copy needed.
    return { ...base, encoding: 'svo', svo };
  }
  return {
    ...base,
    encoding: 'dense',
    visibility: out.visibility,
    // §6.4 ownership: `validity` is cache-owned and the worker transfers this
    // result's buffers (detaching them). Hand out a copy, or the next
    // `compute()` would upload a detached buffer.
    validity: validity.slice(),
    coverage: out.coverage,
  };
}

/** Dense-encoding VoxelAccessor. forEachLeaf degrades to per-voxel reporting. */
export function denseAccessor(
  dims: Vec3,
  camWords: number,
  visibility: Uint32Array,
  validity: Uint32Array,
): VoxelAccessor {
  const [nx, ny, nz] = dims;
  const li = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const check = (i: number, j: number, k: number) => {
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) {
      throw new RangeError(`voxel (${i},${j},${k}) out of chunk bounds ${dims.join('×')}`);
    }
  };
  return {
    getMask(i, j, k) {
      check(i, j, k);
      return visibility[li(i, j, k) * camWords] >>> 0;
    },
    getMaskWord(i, j, k, word) {
      check(i, j, k);
      return visibility[li(i, j, k) * camWords + word] >>> 0;
    },
    isValid(i, j, k) {
      check(i, j, k);
      const idx = li(i, j, k);
      return ((validity[idx >> 5] >>> (idx & 31)) & 1) === 1;
    },
    forEachLeaf(cb) {
      // Accessor-owned scratch (§9.5): refilled per voxel, never handed out twice.
      const words = new Uint32Array(camWords);
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const idx = li(i, j, k);
            const valid = ((validity[idx >> 5] >>> (idx & 31)) & 1) === 1;
            const base = idx * camWords;
            for (let w = 0; w < camWords; w++) words[w] = visibility[base + w] >>> 0;
            cb([i, j, k], 1, words[0] >>> 0, valid, words);
          }
    },
  };
}

/** VoxelAccessor for any ChunkResult, regardless of encoding. */
export function accessor(result: ChunkResult): VoxelAccessor {
  if (result.encoding === 'svo') return svoAccessor(result.svo!);
  return denseAccessor(result.dims, result.camWords, result.visibility!, result.validity!);
}

/**
 * Dense validity + visibility for a retained chunk (§19.4). A `dense` chunk
 * already carries both; an `svo` one is expanded through the accessor, which is
 * the same traversal `forEachLeaf` uses. Aggregation needs a flat mask array
 * either way — the compression exists to cross a boundary cheaply, not to be
 * indexed by a shader.
 */
export function denseOf(
  chunk: ChunkResult,
  scratch: DenseScratch,
): { validity: Uint32Array; visibility: Uint32Array | null } {
  // A chunk no camera covers has every mask word zero, which §19.4 encodes as an
  // absent buffer — the same case chunk-level pre-cull (§7.2) leaves most chunks
  // of a large site in. `coveredCount` decides it in O(1): masks are only ever
  // written for valid voxels, so nothing covered means nothing set.
  const zeroMasks = chunk.stats.coveredCount === 0;
  if (chunk.encoding === 'dense' && chunk.visibility && chunk.validity) {
    return { validity: chunk.validity, visibility: zeroMasks ? null : chunk.visibility };
  }
  const [nx, ny, nz] = chunk.dims;
  const voxelCount = nx * ny * nz;
  const cw = chunk.camWords;
  const { validity, visibility } = scratch.take(
    (voxelCount + 31) >> 5,
    zeroMasks ? 0 : voxelCount * cw,
  );
  const acc = accessor(chunk);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const li = i + nx * (j + ny * k);
        if (!acc.isValid(i, j, k)) {
          // Reused scratch: an invalid voxel has to be written, not skipped, or
          // it would keep the previous chunk's mask.
          if (!zeroMasks) for (let w = 0; w < cw; w++) visibility[li * cw + w] = 0;
          continue;
        }
        validity[li >> 5] |= 1 << (li & 31);
        if (!zeroMasks) {
          for (let w = 0; w < cw; w++) visibility[li * cw + w] = acc.getMaskWord(i, j, k, w);
        }
      }
    }
  }
  return { validity, visibility: zeroMasks ? null : visibility };
}

/**
 * The reused dense-expansion buffers of {@link denseOf}. Each is grown to the
 * largest chunk asked for and never shrunk, and each is handed out as an exact
 * subarray so a caller's `length` still describes the chunk rather than the
 * high-water mark.
 *
 * `validity` is zeroed on every hand-out because `denseOf` only ever ORs bits
 * into it; `visibility` is not, because the expansion loop assigns every word it
 * covers — see the invalid-voxel branch above.
 */
export class DenseScratch {
  private validityBuf = new Uint32Array(0);
  private visibilityBuf = new Uint32Array(0);

  take(validityWords: number, visibilityWords: number): {
    validity: Uint32Array;
    visibility: Uint32Array;
  } {
    if (this.validityBuf.length < validityWords) this.validityBuf = new Uint32Array(validityWords);
    if (this.visibilityBuf.length < visibilityWords) {
      this.visibilityBuf = new Uint32Array(visibilityWords);
    }
    const validity = this.validityBuf.subarray(0, validityWords);
    validity.fill(0);
    return { validity, visibility: this.visibilityBuf.subarray(0, visibilityWords) };
  }
}
