import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeAssetCopyFailure,
  describeOverwritePrompt,
  describeSaveFailure,
  describeSceneFileStatus,
  nextSaveTarget,
  planAssetCopy,
  resolveSaveAction,
} from '../src/scene/saveTarget.ts';
import { identityTransform, type GeometryObject } from '../src/scene/geometryModel.ts';

// Stand-ins for directory handles — the logic only ever reads `.name` (§14.5).
const siteA = { name: 'site-a' };
const siteB = { name: 'site-b' };

test('Save with a target writes silently, without a picker (spec §14.5)', () => {
  assert.deepEqual(resolveSaveAction(true, 'save'), { kind: 'write', confirmIfExists: false });
});

test('Save with no target falls back to the picker (spec §14.5)', () => {
  assert.deepEqual(resolveSaveAction(false, 'save'), { kind: 'pick', confirmIfExists: true });
});

test('Save As… always picks, target or not (spec §14.5)', () => {
  assert.deepEqual(resolveSaveAction(true, 'saveAs'), { kind: 'pick', confirmIfExists: true });
  assert.deepEqual(resolveSaveAction(false, 'saveAs'), { kind: 'pick', confirmIfExists: true });
});

test('every picked folder confirms before replacing a scene; an established target never does (spec §14.5)', () => {
  // The overwrite rule keys off the picker, not the button — so the boot-state
  // Save fallback is guarded too.
  assert.equal(resolveSaveAction(false, 'save').confirmIfExists, true);
  assert.equal(resolveSaveAction(true, 'saveAs').confirmIfExists, true);
  assert.equal(resolveSaveAction(true, 'save').confirmIfExists, false);
});

test('a successful import adopts the imported folder as the target (spec §14.5)', () => {
  assert.equal(nextSaveTarget(null, { kind: 'imported', folder: siteA }), siteA);
  assert.equal(nextSaveTarget(siteA, { kind: 'imported', folder: siteB }), siteB);
});

test('a successful Save As… retargets to the folder written (spec §14.5)', () => {
  assert.equal(nextSaveTarget(siteA, { kind: 'saved', folder: siteB }), siteB);
});

test('a failed save keeps the target so it can be retried or redirected (spec §14.8)', () => {
  assert.equal(nextSaveTarget(siteA, { kind: 'failed' }), siteA);
  assert.equal(nextSaveTarget(null, { kind: 'failed' }), null);
});

test('a cancelled picker or overwrite prompt leaves the target untouched (spec §14.8)', () => {
  assert.equal(nextSaveTarget(siteA, { kind: 'cancelled' }), siteA);
  assert.equal(nextSaveTarget(null, { kind: 'cancelled' }), null);
});

test('status names the folder Save would write to (spec §14.7)', () => {
  assert.equal(describeSceneFileStatus(siteA, null), 'Folder: site-a');
});

test('status acknowledges a silent save, which closes no dialog (spec §14.7)', () => {
  assert.equal(describeSceneFileStatus(siteA, { assetsCopied: 0 }), 'Saved to site-a');
});

test('status reports copied assets, singular and plural (spec §14.5, §14.7)', () => {
  assert.equal(describeSceneFileStatus(siteB, { assetsCopied: 1 }), 'Saved to site-b — 1 asset copied');
  assert.equal(describeSceneFileStatus(siteB, { assetsCopied: 3 }), 'Saved to site-b — 3 assets copied');
});

test('status says where Save will ask when there is no target (spec §14.1, §14.7)', () => {
  assert.equal(describeSceneFileStatus(null, null), 'No folder chosen — Save will ask where to write.');
  // No target means nothing was saved; a stale "saved" can't resurrect a name.
  assert.equal(describeSceneFileStatus(null, { assetsCopied: 2 }), 'No folder chosen — Save will ask where to write.');
});

test('the overwrite prompt names the folder at risk (spec §14.5)', () => {
  assert.equal(
    describeOverwritePrompt('site-b', { sceneExists: true, assetClashes: 0 }),
    '"site-b" already contains a scene.json. Replace it?',
  );
});

test('the overwrite prompt discloses the assets it would replace (spec §14.5)', () => {
  assert.equal(
    describeOverwritePrompt('site-b', { sceneExists: true, assetClashes: 2 }),
    '"site-b" already contains a scene.json and 2 of this scene\'s assets. Replace them?',
  );
  assert.equal(
    describeOverwritePrompt('site-b', { sceneExists: false, assetClashes: 2 }),
    '"site-b" already contains 2 of this scene\'s assets. Replace them?',
  );
  assert.equal(
    describeOverwritePrompt('site-b', { sceneExists: false, assetClashes: 1 }),
    '"site-b" already contains 1 of this scene\'s assets. Replace it?',
  );
});

test('an empty destination is not worth a prompt (spec §14.5)', () => {
  assert.equal(describeOverwritePrompt('site-b', { sceneExists: false, assetClashes: 0 }), null);
});

// --- Asset copy planning (spec §14.5) ---

const gltf = (src: string): GeometryObject => ({ kind: 'gltf', src, ...identityTransform() });
const box: GeometryObject = { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], ...identityTransform() };
const room: GeometryObject = { kind: 'room', halfX: 5, halfZ: 5, height: 3, thickness: 0.2, ...identityTransform() };

test('the copy plan is every referenced asset, in scene order (spec §14.5)', () => {
  assert.deepEqual(planAssetCopy([gltf('assets/shelf.glb'), box, gltf('assets/rack.glb')]), [
    'assets/shelf.glb',
    'assets/rack.glb',
  ]);
});

test('an asset referenced twice is copied once (spec §14.5)', () => {
  assert.deepEqual(planAssetCopy([gltf('assets/shelf.glb'), gltf('assets/shelf.glb')]), ['assets/shelf.glb']);
});

test('primitive-only geometry copies nothing — the default scene never has assets (spec §14.5)', () => {
  assert.deepEqual(planAssetCopy([room, box]), []);
  assert.deepEqual(planAssetCopy([]), []);
});

test('nested asset paths are planned verbatim, for the destination to recreate (spec §14.2, §14.5)', () => {
  assert.deepEqual(planAssetCopy([gltf('assets/site/level-1/rack.glb')]), ['assets/site/level-1/rack.glb']);
});

test('a failed asset copy names the asset and says nothing was saved (spec §14.8)', () => {
  assert.equal(
    describeAssetCopyFailure('assets/rack.glb', 'not found in the source folder'),
    'Couldn\'t copy "assets/rack.glb": not found in the source folder. Nothing was saved.',
  );
});

test('a save failure names the folder and points at Save As… (spec §14.8)', () => {
  assert.equal(
    describeSaveFailure('site-a', 'permission denied'),
    'Couldn\'t save to "site-a": permission denied. Use Save As… to choose another folder.',
  );
});
