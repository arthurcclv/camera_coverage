/**
 * `aim_optimization.md` §8 — the measured per-zone comparison (§6.3).
 *
 * The rule these pin down: the optimizer's own ΔΦ cannot say whether one zone
 * paid for another, so the report must, and a regression must be impossible to
 * miss.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Zone, ZoneCoverage, ZoneSummary } from '../src/scene/samplingVolumes.ts';
import {
  RATE_EPSILON,
  compareCoverage,
  snapshotCoverage,
  type CoverageSnapshot,
} from '../src/optimize/comparison.ts';

const zone = (id: string, name: string): Zone => ({ id, name, enabled: true });

function summary(validVoxels: number, coveredFraction: number): ZoneSummary {
  const blind = Math.round(validVoxels * (1 - coveredFraction));
  return { validVoxels, overallRate: coveredFraction, blindVoxels: blind, perCamera: [] };
}

function coverage(union: ZoneSummary, perZone: Record<string, ZoneSummary>): ZoneCoverage {
  return { perZone: new Map(Object.entries(perZone)), enabledUnion: union };
}

const ZONES = [zone('zone-1', 'Dock'), zone('zone-2', 'Corridor')];

test('§6.3: a snapshot carries the figures a later run is diffed against', () => {
  const snap = snapshotCoverage(
    coverage(summary(1000, 0.5), { 'zone-1': summary(400, 0.25), 'zone-2': summary(600, 0.7) }),
  );
  assert.equal(snap.union.validVoxels, 1000);
  assert.equal(snap.union.coverageRate, 0.5);
  assert.equal(snap.perZone.get('zone-1')!.blindVoxels, 300);
  assert.equal(snap.perZone.get('zone-2')!.coverageRate, 0.7);
});

test('§6.3: a null coverage snapshots as zeros rather than throwing', () => {
  // Reachable in practice: an apply before any run has populated the store.
  const snap = snapshotCoverage(null);
  assert.equal(snap.union.validVoxels, 0);
  assert.equal(snap.perZone.size, 0);
});

test('§6.3: a zone that lost coverage is flagged and listed first', () => {
  // The exact failure §1.3 warns about: Φ rises while a zone gets worse.
  const before = snapshotCoverage(
    coverage(summary(1000, 0.50), { 'zone-1': summary(400, 0.80), 'zone-2': summary(600, 0.30) }),
  );
  const after = snapshotCoverage(
    coverage(summary(1000, 0.62), { 'zone-1': summary(400, 0.55), 'zone-2': summary(600, 0.67) }),
  );

  const c = compareCoverage(before, after, ZONES, 'All enabled zones');

  // The union improved — which is precisely why it cannot be the whole report.
  assert.ok(c.union.rateDelta > 0);
  assert.equal(c.union.regressed, false);
  assert.equal(c.union.zoneId, null);

  assert.equal(c.regressedCount, 1);
  assert.equal(c.zones[0].zoneId, 'zone-1', 'the regression must come first');
  assert.equal(c.zones[0].regressed, true);
  assert.ok(c.zones[0].rateDelta < 0);
  assert.equal(c.zones[1].zoneId, 'zone-2');
  assert.equal(c.zones[1].regressed, false);
});

test('§6.3: improvements are ordered by how much they improved', () => {
  const before = snapshotCoverage(
    coverage(summary(1000, 0.4), { 'zone-1': summary(400, 0.4), 'zone-2': summary(600, 0.4) }),
  );
  const after = snapshotCoverage(
    coverage(summary(1000, 0.6), { 'zone-1': summary(400, 0.45), 'zone-2': summary(600, 0.7) }),
  );
  const c = compareCoverage(before, after, ZONES, 'u');
  assert.equal(c.regressedCount, 0);
  assert.deepEqual(c.zones.map((z) => z.zoneId), ['zone-2', 'zone-1']);
});

test('§6.3: a sub-epsilon drop is noise, not a regression', () => {
  // Coverage is a ratio of integer voxel counts, so it moves by a voxel or two
  // for reasons unrelated to aim. Crying wolf on that would make the banner
  // meaningless.
  const before = snapshotCoverage(coverage(summary(1000, 0.5), { 'zone-1': summary(400, 0.5) }));
  const after = snapshotCoverage(
    coverage(summary(1000, 0.5), { 'zone-1': summary(400, 0.5 - RATE_EPSILON / 2) }),
  );
  const c = compareCoverage(before, after, ZONES, 'u');
  assert.equal(c.regressedCount, 0);
  assert.ok(c.zones[0].rateDelta < 0, 'the delta is still reported, just not flagged');
});

test('§6.3: blindRemoved is positive when blind spots went away', () => {
  const before = snapshotCoverage(coverage(summary(1000, 0.5), { 'zone-1': summary(400, 0.5) }));
  const after = snapshotCoverage(coverage(summary(1000, 0.8), { 'zone-1': summary(400, 0.9) }));
  const c = compareCoverage(before, after, ZONES, 'u');
  assert.equal(c.union.blindRemoved, 500 - 200);
  assert.equal(c.zones[0].blindRemoved, 200 - 40);
});

test('§6.3: a zone with no marked voxels in either run is omitted', () => {
  // An empty zone would otherwise show a meaningless 0% → 0% row on every run.
  const empty: CoverageSnapshot = snapshotCoverage(
    coverage(summary(1000, 0.5), { 'zone-1': summary(400, 0.5), 'zone-2': summary(0, 0) }),
  );
  const c = compareCoverage(empty, empty, ZONES, 'u');
  assert.deepEqual(c.zones.map((z) => z.zoneId), ['zone-1']);
});

test('§6.3: a zone that gained or lost its volumes still appears', () => {
  // Not merely cosmetic: a zone emptied between the two runs is exactly the case
  // where a coverage figure would be silently misleading, so it must be visible.
  const before = snapshotCoverage(coverage(summary(400, 0.5), { 'zone-1': summary(400, 0.5) }));
  const after = snapshotCoverage(coverage(summary(0, 0), { 'zone-1': summary(0, 0) }));
  const c = compareCoverage(before, after, ZONES, 'u');
  assert.equal(c.zones.length, 1);
  assert.equal(c.zones[0].before.validVoxels, 400);
  assert.equal(c.zones[0].after.validVoxels, 0);
});

test('§6.3: zone labels come from the zone list, not the snapshot', () => {
  // The snapshot holds ids; a rename between runs must show the current name.
  const snap = snapshotCoverage(coverage(summary(400, 0.5), { 'zone-1': summary(400, 0.5) }));
  const c = compareCoverage(snap, snap, [zone('zone-1', 'Renamed dock')], 'All enabled zones');
  assert.equal(c.zones[0].label, 'Renamed dock');
  assert.equal(c.union.label, 'All enabled zones');
});
