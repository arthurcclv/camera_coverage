import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeAssetPath, parseSceneFile, serializeScene, type SceneFileJSON } from '../src/scene/sceneFile.ts';

function validDoc(): SceneFileJSON {
  return {
    formatVersion: 1,
    geometry: [
      {
        kind: 'room',
        halfX: 10,
        halfZ: 10,
        height: 6,
        thickness: 0.3,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      {
        kind: 'box',
        min: [-7, 0, -7],
        max: [-4, 2.5, -4],
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      {
        kind: 'gltf',
        src: 'assets/shelf.glb',
        position: [2, 0, 3],
        rotation: [0, 0.707, 0, 0.707],
        scale: [1, 1, 1],
      },
    ],
    cameras: [
      { id: 'cam-1', position: [-6, 5.4, -9.6], rotation: [0, 0, 0, 1], fov: 60, aspect: 1.7778, near: 0.1, far: 30 },
    ],
    probes: [{ id: 'probe-1', position: [0, 1, 0] }],
    sections: [{ id: 'section-1', orientation: 'horizontal', min: 0, max: 2, aggregation: 'mean', visible: true }],
  };
}

test('parseSceneFile accepts a well-formed document (spec §14.3 sketch)', () => {
  const result = parseSceneFile(validDoc());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.geometry.length, 3);
  assert.equal(result.scene.cameras.length, 1);
  assert.equal(result.scene.probes.length, 1);
  assert.equal(result.scene.sections.length, 1);
});

test('serializeScene . parseSceneFile round-trips', () => {
  const doc = validDoc();
  const parsed = parseSceneFile(doc);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const reserialized = serializeScene(parsed.scene);
  assert.deepEqual(reserialized, doc);
});

test('parseSceneFile rejects non-object JSON', () => {
  assert.equal(parseSceneFile([1, 2, 3]).ok, false);
  assert.equal(parseSceneFile('hello').ok, false);
  assert.equal(parseSceneFile(null).ok, false);
});

test('parseSceneFile rejects an unknown/newer formatVersion (spec §14.8)', () => {
  const result = parseSceneFile({ ...validDoc(), formatVersion: 2 });
  assert.equal(result.ok, false);
});

test('parseSceneFile rejects an unknown geometry kind (spec §14.8)', () => {
  const doc = validDoc();
  doc.geometry = [{ ...doc.geometry[1], kind: 'cylinder' } as never];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a duplicate id within cameras (spec §14.8)', () => {
  const doc = validDoc();
  doc.cameras = [...doc.cameras, { ...doc.cameras[0] }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a duplicate id within probes (spec §14.8)', () => {
  const doc = validDoc();
  doc.probes = [...doc.probes, { ...doc.probes[0] }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a duplicate id within sections (spec §14.8)', () => {
  const doc = validDoc();
  doc.sections = [...doc.sections, { ...doc.sections[0] }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile allows the same id reused across different categories', () => {
  const doc = validDoc();
  doc.probes = [{ id: 'cam-1', position: [0, 1, 0] }];
  assert.equal(parseSceneFile(doc).ok, true);
});

test('parseSceneFile rejects an unsafe gltf src (spec §14.2, §14.8)', () => {
  for (const src of ['/etc/passwd', '../outside.glb', 'assets/../../escape.glb', 'https://example.com/a.glb', 'file:///a.glb', 'C:\\a.glb']) {
    const doc = validDoc();
    doc.geometry = [{ ...doc.geometry[2], src } as never];
    assert.equal(parseSceneFile(doc).ok, false, `expected "${src}" to be rejected`);
  }
});

test('parseSceneFile rejects a geometry object missing position/rotation/scale', () => {
  const doc = validDoc();
  const { position: _position, ...rest } = doc.geometry[1] as Record<string, unknown>;
  doc.geometry = [rest as never];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('isSafeAssetPath accepts plain relative paths', () => {
  assert.equal(isSafeAssetPath('assets/shelf.glb'), true);
  assert.equal(isSafeAssetPath('assets/sub/dir/shelf.glb'), true);
});

test('isSafeAssetPath rejects absolute paths, URLs, and traversal', () => {
  assert.equal(isSafeAssetPath('/assets/shelf.glb'), false);
  assert.equal(isSafeAssetPath('../shelf.glb'), false);
  assert.equal(isSafeAssetPath('assets/../shelf.glb'), false);
  assert.equal(isSafeAssetPath('http://evil.example/shelf.glb'), false);
  assert.equal(isSafeAssetPath('data:model/gltf-binary;base64,AAAA'), false);
  assert.equal(isSafeAssetPath('C:\\shelf.glb'), false);
  assert.equal(isSafeAssetPath(''), false);
});
