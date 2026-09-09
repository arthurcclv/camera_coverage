import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeAssetCopyFailure,
  describeOverwriteConfirm,
  describeReplaceWarning,
  describeSaveFailure,
  describeSceneFileStatus,
  describeUnsavedWarning,
  isSceneFileName,
  nextSaveTarget,
  normalizeSceneFileName,
  planAssetCopy,
  resolveSaveAction,
  resolveWriteAction,
  summarizeSceneFile,
} from '../src/scene/saveTarget.ts';
import { identityTransform, type GeometryObject } from '../src/scene/geometryModel.ts';
import { defaultSplat } from '../src/scene/splats.ts';

// Stand-ins for directory handles — the logic only ever reads `.name` (§14.5).
const siteA = { name: 'site-a' };
const siteB = { name: 'site-b' };

// --- Save routing (spec §14.5) ---

test('Save with a target writes silently, without a dialog (spec §14.5)', () => {
  assert.deepEqual(resolveSaveAction(true, 'save'), { kind: 'write' });
});

test('Save with no target falls through to the Save-as dialog (spec §14.5)', () => {
  // One code path, so a scene built from scratch gets named like any other.
  assert.deepEqual(resolveSaveAction(false, 'save'), { kind: 'dialog' });
});

test('Save As… always opens the dialog, target or not (spec §14.5)', () => {
  assert.deepEqual(resolveSaveAction(true, 'saveAs'), { kind: 'dialog' });
  assert.deepEqual(resolveSaveAction(false, 'saveAs'), { kind: 'dialog' });
});

// --- The save target: folder *and* file (spec §14.5) ---

test('a successful import adopts the imported file and folder as the target (spec §14.5)', () => {
  assert.deepEqual(nextSaveTarget(null, { kind: 'imported', folder: siteA, name: 'scene.json' }), {
    folder: siteA,
    name: 'scene.json',
  });
});

test('loading a sibling variant retargets the name but keeps the folder (spec §14.2, §14.5)', () => {
  // The point of naming scene files: two variants, one `assets/`.
  const target = { folder: siteA, name: 'scene.json' };
  assert.deepEqual(nextSaveTarget(target, { kind: 'imported', folder: siteA, name: 'night-shift.json' }), {
    folder: siteA,
    name: 'night-shift.json',
  });
});

test('a successful Save As… retargets to the file written (spec §14.5)', () => {
  assert.deepEqual(nextSaveTarget({ folder: siteA, name: 'scene.json' }, { kind: 'saved', folder: siteB, name: 'a.json' }), {
    folder: siteB,
    name: 'a.json',
  });
});

test('a failed save keeps the target so it can be retried or redirected (spec §14.8)', () => {
  const target = { folder: siteA, name: 'scene.json' };
  assert.equal(nextSaveTarget(target, { kind: 'failed' }), target);
  assert.equal(nextSaveTarget(null, { kind: 'failed' }), null);
});

test('a cancelled picker or dialog leaves the target untouched (spec §14.8)', () => {
  const target = { folder: siteA, name: 'scene.json' };
  assert.equal(nextSaveTarget(target, { kind: 'cancelled' }), target);
  assert.equal(nextSaveTarget(null, { kind: 'cancelled' }), null);
});

// --- File names (spec §14.5) ---

test('a plain name gains the extension the Load dialog looks for (spec §14.2, §14.5)', () => {
  assert.deepEqual(normalizeSceneFileName('night-shift'), { ok: true, name: 'night-shift.json' });
});

test('a name that already ends .json is left alone, whatever its case (spec §14.5)', () => {
  assert.deepEqual(normalizeSceneFileName('night-shift.json'), { ok: true, name: 'night-shift.json' });
  assert.deepEqual(normalizeSceneFileName('Night-Shift.JSON'), { ok: true, name: 'Night-Shift.JSON' });
});

test('another extension is appended to, not honoured — an unlisted file is unfindable (spec §14.2)', () => {
  assert.deepEqual(normalizeSceneFileName('notes.txt'), { ok: true, name: 'notes.txt.json' });
});

test('surrounding whitespace is trimmed before the extension is decided (spec §14.5)', () => {
  assert.deepEqual(normalizeSceneFileName('  night shift  '), { ok: true, name: 'night shift.json' });
  // Spaces and non-ASCII inside a name are fine — a site survey names its scenes.
  assert.deepEqual(normalizeSceneFileName('夕班'), { ok: true, name: '夕班.json' });
});

test('an empty name is refused rather than silently defaulted (spec §14.5)', () => {
  assert.deepEqual(normalizeSceneFileName(''), { ok: false, error: 'Enter a file name.' });
  assert.deepEqual(normalizeSceneFileName('   '), { ok: false, error: 'Enter a file name.' });
});

test('a path separator is refused: it would mean a subfolder, which §14.2 forbids', () => {
  for (const raw of ['night/shift', 'night\\shift', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    const checked = normalizeSceneFileName(raw);
    assert.equal(checked.ok, false, `${raw} should be refused`);
    if (!checked.ok) assert.match(checked.error, /cannot contain/);
  }
});

test('a leading dot is refused — it hides the file and makes ".json" a legal name (spec §14.5)', () => {
  assert.deepEqual(normalizeSceneFileName('.json'), { ok: false, error: 'A file name cannot start with a dot.' });
  assert.deepEqual(normalizeSceneFileName('.hidden'), { ok: false, error: 'A file name cannot start with a dot.' });
});

test('the Load dialog lists *.json at the root, dotfiles excluded (spec §14.2, §14.4)', () => {
  assert.equal(isSceneFileName('scene.json'), true);
  assert.equal(isSceneFileName('NIGHT.JSON'), true);
  assert.equal(isSceneFileName('shelf.glb'), false);
  assert.equal(isSceneFileName('.eslintrc.json'), false);
});

// --- List summaries (spec §14.4, §14.7) ---

const scene = (cameras: number, probes: number, sections: number) => ({
  cameras: Array.from({ length: cameras }),
  probes: Array.from({ length: probes }),
  sections: Array.from({ length: sections }),
});

test('a summary names what a variant differs in (spec §14.4)', () => {
  assert.equal(summarizeSceneFile(scene(96, 12, 0)), '96 cams · 12 probes');
});

test('sections join the summary only when there are any, keeping the line short (spec §14.7)', () => {
  assert.equal(summarizeSceneFile(scene(96, 12, 3)), '96 cams · 12 probes · 3 sections');
});

test('counts are singular at one and shown at zero (spec §14.4)', () => {
  assert.equal(summarizeSceneFile(scene(1, 1, 1)), '1 cam · 1 probe · 1 section');
  // An empty scene file is still a scene file, and says so rather than reading blank.
  assert.equal(summarizeSceneFile(scene(0, 0, 0)), '0 cams · 0 probes');
});

// --- Status line (spec §14.7) ---

test('status composes folder and file, since two folders can both hold a scene.json (spec §14.7)', () => {
  assert.equal(describeSceneFileStatus({ folder: siteA, name: 'night-shift.json' }, null), 'site-a/night-shift.json');
});

test('status acknowledges a silent save by name, the folder being unchanged (spec §14.7)', () => {
  assert.equal(describeSceneFileStatus({ folder: siteA, name: 'night-shift.json' }, { assetsCopied: 0 }), 'Saved night-shift.json');
});

test('a save that copied assets names the whole destination (spec §14.5, §14.7)', () => {
  assert.equal(
    describeSceneFileStatus({ folder: siteB, name: 'a.json' }, { assetsCopied: 1 }),
    'Saved to site-b/a.json — 1 asset copied',
  );
  assert.equal(
    describeSceneFileStatus({ folder: siteB, name: 'a.json' }, { assetsCopied: 3 }),
    'Saved to site-b/a.json — 3 assets copied',
  );
});

test('status says where Save will ask when there is no target (spec §14.1, §14.7)', () => {
  assert.equal(describeSceneFileStatus(null, null), 'No file chosen — Save will ask where to write.');
  // No target means nothing was saved; a stale "saved" can't resurrect a name.
  assert.equal(describeSceneFileStatus(null, { assetsCopied: 2 }), 'No file chosen — Save will ask where to write.');
});

// --- Replace warning (spec §14.5) ---

test('the replace warning names the file at risk (spec §14.5)', () => {
  assert.equal(
    describeReplaceWarning('night-shift.json', { fileExists: true, assetClashes: 0 }),
    'Replaces "night-shift.json".',
  );
});

test('the replace warning discloses the assets it would replace (spec §14.5)', () => {
  assert.equal(
    describeReplaceWarning('a.json', { fileExists: true, assetClashes: 2 }),
    'Replaces "a.json" and 2 of this scene\'s assets.',
  );
  assert.equal(describeReplaceWarning('a.json', { fileExists: false, assetClashes: 2 }), "Replaces 2 of this scene's assets.");
  assert.equal(describeReplaceWarning('a.json', { fileExists: false, assetClashes: 1 }), "Replaces 1 of this scene's assets.");
});

test('an untouched destination is not worth a warning, so the button stays Save (spec §14.5)', () => {
  assert.equal(describeReplaceWarning('a.json', { fileExists: false, assetClashes: 0 }), null);
});

// --- Unsaved-changes guard (spec §14.4) ---

test('the unsaved warning names the work at stake (spec §14.4)', () => {
  assert.equal(
    describeUnsavedWarning('night-shift.json'),
    '"night-shift.json" has unsaved changes — loading discards them.',
  );
});

test('a scene with no file yet is warned about anonymously (spec §14.1, §14.4)', () => {
  assert.equal(describeUnsavedWarning(null), 'This scene has unsaved changes — loading discards them.');
});

// --- Overwrite routing: one rule for both write paths (spec §14.5) ---

test('replacing a file is confirmed; creating one writes straight through (spec §14.5)', () => {
  assert.deepEqual(resolveWriteAction({ fileExists: true, assetClashes: 0 }), { kind: 'confirm' });
  assert.deepEqual(resolveWriteAction({ fileExists: false, assetClashes: 0 }), { kind: 'write' });
});

test('clashing assets alone never raise the confirmation (spec §14.5)', () => {
  // A cross-folder Save As… under a fresh name is a creation; the assets copied
  // alongside it are what makes the destination whole, not a loss.
  assert.deepEqual(resolveWriteAction({ fileExists: false, assetClashes: 3 }), { kind: 'write' });
  // They are still *reported* once the scene file itself is what's at stake.
  assert.deepEqual(resolveWriteAction({ fileExists: true, assetClashes: 3 }), { kind: 'confirm' });
});

test('the confirmation names folder and file, since two folders can hold a scene.json (spec §14.5)', () => {
  assert.deepEqual(describeOverwriteConfirm({ folder: siteA, name: 'scene.json' }, { fileExists: true, assetClashes: 0 }), [
    'site-a/scene.json already exists. Saving replaces it.',
  ]);
});

test('the confirmation adds the asset count only for a cross-folder save (spec §14.5)', () => {
  assert.deepEqual(describeOverwriteConfirm({ folder: siteB, name: 'a.json' }, { fileExists: true, assetClashes: 2 }), [
    'site-b/a.json already exists. Saving replaces it.',
    "Also replaces 2 of this scene's assets in that folder.",
  ]);
  // Partitive, so one asset needs no singular branch.
  const one = describeOverwriteConfirm({ folder: siteB, name: 'a.json' }, { fileExists: true, assetClashes: 1 });
  assert.equal(one[1], "Also replaces 1 of this scene's assets in that folder.");
});

// --- Asset copy planning (spec §14.5) ---

const gltf = (src: string): GeometryObject => ({ kind: 'gltf', src, ...identityTransform() });
const box: GeometryObject = { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], ...identityTransform() };
const room: GeometryObject = { kind: 'room', halfX: 5, halfZ: 5, height: 3, thickness: 0.2, ...identityTransform() };
// `splats` is a required argument, not a defaulted one: every caller has the
// scene's array in hand (`gaussian_splats.md` §8), so a scene with no capture
// passes `[]` rather than leaving it off.
const splat = (src: string) => defaultSplat('splat-1', src);

test('the copy plan is every referenced asset, in scene order (spec §14.5)', () => {
  assert.deepEqual(planAssetCopy([gltf('assets/shelf.glb'), box, gltf('assets/rack.glb')], []), [
    'assets/shelf.glb',
    'assets/rack.glb',
  ]);
});

test('an asset referenced twice is copied once (spec §14.5)', () => {
  assert.deepEqual(planAssetCopy([gltf('assets/shelf.glb'), gltf('assets/shelf.glb')], []), ['assets/shelf.glb']);
});

test('primitive-only geometry copies nothing — the default scene never has assets (spec §14.5)', () => {
  assert.deepEqual(planAssetCopy([room, box], []), []);
  assert.deepEqual(planAssetCopy([], []), []);
});

test('nested asset paths are planned verbatim, for the destination to recreate (spec §14.2, §14.5)', () => {
  assert.deepEqual(planAssetCopy([gltf('assets/site/level-1/rack.glb')], []), ['assets/site/level-1/rack.glb']);
});

// --- Failure text (spec §14.8) ---

test('a failed asset copy names the asset and says nothing was saved (spec §14.8)', () => {
  assert.equal(
    describeAssetCopyFailure('assets/rack.glb', 'not found in the source folder'),
    'Couldn\'t copy "assets/rack.glb": not found in the source folder. Nothing was saved.',
  );
});

test('a save failure names the file and points at Save As… (spec §14.8)', () => {
  assert.equal(
    describeSaveFailure('night-shift.json', 'permission denied'),
    'Couldn\'t save "night-shift.json": permission denied. Use Save As… to choose another folder.',
  );
});

// --- splat captures in the asset copy plan (`gaussian_splats.md` §8) --------

test('planAssetCopy includes splat srcs alongside gltf srcs', () => {
  // A cross-folder Save As… must leave the destination holding a *complete*
  // scene, and a capture is as much a referenced file as a GLB.
  assert.deepEqual(
    planAssetCopy([gltf('assets/shelf.glb')], [splat('assets/site.spz'), splat('assets/dock.sog')]),
    ['assets/shelf.glb', 'assets/site.spz', 'assets/dock.sog'],
  );
});

test('a capture referenced by two splat rows copies once (§3.3)', () => {
  // Two rows on one file is how two registrations are compared, and it must not
  // cost two copies of a hundreds-of-megabytes capture in the destination.
  assert.deepEqual(
    planAssetCopy([], [splat('assets/site.spz'), splat('assets/site.spz')]),
    ['assets/site.spz'],
  );
});

test('a src shared by a gltf object and a splat row is deduplicated across the two', () => {
  assert.deepEqual(
    planAssetCopy([gltf('assets/thing.glb')], [splat('assets/thing.glb')]),
    ['assets/thing.glb'],
  );
});

test('a scene with no splats plans exactly its gltf srcs', () => {
  assert.deepEqual(planAssetCopy([gltf('assets/shelf.glb')], []), ['assets/shelf.glb']);
  assert.deepEqual(planAssetCopy([], []), []);
});
