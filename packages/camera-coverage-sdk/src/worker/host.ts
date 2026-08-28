/**
 * Worker-side host: drives a CoverageEngine in response to protocol messages
 * (§16). Chunk results are streamed back as transferables during `compute`.
 *
 * In a real deployment the worker entry is one line:
 *   import { installHost, messageTransport } from '.../worker/host.ts';
 *   installHost(messageTransport(self as any));
 */

import { CoverageEngine, type EngineInternalOptions } from '../engine.ts';
import { EngineError } from '../types.ts';
import {
  chunkTransferables,
  type Req,
  type Transport,
} from './protocol.ts';

export interface HostOptions {
  /** Factory for the engine, e.g. to inject WASM kernels. */
  createEngine?: () => CoverageEngine;
  engineOptions?: EngineInternalOptions;
}

export function installHost(transport: Transport, opts: HostOptions = {}): void {
  const create = opts.createEngine ?? (() => new CoverageEngine(opts.engineOptions));
  let engine: CoverageEngine | null = null;

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
        case 'compute': {
          // Install the chunk stream only when the client asked for it: with no
          // `onChunkDone` on the main thread there is nobody to receive chunks,
          // and passing one here would defeat the stats-only path (§11.1).
          const { emitChunks, ...engineOpts } = req.opts;
          const summary = await engine!.compute({
            ...engineOpts,
            onChunkDone: emitChunks
              ? (chunkId, result) => {
                  transport.post(
                    { kind: 'chunk', computeId: req.id, chunkId, result },
                    chunkTransferables(result),
                  );
                }
              : undefined,
          });
          reply(req.id, summary);
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
