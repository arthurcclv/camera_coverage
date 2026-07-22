import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraLabel, defaultCameraName, toCameraConfig, type SceneCamera } from '../src/cameras/camera.ts';

function cam(id: string, name: string): SceneCamera {
  return { id, name, position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 };
}

test('defaultCameraName derives "Camera N" from a cam-N id, else passes the id through (spec §5.6)', () => {
  assert.equal(defaultCameraName('cam-1'), 'Camera 1');
  assert.equal(defaultCameraName('cam-42'), 'Camera 42');
  assert.equal(defaultCameraName('weird'), 'weird');
});

test('cameraLabel trims the name and falls back to the default when blank (spec §5.6)', () => {
  assert.equal(cameraLabel(cam('cam-1', 'Front door')), 'Front door');
  assert.equal(cameraLabel(cam('cam-1', '  Lobby  ')), 'Lobby');
  assert.equal(cameraLabel(cam('cam-2', '')), 'Camera 2');
  assert.equal(cameraLabel(cam('cam-3', '   ')), 'Camera 3');
});

test('toCameraConfig drops the app-only name at the SDK boundary (spec §8, §14.1)', () => {
  const cfg = toCameraConfig(cam('cam-1', 'Front door'));
  assert.equal('name' in cfg, false);
  assert.deepEqual(cfg, { id: 'cam-1', position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 });
});
