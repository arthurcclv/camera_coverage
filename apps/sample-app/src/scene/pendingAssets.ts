/**
 * The **pending store** (`asset_import.md` §7): the bytes of an imported asset
 * that exist only in this browser session, held beside the scene until a save
 * materialises them into the target folder's `assets/` (§8).
 *
 * The row carries its real `src` from the moment it is created, and this map is
 * keyed by that `src` — so **`Scene` is untouched**: no nullable `src`, no new
 * array, no new field, no format change. A pending mesh serializes exactly as a
 * resolved one, `formatVersion` stays 4, and the dirty check keeps working
 * through the existing `serializeScene` baseline comparison with no exclusion
 * (§7.1).
 *
 * Keying by `src` is not arbitrary: it is the key `geometry_assets.md` §3.5's
 * parse cache and `gaussian_splats.md` §3.3's decode cache already use, so two
 * rows on one pending asset share one entry, one parse and one set of GPU
 * buffers — exactly as two rows on a resolved one do.
 *
 * Pure: the map holds `File` handles but never reads them, so every rule below
 * is testable with no File System Access API (`ai/CONVENTIONS.md`).
 */
import { importFolderName } from './assetImport.ts';

/**
 * One imported asset's bytes, awaiting a save (`asset_import.md` §7.1).
 *
 * A `File` is a disk-backed `Blob`, so holding a whole closure costs
 * essentially no memory — which is what makes deferring every import to the
 * next save viable. The cost is **staleness**: a file moved or deleted between
 * import and save can no longer be read, which §8.2's pre-flight is what catches.
 */
export interface PendingAsset {
  /** The picked file's bytes, read lazily when the save writes them. */
  file: File;
  /**
   * The picker's own handle for that file — kept because **identity is the only
   * way** to ask whether it already lives in the target's `assets/` (§8.3). The
   * picker exposes no path, so a name-or-size comparison is the alternative, and
   * it silently references the wrong `wall.png`.
   */
  handle: FileSystemFileHandle;
  /**
   * Dependency path (relative to the scene folder root) → its picked `File`
   * (§5). Always empty until stage C adds dependency resolution.
   */
  deps: ReadonlyMap<string, File>;
}

/** `src` → the files to write when that asset is materialised (§8). */
export type PendingAssets = ReadonlyMap<string, PendingAsset>;

/**
 * Every file this asset writes, at the folder-relative path it writes to: the
 * asset itself first, then each dependency at the path its model spells out
 * (§5.1, §8.7).
 *
 * One definition, because three passes walk the same list in the same order —
 * the pre-flight probe (§8.2), the write loop (§8.7 step 6) and the plan's path
 * list — and a pre-flight that checked a different set than the write loop wrote
 * would be worth nothing.
 */
export function assetFiles(src: string, asset: PendingAsset): [string, File][] {
  return [[src, asset.file], ...asset.deps];
}

/** An empty store — the boot state, and what a scene replacement returns to (§7.3). */
export function noPendingAssets(): PendingAssets {
  return new Map();
}

/** Record an imported asset's bytes against the `src` its row references (§6.2). */
export function addPending(pending: PendingAssets, src: string, asset: PendingAsset): PendingAssets {
  return new Map(pending).set(src, asset);
}

/**
 * Drop every entry no surviving row references (`asset_import.md` §7.3) —
 * refcounting by referencing rows, the same rule the parse and decode caches
 * use. Called after any edit that can remove a row, so a deleted import releases
 * its bytes and a **duplicated** row keeps them alive.
 *
 * `referenced` is every `src` the scene still mentions, meshes and captures
 * alike; the store does not distinguish the two kinds, because materialising
 * them does not either.
 */
export function releaseUnreferenced(pending: PendingAssets, referenced: Iterable<string>): PendingAssets {
  if (pending.size === 0) return pending;
  const live = new Set(referenced);
  const next = new Map<string, PendingAsset>();
  for (const [src, asset] of pending) if (live.has(src)) next.set(src, asset);
  return next.size === pending.size ? pending : next;
}

/**
 * The `assets/<name>/` folder names already claimed by pending imports — the
 * `taken` set `resolveImportName` uniquifies against (§6.2).
 *
 * Only pending entries are consulted. Uniqueness against what is **on disk** is
 * settled at save (§8.4), because only that needs a folder to be readable, and
 * at import time there may be no save target at all.
 */
export function pendingFolderNames(pending: PendingAssets): Set<string> {
  const names = new Set<string>();
  for (const src of pending.keys()) {
    const name = importFolderName(src);
    if (name != null) names.add(name);
  }
  return names;
}

/**
 * How many imported assets would be lost if the scene were discarded
 * (`asset_import.md` §9) — what the Load-anyway warning names, and what the
 * `not saved` row marker counts.
 *
 * Counted over the store rather than over rows, so two rows on one pending
 * asset are one asset at risk, which is what the sentence means.
 */
export function pendingCount(pending: PendingAssets): number {
  return pending.size;
}
