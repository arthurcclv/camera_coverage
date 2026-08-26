/** Tests for `cameras/sceneCameras.ts` (spec §5, §12). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ASPECT,
  DEFAULT_FAR,
  DEFAULT_NEAR,
  readSceneCameras,
} from '../src/cameras/sceneCameras.ts';

/** A minimal valid camera; spread over to make variants. */
const CAM = {
  id: 'cam-1',
  position: [1, 2, 3],
  rotation: [0, 0, 0, 1],
  fov: 60,
};

function scene(cameras: unknown[], extra: Record<string, unknown> = {}) {
  return { formatVersion: 2, cameras, ...extra };
}

function ok(raw: unknown) {
  const result = readSceneCameras(raw);
  assert.equal(result.ok, true, `expected ok, got: ${result.ok === false ? result.error : ''}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function err(raw: unknown): string {
  const result = readSceneCameras(raw);
  assert.equal(result.ok, false, 'expected a failure');
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

test('reads a minimal camera and applies every optional default', () => {
  const { cameras } = ok(scene([CAM]));
  assert.equal(cameras.length, 1);
  assert.deepEqual(cameras[0], {
    id: 'cam-1',
    name: '',
    position: [1, 2, 3],
    rotation: [0, 0, 0, 1],
    fov: 60,
    aspect: DEFAULT_ASPECT,
    near: DEFAULT_NEAR,
    far: DEFAULT_FAR,
    enabled: true,
  });
});

test('reads explicit optional fields', () => {
  const { cameras } = ok(
    scene([{ ...CAM, name: '  Entrance  ', aspect: 4 / 3, near: 0.25, far: 42, enabled: false }]),
  );
  assert.equal(cameras[0].name, 'Entrance');
  assert.equal(cameras[0].aspect, 4 / 3);
  assert.equal(cameras[0].near, 0.25);
  assert.equal(cameras[0].far, 42);
  assert.equal(cameras[0].enabled, false);
});

test('ignores every non-camera key, including unknown ones (§5.1)', () => {
  const { cameras, notices } = ok(
    scene([CAM], {
      geometry: [{ kind: 'room', nonsense: true }],
      probes: 'not even an array',
      sections: null,
      zones: 12,
      volumes: {},
      clipSectionId: 'whatever',
      useZones: 'yes',
      somethingAddedLater: { nested: [1, 2, 3] },
    }),
  );
  assert.equal(cameras.length, 1);
  assert.deepEqual(notices, []);
});

test('accepts formatVersion 1 with no notice', () => {
  const { notices } = ok({ formatVersion: 1, cameras: [CAM] });
  assert.deepEqual(notices, []);
});

test('a future formatVersion is a non-blocking notice, not a refusal (§5.1)', () => {
  const { cameras, notices } = ok({ formatVersion: 99, cameras: [CAM] });
  assert.equal(cameras.length, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /formatVersion 99 is newer/);
});

test('an empty camera list succeeds with a notice', () => {
  const { cameras, notices } = ok(scene([]));
  assert.deepEqual(cameras, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /no cameras/);
});

test('normalizes the rotation quaternion', () => {
  const { cameras } = ok(scene([{ ...CAM, rotation: [0, 0, 0, 2] }]));
  assert.deepEqual(cameras[0].rotation, [0, 0, 0, 1]);
});

test('rejects a zero-length quaternion, which carries no orientation', () => {
  assert.match(err(scene([{ ...CAM, rotation: [0, 0, 0, 0] }])), /non-zero quaternion/);
});

test('rejects a non-object root and a missing/invalid formatVersion', () => {
  assert.match(err([]), /must be a JSON object/);
  assert.match(err({ cameras: [] }), /formatVersion must be a positive integer/);
  assert.match(err({ formatVersion: 1.5, cameras: [] }), /formatVersion must be a positive integer/);
  assert.match(err({ formatVersion: 0, cameras: [] }), /formatVersion must be a positive integer/);
});

test('rejects a missing or non-array cameras key', () => {
  assert.match(err({ formatVersion: 2 }), /cameras must be an array/);
  assert.match(err({ formatVersion: 2, cameras: {} }), /cameras must be an array/);
});

test('one invalid entry fails the whole import, naming index and field (§5.3)', () => {
  const message = err(scene([CAM, { ...CAM, id: 'cam-2', rotation: [0, 0, 1] }]));
  assert.match(message, /^cameras\[1\]: rotation must be 4 finite numbers$/);
});

test('rejects each invalid field with a specific message', () => {
  assert.match(err(scene([{ ...CAM, id: '   ' }])), /cameras\[0\]: id must be a non-empty string/);
  assert.match(err(scene([{ ...CAM, position: [1, 2] }])), /position must be 3 finite numbers/);
  assert.match(err(scene([{ ...CAM, position: [1, 2, Infinity] }])), /position must be 3 finite numbers/);
  assert.match(err(scene([{ ...CAM, fov: 0 }])), /fov must be a number in \(0, 180\)/);
  assert.match(err(scene([{ ...CAM, fov: 180 }])), /fov must be a number in \(0, 180\)/);
  assert.match(err(scene([{ ...CAM, aspect: 0 }])), /aspect must be a positive number/);
  assert.match(err(scene([{ ...CAM, near: -1 }])), /near must be a positive number/);
  assert.match(err(scene([{ ...CAM, enabled: 'yes' }])), /enabled must be a boolean/);
  assert.match(err(scene(['nope'])), /cameras\[0\]: must be an object/);
});

test('rejects far <= near, which would clip everything', () => {
  assert.match(err(scene([{ ...CAM, near: 5, far: 5 }])), /far must be greater than near/);
  assert.match(err(scene([{ ...CAM, near: 5, far: 1 }])), /far must be greater than near/);
});

test('a non-string name degrades to blank rather than failing', () => {
  const { cameras } = ok(scene([{ ...CAM, name: 42 }]));
  assert.equal(cameras[0].name, '');
});

test('preserves file order (§5.3)', () => {
  const { cameras } = ok(
    scene([
      { ...CAM, id: 'cam-3' },
      { ...CAM, id: 'cam-1' },
      { ...CAM, id: 'cam-2' },
    ]),
  );
  assert.deepEqual(cameras.map((c) => c.id), ['cam-3', 'cam-1', 'cam-2']);
});
