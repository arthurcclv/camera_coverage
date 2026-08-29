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
import type { AggregateResult, AggregateSpec } from '../aggregate.ts';

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
        /**
         * §19 descriptor. Unlike the callbacks, this crosses unchanged — the
         * descriptor is plain data by construction (§19.1), which is exactly why
         * regions are boxes and not a caller predicate.
         */
        aggregate?: AggregateSpec;
        /** The caller supplied `onAggregate`, so the host streams results back (§19.4). */
        emitAggregate?: boolean;
        /** The caller passed a `signal`, so the host installs an AbortController (§13.2). */
        cancellable?: boolean;
      };
    }
  /** §19.4 standalone aggregation over chunks the *client* retained. */
  | {
      id: number;
      kind: 'aggregate';
      /** Empty ⇒ run over the host's retained chunks (§16.1 host-side retention). */
      chunks: ChunkResult[];
      useRetained?: boolean;
      spec: AggregateSpec;
      cancellable?: boolean;
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
  | {
      id: number;
      ok: false;
      /**
       * `stack` and `detail` are carried so a worker-side failure is diagnosable
       * from the main thread (§17). Without them every non-`EngineError` throw —
       * an allocation failure above all — arrives naming nothing.
       */
      error: { code: string; message: string; stack?: string; detail?: unknown };
    };

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

/** Streamed per chunk during `compute` or `aggregate` (§19.4). */
export interface AggregateEvent {
  kind: 'aggregate';
  computeId: number;
  result: AggregateResult;
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

/** Collect the transferable buffers of an AggregateResult (§19.4). */
export function aggregateTransferables(result: AggregateResult): Transferable[] {
  const t: Transferable[] = [];
  const push = (a?: { buffer: ArrayBufferLike }) => {
    if (a && a.buffer instanceof ArrayBuffer) t.push(a.buffer);
  };
  // Groups are region accumulators in every respect but which entries they sum
  // (§19.2), so they carry a `seen` array of the same shape. Omitting them here
  // left the one part of the result that is structured-clone *copied* while the
  // rest was transferred — the exact cost §16.1 says this function removes.
  for (const r of result.regions ?? []) push(r.seen);
  for (const g of result.groups ?? []) push(g.seen);

  for (const c of result.columns ?? []) {
    push(c.camCountSum);
    push(c.camCountMax);
    push(c.camCountMin);
    push(c.blindCount);
    push(c.validCount);
    push(c.obstacleCount);
    push(c.filteredCount);
    push(c.seenWords);
  }
  push(result.leafCounts?.index);
  push(result.leafCounts?.size);
  push(result.leafCounts?.count);
  push(result.probeMasks);
  push(result.probeHits);
  return t;
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
