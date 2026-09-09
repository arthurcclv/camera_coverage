/**
 * The **Add 3DGS** dialog's list decisions (`gaussian_splats.md` §3.2) — which
 * of `assets/`'s files are listed, in what order, and which can be committed.
 *
 * Testable with plain strings and no File System Access API, which is the whole
 * point of the `splatAssets.ts` / `sceneIO.ts` split (§11, `ai/CONVENTIONS.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  firstSelectableAsset,
  formatByteSize,
  planSplatAssetList,
} from '../src/scene/splatAssets.ts';
import { SOG_BUNDLE_REASON } from '../src/scene/splats.ts';

test('the list is filtered to the accepted capture extensions (§3.1)', () => {
  const rows = planSplatAssetList([
    'site.spz',
    'yard.ply',
    'dock.sog',
    'old.splat',
    'legacy.ksplat',
    'shelf.glb',
    'scene.json',
    'notes.txt',
    'thumb.webp',
  ]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['dock.sog', 'legacy.ksplat', 'old.splat', 'site.spz', 'yard.ply'],
  );
  assert.ok(rows.every((r) => r.error == null));
});

test('a PCSOGS meta.json is listed with its reason, not silently dropped (§3.1, §9)', () => {
  const rows = planSplatAssetList(['meta.json', 'site.spz']);
  const meta = rows.find((r) => r.name === 'meta.json');
  assert.ok(meta, 'meta.json should be listed');
  assert.equal(meta.error, SOG_BUNDLE_REASON);
  // Listed, but not committable: the fix is its `.sog` zip, and the row says so
  // rather than leaving a folder full of `.webp` payloads looking empty.
  assert.equal(firstSelectableAsset(rows), 'site.spz');
});

test('the order is case-insensitive, so a folder does not reshuffle between openings', () => {
  const rows = planSplatAssetList(['Zulu.spz', 'alpha.spz', 'Bravo.ply']);
  assert.deepEqual(rows.map((r) => r.name), ['alpha.spz', 'Bravo.ply', 'Zulu.spz']);
});

test('the order does not depend on the folder enumeration order', () => {
  const names = ['dock.sog', 'alpha.spz', 'meta.json', 'Zulu.ply'];
  const forward = planSplatAssetList(names).map((r) => r.name);
  const reversed = planSplatAssetList([...names].reverse()).map((r) => r.name);
  assert.deepEqual(forward, reversed);
});

test('a file this scene already references is still listed and still selectable (§3.2, §3.3)', () => {
  // Nothing here takes the scene's own `splats` into account, deliberately:
  // adding one capture twice is how two registrations are compared, and the
  // per-`src` decode cache makes it cost a row rather than a gigabyte.
  const rows = planSplatAssetList(['site.spz']);
  assert.deepEqual(rows, [{ name: 'site.spz', error: null }]);
  assert.equal(firstSelectableAsset(rows), 'site.spz');
});

test('an empty folder, and one holding nothing decodable, both offer no commit (§3.2)', () => {
  assert.deepEqual(planSplatAssetList([]), []);
  assert.equal(firstSelectableAsset([]), null);

  const nothingUsable = planSplatAssetList(['shelf.glb', 'scene.json', 'meta.json']);
  assert.deepEqual(nothingUsable.map((r) => r.name), ['meta.json']);
  assert.equal(firstSelectableAsset(nothingUsable), null);
});

test('sizes are formatted for scanning, and an unreadable one degrades to a dash', () => {
  // A site capture runs to hundreds of megabytes, so the row reports its size —
  // read from the handle's metadata, never by reading the file (§3.2).
  assert.equal(formatByteSize(412_000_000), '412.0 MB');
  assert.equal(formatByteSize(1_400_000_000), '1.4 GB');
  assert.equal(formatByteSize(840_000), '840 kB');
  assert.equal(formatByteSize(512), '512 B');
  assert.equal(formatByteSize(null), '—');
});
