/** Tests for `cameras/label.ts` (spec §5.4, §12). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraLabel, defaultCameraName } from '../src/cameras/label.ts';

test('derives `Camera N` from a `cam-N` id', () => {
  assert.equal(defaultCameraName('cam-1'), 'Camera 1');
  assert.equal(defaultCameraName('cam-42'), 'Camera 42');
});

test('any other id form is its own default label', () => {
  assert.equal(defaultCameraName('entrance'), 'entrance');
  assert.equal(defaultCameraName('cam-'), 'cam-');
  assert.equal(defaultCameraName('cam-1a'), 'cam-1a');
  assert.equal(defaultCameraName('CAM-1'), 'CAM-1');
});

test('a non-blank name wins', () => {
  assert.equal(cameraLabel({ id: 'cam-1', name: 'Entrance' }), 'Entrance');
});

test('a blank or whitespace name falls back to the default', () => {
  assert.equal(cameraLabel({ id: 'cam-1', name: '' }), 'Camera 1');
  assert.equal(cameraLabel({ id: 'cam-1', name: '   ' }), 'Camera 1');
  assert.equal(cameraLabel({ id: 'cam-2', name: '\t\n' }), 'Camera 2');
});

test('a name with surrounding whitespace is trimmed', () => {
  assert.equal(cameraLabel({ id: 'cam-1', name: '  Entrance  ' }), 'Entrance');
});

test('never returns an empty string', () => {
  for (const name of ['', ' ', '\t']) {
    assert.ok(cameraLabel({ id: 'cam-9', name }).length > 0);
  }
});
