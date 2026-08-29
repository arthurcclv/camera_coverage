import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_MIN_EMPTY,
  MAX_AGGREGATE_GROUPS,
  ProbeHit,
  WorkspaceGrid,
  type AggregateResult,
  type ColumnAccum,
  type RegionAccum,
} from '@linkervision/camera-coverage-sdk';
import { CoverageRun } from '../src/scene/coverageRun.ts';
import { buildAggregateSpec, MARKED_GROUP } from '../src/scene/aggregateSpec.ts';
import type { Probe } from '../src/scene/probeVisibility.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';

// A 2×1×2 workspace of 1 m voxels → one 2×1×2 chunk.
const GRID = new WorkspaceGrid({ worldMin: [0, 0, 0], worldMax: [2, 1, 2], voxelSize: 1, chunkSizeXZ: 2 });
const CAMS = ['cam-a', 'cam-b', 'cam-c'].map((id) => ({ id, enabled: true }));

const PROBE: Probe = { id: 'p1', position: [0.5, 0.5, 0.5], name: '' };
const ZONES: Zone[] = [{ id: 'zone-1', name: 'Z1', enabled: true }];
const VOLUMES: SamplingVolume[] = [
  { id: 'v1', zoneId: 'zone-1', position: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1], size: [1, 1, 1] },
];
const SECTIONS: Section[] = [
  {
    id: 's1', orientation: 'horizontal', min: 0, max: 1, minA: 0, maxA: 2, minB: 0, maxB: 2,
    aggregation: 'mean', enabled: true, clipRange: 1, name: '',
  },
];

function descriptor(zones = ZONES, volumes = VOLUMES, sections = SECTIONS, probes = [PROBE]) {
  return buildAggregateSpec({
    grid: GRID,
    zones,
    volumes,
    sections,
    probes,
    samplingActive: volumes.length > 0,
  });
}

function region(valid: number, covered: number, seen: number[]): RegionAccum {
  return { valid, covered, blind: valid - covered, seen: Uint32Array.from(seen) };
}

function column(dimsA: number, dimsB: number, valid: number[], sum: number[]): ColumnAccum {
  const n = dimsA * dimsB;
  return {
    dimsA,
    dimsB,
    camCountSum: Uint32Array.from(sum),
    camCountMax: Uint8Array.from(sum),
    camCountMin: Uint8Array.from(sum.map((v, i) => (valid[i] > 0 ? v : COLUMN_MIN_EMPTY))),
    blindCount: new Uint32Array(n),
    validCount: Uint32Array.from(valid),
    obstacleCount: new Uint32Array(n),
    filteredCount: new Uint32Array(n),
    seenWords: new Uint32Array(n),
  };
}

/** Groups array laid out as the SDK returns it: one entry per group index. */
function groups(entries: Record<number, RegionAccum>): RegionAccum[] {
  return Array.from({ length: MAX_AGGREGATE_GROUPS }, (_, i) => entries[i] ?? region(0, 0, [0, 0, 0]));
}

/** One chunk's result: zone-1 (group 0) and the marked union both hold 1 voxel. */
function result(chunkId = 0, validInZone = 1): AggregateResult {
  return {
    chunkId,
    regions: [region(validInZone, validInZone, [validInZone, 0, validInZone])],
    groups: groups({
      0: region(validInZone, validInZone, [validInZone, 0, validInZone]),
      [MARKED_GROUP]: region(validInZone, validInZone, [validInZone, 0, validInZone]),
    }),
    columns: [column(2, 2, [1, 1, 1, 1], [2, 2, 2, 2])],
    leafCounts: { counts: new Uint8Array(4), validity: Uint32Array.of(0b1111) },
    probeMasks: Uint32Array.of(0b101),
    probeHits: Uint8Array.of(ProbeHit.Valid),
  };
}

test('reset does not bump the generation; clear does (spec §14.4)', () => {
  const run = new CoverageRun();
  const g0 = run.generation;

  run.reset(GRID, CAMS, descriptor());
  assert.equal(run.generation, g0, 'reset must not invalidate the run that snapshotted the token');

  run.clear();
  assert.equal(run.generation, g0 + 1, 'clear (scene replace) bumps to drop in-flight results');
});

test('isCurrent tracks the current generation across a clear', () => {
  const run = new CoverageRun();
  const token = run.generation;
  assert.equal(run.isCurrent(token), true);

  run.reset(GRID, CAMS, descriptor());
  assert.equal(run.isCurrent(token), true);

  run.clear();
  assert.equal(run.isCurrent(token), false, 'the token from before the clear is now stale');
});

test('addResult fans out: all three reads reflect the retained aggregation', () => {
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor());
  run.addResult(result());

  const probe = run.probeQueries([PROBE]).get('p1')!;
  assert.equal(probe.status, 'ok');
  assert.ok(probe.status === 'ok');
  assert.equal(probe.seenCount, 2, 'cameras at bits 0 and 2');

  const zone = run.zoneCoverage(ZONES);
  assert.ok(zone, 'a retained run yields zone coverage');
  assert.equal(zone.perZone.get('zone-1')!.validVoxels, 1);
  assert.equal(zone.enabledUnion.validVoxels, 1);

  assert.notEqual(run.sectionCells(SECTIONS).get('s1'), null);
});

test('a zone reads from its group, not from summing its regions', () => {
  // Two volumes in one zone, overlapping: their regions each count the shared
  // voxel, the group counts it once. Summing regions would report 2.
  const zones: Zone[] = [{ id: 'zone-1', name: 'Z1', enabled: true }];
  const volumes: SamplingVolume[] = [
    { id: 'v1', zoneId: 'zone-1', position: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1], size: [1, 1, 1] },
    { id: 'v2', zoneId: 'zone-1', position: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1], size: [1, 1, 1] },
  ];
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor(zones, volumes));
  run.addResult({
    chunkId: 0,
    regions: [region(1, 1, [1, 0, 0]), region(1, 1, [1, 0, 0])],
    groups: groups({ 0: region(1, 1, [1, 0, 0]) }),
  });
  assert.equal(run.zoneCoverage(zones)!.perZone.get('zone-1')!.validVoxels, 1);
});

test('a re-sent chunk replaces its accumulators rather than adding to them (spec §8)', () => {
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor());
  run.addResult(result(0, 3));
  assert.equal(run.zoneCoverage(ZONES)!.perZone.get('zone-1')!.validVoxels, 3);

  // What an incremental run does: chunk 0 comes back with different numbers.
  run.addResult(result(0, 1));
  assert.equal(
    run.zoneCoverage(ZONES)!.perZone.get('zone-1')!.validVoxels,
    1,
    'replaced, not summed — a running total could not tell the difference',
  );
});

test('chunks merge: two chunks sum into one answer (spec §13.4)', () => {
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor());
  run.addResult(result(0, 2));
  run.addResult(result(1, 5));
  assert.equal(run.zoneCoverage(ZONES)!.perZone.get('zone-1')!.validVoxels, 7);
});

test('adopt swaps index and results together (spec §3.3)', () => {
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor());
  run.addResult(result(0, 2));

  // A second zone appears; its group index only exists in the new descriptor.
  const zones: Zone[] = [...ZONES, { id: 'zone-2', name: 'Z2', enabled: true }];
  const volumes: SamplingVolume[] = [
    ...VOLUMES,
    { id: 'v2', zoneId: 'zone-2', position: [1.5, 0.5, 1.5], rotation: [0, 0, 0, 1], size: [1, 1, 1] },
  ];
  const next = descriptor(zones, volumes);
  run.adopt(next, [
    {
      chunkId: 0,
      groups: groups({ 0: region(2, 2, [2, 0, 0]), 1: region(4, 1, [1, 0, 0]) }),
    },
  ]);

  const cov = run.zoneCoverage(zones)!;
  assert.equal(cov.perZone.get('zone-1')!.validVoxels, 2);
  assert.equal(cov.perZone.get('zone-2')!.validVoxels, 4);
  assert.equal(cov.perZone.get('zone-2')!.overallRate, 0.25);
});

test('a zone with no volumes reads as all-zero, not as missing', () => {
  const zones: Zone[] = [...ZONES, { id: 'zone-empty', name: 'E', enabled: true }];
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor(zones, VOLUMES));
  run.addResult(result());
  const summary = run.zoneCoverage(zones)!.perZone.get('zone-empty');
  assert.ok(summary, 'every zone gets an entry so its badge stays live');
  assert.equal(summary.validVoxels, 0);
});

test('a probe no chunk claimed reads no-data (spec §12.2)', () => {
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor());
  run.addResult({ ...result(), probeHits: Uint8Array.of(ProbeHit.Missed) });
  assert.equal(run.probeQueries([PROBE]).get('p1')!.status, 'no-data');
});

test('a probe in an invalid voxel reads no-data, not "0 of N" (spec §12.3)', () => {
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor());
  run.addResult({ ...result(), probeHits: Uint8Array.of(ProbeHit.Invalid) });
  assert.equal(run.probeQueries([PROBE]).get('p1')!.status, 'no-data');
});

test('probe masks decode at each camera own mask bit (spec §5.4)', () => {
  const cams = [
    { id: 'cam-a', enabled: true },
    { id: 'cam-b', enabled: false },
    { id: 'cam-c', enabled: true },
  ];
  const run = new CoverageRun();
  run.reset(GRID, cams, descriptor());
  // Bits 0 and 2 set: both *enabled* cameras. Reading by list position would
  // look at bit 1 and report 'cam-c' as unseen.
  run.addResult({ ...result(), probeMasks: Uint32Array.of(0b101) });
  const q = run.probeQueries([PROBE]).get('p1')!;
  assert.ok(q.status === 'ok');
  assert.deepEqual(q.cameraIds, ['cam-a', 'cam-c']);
  assert.deepEqual(q.visible, [true, true]);
});

test('clear wipes all three reads and invalidates the run (spec §14.4)', () => {
  const run = new CoverageRun();
  run.reset(GRID, CAMS, descriptor());
  run.addResult(result());
  assert.ok(run.zoneCoverage(ZONES));

  run.clear();
  assert.equal(run.probeQueries([PROBE]).get('p1')!.status, 'no-data');
  assert.equal(run.zoneCoverage(ZONES), null);
  assert.equal(run.sectionCells(SECTIONS).get('s1'), null);
});

test('the store owns the descriptor its results were produced under (spec §3.3)', () => {
  // A run reuses this rather than the newest descriptor: accumulators laid out
  // by two descriptors cannot be merged, and an incremental run merges.
  const run = new CoverageRun();
  assert.equal(run.descriptor, null);

  const first = descriptor();
  run.reset(GRID, CAMS, first);
  assert.equal(run.descriptor, first);

  const next = descriptor([...ZONES, { id: 'z2', name: 'Z2', enabled: true }]);
  run.adopt(next, [result()]);
  assert.equal(run.descriptor, next, 'adopt swaps both halves');

  run.clear();
  assert.equal(run.descriptor, null);
});

test('a fresh coordinator reads empty before any run', () => {
  const run = new CoverageRun();
  assert.equal(run.hasRun(), false);
  assert.equal(run.probeQueries([PROBE]).get('p1')!.status, 'no-data');
  assert.equal(run.zoneCoverage(ZONES), null);
  assert.equal(run.sectionCells(SECTIONS).get('s1'), null);
});
