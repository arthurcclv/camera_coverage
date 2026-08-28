/**
 * Worker host/client end-to-end over the in-process loopback transport (§16).
 * Verifies the full lifecycle proxies correctly, chunk results stream back,
 * and synchronous error semantics (TOO_MANY_CAMERAS) are preserved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkerClient } from '../src/worker/client.ts';
import { installHost } from '../src/worker/host.ts';
import { loopback } from '../src/worker/protocol.ts';
import { accessor } from '../src/results.ts';
import { EngineError, EngineErrorCode, type ChunkResult } from '../src/types.ts';
import { camera, LOOK_NEG_Z, voxelIndexOf, wallZ } from './helpers.ts';

function makeClient(): WorkerClient {
  const [clientSide, hostSide] = loopback();
  installHost(hostSide); // host creates a CoverageEngine on init
  return new WorkerClient(clientSide);
}

test('worker: full lifecycle + streamed chunk result', async () => {
  const client = makeClient();
  const caps = await client.init({
    worldMin: [0, 0, 0],
    worldMax: [6, 3, 6],
    voxelSize: 0.3,
    chunkSizeXZ: 10,
    backend: 'cpu',
  });
  assert.equal(caps.backend, 'cpu');

  const stats = await client.loadScene(wallZ(2.5, 0, 6, 0, 3));
  assert.ok(stats.triangles >= 2);

  await client.setSampling({ regions: [{ type: 'full' }] });
  client.setCameras([camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);

  const chunks = new Map<number, ChunkResult>();
  const summary = await client.compute({
    onChunkDone: (id, r) => chunks.set(id, r),
  });

  assert.ok(chunks.has(0), 'chunk 0 streamed back to the main thread');
  assert.ok(summary.validVoxels > 0);
  assert.ok(summary.overallRate > 0 && summary.overallRate <= 1);

  const acc = accessor(chunks.get(0)!);
  const front = voxelIndexOf([0, 0, 0], 0.3, [3.15, 1.65, 4.05]);
  const behind = voxelIndexOf([0, 0, 0], 0.3, [3.15, 1.65, 1.05]);
  assert.equal(acc.getMask(...front) & 1, 1, 'front-of-wall visible via worker');
  assert.equal(acc.getMask(...behind), 0, 'behind-wall occluded via worker');

  client.dispose();
});

test('worker: setCameras throws TOO_MANY_CAMERAS synchronously on the client', () => {
  const client = makeClient();
  const cams = Array.from({ length: 129 }, (_, i) => camera(`c${i}`, [1, 1, 1]));
  assert.throws(
    () => client.setCameras(cams),
    (e: unknown) => e instanceof EngineError && e.code === EngineErrorCode.TOO_MANY_CAMERAS,
  );
});

test('worker: engine errors propagate as rejections', async () => {
  const client = makeClient();
  await client.init({ worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 10, backend: 'cpu' });
  // compute before setSampling → INVALID_STATE from the host engine.
  await assert.rejects(
    () => client.compute({}),
    (e: unknown) => e instanceof EngineError,
  );
});

test('worker: a cancel crosses the boundary and rejects the compute (§13.2)', async () => {
  // The real point of this test: an AbortSignal cannot be cloned into a worker,
  // and on the CPU backend a run only observes a cancel because the engine yields
  // to the *macrotask* queue between chunks. Both are exercised end-to-end here.
  const client = makeClient();
  await client.init({
    worldMin: [0, 0, 0],
    worldMax: [12, 3, 12],
    voxelSize: 0.3,
    chunkSizeXZ: 3, // 16 chunks, so there are boundaries to cancel at
    backend: 'cpu',
  });
  await client.loadScene(wallZ(6, 0, 12, 0, 3));
  await client.setSampling({ regions: [{ type: 'full' }] });
  client.setCameras([camera('c', [6, 1.5, 10], LOOK_NEG_Z, { far: 30 })]);

  const controller = new AbortController();
  let seen = 0;
  const run = client.compute({
    signal: controller.signal,
    onChunkDone: () => {
      // Cancel from inside the stream, i.e. genuinely mid-run.
      if (++seen === 2) controller.abort();
    },
  });

  await assert.rejects(
    () => run,
    (e: unknown) => e instanceof EngineError && e.code === EngineErrorCode.COMPUTE_CANCELED,
  );
  assert.ok(seen < 16, `stopped before every chunk streamed (${seen})`);

  // The client stays usable: a fresh compute on the same worker completes.
  const summary = await client.compute({ onChunkDone: () => {} });
  assert.ok(summary.validVoxels > 0);
  client.dispose();
});

test('worker: a compute with no signal is never made cancellable (§13.2)', async () => {
  const client = makeClient();
  await client.init({ worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 10, backend: 'cpu' });
  await client.loadScene(wallZ(3, 0, 6, 0, 3));
  await client.setSampling({ regions: [{ type: 'full' }] });
  client.setCameras([camera('c', [3, 1.5, 5], LOOK_NEG_Z)]);
  // No signal ⇒ the host installs no controller and the engine skips its
  // per-chunk yield; the run simply completes.
  const summary = await client.compute({ onChunkDone: () => {} });
  assert.ok(summary.validVoxels > 0);
  client.dispose();
});
