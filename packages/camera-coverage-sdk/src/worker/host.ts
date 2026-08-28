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
  chunkTransferables,
  type Req,
  type Transport,
} from './protocol.ts';

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
}

export function installHost(transport: Transport, opts: HostOptions = {}): void {
  const create = opts.createEngine ?? (() => new CoverageEngine(opts.engineOptions));
  let engine: CoverageEngine | null = null;
  /** Abort controllers for cancellable computes, by their request id (§13.2). */
  const inFlight = new Map<number, AbortController>();

  const reply = (id: number, value: unknown) =>
    transport.post({ id, ok: true, value });
  const replyError = (id: number, err: unknown) => {
    const code = err instanceof EngineError ? err.code : 'INVALID_STATE';
    const message = err instanceof Error ? err.message : String(err);
    transport.post({ id, ok: false, error: { code, message } });
  };

  transport.onMessage(async (raw) => {
    const req = raw as Req;
    try {
      switch (req.kind) {
        case 'init':
          engine = create();
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
          const { emitChunks, cancellable, ...engineOpts } = req.opts;
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
              opts.onRunStart?.(info);
              transport.post({ kind: 'runStart', computeId: req.id, ...info });
            },
            onChunkDone: opts.onChunk
              ? // A local consumer means per-voxel output is always produced, and
                // nothing is posted: the point is that these buffers never cross.
                (chunkId, result) => opts.onChunk!(chunkId, result)
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
        case 'dispose':
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
