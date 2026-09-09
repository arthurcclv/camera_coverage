/**
 * The **Add 3DGS** dialog's file list as *decisions* rather than I/O
 * (`gaussian_splats.md` §3.2): which of the scene folder's `assets/` entries are
 * listed, in what order, and which of them can be committed.
 *
 * `sceneIO.listSplatAssets` does the reading and nothing else — the same split
 * `sceneFileList.ts` has from `sceneIO.ts`, so the list is unit-testable with
 * plain strings and no File System Access API (`ai/CONVENTIONS.md`).
 */
import { isSplatFileName, SOG_BUNDLE_MANIFEST, SOG_BUNDLE_REASON } from './splats.ts';

/** One row of the Add 3DGS dialog's list (`gaussian_splats.md` §3.2). */
export interface SplatAssetEntry {
  name: string;
  /** Why the row is unselectable, or `null` when it can be added. */
  error: string | null;
}

/** A listed row plus its byte size, once `sceneIO` has read the handle's metadata. */
export interface SplatAssetFile extends SplatAssetEntry {
  /** `FileSystemFileHandle.getFile().size`; `null` when the metadata could not be read. */
  size: number | null;
}

/**
 * Which of `assets/`'s file names the Add 3DGS dialog lists, and in what order
 * (`gaussian_splats.md` §3.2).
 *
 * Filtered to the accepted capture extensions (§3.1), with one deliberate
 * exception: a PCSOGS `meta.json` is **listed with its reason** rather than
 * silently dropped, the same choice the Load dialog makes for an invalid
 * `*.json` (`spec.md` §14.4) — so a folder holding a SOG bundle explains itself
 * instead of looking empty.
 *
 * The order is stable and case-insensitive, exactly as `planSceneFileList`
 * sorts scene files: the list is scanned by eye, so a folder's contents must not
 * reshuffle between openings. A file this scene **already references** is still
 * listed and still selectable — two rows on one capture is how two
 * registrations are compared (§3.3) — so nothing here takes the scene's own
 * `splats` into account.
 */
export function planSplatAssetList(fileNames: readonly string[]): SplatAssetEntry[] {
  const rows: SplatAssetEntry[] = [];
  for (const name of fileNames) {
    if (isSplatFileName(name)) rows.push({ name, error: null });
    else if (name.toLowerCase() === SOG_BUNDLE_MANIFEST) rows.push({ name, error: SOG_BUNDLE_REASON });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return rows;
}

/**
 * Which row the freshly-listed `assets/` opens with (`gaussian_splats.md` §3.2):
 * the first **selectable** one, so the commit button always has a subject.
 * `null` when nothing in the folder can be added.
 */
export function firstSelectableAsset(entries: readonly SplatAssetEntry[]): string | null {
  return entries.find((e) => e.error == null)?.name ?? null;
}

/** A listed size as the row renders it — `12.4 MB`, `840 kB`, `— ` when unknown. */
export function formatByteSize(size: number | null): string {
  if (size == null) return '—';
  if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`;
  if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`;
  if (size >= 1e3) return `${Math.round(size / 1e3)} kB`;
  return `${size} B`;
}
