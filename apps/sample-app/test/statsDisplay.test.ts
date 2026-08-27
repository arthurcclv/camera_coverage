import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoverageSummary } from '@linkervision/camera-coverage-sdk';
import { displayCoverageSummary, hierarchyPerCamera } from '../src/scene/statsDisplay.ts';
import type { ZoneSummary } from '../src/scene/samplingVolumes.ts';

// The SDK summary over the full sampled volume, and the enabled-zones union over
// the (smaller) marked set — the same two cameras, deliberately different rates.
const sdkSummary: CoverageSummary = {
  perCamera: [
    { id: 'cam-1', coverageRate: 0.4 },
    { id: 'cam-2', coverageRate: 0.25 },
  ],
  overallRate: 0.55,
  validVoxels: 1000,
  elapsedMs: 12,
};

const union: ZoneSummary = {
  validVoxels: 200,
  overallRate: 0.9,
  blindVoxels: 20,
  perCamera: [
    { id: 'cam-1', coverageRate: 0.8 },
    { id: 'cam-2', coverageRate: 0.5 },
  ],
};

test('with zones off the SDK summary is displayed as-is (spec §10)', () => {
  assert.equal(displayCoverageSummary(sdkSummary, union, false), sdkSummary);
  assert.equal(displayCoverageSummary(sdkSummary, null, false), sdkSummary);
});

test('with zones on the union overrides the coverage numbers, keeping elapsed (§7.4)', () => {
  const d = displayCoverageSummary(sdkSummary, union, true)!;
  assert.equal(d.overallRate, 0.9);
  assert.equal(d.validVoxels, 200);
  assert.deepEqual(d.perCamera, union.perCamera);
  assert.equal(d.elapsedMs, 12, 'the union has no timing of its own');
});

test('no run means nothing to display', () => {
  assert.equal(displayCoverageSummary(null, union, true), null);
  assert.equal(hierarchyPerCamera(null), null);
});

// The consistency guarantee itself (spec §5.5, `sampling_volumes.md` §7.4): the
// hierarchy badge and the stats panel's "Per camera" line are the same numbers.
test('hierarchy rates are the displayed summary rates, zones on or off', () => {
  for (const samplingActive of [false, true]) {
    const d = displayCoverageSummary(sdkSummary, union, samplingActive);
    assert.deepEqual(hierarchyPerCamera(d), d!.perCamera);
  }
});

test('an empty marked set drops the badges rather than reporting 0% (§7.4)', () => {
  const empty: ZoneSummary = { validVoxels: 0, overallRate: 0, blindVoxels: 0, perCamera: [] };
  const d = displayCoverageSummary(sdkSummary, empty, true)!;
  assert.equal(d.validVoxels, 0);
  assert.equal(hierarchyPerCamera(d), null);
});

test('a camera missing from the union summary gets no rate', () => {
  const partial: ZoneSummary = { ...union, perCamera: [{ id: 'cam-1', coverageRate: 0.8 }] };
  const rates = hierarchyPerCamera(displayCoverageSummary(sdkSummary, partial, true));
  assert.equal(new Map(rates!.map((p) => [p.id, p.coverageRate])).get('cam-2'), undefined);
});
