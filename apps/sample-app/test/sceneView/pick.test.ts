import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestHit, type PickCandidate } from '../../src/scene/sceneView/pick.ts';

const cam = (id: string, distance: number): PickCandidate => ({ selection: { kind: 'camera', id }, distance });
const probe = (id: string, distance: number): PickCandidate => ({ selection: { kind: 'probe', id }, distance });
const volume = (id: string, distance: number): PickCandidate => ({ selection: { kind: 'volume', id }, distance });

test('no candidates → null (a click on empty space, spec §5.2)', () => {
  assert.equal(nearestHit([]), null);
});

test('a single candidate is selected', () => {
  assert.deepEqual(nearestHit([probe('probe-1', 4.2)]), { kind: 'probe', id: 'probe-1' });
});

test('the nearest candidate wins regardless of push order (spec §5.2, §12.4)', () => {
  const hit = nearestHit([cam('cam-1', 9), volume('vol-1', 2), probe('probe-1', 5)]);
  assert.deepEqual(hit, { kind: 'volume', id: 'vol-1' });
});

test('ties keep the earlier candidate (camera → probe → volume push order)', () => {
  // Camera and probe hit at the same distance: camera was pushed first, so it wins.
  const hit = nearestHit([cam('cam-1', 3), probe('probe-1', 3)]);
  assert.deepEqual(hit, { kind: 'camera', id: 'cam-1' });
});
