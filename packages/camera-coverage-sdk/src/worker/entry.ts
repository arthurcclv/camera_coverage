/**
 * Ready-made Web Worker entry point. Bundle this as your worker script:
 *
 *   // main thread
 *   const worker = new Worker(new URL('.../worker/entry.ts', import.meta.url), { type: 'module' });
 *   const engine = WorkerClient.fromWorker(worker);
 *
 * To run with the Rust WASM kernels, fetch the .wasm on the main thread (or
 * inside a custom entry) and pass `createEngine` to `installHost`.
 */

import { installHost } from './host.ts';
import { messageTransport } from './protocol.ts';

// `self` is the DedicatedWorkerGlobalScope; cast to the minimal post target.
installHost(
  messageTransport(
    self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((ev: { data: unknown }) => void) | null },
  ),
);
