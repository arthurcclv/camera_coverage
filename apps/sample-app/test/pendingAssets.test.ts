/**
 * The pending store (`asset_import.md` §7) — the bytes of an imported asset,
 * held beside the scene until a save materialises them.
 *
 * Pure: the store holds `File` handles but never reads them, so every rule is
 * testable with no File System Access API (`ai/CONVENTIONS.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addPending,
  noPendingAssets,
  pendingCount,
  assetFiles,
  pendingFolderNames,
  releaseUnreferenced,
  type PendingAsset,
} from '../src/scene/pendingAssets.ts';

/** A pending entry whose bytes are never read — only its identity matters here. */
function asset(name: string): PendingAsset {
  // The store never touches the handle — only the save's dedupe walk does (§8.3).
  const handle = { name, kind: 'file' } as unknown as FileSystemFileHandle;
  return { file: new File([name], name), handle, deps: new Map() };
}

test('an import records its bytes against the src its row references (§6.2, §7.1)', () => {
  const pending = addPending(noPendingAssets(), 'assets/rack/rack.gltf', asset('rack.gltf'));
  assert.equal(pendingCount(pending), 1);
  assert.equal(pending.get('assets/rack/rack.gltf')?.file.name, 'rack.gltf');
});

test('adding returns a new map, leaving the previous one alone', () => {
  const before = noPendingAssets();
  const after = addPending(before, 'assets/rack/rack.gltf', asset('rack.gltf'));
  assert.equal(pendingCount(before), 0);
  assert.equal(pendingCount(after), 1);
});

test('two rows on one pending asset share one entry (§7.1)', () => {
  // Keyed by `src`, exactly as the parse and decode caches are — so a duplicated
  // row costs one entry, one parse and one set of GPU buffers.
  const pending = addPending(noPendingAssets(), 'assets/rack/rack.gltf', asset('rack.gltf'));
  assert.equal(pendingCount(releaseUnreferenced(pending, ['assets/rack/rack.gltf', 'assets/rack/rack.gltf'])), 1);
});

test('an entry no surviving row references is released (§7.3)', () => {
  let pending = addPending(noPendingAssets(), 'assets/rack/rack.gltf', asset('rack.gltf'));
  pending = addPending(pending, 'assets/site/site.spz', asset('site.spz'));

  const afterDelete = releaseUnreferenced(pending, ['assets/site/site.spz']);
  assert.equal(pendingCount(afterDelete), 1);
  assert.ok(afterDelete.has('assets/site/site.spz'));
  assert.ok(!afterDelete.has('assets/rack/rack.gltf'));
});

test('a duplicated row keeps its bytes alive (§7.3)', () => {
  const pending = addPending(noPendingAssets(), 'assets/rack/rack.gltf', asset('rack.gltf'));
  const kept = releaseUnreferenced(pending, ['assets/rack/rack.gltf']);
  assert.equal(pendingCount(kept), 1);
  // Nothing changed, so the same map comes back rather than a fresh copy.
  assert.equal(kept, pending);
});

test('releasing everything lands back at the empty store (§7.3)', () => {
  const pending = addPending(noPendingAssets(), 'assets/rack/rack.gltf', asset('rack.gltf'));
  assert.equal(pendingCount(releaseUnreferenced(pending, [])), 0);
});

test('an already-resolved src in the scene is not a pending entry', () => {
  // A row referencing a file that is genuinely on disk holds nothing here, so a
  // scene full of them reports no unsaved assets.
  const pending = releaseUnreferenced(noPendingAssets(), ['assets/site.spz', 'assets/shelf.glb']);
  assert.equal(pendingCount(pending), 0);
});

test('the claimed folder names are what a new import uniquifies against (§6.2)', () => {
  let pending = addPending(noPendingAssets(), 'assets/rack/rack.gltf', asset('rack.gltf'));
  pending = addPending(pending, 'assets/rack-2/rack.gltf', asset('rack.gltf'));
  // A hand-placed flat `src` claims no folder — it is not shaped like an import.
  pending = addPending(pending, 'assets/site.spz', asset('site.spz'));

  assert.deepEqual([...pendingFolderNames(pending)].sort(), ['rack', 'rack-2']);
});

test('an asset writes itself first, then each dependency at its own path (§8.7)', () => {
  // One definition for three passes: the pre-flight probe, the write loop and
  // the plan's path list must walk the same files in the same order.
  const entry = asset('rack.gltf');
  const withDeps: PendingAsset = {
    ...entry,
    deps: new Map([['assets/rack/rack.bin', new File(['bin'], 'rack.bin')]]),
  };
  assert.deepEqual(
    assetFiles('assets/rack/rack.gltf', withDeps).map(([path]) => path),
    ['assets/rack/rack.gltf', 'assets/rack/rack.bin'],
  );
  assert.equal(assetFiles('assets/rack/rack.gltf', withDeps)[0]?.[1], entry.file);
});
