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
