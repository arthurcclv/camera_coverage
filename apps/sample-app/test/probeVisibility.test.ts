import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProbeName, probeLabel } from '../src/scene/probeVisibility.ts';

test('probeLabel trims the name and falls back to "Probe N" when blank (spec §5.6, §12.1)', () => {
  assert.equal(defaultProbeName('probe-1'), 'Probe 1');
  assert.equal(defaultProbeName('odd'), 'odd');
  assert.equal(probeLabel({ id: 'probe-1', position: [0, 0, 0], name: 'Aisle 3' }), 'Aisle 3');
  assert.equal(probeLabel({ id: 'probe-1', position: [0, 0, 0], name: '  Dock  ' }), 'Dock');
  assert.equal(probeLabel({ id: 'probe-2', position: [0, 0, 0], name: '' }), 'Probe 2');
  assert.equal(probeLabel({ id: 'probe-3', position: [0, 0, 0], name: '   ' }), 'Probe 3');
});
