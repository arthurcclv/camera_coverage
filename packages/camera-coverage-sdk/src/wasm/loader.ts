/**
 * JS loader for the Rust WASM kernels (raw pointer ABI — no wasm-bindgen).
 *
 * See `crates/camera_coverage_wasm/src/lib.rs` for the memory model: JS allocates
 * input buffers, calls a kernel, reads the returned u32 header, copies outputs
 * out, and frees every buffer.
 */

import type { Kernels } from '../kernels.ts';
import type { CleanMesh } from '../geometry/mesh.ts';
import type { Bvh } from '../geometry/bvh.ts';
import { BVH_NODE_WORDS } from '../geometry/bvh.ts';
import type { Occupancy } from '../occupancy.ts';
import type { DenseChunk } from '../svo.ts';
import type { SceneMesh, SvoChunk, Vec3 } from '../types.ts';
import type { WorkspaceGrid } from '../grid.ts';

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  dealloc(ptr: number, size: number): void;
  clean_mesh(posPtr: number, posLen: number, idxPtr: number, idxLen: number): number;
  build_bvh(triPtr: number, triLen: number): number;
  compute_occupancy(
    nx: number, ny: number, nz: number,
    wminX: number, wminY: number, wminZ: number,
    voxelSize: number, triPtr: number, triLen: number, solidDetection: number,
  ): number;
  build_svo(
    nx: number, ny: number, nz: number, camWords: number,
    visPtr: number, visLen: number, valPtr: number, valLen: number,
  ): number;
}

class Wasm {
  private ex: WasmExports;
  constructor(ex: WasmExports) {
    this.ex = ex;
  }

  private get buf(): ArrayBuffer {
    return this.ex.memory.buffer as ArrayBuffer;
  }

  /** Allocate and copy a byte view into WASM memory; returns the pointer. */
  private write(view: ArrayBufferView): number {
    const len = view.byteLength;
    const ptr = this.ex.alloc(len); // may grow memory → re-acquire buffer after
    const src = new Uint8Array(view.buffer, view.byteOffset, len);
    new Uint8Array(this.buf, ptr, len).set(src);
    return ptr;
  }

  private header(ptr: number, words: number): Uint32Array {
    // Copy the header out immediately (subsequent allocs could detach the buffer).
    return new Uint32Array(this.buf.slice(ptr, ptr + words * 4));
  }
  private headerF32(ptr: number, words: number): Float32Array {
    return new Float32Array(this.buf.slice(ptr, ptr + words * 4));
  }

  private copyU32(ptr: number, byteLen: number): Uint32Array {
    return new Uint32Array(this.buf.slice(ptr, ptr + byteLen));
  }
  private copyF32(ptr: number, byteLen: number): Float32Array {
    return new Float32Array(this.buf.slice(ptr, ptr + byteLen));
  }
  private copyU8(ptr: number, byteLen: number): Uint8Array {
    return new Uint8Array(this.buf.slice(ptr, ptr + byteLen));
  }
  private free(ptr: number, byteLen: number): void {
    if (ptr !== 0) this.ex.dealloc(ptr, byteLen);
  }

  cleanMesh(mesh: SceneMesh): CleanMesh {
    const posPtr = this.write(mesh.positions);
    const idxPtr = this.write(mesh.indices);
    const hp = this.ex.clean_mesh(posPtr, mesh.positions.length, idxPtr, mesh.indices.length);

    const h = this.header(hp, 10);
    const hf = this.headerF32(hp, 10);
    const triPtr = h[0], triLen = h[1], triCount = h[2], removed = h[3];
    const triVerts = this.copyF32(triPtr, triLen);
    const aabb = {
      min: [hf[4], hf[5], hf[6]] as Vec3,
      max: [hf[7], hf[8], hf[9]] as Vec3,
    };

    this.free(posPtr, mesh.positions.byteLength);
    this.free(idxPtr, mesh.indices.byteLength);
    this.free(triPtr, triLen);
    this.free(hp, 10 * 4);

    return { triVerts, triangleCount: triCount, removed, aabb };
  }

  buildBvh(clean: CleanMesh): Bvh {
    const triPtr = this.write(clean.triVerts);
    const hp = this.ex.build_bvh(triPtr, clean.triVerts.length);

    const h = this.header(hp, 6);
    const nodesPtr = h[0], nodesLen = h[1], tdPtr = h[2], tdLen = h[3];
    const nodeCount = h[4], triangleCount = h[5];

    const nodesBytes = this.copyU8(nodesPtr, nodesLen);
    const triData = this.copyF32(tdPtr, tdLen);

    this.free(triPtr, clean.triVerts.byteLength);
    this.free(nodesPtr, nodesLen);
    this.free(tdPtr, tdLen);
    this.free(hp, 6 * 4);

    const nodes = nodesBytes.buffer as ArrayBuffer;
    return {
      nodes,
      nodeCount,
      f32: new Float32Array(nodes),
      u32: new Uint32Array(nodes),
      triData,
      triangleCount,
    };
  }

  computeOccupancy(grid: WorkspaceGrid, clean: CleanMesh, solidDetection: boolean): Occupancy {
    const [nx, ny, nz] = grid.gridDims;
    const triPtr = this.write(clean.triVerts);
    const hp = this.ex.compute_occupancy(
      nx, ny, nz,
      grid.worldMin[0], grid.worldMin[1], grid.worldMin[2],
      grid.voxelSize, triPtr, clean.triVerts.length, solidDetection ? 1 : 0,
    );
    const h = this.header(hp, 4);
    const cellsPtr = h[0], cellsLen = h[1], solidCount = h[2], mixedCount = h[3];
    const cells = this.copyU8(cellsPtr, cellsLen);

    this.free(triPtr, clean.triVerts.byteLength);
    this.free(cellsPtr, cellsLen);
    this.free(hp, 4 * 4);

    return { dims: grid.gridDims, cells, solidDetection, solidCount, mixedCount };
  }

  buildSvo(chunkId: number, dense: DenseChunk): SvoChunk | null {
    const [nx, ny, nz] = dense.dims;
    const cw = dense.camWords;
    const visPtr = this.write(dense.visibility);
    const valPtr = this.write(dense.validity);
    const hp = this.ex.build_svo(
      nx, ny, nz, cw,
      visPtr, dense.visibility.length, valPtr, dense.validity.length,
    );
    const h = this.header(hp, 10);
    const flag = h[0];

    let result: SvoChunk | null = null;
    if (flag === 1) {
      const childPtr = h[1], childLen = h[2];
      const keyPtr = h[3], keyLen = h[4];
      const validPtr = h[5], validLen = h[6];
      const palPtr = h[7], palLen = h[8];

      const nodeChild = this.copyU32(childPtr, childLen);
      const nodeKey = this.copyU32(keyPtr, keyLen);
      const nodeValid = this.copyU8(validPtr, validLen);
      const palette = palLen > 0 ? this.copyU32(palPtr, palLen) : undefined;

      this.free(childPtr, childLen);
      this.free(keyPtr, keyLen);
      this.free(validPtr, validLen);
      this.free(palPtr, palLen);

      result = {
        chunkId,
        rootSize: 256,
        depth: 8,
        dims: [nx, ny, nz],
        camWords: cw,
        mode: 1,
        nodeChild,
        nodeKey,
        nodeValid,
        palette,
      };
    }

    this.free(visPtr, dense.visibility.byteLength);
    this.free(valPtr, dense.validity.byteLength);
    this.free(hp, 10 * 4);
    return result;
  }
}

/**
 * Instantiate the Rust kernels from raw wasm bytes or a compiled module.
 * The result satisfies the same `Kernels` interface as `tsKernels`.
 */
export async function createWasmKernels(
  source: BufferSource | WebAssembly.Module,
): Promise<Kernels> {
  const { instance } =
    source instanceof WebAssembly.Module
      ? { instance: await WebAssembly.instantiate(source, {}) }
      : await WebAssembly.instantiate(source, {});
  const wasm = new Wasm(instance.exports as unknown as WasmExports);
  return {
    cleanMesh: (m) => wasm.cleanMesh(m),
    buildBvh: (c) => wasm.buildBvh(c),
    computeOccupancy: (g, c, s) => wasm.computeOccupancy(g, c, s),
    buildSvo: (id, d) => wasm.buildSvo(id, d),
  };
}
