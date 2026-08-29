/**
 * The app → SDK descriptor mapping (spec §3.3).
 *
 * This is the file where a mistake is invisible: every wrong answer it can
 * produce is a *plausible* number read out of the wrong group or the wrong slab,
 * never a crash. So the assertions here are about identity — which region is
 * whose, which group a zone owns, which slab a section reads — rather than about
 * coverage values, which the SDK's own tests already pin down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AGGREGATE_GROUPS,
  MAX_AGGREGATE_PROBES,
  MAX_AGGREGATE_REGIONS,
  MAX_AGGREGATE_SLABS,
  validateAggregateSpec,
  WorkspaceGrid,
  type Quat,
} from '@linkervision/camera-coverage-sdk';
import {
  buildAggregateSpec,
  capWarningMessage,
  CAPS,
  MARKED_GROUP,
  MAX_ZONES,
  sectionColumnLength,
} from '../src/scene/aggregateSpec.ts';
import { slabTransposed } from '../src/scene/sectionHeatmap.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import type { Probe } from '../src/scene/probeVisibility.ts';

const IDENTITY: Quat = [0, 0, 0, 1];
// 4×2×4 m of 1 m voxels ⇒ gridDims [4, 2, 4].
const GRID = new WorkspaceGrid({ worldMin: [0, 0, 0], worldMax: [4, 2, 4], voxelSize: 1, chunkSizeXZ: 4 });

function zone(id: string, enabled = true): Zone {
  return { id, name: id, enabled };
}

function volume(id: string, zoneId: string, x = 0): SamplingVolume {
  return { id, zoneId, position: [x, 0, 0], rotation: IDENTITY, size: [2, 2, 2] };
}

function section(id: string, orientation: Section['orientation'] = 'horizontal'): Section {
  return {
    id, orientation, min: 0, max: 2, minA: 0, maxA: 4, minB: 0, maxB: 4,
    aggregation: 'mean', enabled: true, clipRange: 1, name: '',
  };
}

function build(over: Partial<Parameters<typeof buildAggregateSpec>[0]> = {}) {
  return buildAggregateSpec({
    grid: GRID,
    zones: [],
    volumes: [],
    sections: [],
    probes: [],
    samplingActive: false,
    ...over,
  });
}

test('every descriptor the app can build is valid by the SDK rules (§19.6)', () => {
  const { spec } = build({
    zones: [zone('z1'), zone('z2', false)],
    volumes: [volume('v1', 'z1'), volume('v2', 'z2', 3)],
    sections: [section('s1'), section('s2', 'vertical-x'), section('s3', 'vertical-z')],
    probes: [{ id: 'p1', position: [1, 1, 1], name: '' }],
    samplingActive: true,
  });
  assert.doesNotThrow(() => validateAggregateSpec(spec));
});

test('one region per volume, in volume order', () => {
  const { spec } = build({
    zones: [zone('z1')],
    volumes: [volume('v1', 'z1', 0), volume('v2', 'z1', 3)],
    samplingActive: true,
  });
  assert.equal(spec.regions!.length, 2);
  assert.deepEqual(spec.regions![0].center, [0, 0, 0]);
  assert.deepEqual(spec.regions![1].center, [3, 0, 0]);
  // Half-extents, not full sizes — a volume's `size` is its full edge length.
  assert.deepEqual(spec.regions![0].halfSize, [1, 1, 1]);
});

test("a zone's volumes all declare that zone's group", () => {
  const { spec, index } = build({
    zones: [zone('z1'), zone('z2')],
    volumes: [volume('v1', 'z1'), volume('v2', 'z2'), volume('v3', 'z1')],
    samplingActive: true,
  });
  const g1 = index.zoneGroup.get('z1')!;
  const g2 = index.zoneGroup.get('z2')!;
  assert.notEqual(g1, g2);
  assert.ok(spec.regions![0].groups.includes(g1));
  assert.ok(spec.regions![1].groups.includes(g2));
  assert.ok(spec.regions![2].groups.includes(g1));
});

test('only enabled zones feed the marked group and the filter (§7.3)', () => {
  const { spec, index } = build({
    zones: [zone('z1'), zone('z2', false)],
    volumes: [volume('v1', 'z1'), volume('v2', 'z2', 3)],
    samplingActive: true,
  });
  assert.ok(spec.regions![0].groups.includes(MARKED_GROUP));
  assert.ok(!spec.regions![1].groups.includes(MARKED_GROUP), 'a disabled zone is out of the union');
  // …but it still declares its own group, so its panel stays live.
  assert.ok(spec.regions![1].groups.includes(index.zoneGroup.get('z2')!));

  assert.deepEqual(spec.columns, []);
  assert.deepEqual(spec.leafCounts!.maskRegions, [0], 'only the enabled zone filters');
  assert.equal(index.marked, true);
});

test('with sampling inactive nothing is filtered and the union is empty', () => {
  const { spec, index } = build({
    zones: [zone('z1')],
    volumes: [volume('v1', 'z1')],
    sections: [section('s1')],
    samplingActive: false,
  });
  assert.deepEqual(spec.leafCounts!.maskRegions, [], 'no filter ⇒ every valid voxel drawn');
  assert.deepEqual(spec.columns![0].maskRegions, []);
  assert.ok(!spec.regions![0].groups.includes(MARKED_GROUP));
  assert.equal(index.marked, false);
});

test('a volume whose zone no longer exists is dropped, not orphaned into a group', () => {
  const { spec } = build({
    zones: [zone('z1')],
    volumes: [volume('v1', 'z1'), volume('vX', 'gone')],
    samplingActive: true,
  });
  assert.equal(spec.regions!.length, 1);
});

test('a section becomes a slab with its own collapse axis (§13.2)', () => {
  const { spec, index } = build({
    sections: [section('h', 'horizontal'), section('vx', 'vertical-x'), section('vz', 'vertical-z')],
  });
  assert.equal(spec.columns!.length, 3);
  assert.equal(spec.columns![index.sectionSlab.get('h')!].axis, 1);
  assert.equal(spec.columns![index.sectionSlab.get('vx')!].axis, 0);
  assert.equal(spec.columns![index.sectionSlab.get('vz')!].axis, 2);
});

test('only vertical-x is transposed (spec §3.3)', () => {
  // Derived from the orientation, not carried in the index: the descriptor and
  // the read-back share one owner of this fact (`sectionHeatmap.slabTransposed`).
  assert.equal(slabTransposed('horizontal'), false);
  assert.equal(slabTransposed('vertical-x'), true, 'Z×Y is descending, the SDK numbers ascending');
  assert.equal(slabTransposed('vertical-z'), false);
});

test("a slab's range is the section footprint in global voxel indices (§13.2)", () => {
  const s = { ...section('s1'), min: 0.5, max: 1.5, minA: 1, maxA: 3, minB: 0, maxB: 4 };
  const { spec } = build({ sections: [s] });
  // axisA = X (1..3 m ⇒ voxel columns 1..2), axisB = Z (0..4 m ⇒ 0..3),
  // collapse = Y (0.5..1.5 m ⇒ 0..1).
  assert.deepEqual(spec.columns![0].range[0], [1, 2]);
  assert.deepEqual(spec.columns![0].range[2], [0, 3]);
  assert.deepEqual(spec.columns![0].range[1], [0, 1]);
});

test('sectionColumnLength counts the voxels a column spans', () => {
  assert.equal(sectionColumnLength(GRID, { ...section('s'), min: 0, max: 2 }), 2);
  assert.equal(sectionColumnLength(GRID, { ...section('s'), min: 0, max: 1 }), 1);
  assert.equal(
    sectionColumnLength(GRID, { ...section('s', 'vertical-x'), min: 0, max: 4 }),
    4,
    'vertical-x collapses X, which is 4 voxels wide',
  );
});

test('probes map to their descriptor index in order', () => {
  const probes: Probe[] = [
    { id: 'p1', position: [0, 0, 0], name: '' },
    { id: 'p2', position: [1, 1, 1], name: '' },
  ];
  const { spec, index } = build({ probes });
  assert.deepEqual(spec.probes, [[0, 0, 0], [1, 1, 1]]);
  assert.equal(index.probeIndex.get('p1'), 0);
  assert.equal(index.probeIndex.get('p2'), 1);
});

test('an over-cap zone is dropped from the index, not folded into a neighbour', () => {
  const zones = Array.from({ length: MAX_ZONES + 2 }, (_, i) => zone(`z${i}`));
  const volumes = zones.map((z, i) => volume(`v${i}`, z.id));
  const { spec, index } = build({ zones, volumes, samplingActive: true });

  assert.equal(index.zoneGroup.size, MAX_ZONES);
  assert.equal(index.zoneGroup.get(`z${MAX_ZONES}`), undefined);
  // Its volumes are dropped too — a region in no group would still report its
  // own entry, and reading a dropped zone's numbers off it would be wrong.
  assert.equal(spec.regions!.length, MAX_ZONES);
  // Every declared group index stays inside the SDK's range.
  for (const r of spec.regions!) {
    for (const g of r.groups) assert.ok(g >= 0 && g < MAX_AGGREGATE_GROUPS);
  }
  assert.doesNotThrow(() => validateAggregateSpec(spec));
});

test('over-cap sections and probes are dropped, and the survivors keep valid indices', () => {
  const sections = Array.from({ length: 40 }, (_, i) => section(`s${i}`));
  const probes: Probe[] = Array.from({ length: 300 }, (_, i) => ({
    id: `p${i}`,
    position: [0, 0, 0],
    name: '',
  }));
  const { spec, index } = build({ sections, probes });

  assert.equal(spec.columns!.length, 32);
  assert.equal(spec.probes!.length, 256);
  assert.equal(index.sectionSlab.get('s39'), undefined);
  assert.equal(index.probeIndex.get('p299'), undefined);
  for (const slab of index.sectionSlab.values()) assert.ok(slab < spec.columns!.length);
  assert.doesNotThrow(() => validateAggregateSpec(spec));
});

test('leafCounts is always requested — the overlay needs counts on every run (§9)', () => {
  const { spec } = build();
  assert.ok(spec.leafCounts, 'omitting it would leave the viewport blank');
});

// --- §3.3 cap warnings (spec §11) -------------------------------------------

test('the caps come from the SDK, never a local copy (§3.3)', () => {
  // A re-typed constant that drifted from the SDK's would either drop a section
  // the SDK would have taken, or hand it one too many and throw — and neither
  // reads as a cap problem at the call site.
  assert.equal(CAPS.zones, MAX_ZONES);
  assert.equal(CAPS.volumes, MAX_AGGREGATE_REGIONS);
  assert.equal(CAPS.sections, MAX_AGGREGATE_SLABS);
  assert.equal(CAPS.probes, MAX_AGGREGATE_PROBES);
});

test('a scene inside every cap warns about nothing', () => {
  const { warnings } = build({
    zones: [zone('z1')],
    volumes: [volume('v1', 'z1')],
    sections: [section('s1')],
    probes: [{ id: 'p1', position: [1, 1, 1], name: '' }],
  });
  assert.deepEqual(warnings, []);
});

test('each over-cap kind is dropped *and* warned about, never silently (§3.3, §11)', () => {
  const zones = Array.from({ length: CAPS.zones + 2 }, (_, i) => zone(`z${i}`));
  const volumes = Array.from({ length: CAPS.volumes + 5 }, (_, i) => volume(`v${i}`, 'z0'));
  const sections = Array.from({ length: CAPS.sections + 8 }, (_, i) => section(`s${i}`));
  const probes: Probe[] = Array.from({ length: CAPS.probes + 44 }, (_, i) => ({
    id: `p${i}`, position: [0, 0, 0], name: '',
  }));
  const { spec, warnings } = build({ zones, volumes, sections, probes, samplingActive: true });

  const byKind = new Map(warnings.map((w) => [w.kind, w]));
  assert.deepEqual([...byKind.keys()].sort(), ['probes', 'sections', 'volumes', 'zones']);
  assert.deepEqual(byKind.get('zones'), {
    kind: 'zones', cap: CAPS.zones, requested: CAPS.zones + 2, dropped: 2,
  });
  assert.equal(byKind.get('volumes')!.dropped, 5);
  assert.equal(byKind.get('sections')!.dropped, 8);
  assert.equal(byKind.get('probes')!.dropped, 44);

  // The descriptor is still valid — that is the whole point of warning rather
  // than throwing: the run proceeds, minus what was named.
  assert.ok(spec.regions!.length <= CAPS.volumes);
  assert.equal(spec.columns!.length, CAPS.sections);
  assert.equal(spec.probes!.length, CAPS.probes);
  assert.doesNotThrow(() => validateAggregateSpec(spec));
});

test('volumes are capped at 64 — the one cap that used to go unchecked (§19.6)', () => {
  // Regression: zones, sections and probes were all bounded, volumes were not,
  // so a 65th volume reached `validateAggregateSpec` and threw
  // AGGREGATE_TOO_LARGE from inside the SDK instead of being dropped here.
  const volumes = Array.from({ length: CAPS.volumes + 1 }, (_, i) => volume(`v${i}`, 'z0'));
  const { spec, warnings } = build({ zones: [zone('z0')], volumes, samplingActive: true });

  assert.equal(spec.regions!.length, CAPS.volumes);
  assert.equal(warnings.find((w) => w.kind === 'volumes')?.dropped, 1);
  assert.doesNotThrow(() => validateAggregateSpec(spec));
});

test('a warning names the kind, the cap, and how many were dropped (§11)', () => {
  const msg = capWarningMessage({ kind: 'sections', cap: 32, requested: 40, dropped: 8 });
  assert.match(msg, /40/);
  assert.match(msg, /32/);
  assert.match(msg, /8/);
  assert.match(msg, /sections/);
});
