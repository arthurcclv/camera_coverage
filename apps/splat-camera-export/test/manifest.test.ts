/** Tests for `export/manifest.ts` (spec §9.4, §12). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDENTITY_ALIGNMENT } from '../src/align/alignment.ts';
import type { PreviewCamera } from '../src/cameras/sceneCameras.ts';
import {
  buildManifest,
  farRenderedFor,
  serializeManifest,
  type RenderSettings,
} from '../src/export/manifest.ts';

const CAMERA: PreviewCamera = {
  id: 'cam-1',
  name: 'Entrance',
  position: [2, 2.5, -3],
  rotation: [0, 0.38, 0, 0.92],
  fov: 60,
  aspect: 1.7778,
  near: 0.1,
  far: 30,
  enabled: true,
};

const RENDER: RenderSettings = {
  format: 'png',
  quality: 0.92,
  samples: 4,
  settleFrames: 2,
  background: [0.1, 0.1, 0.12, 1],
  transparentBackground: false,
  farOverride: 1000,
};

const SPLAT = { filename: 'site.ply', byteSize: 184320000 };

function build(render: RenderSettings = RENDER, cameras = [CAMERA]) {
  return buildManifest({
    sourceScene: 'scene.json',
    splat: SPLAT,
    alignment: IDENTITY_ALIGNMENT,
    render,
    exported: cameras.map((camera, i) => ({
      camera,
      file: `${camera.name}.png`,
      size: { width: 1920, height: 1080, clamped: false },
    })),
  });
}

test('records the generator, source, splat, and alignment', () => {
  const manifest = build();
  assert.equal(manifest.generator, '@linkervision/splat-camera-export');
  assert.equal(manifest.sourceScene, 'scene.json');
  assert.deepEqual(manifest.splat, SPLAT);
  assert.deepEqual(manifest.alignment, IDENTITY_ALIGNMENT);
});

test('records each camera pose verbatim from the import, in scene-frame terms', () => {
  const entry = build().cameras[0];
  assert.deepEqual(entry.position, CAMERA.position);
  assert.deepEqual(entry.rotation, CAMERA.rotation);
  assert.equal(entry.fov, 60);
  assert.equal(entry.aspect, 1.7778);
  assert.equal(entry.near, 0.1);
  assert.equal(entry.id, 'cam-1');
  assert.equal(entry.name, 'Entrance');
  assert.equal(entry.enabled, true);
  assert.equal(entry.width, 1920);
  assert.equal(entry.height, 1080);
  assert.equal(entry.file, 'Entrance.png');
});

test('far is the authored value and farRendered what was actually used (§5.2)', () => {
  const entry = build().cameras[0];
  assert.equal(entry.far, 30);
  assert.equal(entry.farRendered, 1000);
});

test('clipping at camera far makes the two agree', () => {
  const entry = build({ ...RENDER, farOverride: null }).cameras[0];
  assert.equal(entry.far, 30);
  assert.equal(entry.farRendered, 30);
});

test('farRenderedFor follows the override', () => {
  assert.equal(farRenderedFor(CAMERA, null), 30);
  assert.equal(farRenderedFor(CAMERA, 500), 500);
});

test('quality is omitted for PNG, where it had no effect', () => {
  const manifest = build({ ...RENDER, format: 'png' });
  assert.equal('quality' in manifest.render, false);
  assert.equal(manifest.render.format, 'png');
});

test('quality is recorded for JPEG', () => {
  const manifest = build({ ...RENDER, format: 'jpeg', quality: 0.8 });
  assert.equal(manifest.render.quality, 0.8);
});

test('records the settle frames and samples the run actually used', () => {
  const manifest = build({ ...RENDER, samples: 1, settleFrames: 5 });
  assert.equal(manifest.render.samples, 1);
  assert.equal(manifest.render.settleFrames, 5);
});

test('records the background and transparency', () => {
  const manifest = build({ ...RENDER, transparentBackground: true });
  assert.equal(manifest.render.transparentBackground, true);
  assert.deepEqual(manifest.render.background, [0.1, 0.1, 0.12, 1]);
});

test('camera order follows the exported order', () => {
  const second = { ...CAMERA, id: 'cam-2', name: 'Bay' };
  const manifest = build(RENDER, [CAMERA, second]);
  assert.deepEqual(manifest.cameras.map((c) => c.id), ['cam-1', 'cam-2']);
});

test('serializes to parseable JSON ending in a newline', () => {
  const text = serializeManifest(build());
  assert.ok(text.endsWith('\n'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.cameras[0].farRendered, 1000);
});
