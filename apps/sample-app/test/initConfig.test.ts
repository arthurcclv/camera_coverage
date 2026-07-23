import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initConfig } from '../src/engine/useEngine.ts';

test('initConfig: solidDetection is always off (spec §3.2, §4.2)', () => {
  // A watertight imported room would otherwise be flood-filled to SOLID_GEOMETRY
  // in its entirety, flagging every in-room camera CAMERA_INSIDE_GEOMETRY.
  const auto = initConfig([0, 0, 0], [20, 6, 20], 0.5, 10, 'auto');
  assert.equal(auto.solidDetection, false);

  const cpu = initConfig([0, 0, 0], [20, 6, 20], 0.5, 10, 'cpu');
  assert.equal(cpu.solidDetection, false);
});

test('initConfig: forwards the workspace and backend verbatim', () => {
  const cfg = initConfig([-1, -2, -3], [4, 5, 6], 0.25, 8, 'auto');
  assert.deepEqual(cfg, {
    worldMin: [-1, -2, -3],
    worldMax: [4, 5, 6],
    voxelSize: 0.25,
    chunkSizeXZ: 8,
    solidDetection: false,
    backend: 'auto',
  });
});
