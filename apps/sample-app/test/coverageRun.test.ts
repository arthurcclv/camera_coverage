import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceGrid, type ChunkResult } from '@linkervision/camera-coverage-sdk';
import { CoverageRun } from '../src/scene/coverageRun.ts';
import type { Probe } from '../src/scene/probeVisibility.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';

// A 2×1×2 workspace of 1 m voxels → one 2×1×2 chunk. Voxel centers (li = i + 2k):
// 0→(0.5,0.5,0.5), 1→(1.5,0.5,0.5), 2→(0.5,0.5,1.5), 3→(1.5,0.5,1.5).
const GRID = new WorkspaceGrid({ worldMin: [0, 0, 0], worldMax: [2, 1, 2], voxelSize: 1, chunkSizeXZ: 2 });
const IDS = ['cam-a', 'cam-b', 'cam-c'].map((id) => ({ id, enabled: true }));

/** Voxels 0 and 2 valid + seen by cameras 0 and 2; all four valid. */
function buildChunk(): ChunkResult {
  return {
    chunkId: 0,
    encoding: 'dense',
    dims: [2, 1, 2],
    origin: [0, 0, 0],
    voxelSize: 1,
    camWords: 1,
    mode: 1,
    visibility: Uint32Array.from([0b101, 0, 0b101, 0]),
    validity: Uint32Array.of(0b1111),
    coverage: new Uint8Array(4),
    stats: { validVoxels: 4, coveredVoxels: 2, elapsedMs: 0 },
  } as unknown as ChunkResult;
}

const PROBE: Probe = { id: 'p1', position: [0.5, 0.5, 0.5], name: '' }; // voxel 0: valid, seen
const ZONES: Zone[] = [{ id: 'zone-1', name: 'Z1', enabled: true }];
// Box over voxel 0's center → marks exactly that voxel.
const VOLUMES: SamplingVolume[] = [
  { id: 'v1', zoneId: 'zone-1', position: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1], size: [1, 1, 1] },
];
// Horizontal section spanning the whole footprint (collapse axis Y).
const SECTIONS: Section[] = [
  { id: 's1', orientation: 'horizontal', min: 0, max: 1, minA: 0, maxA: 2, minB: 0, maxB: 2, aggregation: 'mean', enabled: true, clipRange: 1 },
];

test('reset does not bump the generation; clear does (spec §14.4)', () => {
  const run = new CoverageRun();
  const g0 = run.generation;

  run.reset(GRID, IDS);
  assert.equal(run.generation, g0, 'reset must not invalidate the run that snapshotted the token');

  run.clear();
  assert.equal(run.generation, g0 + 1, 'clear (scene replace) bumps to drop in-flight chunks');
});

test('isCurrent tracks the current generation across a clear', () => {
  const run = new CoverageRun();
  const token = run.generation;
  assert.equal(run.isCurrent(token), true);

  run.reset(GRID, IDS); // still the same generation
  assert.equal(run.isCurrent(token), true);

  run.clear(); // scene replaced mid-run
  assert.equal(run.isCurrent(token), false, 'the token from before the clear is now stale');
});

test('addChunk fans out: all three reads reflect the retained chunk', () => {
  const run = new CoverageRun();
  run.reset(GRID, IDS);
  run.addChunk(buildChunk());

  const probe = run.probeQueries([PROBE]).get('p1')!;
  assert.equal(probe.status, 'ok');
  assert.ok(probe.status === 'ok');
  assert.equal(probe.seenCount, 2); // cameras at bits 0 and 2

  const zone = run.zoneCoverage(ZONES, VOLUMES);
  assert.ok(zone, 'a retained run yields zone coverage');
  assert.equal(zone.perZone.get('zone-1')!.validVoxels, 1); // the one marked voxel

  const cells = run.sectionCells(SECTIONS, null);
  assert.notEqual(cells.get('s1'), null); // a grid exists once a run is retained
});

test('clear wipes all three reads and invalidates the run (spec §14.4)', () => {
  const run = new CoverageRun();
  run.reset(GRID, IDS);
  run.addChunk(buildChunk());
  assert.ok(run.zoneCoverage(ZONES, VOLUMES)); // populated before clear

  run.clear();
  assert.equal(run.probeQueries([PROBE]).get('p1')!.status, 'no-data');
  assert.equal(run.zoneCoverage(ZONES, VOLUMES), null);
  assert.equal(run.sectionCells(SECTIONS, null).get('s1'), null);
});

test('a fresh coordinator reads empty before any run', () => {
  const run = new CoverageRun();
  assert.equal(run.probeQueries([PROBE]).get('p1')!.status, 'no-data');
  assert.equal(run.zoneCoverage(ZONES, VOLUMES), null);
  assert.equal(run.sectionCells(SECTIONS, null).get('s1'), null);
});
