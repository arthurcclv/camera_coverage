/**
 * Tests for the "Place on surface" tool's target rule (spec §2.4.2).
 *
 * The point of `PLACEABLE_KINDS` is that the supported set lives in exactly one
 * place, so these tests pin the list itself as well as the resolution over it:
 * widening it should be a visible, deliberate edit here, not a silent one.
 *
 * A polyline **vertex** is the one target that is a sub-selection rather than an
 * entity (`camera_placement.md` §6.2), which is why the resolution takes the
 * vertex alongside the selection — and why a constraint selection *without* one
 * is not placeable: a polyline has no position of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLACEABLE_KINDS, canPlace, placeTarget, placeTooltip } from '../src/scene/placement.ts';
import type { Selection } from '../src/scene/viewportSelection.ts';

test('the supported kinds are exactly camera, probe, and constraint (spec §2.4.2)', () => {
  assert.deepEqual([...PLACEABLE_KINDS], ['camera', 'probe', 'constraint']);
});

test('a camera and a probe are placed by their own position', () => {
  assert.deepEqual(placeTarget({ kind: 'camera', id: 'cam-1' }, null), { kind: 'camera', id: 'cam-1' });
  assert.deepEqual(placeTarget({ kind: 'probe', id: 'probe-1' }, null), { kind: 'probe', id: 'probe-1' });
  // A vertex sub-selection is irrelevant to them: it belongs to a constraint.
  assert.deepEqual(placeTarget({ kind: 'camera', id: 'cam-1' }, 2), { kind: 'camera', id: 'cam-1' });
});

test('a constraint is placeable only through a selected vertex (§6.2)', () => {
  const selection: Selection = { kind: 'constraint', id: 'con-1' };
  assert.deepEqual(placeTarget(selection, 2), { kind: 'vertex', id: 'con-1', vertex: 2 });
  // Vertex 0 is a vertex like any other — a falsy index must not read as "none".
  assert.deepEqual(placeTarget(selection, 0), { kind: 'vertex', id: 'con-1', vertex: 0 });
  // A point or plane constraint resolves no vertex, so the tool stays disabled:
  // its position is the whole entity's, and moving it is the gizmo's job.
  assert.equal(placeTarget(selection, null), null);
});

test('the kinds that carry no placeable point are refused (spec §2.4.2)', () => {
  // A section is bounds, not a point; a zone has no transform; a volume's
  // position is its box centre, so a surface hit would bury half the box.
  assert.equal(placeTarget({ kind: 'section', id: 'section-1' }, null), null);
  assert.equal(placeTarget({ kind: 'zone', id: 'zone-1' }, null), null);
  assert.equal(placeTarget({ kind: 'volume', id: 'volume-1' }, null), null);
  assert.equal(placeTarget({ kind: 'constraintGroup', id: 'group-1' }, 1), null);
  assert.equal(placeTarget(null, null), null);
});

test('canPlace agrees with placeTarget across every selection kind', () => {
  const kinds: Array<NonNullable<Selection>['kind']> = [
    'camera', 'probe', 'section', 'zone', 'volume', 'constraintGroup', 'constraint',
  ];
  for (const kind of kinds) {
    for (const vertex of [null, 0, 3]) {
      const selection: Selection = { kind, id: `${kind}-1` };
      assert.equal(canPlace(selection, vertex), placeTarget(selection, vertex) !== null, `${kind}/${vertex}`);
    }
  }
  assert.equal(canPlace(null, null), false);
});

test('the tooltip names the selection requirement when disabled (spec §2.4.2)', () => {
  const tip = placeTooltip(null, null, false);
  assert.match(tip, /select a camera, a probe, or a polyline vertex/i);
  assert.equal(placeTooltip({ kind: 'volume', id: 'volume-1' }, null, false), tip);
  // A constraint with no vertex resolved is disabled for the same reason.
  assert.equal(placeTooltip({ kind: 'constraint', id: 'con-1' }, null, false), tip);
});

test('the tooltip tells the user what to do once armed, and what it will move', () => {
  const selection: Selection = { kind: 'camera', id: 'cam-1' };
  assert.equal(placeTooltip(selection, null, false), 'Place on surface');
  assert.match(placeTooltip(selection, null, true), /click the geometry/i);
  // A vertex target says so, since the button is shared with whole entities.
  const vertexTip = placeTooltip({ kind: 'constraint', id: 'con-1' }, 1, false);
  assert.match(vertexTip, /vertex/i);
  assert.match(placeTooltip({ kind: 'constraint', id: 'con-1' }, 1, true), /click the geometry/i);
});
