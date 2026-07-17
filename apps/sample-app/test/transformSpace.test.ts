import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRANSFORM_SPACE,
  spaceIconKind,
  spaceTooltip,
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

test('spaceTooltip names the current space and the click action', () => {
  assert.match(spaceTooltip('local'), /^Local space/);
  assert.match(spaceTooltip('local'), /global/);
  assert.match(spaceTooltip('global'), /^Global space/);
  assert.match(spaceTooltip('global'), /local/);
});
