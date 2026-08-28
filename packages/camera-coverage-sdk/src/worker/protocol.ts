/**
 * Worker message protocol (§16): the engine runs inside a Web Worker to keep
 * the main thread unblocked; the main thread talks to it over a transport.
 *
 * The `Transport` abstraction lets the same host/client code run against a real
 * `Worker` / `DedicatedWorkerGlobalScope` or an in-process loopback (tests).
 */

import type {
  CameraConfig,
  ChunkResult,
  CoverageSummary,
  EngineOptions,
  RunStart,
  GpuCapabilities,
  SamplingConfig,
  SamplingStats,
  SceneStats,
  WorkspaceConfig,
} from '../types.ts';

export interface Transport {
  post(data: unknown, transfer?: Transferable[]): void;
  onMessage(handler: (data: unknown) => void): void;
}

export type Req =
  | { id: number; kind: 'init'; config: WorkspaceConfig & EngineOptions }
  | { id: number; kind: 'loadScene'; positions: Float32Array; indices: Uint32Array }
  | { id: number; kind: 'setSampling'; config: SamplingConfig }
  | { id: number; kind: 'setCameras'; cameras: CameraConfig[] }
  | {
      id: number;
      kind: 'compute';
      /**
       * `ComputeOptions` minus the callback, which cannot cross the boundary.
       * `emitChunks` carries the caller's `onChunkDone` intent instead (§11.1,
       * §16.1): the host installs a chunk stream only when it is set, and the
       * engine then skips per-voxel readback.
       */
      opts: {
        mode?: 1 | 2;
        threshold?: number;
        chunks?: number[];
        precull?: boolean;
        incremental?: boolean;
        emitChunks?: boolean;
        /** The caller passed a `signal`, so the host installs an AbortController (§13.2). */
        cancellable?: boolean;
      };
    }
  /**
   * Abort the in-flight `compute` whose request id is `computeId` (§13.2). A
   * separate message rather than a field, because an `AbortSignal` can no more
   * cross the boundary than a callback can: the client keeps the signal and
   * translates a firing into this.
   */
  | { id: number; kind: 'cancel'; computeId: number }
  | { id: number; kind: 'dispose' };

export type Res =
  | { id: number; ok: true; value: ResultValue }
  | { id: number; ok: false; error: { code: string; message: string } };

export type ResultValue =
  | GpuCapabilities
  | SceneStats
  | SamplingStats
  | CoverageSummary
  | null;

/** Streamed during `compute` before its final response. */
export interface ChunkEvent {
  kind: 'chunk';
  computeId: number;
  chunkId: number;
  result: ChunkResult;
}

/**
 * Streamed during `compute` before the first `ChunkEvent` (§16.1). Unlike
 * `emitChunks`, this travels host → client: only the engine knows whether it
 * could honour an incremental request, and the client must know before the
 * first chunk arrives so it can decide whether to clear its store.
 */
export interface RunStartEvent extends RunStart {
  kind: 'runStart';
  computeId: number;
}

// --- transport adapters ----------------------------------------------------

interface PostTarget {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Wrap a real `Worker` (client side) or `self` (host side). */
export function messageTransport(target: PostTarget): Transport {
  return {
    post: (data, transfer) => target.postMessage(data, transfer ?? []),
    onMessage: (handler) => {
      target.onmessage = (ev) => handler(ev.data);
    },
  };
}

/**
 * In-process transport pair for tests. Delivery is async (microtask) and
 * structured-cloned to mimic the real Worker boundary (transfer lists are a
 * no-op — the clone already yields independent copies).
 */
export function loopback(): [Transport, Transport] {
  let handlerA: ((d: unknown) => void) | null = null;
  let handlerB: ((d: unknown) => void) | null = null;
  const clone = (d: unknown) => (typeof structuredClone === 'function' ? structuredClone(d) : d);

  const a: Transport = {
    post: (data) => { const d = clone(data); queueMicrotask(() => handlerB?.(d)); },
    onMessage: (h) => { handlerA = h; },
  };
  const b: Transport = {
    post: (data) => { const d = clone(data); queueMicrotask(() => handlerA?.(d)); },
    onMessage: (h) => { handlerB = h; },
  };
  return [a, b];
}

/** Collect the transferable buffers of a ChunkResult (§16.1). */
export function chunkTransferables(result: ChunkResult): Transferable[] {
  const t: Transferable[] = [];
  const push = (a?: { buffer: ArrayBufferLike }) => {
    if (a && a.buffer instanceof ArrayBuffer) t.push(a.buffer);
  };
  if (result.svo) {
    push(result.svo.nodeChild);
    push(result.svo.nodeKey);
    push(result.svo.nodeValid);
    push(result.svo.palette);
  }
  push(result.visibility);
  push(result.validity);
  push(result.coverage);
  return t;
}
