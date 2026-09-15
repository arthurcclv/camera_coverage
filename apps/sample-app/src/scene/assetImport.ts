/**
 * Importing an asset from **anywhere on disk** as *decisions* rather than I/O
 * (`asset_import.md` §3, §4, §6) — which entry accepts which file, why a file is
 * refused, and what the folder it lands in is called.
 *
 * The picker itself lives in `sceneIO.ts`, the same split `sceneFileList.ts` has
 * from it: every judgement here, the File System Access calls there, so the
 * routing is unit-testable with plain strings and no browser
 * (`ai/CONVENTIONS.md`).
 *
 * This module replaces both asset **listings** (`asset_import.md` §1.2). There
 * is no longer any question of "which of `assets/` do you want" — the picker
 * reaches the whole disk, and a file that happens to already be in `assets/`
 * resolves to itself at save time (§8.3).
 */
import { classifyPlyHeader, type PlyKind } from './plyHeader.ts';
import type { Message } from './saveTarget.ts';
import { basename, SOG_BUNDLE_MANIFEST, SPLAT_EXTENSIONS } from './splats.ts';

/**
 * Which "+" entry the user chose (`asset_import.md` §3.1) — and therefore what
 * they meant by a file that could be either.
 *
 * Two entries rather than one sniffing **Import…**, because `.ply` is a legal
 * member of both lists: the entry is the only place the user can say whether a
 * point cloud is their site backdrop or a mistake (§4.2).
 */
export type ImportKind = 'model' | 'capture';

/**
 * The triangle formats a **mesh asset** may take (`geometry_assets.md` §3.1).
 * One `mesh` kind covers all four; the loader is chosen by extension.
 */
export const MODEL_EXTENSIONS = ['.glb', '.gltf', '.ply', '.obj'] as const;

/** The accepted extensions for each entry (`asset_import.md` §4.1). */
export function acceptedExtensions(kind: ImportKind): readonly string[] {
  return kind === 'model' ? MODEL_EXTENSIONS : SPLAT_EXTENSIONS;
}

/** The scene-folder subdirectory every import lands under (`asset_import.md` §6.2). */
export const ASSET_DIR = 'assets';

/** Whether a picked file needs its header sniffed before it can be routed (§4.2). */
export function needsPlySniff(fileName: string): boolean {
  return extensionOf(fileName) === '.ply';
}

/**
 * A picked file was accepted, or refused with the reason the dialog shows (§4).
 *
 * The reason is an **i18n key**, never English: this is a pure function
 * composing user-facing text, so it returns the message as data and the dialog
 * resolves it (`spec.md` §18.4, `ai/CONVENTIONS.md`). The wording in §4.2's
 * table is the `en` copy of these keys, not the value here.
 */
export type ImportRouting = { ok: true } | { ok: false; reason: Message };

/**
 * Whether this entry accepts this file (`asset_import.md` §4.1, §4.2, §4.4).
 *
 * `ply` is the header classification from {@link classifyPlyHeader} — required
 * when {@link needsPlySniff} says so, ignored otherwise.
 *
 * Every refusal **names the remedy**, and for a wrong-kind PLY the remedy is the
 * other entry — which, unlike the listings this replaces, is enabled, opens a
 * picker, and can be pointed at the very same file (§4.2). That dead end is the
 * reason both dialogs were unified rather than only one being replaced.
 */
export function routePickedFile(kind: ImportKind, fileName: string, ply?: PlyKind): ImportRouting {
  const name = basename(fileName);
  if (kind === 'capture' && name.toLowerCase() === SOG_BUNDLE_MANIFEST) {
    return refuse('importRefusalSogBundle');
  }
  const ext = extensionOf(name);
  const accepted = acceptedExtensions(kind);
  if (ext == null || !accepted.includes(ext)) {
    // Naming the accepted set is what §4.1 requires; naming the entry is not,
    // and the user clicked it a moment ago.
    const params = { accepted: accepted.join(', ') };
    return ext == null
      ? refuse('importRefusalNoExtension', params)
      : refuse('importRefusalExtension', { ...params, ext });
  }
  if (ext !== '.ply') return { ok: true };

  switch (ply) {
    case 'splat':
      return kind === 'capture' ? { ok: true } : refuse('importRefusalSplatPly');
    case 'mesh':
      return kind === 'model' ? { ok: true } : refuse('importRefusalMeshPly');
    case 'points':
      // A bare point cloud has no faces, so as geometry it would occupy a row,
      // occlude nothing, and still grow the workspace AABB — diluting every
      // coverage rate with voxels nothing can cover (`geometry_assets.md`
      // §4.5). As a capture it is exactly what Spark decodes.
      return kind === 'capture' ? { ok: true } : refuse('importRefusalNoFaces');
    default:
      return refuse('importRefusalUnreadablePly');
  }
}

/** A refusal carrying the key its reason is displayed from (`common` namespace). */
function refuse(key: string, params?: Record<string, string>): ImportRouting {
  return { ok: false, reason: params == null ? { key } : { key, params } };
}

/** A file name's lowercased final extension, or `null` when it has none. */
export function extensionOf(fileName: string): string | null {
  const name = basename(fileName);
  const at = name.lastIndexOf('.');
  return at <= 0 ? null : name.slice(at).toLowerCase();
}

/**
 * The folder name an import lands under — `rack.gltf` ⇒ `rack`, so the asset
 * becomes `assets/rack/rack.gltf` and its dependencies sit beneath it
 * (`asset_import.md` §6.2).
 *
 * **One rule, self-contained files included.** `assets/shelf/shelf.glb` is a
 * path segment longer than it needs to be, and that is the price of not
 * branching on whether a parse happened to find dependencies — something the
 * user cannot predict before picking. It also makes collisions structural: two
 * models that both ship `textures/wall.png` can never touch each other's files.
 *
 * `taken` is the set of folder names **already claimed by pending imports**, and
 * nothing else: uniqueness against what is on disk is settled at save (§8.4),
 * because only that needs a folder to be readable. Two imports of two different
 * `rack.gltf`s in one session therefore become `rack` and `rack-2` immediately,
 * since the app can see its own pending set.
 */
export function resolveImportName(fileName: string, kind: ImportKind, taken: Iterable<string>): string {
  const claimed = new Set(taken);
  // Normalized **whole**, not from its basename: a separator is one of the
  // characters §14.5's rule replaces, so splitting on it first would silently
  // drop everything before it rather than make it safe. A picked `File.name`
  // carries no separator anyway — this is what happens when one appears.
  const base = normalizeName(stripExtension(fileName)) || (kind === 'model' ? 'model' : 'capture');
  if (!claimed.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!claimed.has(candidate)) return candidate;
  }
}

/** `rack.gltf` ⇒ `rack`; a name with no extension is returned whole. */
function stripExtension(name: string): string {
  const ext = extensionOf(name);
  return ext == null ? name : name.slice(0, name.length - ext.length);
}

/**
 * A picked file's name made safe as a folder name, by `spec.md` §14.5's
 * portability rule: scene folders travel between machines, and a path separator
 * would silently mean a subfolder. Rejected characters and any leading `.`
 * become `-`; an empty result falls back to the caller's default.
 */
function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/^\.+/, '-')
    .trim();
}

/** Where an imported file's bytes will live, relative to the scene folder root (§6.2). */
export function importSrc(folderName: string, fileName: string): string {
  return `${ASSET_DIR}/${folderName}/${basename(fileName)}`;
}

/**
 * The `assets/<name>/` segment of a `src` produced by {@link importSrc}, or
 * `null` for a `src` that is not shaped like an import — a hand-placed
 * `assets/site.spz`, which stays valid and resolves identically (§6.2).
 */
export function importFolderName(src: string): string | null {
  const parts = src.split('/');
  return parts.length === 3 && parts[0] === ASSET_DIR ? parts[1]! : null;
}
