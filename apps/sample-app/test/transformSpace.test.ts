import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRANSFORM_SPACE,
  spaceIconKind,
  spaceTooltipKey,
  threeSpace,
  toggleSpace,
} from '../src/scene/transformSpace.ts';

test('defaults to local space (spec §2.4)', () => {
  assert.equal(DEFAULT_TRANSFORM_SPACE, 'local');
});

test('toggleSpace flips between local and global and round-trips', () => {
  assert.equal(toggleSpace('local'), 'global');
  assert.equal(toggleSpace('global'), 'local');
  assert.equal(toggleSpace(toggleSpace('local')), 'local');
});

test('threeSpace maps UI space to TransformControls strings', () => {
  assert.equal(threeSpace('local'), 'local');
  assert.equal(threeSpace('global'), 'world');
});

test('spaceIconKind reflects the current space', () => {
  assert.equal(spaceIconKind('local'), 'box');
  assert.equal(spaceIconKind('global'), 'globe');
});

test('spaceTooltipKey names the current space and the click action (spec §18.4)', () => {
  assert.equal(spaceTooltipKey('local'), 'spaceTooltipLocal');
  assert.equal(spaceTooltipKey('global'), 'spaceTooltipGlobal');
});
