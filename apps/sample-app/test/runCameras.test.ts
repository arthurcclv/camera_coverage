import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskBitSet, runCameras, NO_RUN_CAMERAS } from '../src/scene/runCameras.ts';

test('with every camera enabled, bit index equals list index (spec §5.4)', () => {
  const cams = runCameras([
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
    { id: 'c', enabled: true },
  ]);
  assert.deepEqual(cams.ids, ['a', 'b', 'c']);
  assert.deepEqual(cams.bits, [0, 1, 2]);
});

test('a disabled camera keeps its bit slot, so later cameras do not shift (spec §5.4)', () => {
  // The whole point of passing disabled cameras to setCameras: filtering 'b' out
  // would move 'c' from bit 2 to bit 1 and invalidate every retained mask.
  const cams = runCameras([
    { id: 'a', enabled: true },
    { id: 'b', enabled: false },
    { id: 'c', enabled: true },
  ]);
  assert.deepEqual(cams.ids, ['a', 'c'], 'disabled cameras are not listed');
  assert.deepEqual(cams.bits, [0, 2], 'but the survivors keep their original bits');
});

test('all cameras disabled yields an empty enabled set, not an error', () => {
  const cams = runCameras([{ id: 'a', enabled: false }]);
  assert.deepEqual(cams.ids, []);
  assert.deepEqual(cams.bits, []);
  assert.deepEqual(NO_RUN_CAMERAS, { ids: [], bits: [] });
});

test('maskBitSet reads bits past word 0 and refuses bits past camWords', () => {
  const words = [0b0101, 0b0010];
  const read = (w: number) => words[w];
  assert.equal(maskBitSet(read, 2, 0), true);
  assert.equal(maskBitSet(read, 2, 1), false);
  assert.equal(maskBitSet(read, 2, 2), true);
  assert.equal(maskBitSet(read, 2, 33), true, 'bit 33 is word 1, bit 1');
  // A run computed with fewer words than the camera list implies must read 0
  // rather than index past the array.
  assert.equal(maskBitSet(read, 1, 33), false);
});
