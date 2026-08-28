/**
 * Acceptance criteria §18 (CPU reference backend, fixed scenes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoverageEngine } from '../src/engine.ts';
import { samplingCounters } from '../src/sampling.ts';
import { tsKernels } from '../src/kernels.ts';
import { accessor } from '../src/results.ts';
import { EngineError, EngineErrorCode } from '../src/types.ts';
import type {
  CameraConfig,
  ChunkResult,
  SceneMesh,
  Vec3,
  WorkspaceConfig,
} from '../src/types.ts';
import type { VoxelAccessor } from '../src/svo.ts';
import { box, camera, LOOK_NEG_Z, voxelIndexOf, wallZ } from './helpers.ts';

const WS: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 6], voxelSize: 0.3, chunkSizeXZ: 10 };
const EMPTY: SceneMesh = { positions: new Float32Array(0), indices: new Uint32Array(0) };

interface RunResult {
  results: Map<number, ChunkResult>;
  acc0: VoxelAccessor;
  summary: { perCamera: { id: string; coverageRate: number }[]; overallRate: number; validVoxels: number };
}

async function run(
  scene: SceneMesh,
  cams: CameraConfig[],
  opts: {
    workspace?: WorkspaceConfig;
    mode?: 1 | 2;
    threshold?: number;
    precull?: boolean;
    solidDetection?: boolean;
  } = {},
): Promise<RunResult> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...(opts.workspace ?? WS), backend: 'cpu', solidDetection: opts.solidDetection ?? true });
  await engine.loadScene(scene);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(cams);
  const results = new Map<number, ChunkResult>();
  const summary = await engine.compute({
    mode: opts.mode ?? 1,
    threshold: opts.threshold ?? 1,
    precull: opts.precull ?? true,
    onChunkDone: (id, r) => results.set(id, r),
  });
  engine.dispose();
  return { results, acc0: accessor(results.get(0)!), summary };
}

const idx = (p: Vec3) => voxelIndexOf(WS.worldMin, WS.voxelSize, p);

// §18.1 -------------------------------------------------------------------
test('empty scene: in-frustum voxels visible, outside not', async () => {
  const { acc0 } = await run(EMPTY, [camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);

  const front = idx([3.15, 1.65, 4.05]);
  const behind = idx([3.15, 1.65, 5.85]); // behind the camera
  const lateral = idx([0.15, 1.65, 4.05]); // outside horizontal FOV

  assert.ok(acc0.isValid(...front), 'front voxel valid');
  assert.equal(acc0.getMask(...front) & 1, 1, 'front voxel visible');
  assert.equal(acc0.getMask(...behind), 0, 'behind-camera voxel not visible');
  assert.equal(acc0.getMask(...lateral), 0, 'outside-FOV voxel not visible');
});

// §18.2 -------------------------------------------------------------------
test('single-wall occlusion', async () => {
  const scene = wallZ(2.5, 0, 6, 0, 3);
  const { acc0 } = await run(scene, [camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);

  const front = idx([3.15, 1.65, 4.05]); // between wall and camera
  const behind = idx([3.15, 1.65, 1.05]); // behind the wall
  const inWall = idx([3.15, 1.65, 2.55]); // on the wall surface

  assert.equal(acc0.getMask(...front) & 1, 1, 'front of wall visible');
  assert.ok(acc0.isValid(...front));
  assert.equal(acc0.getMask(...behind), 0, 'behind wall occluded');
  assert.ok(acc0.isValid(...behind), 'behind-wall voxel is a valid empty sample');
  assert.equal(acc0.isValid(...inWall), false, 'wall voxel is invalid (MIXED)');
});

// §18.3 -------------------------------------------------------------------
test('camera against a wall facing away (t_max regression)', async () => {
  const scene = wallZ(2.95, 0, 6, 0, 3); // 0.05 m behind the camera
  const { acc0, summary } = await run(scene, [camera('c', [3.15, 1.65, 2.9], LOOK_NEG_Z)]);

  const front = idx([3.15, 1.65, 1.05]);
  assert.equal(acc0.getMask(...front) & 1, 1, 'sample in front is visible; wall behind camera must not occlude');
  assert.ok(summary.perCamera[0].coverageRate > 0, 'camera adjacent to a wall stays active');
});

// §18.4 -------------------------------------------------------------------
test('closed box: SOLID interior invalid; with detection off, valid but blocked', async () => {
  const scene = box([1.2, 0.9, 1.2], [3.6, 2.4, 3.6]);
  const cam = camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z);
  const interior = idx([2.55, 1.65, 2.55]);

  const on = await run(scene, [cam], { solidDetection: true });
  assert.equal(on.acc0.isValid(...interior), false, 'interior is SOLID → invalid');

  const off = await run(scene, [cam], { solidDetection: false });
  assert.equal(off.acc0.isValid(...interior), true, 'interior valid when detection off');
  assert.equal(off.acc0.getMask(...interior), 0, 'interior fully blocked by the box');
});

// §18.5 -------------------------------------------------------------------
test('bitmask packing: visible to cameras 0 and 3', async () => {
  const wide: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 10], voxelSize: 0.5, chunkSizeXZ: 10 };
  const target: Vec3 = [3.25, 1.75, 5.25];
  const cams = [
    camera('c0', [3.25, 1.75, 8.25], LOOK_NEG_Z), // sees target
    camera('c1', [3.25, 1.75, 2.25], LOOK_NEG_Z), // target behind → not seen
    camera('c2', [3.25, 1.75, 1.25], LOOK_NEG_Z), // not seen
    camera('c3', [3.25, 1.75, 9.25], LOOK_NEG_Z), // sees target
  ];
  const { acc0 } = await run(EMPTY, cams, { workspace: wide });
  const ti = voxelIndexOf(wide.worldMin, wide.voxelSize, target);
  assert.equal(acc0.getMask(...ti), 0b1001, 'word[0] == 0b1001');
});

test('bitmask packing: CAM_WORDS=4, camera 100 sets bit 4 of word[3]', async () => {
  const wide: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [6, 3, 10], voxelSize: 0.5, chunkSizeXZ: 10 };
  const target: Vec3 = [3.25, 1.75, 5.25];
  const cams: CameraConfig[] = [];
  for (let i = 0; i < 101; i++) cams.push(camera(`c${i}`, [3.25, 1.75, 8.25], LOOK_NEG_Z));

  const { acc0 } = await run(EMPTY, cams, { workspace: wide });
  const ti = voxelIndexOf(wide.worldMin, wide.voxelSize, target);
  assert.equal(acc0.getMaskWord(ti[0], ti[1], ti[2], 0) >>> 0, 0xffffffff, 'word[0] all set');
  const w3 = acc0.getMaskWord(ti[0], ti[1], ti[2], 3);
  assert.equal(w3, 0b11111, 'cameras 96..100 → word[3] low 5 bits');
  assert.notEqual(w3 & (1 << 4), 0, 'camera 100 → bit 4 of word[3]');
});

test('setCameras rejects > 128 cameras', async () => {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS, backend: 'cpu' });
  const cams = Array.from({ length: 129 }, (_, i) => camera(`c${i}`, [1, 1, 1]));
  assert.throws(() => engine.setCameras(cams), (e: unknown) => e instanceof EngineError && e.code === EngineErrorCode.TOO_MANY_CAMERAS);
  engine.dispose();
});

// §18.5a ------------------------------------------------------------------
test('pre-cull losslessness: on/off produce bit-exact masks', async () => {
  const wide: WorkspaceConfig = { worldMin: [0, 0, 0], worldMax: [20, 3, 6], voxelSize: 0.5, chunkSizeXZ: 10 };
  const cams = [
    camera('a', [5, 1.5, 5], LOOK_NEG_Z),
    camera('b', [15, 1.5, 5], LOOK_NEG_Z),
  ];
  const withCull = await collectAll(wide, cams, true);
  const noCull = await collectAll(wide, cams, false);
  assert.deepEqual(withCull, noCull, 'pre-cull must not change output');
});

// §18.6 -------------------------------------------------------------------
test('determinism: two runs are bit-exact', async () => {
  const scene = wallZ(2.5, 0, 6, 0, 3);
  const cams = [camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)];
  const a = await collectAll(WS, cams, true, scene);
  const b = await collectAll(WS, cams, true, scene);
  assert.deepEqual(a, b);
});

// §18.6a ------------------------------------------------------------------
test('validity cache: built once per chunk, never per compute', async () => {
  // Multi-chunk workspace so the build count is a real number, not just 1.
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [26, 3, 26], voxelSize: 0.5, chunkSizeXZ: 10,
  };
  const scene = wallZ(12.5, 0, 26, 0, 3);
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...ws, backend: 'cpu', solidDetection: true });
  await engine.loadScene(scene);

  // loadScene must not build: no sampling config has been supplied yet (§6.4).
  samplingCounters.reset();
  const stats = await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.5, yMax: 2 }] });
  const afterSampling = samplingCounters.builds;
  assert.equal(afterSampling, 9, 'setSampling builds every chunk of the 3x3 partition, once');
  assert.ok(stats.activeChunks > 0);

  // N computes with the cameras changed between them must add no builds, and
  // must keep producing the same validity bits.
  const validityOf = async (camX: number): Promise<Uint32Array[]> => {
    engine.setCameras([camera('c', [camX, 1.5, 20], LOOK_NEG_Z)]);
    const seen: Uint32Array[] = [];
    await engine.compute({ mode: 1, onChunkDone: (_id, r) => {
      // Repack the chunk's validity bits through the accessor, which reads
      // through either encoding — a true bit-identity check, not a count.
      const [nx, ny, nz] = r.dims;
      const acc = accessor(r);
      const bits = new Uint32Array(((nx * ny * nz) + 31) >> 5);
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            if (!acc.isValid(i, j, k)) continue;
            const li = i + nx * (j + ny * k);
            bits[li >> 5] |= 1 << (li & 31);
          }
      seen.push(bits);
    } });
    return seen;
  };
  const first = await validityOf(5);
  const second = await validityOf(21);
  const third = await validityOf(13);
  assert.equal(samplingCounters.builds, afterSampling, 'compute() rebuilt nothing');
  assert.deepEqual(second, first, 'validity is camera-independent');
  assert.deepEqual(third, first, 'validity is camera-independent');
  engine.dispose();
});

// §18.6b ------------------------------------------------------------------
test('validity ownership: transferring a dense chunk\'s validity away is harmless', async () => {
  // Force the dense encoding (§9.5) so ChunkResult carries `validity` at all.
  const engine = new CoverageEngine({
    onWarning: () => {},
    kernels: { ...tsKernels, buildSvo: () => null },
  });
  await engine.init({ ...WS, backend: 'cpu', solidDetection: true });
  await engine.loadScene(wallZ(2.5, 0, 6, 0, 3));
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras([camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z)]);

  const detach = (r: ChunkResult) => {
    assert.equal(r.encoding, 'dense');
    const buf = r.validity!.buffer as ArrayBuffer;
    structuredClone(buf, { transfer: [buf] }); // detaches the caller's copy
    assert.equal(r.validity!.length, 0, 'buffer really was detached');
  };

  const a = await engine.compute({ mode: 1, onChunkDone: (_id, r) => detach(r) });
  const b = await engine.compute({ mode: 1, onChunkDone: (_id, r) => detach(r) });
  assert.equal(b.overallRate, a.overallRate, 'cache survived the transfer');
  assert.equal(b.validVoxels, a.validVoxels);
  assert.ok(a.validVoxels > 0);
  engine.dispose();
});

// §18.6c ------------------------------------------------------------------
test('stats-only equivalence: omitting onChunkDone changes nothing but readback', async () => {
  const scene = wallZ(2.5, 0, 6, 0, 3);
  const cams = [camera('a', [3.15, 1.65, 5.4], LOOK_NEG_Z), camera('b', [1.05, 1.65, 5.4], LOOK_NEG_Z)];
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS, backend: 'cpu', solidDetection: true });
  await engine.loadScene(scene);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(cams);

  let chunksSeen = 0;
  const withVoxels = await engine.compute({ mode: 1, onChunkDone: () => { chunksSeen++; } });
  const statsOnly = await engine.compute({ mode: 1 });
  engine.dispose();

  assert.ok(chunksSeen > 0, 'the voxel-emitting run streamed chunks');
  assert.equal(statsOnly.validVoxels, withVoxels.validVoxels);
  assert.equal(statsOnly.overallRate, withVoxels.overallRate);
  assert.deepEqual(statsOnly.perCamera, withVoxels.perCamera);
});

// §18.6e ------------------------------------------------------------------
test('regions outside a chunk contribute nothing', async () => {
  // 3x3 chunk partition; one box region occupying only the first chunk. The
  // build loops narrow to the region's index range, so every other chunk must
  // fall out empty rather than collapsing onto a clamped edge index.
  const ws: WorkspaceConfig = {
    worldMin: [0, 0, 0], worldMax: [26, 3, 26], voxelSize: 0.5, chunkSizeXZ: 10,
  };
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...ws, backend: 'cpu', solidDetection: true });
  await engine.loadScene(EMPTY);

  const corner = await engine.setSampling({
    regions: [{ type: 'box', min: [0, 0, 0], max: [5, 2.9, 5] }],
  });
  assert.equal(corner.activeChunks, 1, 'only the chunk the box reaches is active');
  // 10 x 6 x 10 voxel centers at 0.5 m inside [0,5] x [0,2.9] x [0,5].
  assert.equal(corner.validVoxels, 600, 'no edge plane from the neighbouring chunks');

  // Streamed chunks must agree with the summary: 8 of 9 report nothing.
  engine.setCameras([camera('c', [13, 1.5, 13], LOOK_NEG_Z)]);
  let nonEmpty = 0;
  await engine.compute({ mode: 1, onChunkDone: (_id, r) => {
    const [nx, ny, nz] = r.dims;
    const acc = accessor(r);
    let valid = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) if (acc.isValid(i, j, k)) valid++;
    if (valid > 0) nonEmpty++;
  } });
  assert.equal(nonEmpty, 1, 'exactly one chunk carries valid voxels');

  // A band entirely above the workspace reaches no chunk at all.
  const above = await engine.setSampling({
    regions: [{ type: 'heightBand', yMin: 50, yMax: 60 }],
  });
  assert.equal(above.validVoxels, 0, 'out-of-workspace band yields no voxels');
  assert.equal(above.activeChunks, 0);

  // ...and so does one entirely below it.
  const below = await engine.setSampling({
    regions: [{ type: 'heightBand', yMin: -60, yMax: -50 }],
  });
  assert.equal(below.validVoxels, 0);
  assert.equal(below.activeChunks, 0);
  engine.dispose();
});

// §18.7 -------------------------------------------------------------------
test('Mode 2: door-edge voxel has a partial count, threshold behaves', async () => {
  // Half-wall whose edge is at the target/camera x line: some corner samples
  // clear the edge, some are blocked → count strictly in (0,8).
  const scene = wallZ(2.5, 0, 3.15, 0, 3);
  const cam = camera('c', [3.15, 1.65, 5.4], LOOK_NEG_Z);
  const edge = idx([3.15, 1.65, 1.05]);
  const fullyFront = idx([3.15, 1.65, 4.05]);
  const fullyBlocked = idx([1.35, 1.65, 1.05]);

  const t1 = await run(scene, [cam], { mode: 2, threshold: 1 });
  const t8 = await run(scene, [cam], { mode: 2, threshold: 8 });

  // Partial: ≥1 sample visible but <8.
  assert.equal(t1.acc0.getMask(...edge) & 1, 1, 'edge: some sample sees the camera');
  assert.equal(t8.acc0.getMask(...edge) & 1, 0, 'edge: not all 8 samples see the camera');

  // Unobstructed voxel: full count.
  assert.equal(t8.acc0.getMask(...fullyFront) & 1, 1, 'front voxel: all 8 samples visible');
  // Fully occluded voxel: zero count.
  assert.equal(t1.acc0.getMask(...fullyBlocked) & 1, 0, 'fully-behind voxel: no sample visible');
});

// --- helpers ---------------------------------------------------------------

/** Gather (mask, valid) for every voxel of every emitted chunk, for comparison. */
async function collectAll(
  workspace: WorkspaceConfig,
  cams: CameraConfig[],
  precull: boolean,
  scene: SceneMesh = EMPTY,
): Promise<Record<number, number[]>> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...workspace, backend: 'cpu' });
  await engine.loadScene(scene);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(cams);
  const out: Record<number, number[]> = {};
  await engine.compute({
    precull,
    onChunkDone: (id, r) => {
      const acc = accessor(r);
      const [nx, ny, nz] = r.dims;
      const flat: number[] = [];
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            flat.push(acc.getMask(i, j, k) >>> 0, acc.isValid(i, j, k) ? 1 : 0);
          }
      out[id] = flat;
    },
  });
  engine.dispose();
  return out;
}

// ---------------------------------------------------------------------------
// §18.6g–6i — incremental recompute (§13.1)
// ---------------------------------------------------------------------------

/**
 * A 4×4-chunk workspace. Cameras use a short `far` so one camera's frustum
 * touches only a corner of it — without that, every chunk is dirty and 6h's
 * strict-subset assertion is vacuous.
 */
const WS_CHUNKED: WorkspaceConfig = {
  worldMin: [0, 0, 0],
  worldMax: [12, 3, 12],
  voxelSize: 0.3,
  chunkSizeXZ: 3,
};
const CHUNK_COUNT = 16;

/** A wall inside the workspace, so occlusion (not just frustum math) is exercised. */
const WALL: SceneMesh = wallZ(6, 0, 12, 0, 3);

const shortCam = (id: string, position: Vec3, extra: Partial<CameraConfig> = {}) =>
  camera(id, position, LOOK_NEG_Z, { fov: 60, far: 2.5, ...extra });

/** Flatten a chunk's per-voxel mask words + validity, for bit-exact comparison. */
function flatten(r: ChunkResult, camWords: number): number[] {
  const acc = accessor(r);
  const [nx, ny, nz] = r.dims;
  const flat: number[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        for (let w = 0; w < camWords; w++) flat.push(acc.getMaskWord(i, j, k, w) >>> 0);
        flat.push(acc.isValid(i, j, k) ? 1 : 0);
      }
  return flat;
}

interface IncrRun {
  summary: { perCamera: { id: string; coverageRate: number }[]; overallRate: number; validVoxels: number };
  chunks: Map<number, number[]>;
  runStart: { incremental: boolean; chunkIds: number[] } | null;
  /** Backend dispatches — how many chunks actually reached Passes 1–3. */
  dispatches: number;
}

/**
 * Drive an engine through a sequence of camera sets, returning the last run's
 * outcome. Every run after the first asks for `incremental: true`, so the second
 * entry of `sets` is the edit under test.
 */
async function incrementalSequence(
  sets: CameraConfig[][],
  opts: {
    scene?: SceneMesh;
    /** Per-run overrides, indexed alongside `sets`. */
    perRun?: { mode?: 1 | 2; threshold?: number; emitVoxels?: boolean }[];
  } = {},
): Promise<IncrRun> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS_CHUNKED, backend: 'cpu' });
  await engine.loadScene(opts.scene ?? WALL);
  await engine.setSampling({ regions: [{ type: 'full' }] });

  // Wrap the backend to count how many chunks are actually dispatched. Counting
  // emitted chunks would not do: the empty-activeMask path emits without
  // dispatching, so a regression that recomputes everything could still emit the
  // same number of chunks.
  const internals = engine as unknown as { backend: { computeChunk: (a: unknown) => unknown } };
  const backend = internals.backend;
  const original = backend.computeChunk.bind(backend);
  let dispatches = 0;

  let last: IncrRun | null = null;
  for (let n = 0; n < sets.length; n++) {
    const over = opts.perRun?.[n] ?? {};
    const emitVoxels = over.emitVoxels ?? true;
    engine.setCameras(sets[n]);
    const camWords = Math.max(1, Math.ceil(sets[n].length / 32));
    const chunks = new Map<number, number[]>();
    let runStart: IncrRun['runStart'] = null;
    dispatches = 0;
    backend.computeChunk = (a: unknown) => {
      dispatches++;
      return original(a);
    };
    const summary = await engine.compute({
      mode: over.mode ?? 1,
      threshold: over.threshold ?? 1,
      incremental: n > 0,
      onRunStart: (info) => (runStart = { ...info }),
      onChunkDone: emitVoxels ? (id, r) => chunks.set(id, flatten(r, camWords)) : undefined,
    });
    last = { summary, chunks, runStart, dispatches };
  }
  engine.dispose();
  return last!;
}

const C0 = [shortCam('a', [1.5, 1.5, 10.5]), shortCam('b', [10.5, 1.5, 4.0])];
/** Camera 'a' nudged — the gizmo-drag case §13.1 exists for. */
const C1 = [shortCam('a', [1.9, 1.5, 10.3]), shortCam('b', [10.5, 1.5, 4.0])];

test('§18.6g: an incremental run is bit-identical to a full run at the same cameras', async () => {
  const incr = await incrementalSequence([C0, C1]);
  const full = await incrementalSequence([C1]);

  assert.equal(incr.runStart?.incremental, true, 'the C0 → C1 edit must be eligible');

  // Whole-scene summary, not just the recomputed chunks.
  assert.deepEqual(incr.summary.perCamera, full.summary.perCamera);
  assert.equal(incr.summary.overallRate, full.summary.overallRate);
  assert.equal(incr.summary.validVoxels, full.summary.validVoxels);

  // Every chunk the incremental run emitted matches the full run's, word for word.
  assert.ok(incr.chunks.size > 0, 'the edit must dirty at least one chunk');
  for (const [id, flat] of incr.chunks) {
    assert.deepEqual(flat, full.chunks.get(id), `chunk ${id} differs from the full run`);
  }
});

test('§18.6h: an incremental run dispatches only its dirty chunks', async () => {
  const incr = await incrementalSequence([C0, C1]);
  const full = await incrementalSequence([C1]);

  const dirty = incr.runStart!.chunkIds;
  assert.ok(dirty.length < CHUNK_COUNT, 'a short-range camera nudge must not dirty the workspace');
  assert.ok(incr.dispatches < full.dispatches, 'incremental must dispatch fewer chunks than full');
  assert.ok(incr.dispatches <= dirty.length, 'no chunk outside the reported set may dispatch');

  // The emitted chunks are exactly the reported ones — a caller replacing by
  // chunkId must not be handed a chunk the run never announced.
  assert.deepEqual([...incr.chunks.keys()].sort((x, y) => x - y), [...dirty].sort((x, y) => x - y));
});

test('§18.6h: an edit that changes nothing dispatches nothing', async () => {
  const incr = await incrementalSequence([C0, C0]);
  assert.equal(incr.runStart?.incremental, true);
  assert.deepEqual(incr.runStart?.chunkIds, []);
  assert.equal(incr.dispatches, 0);
  assert.equal(incr.chunks.size, 0);
  // The summary is still the whole scene's, served entirely from retained stats.
  const full = await incrementalSequence([C0]);
  assert.deepEqual(incr.summary.perCamera, full.summary.perCamera);
  assert.equal(incr.summary.overallRate, full.summary.overallRate);
});

test('§18.6i: an index-shifting camera-list edit falls back to a full run', async () => {
  const added = [...C0, shortCam('c', [6.0, 1.5, 6.0])];
  const removed = [C0[0]];
  const reordered = [C0[1], C0[0]];

  for (const [label, next] of [
    ['add', added],
    ['delete', removed],
    ['reorder', reordered],
  ] as const) {
    const incr = await incrementalSequence([C0, next]);
    assert.equal(incr.runStart?.incremental, false, `${label} must not run incrementally`);
    assert.equal(incr.runStart?.chunkIds.length, CHUNK_COUNT, `${label} must run every chunk`);
  }
});

test('§18.6i: changing mode, threshold, or emitVoxels falls back to a full run', async () => {
  const cases: { label: string; perRun: { mode?: 1 | 2; threshold?: number; emitVoxels?: boolean }[] }[] = [
    { label: 'mode', perRun: [{ mode: 1 }, { mode: 2 }] },
    { label: 'threshold', perRun: [{ mode: 2, threshold: 1 }, { mode: 2, threshold: 4 }] },
    { label: 'emitVoxels', perRun: [{ emitVoxels: false }, { emitVoxels: true }] },
  ];
  for (const { label, perRun } of cases) {
    const incr = await incrementalSequence([C0, C1], { perRun });
    assert.equal(incr.runStart?.incremental, false, `${label} change must not run incrementally`);
  }
});

test('§18.6i: toggling `enabled` stays incremental and clears that camera everywhere', async () => {
  const off = [C0[0], shortCam('b', [10.5, 1.5, 4.0], { enabled: false })];
  const incr = await incrementalSequence([C0, off]);
  const full = await incrementalSequence([off]);

  assert.equal(incr.runStart?.incremental, true, 'a toggle is index-stable, so it stays eligible');
  assert.ok(incr.runStart!.chunkIds.length < CHUNK_COUNT, 'only b’s frustum chunks are dirty');
  assert.deepEqual(incr.summary.perCamera, full.summary.perCamera);
  // The disabled camera keeps its slot and reports zero, rather than vanishing.
  assert.equal(incr.summary.perCamera.length, 2);
  assert.equal(incr.summary.perCamera[1].id, 'b');
  assert.equal(incr.summary.perCamera[1].coverageRate, 0);
});

test('§18.6i: the first run has no baseline, so it is always full', async () => {
  const incr = await incrementalSequence([C0]);
  assert.equal(incr.runStart?.incremental, false);
  assert.equal(incr.runStart?.chunkIds.length, CHUNK_COUNT);
});

test('§13.1: setSampling drops the baseline, so the next run is full', async () => {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS_CHUNKED, backend: 'cpu' });
  await engine.loadScene(WALL);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(C0);
  await engine.compute({ onChunkDone: () => {} });

  await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.5, yMax: 2.0 }] });
  engine.setCameras(C1);
  let runStart: { incremental: boolean; chunkIds: number[] } | null = null;
  await engine.compute({
    incremental: true,
    onRunStart: (i) => (runStart = { ...i }),
    onChunkDone: () => {},
  });
  engine.dispose();
  assert.equal(runStart!.incremental, false);
  assert.equal(runStart!.chunkIds.length, CHUNK_COUNT);
});

test('§13.1: a scoped `chunks` run leaves the baseline untouched', async () => {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS_CHUNKED, backend: 'cpu' });
  await engine.loadScene(WALL);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(C0);
  const base = await engine.compute({ onChunkDone: () => {} });

  // A scoped run reports over just its chunks — today's behavior, unchanged.
  const scoped = await engine.compute({ chunks: [0], onChunkDone: () => {} });
  assert.ok(scoped.validVoxels < base.validVoxels);

  // ...and the baseline still describes C0, so a C0 → C0 run is a no-op.
  let runStart: { incremental: boolean; chunkIds: number[] } | null = null;
  const after = await engine.compute({
    incremental: true,
    onRunStart: (i) => (runStart = { ...i }),
    onChunkDone: () => {},
  });
  engine.dispose();
  assert.equal(runStart!.incremental, true);
  assert.deepEqual(runStart!.chunkIds, []);
  assert.equal(after.validVoxels, base.validVoxels);
  assert.deepEqual(after.perCamera, base.perCamera);
});

// ---------------------------------------------------------------------------
// §18.6j–6k — cancellation (§13.2)
// ---------------------------------------------------------------------------

/**
 * Run to completion, counting backend dispatches, with a hook that can abort
 * part-way. `abortAfter` fires the controller once that many chunks have been
 * dispatched — so `abortAfter: 0` cancels before any chunk starts.
 */
async function cancellableRun(
  cams: CameraConfig[],
  abortAfter: number | null,
): Promise<{ dispatches: number; error: unknown; engine: CoverageEngine; controller: AbortController }> {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS_CHUNKED, backend: 'cpu' });
  await engine.loadScene(WALL);
  await engine.setSampling({ regions: [{ type: 'full' }] });
  engine.setCameras(cams);

  const controller = new AbortController();
  const internals = engine as unknown as { backend: { computeChunk: (a: unknown) => unknown } };
  const backend = internals.backend;
  const original = backend.computeChunk.bind(backend);
  let dispatches = 0;
  backend.computeChunk = (a: unknown) => {
    dispatches++;
    if (abortAfter !== null && dispatches >= abortAfter && abortAfter > 0) controller.abort();
    return original(a);
  };
  if (abortAfter === 0) controller.abort();

  let error: unknown = null;
  try {
    await engine.compute({ signal: controller.signal, onChunkDone: () => {} });
  } catch (err) {
    error = err;
  }
  return { dispatches, error, engine, controller };
}

test('§18.6j: a cancelled compute rejects with COMPUTE_CANCELED and stops dispatching', async () => {
  const { dispatches, error, engine } = await cancellableRun(C0, 2);
  assert.ok(error instanceof EngineError, 'cancellation surfaces as an EngineError');
  assert.equal((error as EngineError).code, EngineErrorCode.COMPUTE_CANCELED);
  // The chunk in flight when the signal fired always finishes (§13.2), so the
  // count may exceed the trigger by one — but it must not reach the full run.
  assert.ok(dispatches < CHUNK_COUNT, `stopped early (${dispatches} of ${CHUNK_COUNT})`);
  engine.dispose();
});

test('§18.6j: aborting before the first chunk dispatches nothing', async () => {
  const { dispatches, error, engine } = await cancellableRun(C0, 0);
  assert.equal((error as EngineError).code, EngineErrorCode.COMPUTE_CANCELED);
  assert.equal(dispatches, 0);
  engine.dispose();
});

test('§18.6j: the engine stays usable — the next run matches an uninterrupted one', async () => {
  const { engine, error } = await cancellableRun(C0, 2);
  assert.equal((error as EngineError).code, EngineErrorCode.COMPUTE_CANCELED);

  // Same engine, no re-init: a fresh compute must be complete and correct.
  const after = await engine.compute({ onChunkDone: () => {} });
  engine.dispose();

  const clean = await incrementalSequence([C0]);
  assert.equal(after.validVoxels, clean.summary.validVoxels);
  assert.equal(after.overallRate, clean.summary.overallRate);
  assert.deepEqual(after.perCamera, clean.summary.perCamera);
});

test('§18.6j: an already-finished run ignores a late abort', async () => {
  const { engine, controller } = await cancellableRun(C0, null);
  controller.abort(); // after the run settled
  const after = await engine.compute({ signal: controller.signal, onChunkDone: () => {} }).catch((e) => e);
  engine.dispose();
  // A *new* compute on an already-aborted signal is cancelled immediately — the
  // late abort didn't corrupt anything, it just applies to the next run.
  assert.equal((after as EngineError).code, EngineErrorCode.COMPUTE_CANCELED);
});

test('§18.6k: a cancelled run drops the incremental baseline', async () => {
  const engine = new CoverageEngine({ onWarning: () => {} });
  await engine.init({ ...WS_CHUNKED, backend: 'cpu' });
  await engine.loadScene(WALL);
  await engine.setSampling({ regions: [{ type: 'full' }] });

  // A completed run establishes a baseline at C0.
  engine.setCameras(C0);
  await engine.compute({ onChunkDone: () => {} });

  // A cancelled run at C1 leaves statistics straddling two camera generations.
  const controller = new AbortController();
  const internals = engine as unknown as { backend: { computeChunk: (a: unknown) => unknown } };
  const backend = internals.backend;
  const original = backend.computeChunk.bind(backend);
  let n = 0;
  backend.computeChunk = (a: unknown) => {
    if (++n >= 2) controller.abort();
    return original(a);
  };
  engine.setCameras(C1);
  await engine
    .compute({ signal: controller.signal, onChunkDone: () => {} })
    .catch(() => {});
  backend.computeChunk = original;

  // The C1 → C1 edit would be eligible on an intact baseline; it must not be.
  let runStart: { incremental: boolean; chunkIds: number[] } | null = null;
  await engine.compute({
    incremental: true,
    onRunStart: (i) => (runStart = { ...i }),
    onChunkDone: () => {},
  });
  engine.dispose();
  assert.equal(runStart!.incremental, false, 'the baseline must not survive a cancellation');
  assert.equal(runStart!.chunkIds.length, CHUNK_COUNT);
});
