import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

import type { SceneCamera } from '../src/cameras/camera.ts';
import { eulerToQuat, quatToEuler } from '../src/cameras/math.ts';
import {
  buildCameraInfo,
  cameraInfoErrorText,
  cameraInfoFileName,
  cameraInfoJson,
  exportEuler,
} from '../src/cameras/cameraInfo.ts';

function cam(id: string, over: Partial<SceneCamera> = {}): SceneCamera {
  return {
    id,
    name: '',
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    fov: 60,
    enabled: true,
    ...over,
  };
}

/** The `info` string parsed back, for asserting on the payload (spec §15.2). */
function info(entry: { info: string }): { pos: number[]; rot: number[]; hit: number[] | null } {
  return JSON.parse(entry.info);
}

test('info is a JSON document inside a JSON string, keyed pos/rot/hit in order (§15.2)', () => {
  // The double encoding is the external tool's contract, not an accident: `info`
  // must be a *string*, and re-parsing it must give exactly the three keys.
  const [entry] = buildCameraInfo([cam('cam-1', { position: [1, 2, 3] })], [[4, 5, 6]]);
  assert.equal(typeof entry.info, 'string');
  assert.deepEqual(Object.keys(entry), ['name', 'info']);
  assert.deepEqual(Object.keys(info(entry)), ['pos', 'rot', 'hit']);
  assert.deepEqual(info(entry).pos, [1, 2, 3]);
  assert.deepEqual(info(entry).hit, [4, 5, 6]);
});

test('name is the hierarchy label, blank falling back to `Camera N` (§15.2, §5.6)', () => {
  const entries = buildCameraInfo(
    [cam('cam-1', { name: 'Front Gate' }), cam('cam-2'), cam('cam-3', { name: '   ' })],
    [null, null, null],
  );
  assert.deepEqual(
    entries.map((e) => e.name),
    ['Front Gate', 'Camera 2', 'Camera 3'],
  );
});

test('duplicate labels are exported as-is, not de-duplicated (§15.2)', () => {
  // Deliberate: names are not unique in the app, and the file reproduces the
  // tree rather than inventing "Front Gate (2)".
  const entries = buildCameraInfo(
    [cam('cam-1', { name: 'Front Gate' }), cam('cam-2', { name: 'Front Gate' })],
    [null, null],
  );
  assert.deepEqual(
    entries.map((e) => e.name),
    ['Front Gate', 'Front Gate'],
  );
});

test('rot is Euler [x, y, z] in degrees, order XYZ (§15.2)', () => {
  assert.deepEqual(exportEuler([0, 0, 0, 1]), [0, 0, 0]);
  // Degrees, not radians — a 30° downward tilt about X reads as -30.
  assert.deepEqual(exportEuler(eulerToQuat({ yaw: 0, pitch: -30, roll: 0 })), [-30, 0, 0]);
  // A camera facing +X, tilted 30° down. The panel calls this yaw -90 / pitch
  // -30 / roll 0; XYZ decomposes the same quaternion as [-90, -60, -90].
  assert.deepEqual(exportEuler(eulerToQuat({ yaw: -90, pitch: -30, roll: 0 })), [-90, -60, -90]);
});

test('rot is whatever the XYZ decomposition yields, equivalent-but-ugly included (§15.2)', () => {
  // An XYZ decomposition is not unique. A level camera turned right around is
  // [0, 180, 0] to a human and [-180, 0, -180] to the conversion — the same
  // rotation, and the export reports the conversion's branch rather than hunting
  // for the prettiest one. Locked down so nobody "fixes" it into the other.
  assert.deepEqual(exportEuler([0, 1, 0, 0]), [-180, 0, -180]);
  assert.deepEqual(exportEuler(eulerToQuat({ yaw: 180, pitch: 0, roll: 0 })), [-180, 0, -180]);
});

test("rot deliberately differs from the camera panel's YXZ yaw/pitch/roll (§15.2)", () => {
  // The one rule most at risk of being "fixed": the panel edits YXZ
  // yaw/pitch/roll, the export states XYZ [x, y, z]. With both pitch and roll
  // set, the two triples are genuinely different numbers for one quaternion, and
  // neither may be changed to match the other.
  const panel = { yaw: -90, pitch: -30, roll: 20 };
  const q = eulerToQuat(panel);
  const exported = exportEuler(q);
  const roundTrip = quatToEuler(q);
  // The panel's own conversion still round-trips — that convention is untouched.
  assert.ok(Math.abs(roundTrip.yaw - panel.yaw) < 1e-9);
  assert.ok(Math.abs(roundTrip.pitch - panel.pitch) < 1e-9);
  assert.ok(Math.abs(roundTrip.roll - panel.roll) < 1e-9);
  // …and the export's is a different triple, not a reordering of it.
  assert.notDeepEqual([...exported].sort(), [panel.pitch, panel.yaw, panel.roll].sort());
});

test('numbers round to 6 decimals, with no -0 (§15.2)', () => {
  const entry = buildCameraInfo(
    [cam('cam-1', { position: [-3.4000000000000004, 1.8, 12.25] })],
    [[0.1234567891, -1e-9, 4.1166666666]],
  )[0];
  assert.deepEqual(info(entry).pos, [-3.4, 1.8, 12.25]);
  assert.deepEqual(info(entry).hit, [0.123457, 0, 4.116667]);
  // A rounded-away negative must not surface as `-0`.
  assert.ok(!entry.info.includes('-0'));
});

test('a miss is `hit: null`, and the key is always present (§15.3)', () => {
  const [entry] = buildCameraInfo([cam('cam-1')], [null]);
  assert.equal(info(entry).hit, null);
  assert.ok(entry.info.includes('"hit":null'));
});

test('a hit missing from the array reads as a miss, not a throw (§15.2)', () => {
  const entries = buildCameraInfo([cam('cam-1'), cam('cam-2')], [[1, 1, 1]]);
  assert.deepEqual(info(entries[0]).hit, [1, 1, 1]);
  assert.equal(info(entries[1]).hit, null);
});

test('every camera is exported in array order, disabled included (§15.3, §5.4)', () => {
  const cameras = [
    cam('cam-1', { name: 'A' }),
    cam('cam-2', { name: 'B', enabled: false }),
    cam('cam-3', { name: 'C' }),
  ];
  const hits: (Vec3 | null)[] = [null, null, null];
  assert.deepEqual(
    buildCameraInfo(cameras, hits).map((e) => e.name),
    ['A', 'B', 'C'],
  );
});

test('no cameras exports an empty array, not an error (§15.1)', () => {
  assert.deepEqual(buildCameraInfo([], []), []);
  assert.equal(cameraInfoJson([]), '[]');
});

test('the outer document is 2-space indented; info stays compact (§15.2)', () => {
  const json = cameraInfoJson(buildCameraInfo([cam('cam-1', { name: 'A' })], [[1, 2, 3]]));
  assert.match(json, /^\[\n {2}\{\n {4}"name": "A",\n {4}"info": "/);
  // The nested payload is a string, so the indent never reaches inside it, and it
  // carries no whitespace of its own.
  const parsed: { name: string; info: string }[] = JSON.parse(json);
  assert.ok(!parsed[0].info.includes(' '));
  assert.ok(!parsed[0].info.includes('\n'));
});

test('filename derives from the save target, else `cameras.json` (§15.2)', () => {
  assert.equal(cameraInfoFileName('night-shift.json'), 'night-shift-cameras.json');
  assert.equal(cameraInfoFileName('scene.json'), 'scene-cameras.json');
  assert.equal(cameraInfoFileName('SITE-A.JSON'), 'SITE-A-cameras.json');
  // No save target — the boot scene (§14.1).
  assert.equal(cameraInfoFileName(null), 'cameras.json');
  assert.equal(cameraInfoFileName('  '), 'cameras.json');
  // A name that is nothing but the extension has no scene name to carry.
  assert.equal(cameraInfoFileName('.json'), 'cameras.json');
});

test('a failed export always names a reason, whatever it was handed (§15.3)', () => {
  assert.equal(
    cameraInfoErrorText(new Error('mesh could not be cloned')),
    "Couldn't cast the camera rays: mesh could not be cloned",
  );
  // `ErrorEvent.message` is a bare string, and routinely `''` for a worker that
  // failed to load: the banner must not end on a dangling colon.
  assert.equal(
    cameraInfoErrorText('script load failed'),
    "Couldn't cast the camera rays: script load failed",
  );
  for (const nothing of ['', '   ', null, undefined, new Error('')]) {
    assert.equal(
      cameraInfoErrorText(nothing),
      "Couldn't cast the camera rays: the export worker failed",
    );
  }
});
