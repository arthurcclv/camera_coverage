/**
 * Main-thread client: a `VisibilityEngine` proxy that forwards calls to the
 * worker host over a transport (§16). Large input arrays and streamed chunk
 * results cross the boundary as transferables.
 */

import {
  EngineError,
  EngineErrorCode,
  MAX_CAMERAS,
  type CameraConfig,
  type ComputeOptions,
  type CoverageSummary,
  type EngineOptions,
  type GpuCapabilities,
  type SamplingConfig,
  type SamplingStats,
  type SceneMesh,
  type SceneStats,
  type VisibilityEngine,
  type WorkspaceConfig,
} from '../types.ts';
import {
  messageTransport,
  type ChunkEvent,
  type Res,
  type RunStartEvent,
  type Transport,
} from './protocol.ts';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class WorkerClient implements VisibilityEngine {
  private transport: Transport;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private chunkHandlers = new Map<number, NonNullable<ComputeOptions['onChunkDone']>>();
  private runStartHandlers = new Map<number, NonNullable<ComputeOptions['onRunStart']>>();

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onMessage((raw) => this.handle(raw));
  }

  /** Convenience: wrap a real Worker. */
  static fromWorker(worker: Worker): WorkerClient {
    return new WorkerClient(messageTransport(worker as unknown as Parameters<typeof messageTransport>[0]));
  }

  private handle(raw: unknown): void {
    const msg = raw as Res | ChunkEvent | RunStartEvent;
    if ((msg as ChunkEvent).kind === 'chunk') {
      const ev = msg as ChunkEvent;
      this.chunkHandlers.get(ev.computeId)?.(ev.chunkId, ev.result);
      return;
    }
    if ((msg as RunStartEvent).kind === 'runStart') {
      const ev = msg as RunStartEvent;
      this.runStartHandlers.get(ev.computeId)?.({
        incremental: ev.incremental,
        chunkIds: ev.chunkIds,
      });
      return;
    }
    const res = msg as Res;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    this.chunkHandlers.delete(res.id);
    this.runStartHandlers.delete(res.id);
    if (res.ok) p.resolve(res.value);
    else p.reject(new EngineError(res.error.code as EngineErrorCode, res.error.message));
  }

  private call<T>(id: number, kind: string, payload: object, transfer?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.post({ id, kind, ...payload }, transfer);
    });
  }

  init(config: WorkspaceConfig & EngineOptions): Promise<GpuCapabilities> {
    return this.call(++this.seq, 'init', { config });
  }

  loadScene(mesh: SceneMesh): Promise<SceneStats> {
    // Transfer the input buffers to the worker (§16.1). The caller's typed
    // arrays are detached after this call.
    return this.call(
      ++this.seq,
      'loadScene',
      { positions: mesh.positions, indices: mesh.indices },
      [mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer],
    );
  }

  setSampling(config: SamplingConfig): Promise<SamplingStats> {
    return this.call(++this.seq, 'setSampling', { config });
  }

  setCameras(cameras: CameraConfig[]): void {
    // The interface is synchronous and TOO_MANY_CAMERAS must surface here, so
    // validate the count on the main thread before forwarding.
    if (cameras.length > MAX_CAMERAS) {
      throw new EngineError(
        EngineErrorCode.TOO_MANY_CAMERAS,
        `${cameras.length} cameras exceeds the ${MAX_CAMERAS} limit.`,
      );
    }
    void this.call(++this.seq, 'setCameras', { cameras }).catch(() => {});
  }

  compute(opts?: ComputeOptions): Promise<CoverageSummary> {
    const id = ++this.seq;
    if (opts?.onChunkDone) this.chunkHandlers.set(id, opts.onChunkDone);
    if (opts?.onRunStart) this.runStartHandlers.set(id, opts.onRunStart);
    const wire = {
      mode: opts?.mode,
      threshold: opts?.threshold,
      chunks: opts?.chunks,
      precull: opts?.precull,
      incremental: opts?.incremental,
      // Callbacks don't survive postMessage, so forward the *intent* (§11.1):
      // no handler here means the host runs a stats-only compute. An AbortSignal
      // doesn't survive it either (§13.2) — the signal stays here and a firing is
      // relayed as a `cancel` message naming this request.
      emitChunks: !!opts?.onChunkDone,
      cancellable: !!opts?.signal,
    };
    const promise = this.call<CoverageSummary>(id, 'compute', { opts: wire });
    const signal = opts?.signal;
    if (signal) {
      if (signal.aborted) this.postCancel(id);
      else {
        const onAbort = () => this.postCancel(id);
        signal.addEventListener('abort', onAbort, { once: true });
        // Drop the listener whichever way the run ends, so a long-lived signal
        // doesn't accumulate one per run.
        void promise.catch(() => {}).finally(() => signal.removeEventListener('abort', onAbort));
      }
    }
    return promise;
  }

  /** Relay an abort to the host (§13.2); the reply is irrelevant, the rejection comes from `compute`. */
  private postCancel(computeId: number): void {
    void this.call(++this.seq, 'cancel', { computeId }).catch(() => {});
  }

  dispose(): void {
    void this.call(++this.seq, 'dispose', {}).catch(() => {});
  }
}
