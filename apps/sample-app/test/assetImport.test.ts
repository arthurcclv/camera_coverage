/**
 * Import routing and destination naming (`asset_import.md` §4, §6.2) — which
 * entry accepts which picked file, the exact reason a refusal gives, and what
 * the `assets/` folder an import lands in is called.
 *
 * Pure over plain strings: the picker lives in `sceneIO.ts`, every judgement
 * here (`ai/CONVENTIONS.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptedExtensions,
  extensionOf,
  importFolderName,
  importSrc,
  needsPlySniff,
  resolveImportName,
  routePickedFile,
} from '../src/scene/assetImport.ts';
import en from '../src/locales/en/common.json' with { type: 'json' };

/**
 * The refusal's **i18n key**, or `null` when the file was accepted. The router
 * returns messages as data (`spec.md` §18.4), so the assertions below are about
 * which key is chosen; the `en` copy is asserted to exist separately.
 */
function refusal(...args: Parameters<typeof routePickedFile>): string | null {
  const routed = routePickedFile(...args);
  return routed.ok ? null : routed.reason.key;
}

/** A refusal's interpolation params, for the two keys that name a set (§4.1). */
function refusalParams(...args: Parameters<typeof routePickedFile>): Record<string, string | number> {
  const routed = routePickedFile(...args);
  assert.equal(routed.ok, false);
  return routed.ok ? {} : (routed.reason.params ?? {});
}

test('each entry accepts its own extensions, case-insensitively (§4.1)', () => {
  for (const name of ['shelf.glb', 'rack.GLTF', 'site.obj', 'yard.Ply']) {
    assert.equal(refusal('model', name, 'mesh'), null, name);
  }
  for (const name of ['site.spz', 'dock.SOG', 'old.splat', 'legacy.ksplat', 'yard.ply']) {
    assert.equal(refusal('capture', name, 'splat'), null, name);
  }
});

test('an extension the entry does not accept is refused naming the accepted set (§4.1)', () => {
  assert.equal(refusal('model', 'model.fbx'), 'importRefusalExtension');
  assert.deepEqual(refusalParams('model', 'model.fbx'), {
    ext: '.fbx',
    accepted: '.glb, .gltf, .ply, .obj',
  });
});

test('a file with no extension is refused, and says so as such', () => {
  assert.equal(refusal('capture', 'README'), 'importRefusalNoExtension');
  // A dotfile has no extension either — `.gitignore` is a name, not a suffix.
  assert.equal(refusal('model', '.gitignore'), 'importRefusalNoExtension');
  assert.deepEqual(refusalParams('capture', 'README'), {
    accepted: '.spz, .sog, .ply, .splat, .ksplat',
  });
});

test('a splat PLY picked as a model is refused, naming the other entry (§4.2)', () => {
  assert.equal(refusal('model', 'site.ply', 'splat'), 'importRefusalSplatPly');
  assert.match(en.importRefusalSplatPly, /Import 3DGS capture/);
});

test('a mesh PLY picked as a capture is refused, naming the other entry (§4.2)', () => {
  assert.equal(refusal('capture', 'rack.ply', 'mesh'), 'importRefusalMeshPly');
  assert.match(en.importRefusalMeshPly, /Import model/);
});

test('a faceless PLY is a capture but never geometry (§4.2, geometry_assets.md §4.5)', () => {
  assert.equal(refusal('capture', 'cloud.ply', 'points'), null);
  assert.equal(refusal('model', 'cloud.ply', 'points'), 'importRefusalNoFaces');
  assert.match(en.importRefusalNoFaces, /No faces/);
});

test('an unreadable PLY is refused by both entries (§4.2)', () => {
  assert.equal(refusal('model', 'broken.ply', 'unreadable'), 'importRefusalUnreadablePly');
  assert.equal(refusal('capture', 'broken.ply', 'unreadable'), 'importRefusalUnreadablePly');
  // A `.ply` routed with no classification at all is unreadable too, rather
  // than quietly accepted — the sniff is not optional for this extension.
  assert.equal(refusal('model', 'unsniffed.ply'), 'importRefusalUnreadablePly');
});

test('a PCSOGS manifest is refused with its remedy (§4.4, gaussian_splats.md §3.1)', () => {
  assert.equal(refusal('capture', 'meta.json', undefined), 'importRefusalSogBundle');
  assert.equal(refusal('capture', 'site/meta.JSON', undefined), 'importRefusalSogBundle');
  assert.match(en.importRefusalSogBundle, /\.sog/);
});

test('every refusal key it can return carries `en` copy (§4, spec.md §18.4)', () => {
  // The router composes user-facing text as data; a key with no copy behind it
  // would surface as the key itself in the dialog.
  const keys = [
    refusal('model', 'model.fbx'),
    refusal('capture', 'README'),
    refusal('model', 'site.ply', 'splat'),
    refusal('capture', 'rack.ply', 'mesh'),
    refusal('model', 'cloud.ply', 'points'),
    refusal('model', 'broken.ply', 'unreadable'),
    refusal('capture', 'meta.json'),
  ];
  for (const key of keys) assert.ok(key != null && key in en, `missing en copy: ${key}`);
});

test('only a `.ply` needs sniffing (§4.2)', () => {
  assert.equal(needsPlySniff('site.ply'), true);
  assert.equal(needsPlySniff('site.PLY'), true);
  assert.equal(needsPlySniff('shelf.glb'), false);
  assert.equal(needsPlySniff('site.spz'), false);
});

test('the accepted sets are the two format lists', () => {
  assert.deepEqual([...acceptedExtensions('model')], ['.glb', '.gltf', '.ply', '.obj']);
  assert.deepEqual([...acceptedExtensions('capture')], ['.spz', '.sog', '.ply', '.splat', '.ksplat']);
});

test('extensionOf takes the final suffix, lowercased', () => {
  assert.equal(extensionOf('rack.v2.GLB'), '.glb');
  assert.equal(extensionOf('archive.tar.gz'), '.gz');
  assert.equal(extensionOf('README'), null);
  assert.equal(extensionOf('.gitignore'), null);
});

test('the destination folder is the basename minus its extension (§6.2)', () => {
  assert.equal(resolveImportName('rack.gltf', 'model', []), 'rack');
  assert.equal(resolveImportName('site.v2.spz', 'capture', []), 'site.v2');
  // Self-contained files take the same rule — one rule, no branch on whether a
  // parse happened to find dependencies.
  assert.equal(resolveImportName('shelf.glb', 'model', []), 'shelf');
});

test('a name unsafe as a folder is normalized by spec.md §14.5s portability rule (§6.2)', () => {
  assert.equal(resolveImportName('a/b:c*d?.glb', 'model', []), 'a-b-c-d-');
  assert.equal(resolveImportName('  spaced  .glb', 'model', []), 'spaced');
  assert.equal(resolveImportName('.hidden.glb', 'model', []), '-hidden');
});

test('a name with nothing left falls back per kind (§6.2)', () => {
  assert.equal(resolveImportName('   .glb', 'model', []), 'model');
  assert.equal(resolveImportName('   .spz', 'capture', []), 'capture');
});

test('pending names are made unique at import, since the app can see its own set (§6.2)', () => {
  assert.equal(resolveImportName('rack.gltf', 'model', ['rack']), 'rack-2');
  assert.equal(resolveImportName('rack.gltf', 'model', ['rack', 'rack-2']), 'rack-3');
  // Gaps are filled rather than skipped past.
  assert.equal(resolveImportName('rack.gltf', 'model', ['rack', 'rack-3']), 'rack-2');
});

test('importSrc puts every import in a folder of its own (§6.2)', () => {
  assert.equal(importSrc('rack', 'rack.gltf'), 'assets/rack/rack.gltf');
  assert.equal(importSrc('shelf', 'shelf.glb'), 'assets/shelf/shelf.glb');
});

test('importFolderName recovers the segment, and declines a hand-placed flat src (§6.2)', () => {
  assert.equal(importFolderName('assets/rack/rack.gltf'), 'rack');
  assert.equal(importFolderName('assets/site.spz'), null);
  assert.equal(importFolderName('assets/site/model/rack.obj'), null);
  assert.equal(importFolderName('models/rack/rack.obj'), null);
});
