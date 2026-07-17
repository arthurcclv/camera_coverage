/**
 * Acceptance criteria §18 (CPU reference backend, fixed scenes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoverageEngine } from '../src/engine.ts';
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
