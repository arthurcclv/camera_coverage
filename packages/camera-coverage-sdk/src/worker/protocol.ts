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
      opts: { mode?: 1 | 2; threshold?: number; chunks?: number[]; precull?: boolean };
    }
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
