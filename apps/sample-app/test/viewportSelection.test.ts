import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAG_THRESHOLD_PX,
  isClick,
  selectionAfterClick,
  type Selection,
} from '../src/scene/viewportSelection.ts';

const at = (x: number, y: number) => ({ x, y });
const cam = (id: string): Selection => ({ kind: 'camera', id });
const probe = (id: string): Selection => ({ kind: 'probe', id });

test('isClick treats a still pointer as a click (spec §5.2)', () => {
  assert.equal(isClick(at(100, 100), at(100, 100)), true);
  assert.equal(isClick(at(100, 100), at(103, 104)), true); // 5px, at threshold
});

test('isClick rejects movement past the drag threshold', () => {
  assert.equal(isClick(at(100, 100), at(110, 100)), false);
  assert.equal(isClick(at(0, 0), at(0, DRAG_THRESHOLD_PX + 1)), false);
});

test('genuine click on a gizmo selects that camera (spec §5.2)', () => {
  assert.deepEqual(selectionAfterClick(null, cam('cam-2'), at(50, 50), at(51, 50)), cam('cam-2'));
  assert.deepEqual(selectionAfterClick(cam('cam-1'), cam('cam-2'), at(50, 50), at(50, 50)), cam('cam-2'));
});

test('genuine click on a probe selects that probe, deselecting a camera (spec §5.5)', () => {
  assert.deepEqual(selectionAfterClick(cam('cam-1'), probe('probe-1'), at(50, 50), at(50, 50)), probe('probe-1'));
});

test('genuine click on empty space deselects (spec §5.2)', () => {
  assert.equal(selectionAfterClick(cam('cam-1'), null, at(50, 50), at(52, 51)), null);
  assert.equal(selectionAfterClick(null, null, at(50, 50), at(50, 50)), null);
});

test('drag-tail click leaves the selection unchanged (spec §5.2)', () => {
  // Orbit/transform drag ending over empty space must not deselect.
  assert.deepEqual(selectionAfterClick(cam('cam-1'), null, at(50, 50), at(200, 180)), cam('cam-1'));
  // Drag ending over a different gizmo must not switch selection.
  assert.deepEqual(selectionAfterClick(cam('cam-1'), cam('cam-2'), at(50, 50), at(200, 180)), cam('cam-1'));
});
