/**
 * Tests for the "Place on surface" tool's supported-kind rule (spec §2.4.2).
 *
 * The point of `PLACEABLE_KINDS` is that the supported set lives in exactly one
 * place, so these tests pin the list itself as well as the predicate over it:
 * widening it should be a visible, deliberate edit here, not a silent one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLACEABLE_KINDS, canPlace, placeTooltip } from '../src/scene/placement.ts';
import type { Selection } from '../src/scene/viewportSelection.ts';

test('the supported kinds are exactly camera and probe (spec §2.4.2)', () => {
  assert.deepEqual([...PLACEABLE_KINDS], ['camera', 'probe']);
});

test('canPlace accepts the kinds that carry a position', () => {
  assert.equal(canPlace({ kind: 'camera', id: 'cam-1' }), true);
  assert.equal(canPlace({ kind: 'probe', id: 'probe-1' }), true);
});

test('canPlace rejects the kinds that do not (spec §2.4.2)', () => {
  // A section is bounds, not a point; a zone has no transform; a volume's
  // position is its box centre, so a surface hit would bury half the box.
  assert.equal(canPlace({ kind: 'section', id: 'section-1' }), false);
  assert.equal(canPlace({ kind: 'zone', id: 'zone-1' }), false);
  assert.equal(canPlace({ kind: 'volume', id: 'volume-1' }), false);
});

test('canPlace rejects an empty selection', () => {
  assert.equal(canPlace(null), false);
});

test('canPlace agrees with PLACEABLE_KINDS across every selection kind', () => {
  const kinds: Array<NonNullable<Selection>['kind']> = ['camera', 'probe', 'section', 'zone', 'volume'];
  for (const kind of kinds) {
    const expected = PLACEABLE_KINDS.some((k) => k === kind);
    assert.equal(canPlace({ kind, id: `${kind}-1` }), expected, kind);
  }
});

test('the tooltip names the selection requirement when disabled (spec §2.4.2)', () => {
  const tip = placeTooltip(null, false);
  assert.match(tip, /select a camera or probe/i);
  assert.equal(placeTooltip({ kind: 'volume', id: 'volume-1' }, false), tip);
});

test('the tooltip tells the user what to do once armed', () => {
  const selection: Selection = { kind: 'camera', id: 'cam-1' };
  assert.equal(placeTooltip(selection, false), 'Place on surface');
  assert.match(placeTooltip(selection, true), /click the geometry/i);
});
