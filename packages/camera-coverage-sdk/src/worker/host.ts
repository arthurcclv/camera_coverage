/**
 * Worker-side host: drives a CoverageEngine in response to protocol messages
 * (§16). Chunk results are streamed back as transferables during `compute`.
 *
 * In a real deployment the worker entry is one line:
 *   import { installHost, messageTransport } from '.../worker/host.ts';
 *   installHost(messageTransport(self as any));
 */

import { CoverageEngine, type EngineInternalOptions } from '../engine.ts';
import { EngineError, type ChunkResult, type RunStart } from '../types.ts';
import {
  aggregateTransferables,
  chunkTransferables,
  type Req,
  type Transport,
} from './protocol.ts';
import type { AggregateResult } from '../aggregate.ts';

export interface HostOptions {
  /** Factory for the engine, e.g. to inject WASM kernels. */
  createEngine?: () => CoverageEngine;
  engineOptions?: EngineInternalOptions;
  /**
   * Observe each run's shape inside the worker (§16.1), alongside the `runStart`
   * message still posted to the client. A worker-side consumer needs this for the
   * same reason the client does: to know whether to clear its store or replace
   * into it (§13.1).
   */
  onRunStart?: (info: RunStart) => void;
  /**
   * Consume `ChunkResult`s **in the worker** instead of posting them to the
   * client (§16.1). When set, the host always runs with per-voxel output and
   * never posts a `chunk` message, so the per-voxel buffers never cross the
   * boundary. Intended for a caller whose consumers live in the worker and
   * return only small derived products to the main thread.
   */
  onChunk?: (chunkId: number, result: ChunkResult) => void;
  /**
   * Consume §19 aggregation results **in the worker**, alongside (not instead of)
   * the `aggregate` message posted to the client. Unlike `onChunk`, this does not
   * suppress the message: an aggregation result is kilobytes, so a worker-side
   * consumer and a main-thread one can both have it without the transfer being
   * the thing that matters.
   */
  onAggregate?: (result: AggregateResult) => void;
  /**
   * Hand the engine instance to worker-side code as soon as it exists.
   *
   * The standalone `aggregate()` of §19.4 re-reduces chunks the *worker* retained
   * through `onChunk`, so the code holding them needs the same engine the host is
   * driving. Without this seam a worker-side consumer would have to round-trip
   * every retained chunk back to the main thread to re-aggregate it — the exact
   * transfer `onChunk` exists to avoid.
   */
  onEngine?: (engine: CoverageEngine) => void;
  /**
   * Retain the current run's `ChunkResult`s in the worker so
   * `WorkerClient.aggregateRetained` can re-reduce them (§16.1, §19.4).
   *
   * Retention follows the §13.1 rule the host already applies to `onRunStart`:
   * a full run clears the store first, an incremental one replaces by `chunkId`.
   * Clearing on an incremental run would silently blank most of the scene, and
   * nothing would raise an error.
   */
  retainChunks?: boolean;
}

export function installHost(transport: Transport, opts: HostOptions = {}): void {
  const create = opts.createEngine ?? (() => new CoverageEngine(opts.engineOptions));
  let engine: CoverageEngine | null = null;
  /** Abort controllers for cancellable computes, by their request id (§13.2). */
  const inFlight = new Map<number, AbortController>();
  /** §16.1 host-side retention, by chunk id. Empty unless `retainChunks` is set. */
  const retained = new Map<number, ChunkResult>();

  const reply = (id: number, value: unknown) =>
    transport.post({ id, ok: true, value });
  const replyError = (id: number, err: unknown) => {
    const code = err instanceof EngineError ? err.code : 'INVALID_STATE';
    const message = err instanceof Error ? err.message : String(err);
    // §17: carry the stack and detail. A bare `INVALID_STATE: Array buffer
    // allocation failed` names neither the allocation, its size, nor the chunk —
    // and that is the failure a worker is most likely to produce.
    const stack = err instanceof Error ? err.stack?.slice(0, 4096) : undefined;
    const detail = err instanceof EngineError ? err.detail : undefined;
    transport.post({ id, ok: false, error: { code, message, stack, detail } });
  };

  transport.onMessage(async (raw) => {
    const req = raw as Req;
    try {
      switch (req.kind) {
        case 'init':
          // Release the engine being replaced before building the next one
          // (§16.1). A re-init reshapes the grid, so every retained chunk id
          // already means something else — and leaving the old engine to GC
          // means the new workspace's allocations are attempted while the old
          // workspace's are still live, which at 100M voxels is the difference
          // between holding one occupancy grid (§6.2) and two.
          retained.clear();
          engine?.dispose();
          engine = create();
          opts.onEngine?.(engine);
          reply(req.id, await engine.init(req.config));
          break;
        case 'loadScene':
          reply(req.id, await engine!.loadScene({ positions: req.positions, indices: req.indices }));
          break;
        case 'setSampling':
          reply(req.id, await engine!.setSampling(req.config));
          break;
        case 'setCameras':
          engine!.setCameras(req.cameras);
          reply(req.id, null);
          break;
        case 'cancel':
          // Aborting an id that already settled is a no-op: the controller is
          // gone, and a late cancel racing a finishing run is normal (§13.2).
          inFlight.get(req.computeId)?.abort();
          reply(req.id, null);
          break;
        case 'compute': {
          // Install the chunk stream only when the client asked for it: with no
          // `onChunkDone` on the main thread there is nobody to receive chunks,
          // and passing one here would defeat the stats-only path (§11.1).
          const { emitChunks, emitAggregate, cancellable, ...engineOpts } = req.opts;
          // Only install a controller when the client said it may cancel: the
          // signal's presence is what makes the engine yield between chunks
          // (§13.2), so an uncancellable run must not get one.
          const controller = cancellable ? new AbortController() : null;
          if (controller) inFlight.set(req.id, controller);
          try {
          const summary = await engine!.compute({
            ...engineOpts,
            signal: controller?.signal,
            // Always forwarded: only the engine knows whether it honoured an
            // incremental request, and the client needs that before the first
            // chunk to decide whether to clear its store (§16.1).
            onRunStart: (info) => {
              // A full run replaces the whole store; an incremental one keeps
              // what it is not about to re-send (§13.1).
              if (opts.retainChunks && !info.incremental) retained.clear();
              opts.onRunStart?.(info);
              transport.post({ kind: 'runStart', computeId: req.id, ...info });
            },
            onAggregate:
              emitAggregate || opts.onAggregate
                ? (result) => {
                    opts.onAggregate?.(result);
                    if (emitAggregate) {
                      transport.post(
                        { kind: 'aggregate', computeId: req.id, result },
                        aggregateTransferables(result),
                      );
                    }
                  }
                : undefined,
            onChunkDone: opts.onChunk || opts.retainChunks
              ? // A local consumer means per-voxel output is always produced, and
                // nothing is posted: the point is that these buffers never cross.
                (chunkId, result) => {
                  if (opts.retainChunks) retained.set(chunkId, result);
                  opts.onChunk?.(chunkId, result);
                }
              : emitChunks
              ? (chunkId, result) => {
                  transport.post(
                    { kind: 'chunk', computeId: req.id, chunkId, result },
                    chunkTransferables(result),
                  );
                }
              : undefined,
          });
          reply(req.id, summary);
          } finally {
            inFlight.delete(req.id);
          }
          break;
        }
        case 'aggregate': {
          const controller = req.cancellable ? new AbortController() : null;
          if (controller) inFlight.set(req.id, controller);
          try {
            const source = req.useRetained ? retained.values() : req.chunks;
            await engine!.aggregate(source, req.spec, {
              signal: controller?.signal,
              onAggregate: (result) => {
                opts.onAggregate?.(result);
                transport.post(
                  { kind: 'aggregate', computeId: req.id, result },
                  aggregateTransferables(result),
                );
              },
            });
            reply(req.id, null);
          } finally {
            inFlight.delete(req.id);
          }
          break;
        }
        case 'dispose':
          retained.clear();
          engine?.dispose();
          engine = null;
          reply(req.id, null);
          break;
      }
    } catch (err) {
      replyError(req.id, err);
    }
  });
}
