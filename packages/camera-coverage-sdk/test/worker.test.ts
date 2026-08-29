/**
 * Worker host/client end-to-end over the in-process loopback transport (§16).
 * Verifies the full lifecycle proxies correctly, chunk results stream back,
 * and synchronous error semantics (TOO_MANY_CAMERAS) are preserved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkerClient } from '../src/worker/client.ts';
import { installHost } from '../src/worker/host.ts';
import { aggregateTransferables, loopback, type Transport } from '../src/worker/protocol.ts';
import { CoverageEngine } from '../src/engine.ts';
import { accessor } from '../src/results.ts';
import { EngineError, EngineErrorCode, type ChunkResult } from '../src/types.ts';
import { box, camera, LOOK_NEG_Z, voxelIndexOf, wallZ } from './helpers.ts';
import type { AggregateResult, AggregateSpec } from '../src/aggregate.ts';
import type { WorkspaceConfig } from '../src/types.ts';

const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 3 };

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

test('worker: aggregation crosses the boundary while chunks never do (§19.4, §16.1)', async () => {
  const [clientT, hostT] = loopback();
  let posted = 0;
  const counting: Transport = {
    post: (data, transfer) => {
      if ((data as { kind?: string }).kind === 'chunk') posted++;
      hostT.post(data, transfer);
    },
    onMessage: (h) => hostT.onMessage(h),
  };
  installHost(counting, { retainChunks: true });
  const client = new WorkerClient(clientT);

  await client.init({ ...WS, backend: 'cpu' });
  await client.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
  await client.setSampling({ regions: [{ type: 'full' }] });
  client.setCameras([camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);

  const spec: AggregateSpec = {
    regions: [{ center: [2, 1.5, 3], rotation: [0, 0, 0, 1], halfSize: [1.6, 1.4, 2], groups: [0] }],
  };
  const inline: AggregateResult[] = [];
  await client.compute({ mode: 1, aggregate: spec, onAggregate: (r) => inline.push(r) });

  assert.ok(inline.length > 0, 'aggregation results reached the client');
  assert.equal(posted, 0, 'no chunk message was ever posted');
  const total = inline.reduce((n, a) => n + a.regions![0].valid, 0);
  assert.ok(total > 0);

  // Re-reduce a *different* descriptor over the host's retained chunks: no
  // compute, no chunk transfer, a different answer.
  const wider: AggregateSpec = {
    regions: [{ center: [2, 1.5, 3], rotation: [0, 0, 0, 1], halfSize: [3, 2, 3], groups: [0] }],
  };
  const again: AggregateResult[] = [];
  await client.aggregateRetained(wider, { onAggregate: (r) => again.push(r) });
  const widerTotal = again.reduce((n, a) => n + a.regions![0].valid, 0);

  assert.equal(again.length, inline.length, 'every retained chunk was re-reduced');
  assert.ok(widerTotal > total, 'the wider region counts more voxels');
  assert.equal(posted, 0, 'still no chunk message');
  client.dispose();
});

test('§16.1: every aggregate accumulator is on the transfer list, groups included', async () => {
  // §16.1: "results are transferred, not cloned." A group is a region
  // accumulator in every respect but which entries it sums (§19.2), so it
  // carries a `seen` array of the same shape — and omitting it left the one
  // part of the result structured-clone *copied* while the rest was
  // transferred. The numbers are identical either way, so this is asserted on
  // the transfer list itself. (`loopback` clones and ignores the list, so a
  // round trip cannot show it.)
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS, backend: 'cpu' });
  await engine.loadScene(box([1.5, 0.6, 2.4], [3.0, 2.1, 3.3]));
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras([camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);

  // Two regions declaring one shared group, plus a slab, leaf counts and a
  // probe: every array-bearing primitive of §19.2 in one result.
  const spec: AggregateSpec = {
    regions: [
      { center: [2, 1.5, 2.4], rotation: [0, 0, 0, 1], halfSize: [1.2, 1.4, 1.2], groups: [0] },
      { center: [2, 1.5, 3.6], rotation: [0, 0, 0, 1], halfSize: [1.2, 1.4, 1.2], groups: [0] },
    ],
    columns: [{ axis: 1, range: [[0, 19], [0, 9], [0, 19]], maskRegions: [] }],
    leafCounts: { maskRegions: [] },
    probes: [[3.15, 1.65, 4.5]],
  };
  const out: AggregateResult[] = [];
  await engine.compute({ mode: 1, aggregate: spec, onAggregate: (r) => out.push(r) });
  engine.dispose();

  const withGroups = out.filter((r) => (r.groups?.length ?? 0) > 0);
  assert.ok(withGroups.length > 0, 'no chunk carried group accumulators');

  for (const r of out) {
    const listed = new Set(aggregateTransferables(r));
    const owned: [string, ArrayBufferLike][] = [];
    (r.regions ?? []).forEach((x, i) => owned.push([`regions[${i}].seen`, x.seen.buffer]));
    (r.groups ?? []).forEach((x, i) => owned.push([`groups[${i}].seen`, x.seen.buffer]));
    (r.columns ?? []).forEach((c, i) => {
      owned.push([`columns[${i}].camCountSum`, c.camCountSum.buffer]);
      owned.push([`columns[${i}].seenWords`, c.seenWords.buffer]);
    });
    if (r.leafCounts) owned.push(['leafCounts.count', r.leafCounts.count.buffer]);
    if (r.probeMasks) owned.push(['probeMasks', r.probeMasks.buffer]);

    for (const [what, buf] of owned) {
      assert.ok(listed.has(buf as ArrayBuffer), `chunk ${r.chunkId}: ${what} would be cloned, not transferred`);
    }
  }
});
