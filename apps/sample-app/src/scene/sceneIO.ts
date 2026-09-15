/**
 * Import/export orchestration against the File System Access API (spec §14.4,
 * §14.5) — the only impure I/O layer for the scene-file feature. A scene file is
 * addressed by the **save target**, the `{ folder, name }` pair (§14.5): a folder
 * holds any number of scene files, so nothing here knows a default name.
 *
 * Every judgement lives in a pure module — validation and (de)serialization in
 * `sceneFile.ts`, the Load list's ordering/rows/selection in `sceneFileList.ts`,
 * the naming and target rules in `saveTarget.ts`, all unit-tested. This module
 * only wires them to real file reads/writes and GLTFLoader asset resolution, and
 * is deliberately kept that thin so there's as little untested surface as
 * possible (this app's tests target pure functions only — `ai/CONVENTIONS.md`).
 * Asset **import** follows the same split, against `assetImport.ts` and
 * `plyHeader.ts` (`asset_import.md` §3, §4): the picker and the sniff's read
 * live here, every judgement about what they produced lives there.
 */
import { buildSceneGeometry, type GeometryBuild } from './sceneGeometryBuild.ts';
import { isSafeAssetPath, parseSceneFile, resolveSectionFootprints, serializeScene } from './sceneFile.ts';
import { describeSceneFileRow, planSceneFileList, type SceneFileEntry } from './sceneFileList.ts';
import type { SaveTarget } from './saveTarget.ts';
import type { Scene } from './sceneModel.ts';
import { acceptedExtensions, ASSET_DIR, needsPlySniff, type ImportKind } from './assetImport.ts';
import { classifyPlyHeader, PLY_SNIFF_BYTES, type PlyKind } from './plyHeader.ts';
import { assetFiles, type PendingAssets } from './pendingAssets.ts';
import type { AssetDirEntry, PlannedWrite } from './assetMaterialise.ts';
import type { AssetResolver } from './sceneGeometryBuild.ts';

/**
 * Walks a folder-relative asset path (spec §14.2, already validated safe on
 * import) to its file handle. `create` makes the intermediate folders and the
 * file itself, for copying into a Save As… destination (§14.5).
 */
async function fileHandleAt(dir: FileSystemDirectoryHandle, src: string, create: boolean): Promise<FileSystemFileHandle> {
  const segments = src.split('/');
  let current = dir;
  for (let i = 0; i < segments.length - 1; i++) {
    current = await current.getDirectoryHandle(segments[i], { create });
  }
  return current.getFileHandle(segments[segments.length - 1], { create });
}

export async function resolveAssetFromDirectory(dir: FileSystemDirectoryHandle, src: string): Promise<ArrayBuffer> {
  const file = await (await fileHandleAt(dir, src, false)).getFile();
  return file.arrayBuffer();
}

/** A referenced asset that couldn't be copied, carrying which one and why (§14.8). */
export class AssetCopyError extends Error {
  constructor(
    readonly src: string,
    readonly reason: string,
  ) {
    super(`Couldn't copy "${src}": ${reason}`);
    this.name = 'AssetCopyError';
  }
}

function copyFailureReason(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'not found in the source folder';
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Every `*.json` at a folder's root, as the Load dialog lists them (spec §14.4).
 *
 * The rows read and validate for their summaries — **parse only, no GLB is
 * loaded**, which is what keeps opening the dialog cheap and why a row that
 * summarizes fine can still fail its all-or-nothing import on a missing asset
 * (§14.4). Which names are listed, in which order, and which are read at all is
 * `planSceneFileList`'s decision; what each row says is `describeSceneFileRow`'s.
 * Enumeration failures (folder renamed, unmounted, permission lost) throw, for
 * the dialog to show and offer **Change…** against (§14.8).
 */
export async function listSceneFiles(dir: FileSystemDirectoryHandle): Promise<SceneFileEntry[]> {
  const fileNames: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') fileNames.push(name);
  }
  const entries: SceneFileEntry[] = [];
  for (const { name, parse } of planSceneFileList(fileNames)) {
    // Unparsed rows list name-only and validate on selection (§14.4).
    if (!parse) entries.push({ name, summary: null, error: null });
    else entries.push({ name, ...describeSceneFileRow(await readTextAt(dir, name)) });
  }
  return entries;
}

/** One file's text, or `null` when it could not be read — never throws (§14.4). */
async function readTextAt(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile().then((f) => f.text());
  } catch {
    return null;
  }
}

/** A file the user picked, with its PLY classification when one was needed (§4.2). */
export interface PickedImport {
  file: File;
  /** The picker's handle — what the save's dedupe compares by identity (§8.3). */
  handle: FileSystemFileHandle;
  /** From {@link classifyPlyHeader}; absent for a file that needed no sniff. */
  ply?: PlyKind;
}

/**
 * Open the OS file picker for one import entry (`asset_import.md` §3.2), and
 * sniff the result when the extension is ambiguous (§4.2).
 *
 * `showOpenFilePicker` is called **directly from the menu click**, which is the
 * user activation it requires — so no app dialog can precede it, and every
 * dialog this feature shows is a consequence of a pick rather than a preamble to
 * one. Returns `null` when the user cancels, which is a silent no-op.
 *
 * `startIn` is the save target's folder when there is one, so the commonest
 * destination — `assets/` in the folder already open — is one click away, and
 * the picker's own last-used-directory memory handles the rest.
 *
 * The routing decision itself is `routePickedFile`'s, not this function's: all
 * that happens here is a picker call and, for a `.ply`, a bounded read of its
 * first {@link PLY_SNIFF_BYTES} bytes.
 */
export async function pickImportFile(
  kind: ImportKind,
  startIn?: FileSystemDirectoryHandle,
): Promise<PickedImport | null> {
  const description = kind === 'model' ? 'Model files' : '3D Gaussian Splat captures';
  let handles: FileSystemFileHandle[];
  try {
    handles = await window.showOpenFilePicker({
      multiple: false,
      id: 'camera-coverage-assets',
      startIn,
      types: [{ description, accept: { '*/*': [...acceptedExtensions(kind)] } }],
    });
  } catch {
    // The picker throws `AbortError` on cancel, which is a no-op, not a failure
    // to report (§11).
    return null;
  }
  const handle = handles[0];
  if (handle == null) return null;
  const file = await handle.getFile();
  if (!needsPlySniff(file.name)) return { file, handle };
  return { file, handle, ply: await sniffPly(file) };
}

/**
 * Classify a `.ply` from its first {@link PLY_SNIFF_BYTES} bytes (§4.2). A read
 * that fails at all is `unreadable`, which is the same answer as a header that
 * makes no sense — either way the file cannot be routed.
 */
async function sniffPly(file: File): Promise<PlyKind> {
  try {
    const head = await file.slice(0, PLY_SNIFF_BYTES).arrayBuffer();
    return classifyPlyHeader(new TextDecoder('utf-8', { fatal: false }).decode(head));
  } catch {
    return 'unreadable';
  }
}

/**
 * Prove every pending asset's bytes are still readable, **before** the save
 * touches anything (`asset_import.md` §8.2).
 *
 * A `File` from the picker is a lazy, disk-backed `Blob`, and the window between
 * an import and a save is a whole working session — so a source file moved,
 * renamed, deleted or unmounted in the meantime is the single most likely
 * failure here. Discovering it mid-write would mean discovering it after §8.5
 * has already emptied a folder, so it is checked up front and the save aborts
 * naming the file.
 *
 * A one-byte read is enough: it is the access that fails, not the size.
 */
export async function preflightPending(pending: PendingAssets): Promise<void> {
  for (const [src, asset] of pending) {
    for (const [path, file] of assetFiles(src, asset)) {
      try {
        await file.slice(0, 1).arrayBuffer();
      } catch {
        // Its own error type, not an `AssetCopyError`: the reason is a sentence
        // this app wrote rather than a browser's, so it is composed as an i18n
        // message by the caller (`spec.md` §18.4) instead of carried as English.
        throw new PendingUnreadableError(path);
      }
    }
  }
}

/**
 * A pending import whose source file can no longer be read (§8.2) — moved,
 * renamed, deleted or unmounted since the import. Carries only the path,
 * because there is nothing else to say and the wording belongs to the locale.
 */
export class PendingUnreadableError extends Error {
  constructor(readonly src: string) {
    super(`pending asset is no longer readable: ${src}`);
    this.name = 'PendingUnreadableError';
  }
}

/** The direct children of `<dir>/assets/`, or `[]` when there is no `assets/` (§8.4). */
export async function listAssetDir(dir: FileSystemDirectoryHandle): Promise<AssetDirEntry[]> {
  let assets: FileSystemDirectoryHandle;
  try {
    assets = await dir.getDirectoryHandle(ASSET_DIR);
  } catch {
    return [];
  }
  const entries: AssetDirEntry[] = [];
  for await (const [name, handle] of assets.entries()) entries.push({ name, kind: handle.kind });
  return entries;
}

/**
 * Which pending assets are **already in** the target's `assets/`
 * (`asset_import.md` §8.3), mapped to the folder-relative path they actually
 * live at.
 *
 * `FileSystemHandle.isSameEntry` is identity, not a path comparison — which is
 * the only thing available, since the picker exposes no path at all. It is also
 * the only thing that is *correct*: a file renamed on disk still matches, and
 * two different `wall.png`s never do.
 *
 * The walk is recursive because an import writes into `assets/<name>/`, so the
 * file the user is re-picking is very often one level down.
 */
export async function dedupePendingAssets(
  dir: FileSystemDirectoryHandle,
  pending: PendingAssets,
): Promise<Map<string, string>> {
  const matched = new Map<string, string>();
  if (pending.size === 0) return matched;
  let assets: FileSystemDirectoryHandle;
  try {
    assets = await dir.getDirectoryHandle(ASSET_DIR);
  } catch {
    return matched; // no `assets/` yet: nothing can already be in it
  }
  const unmatched = new Map(pending);
  for await (const [path, handle] of walkFiles(assets, ASSET_DIR)) {
    if (unmatched.size === 0) break;
    for (const [src, asset] of unmatched) {
      if (await handle.isSameEntry(asset.handle)) {
        matched.set(src, path);
        unmatched.delete(src);
        break;
      }
    }
  }
  return matched;
}

/** Every file under `dir`, depth-first, yielded with its folder-relative path. */
async function* walkFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<[string, FileSystemFileHandle]> {
  for await (const [name, handle] of dir.entries()) {
    const path = `${prefix}/${name}`;
    if (handle.kind === 'file') yield [path, handle as FileSystemFileHandle];
    else yield* walkFiles(handle as FileSystemDirectoryHandle, path);
  }
}

/**
 * Write the planned folders (`asset_import.md` §8.5, §8.7 step 6).
 *
 * A folder that is being **replaced** is emptied recursively first, so "replace"
 * means replace and the folder afterwards holds exactly one model's files. This
 * is the only place this app removes anything from disk; every constraint on
 * *which* folder may be named here was settled by `planMaterialisation`, which
 * refuses anything that is not a single direct child of `assets/`.
 *
 * Folders are emptied **one at a time, immediately before their own files are
 * written**, so a failure part-way damages at most one — and the error names it.
 */
export async function materialiseAssets(
  dir: FileSystemDirectoryHandle,
  writes: readonly PlannedWrite[],
  pending: PendingAssets,
): Promise<void> {
  for (const write of writes) {
    const asset = pending.get(write.src);
    if (asset == null) continue;
    const name = write.folder.slice(ASSET_DIR.length + 1);
    try {
      if (write.replaces) {
        const assets = await dir.getDirectoryHandle(ASSET_DIR, { create: true });
        await assets.removeEntry(name, { recursive: true });
      }
    } catch (err) {
      throw new AssetCopyError(write.folder, `couldn't be replaced (${copyFailureReason(err)})`);
    }
    for (const [path, file] of assetFiles(write.src, asset)) {
      try {
        const writable = await (await fileHandleAt(dir, path, true)).createWritable();
        await file.stream().pipeTo(writable);
      } catch (err) {
        throw new AssetCopyError(path, copyFailureReason(err));
      }
    }
  }
}

/**
 * The mesh asset resolver, with the **pending store consulted first**
 * (`asset_import.md` §7.2).
 *
 * A pending asset and a materialised one take the same code path from here on,
 * which is what lets a row draw from memory the moment it is imported and keep
 * drawing, unreloaded, after a save rewrites nothing about it.
 */
export function meshResolver(pending: PendingAssets, dir: FileSystemDirectoryHandle | null): AssetResolver {
  return async (src: string) => {
    const held = heldFile(pending, src);
    return held != null ? held.arrayBuffer() : resolveAssetFromDirectory(requireFolder(dir, src), src);
  };
}

/** The pending store's `File` for this `src`, or `null` when the folder is where to look. */
function heldFile(pending: PendingAssets, src: string): File | null {
  return pending.get(src)?.file ?? null;
}

/**
 * The open scene folder, or the failure both resolvers report identically: a
 * `src` that is neither pending nor reachable has nowhere left to come from,
 * which happens only before any Load or Save.
 */
function requireFolder(dir: FileSystemDirectoryHandle | null, src: string): FileSystemDirectoryHandle {
  if (dir == null) throw new Error(`Cannot load "${src}": no scene folder is open`);
  return dir;
}

/**
 * The capture resolver, likewise pending-first (§7.2). Returns a `File` rather
 * than bytes for the same reason `resolveSplatFile` does — the load path streams
 * it, and a pending capture is exactly the `File` the picker handed over.
 */
export function splatResolver(
  pending: PendingAssets,
  dir: FileSystemDirectoryHandle | null,
): (src: string) => Promise<File> {
  return async (src: string) => heldFile(pending, src) ?? resolveSplatFile(requireFolder(dir, src), src);
}

/**
 * Resolves a splat's folder-relative `src` to its `File`
 * (`gaussian_splats.md` §4.4 step 1) — `isSafeAssetPath` first, then the walk,
 * so a hand-edited scene file cannot reach outside the folder even though
 * `parseSceneFile` already rejected it.
 *
 * Returns a `File`, not an `ArrayBuffer`, deliberately: the load path streams it
 * (`file.stream()`), because buffering a gigabyte-scale `.ply` into one
 * `ArrayBuffer` just to hand it over is an avoidable out-of-memory failure
 * (§4.4). Rejecting means **missing**, which the row reports without failing the
 * import (§9).
 */
export async function resolveSplatFile(dir: FileSystemDirectoryHandle, src: string): Promise<File> {
  if (!isSafeAssetPath(src)) throw new Error(`unsafe splat src "${src}"`);
  return (await fileHandleAt(dir, src, false)).getFile();
}

/**
 * Every file name at a folder's root — what the Save-as dialog checks a typed
 * name against, so a collision is known in memory as the user types rather than
 * probed on every keystroke (spec §14.5).
 */
export async function fileNamesIn(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') names.add(name);
  }
  return names;
}

/**
 * Which of `srcs` the destination folder already holds — the asset half of the
 * replace warning (spec §14.5).
 */
export async function findExistingAssets(dir: FileSystemDirectoryHandle, srcs: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const src of srcs) {
    try {
      await fileHandleAt(dir, src, false);
      existing.push(src);
    } catch {
      // Absent (or unreadable) — either way this save wouldn't be replacing it.
    }
  }
  return existing;
}

/**
 * Copies referenced assets from the scene's source folder into a Save As…
 * destination, at the same relative paths (spec §14.5). Runs **before**
 * the scene file is written, and throws `AssetCopyError` on the first failure so
 * the caller can abandon the save with no scene file written — already-copied
 * bytes stay put, since undoing them could delete a file this copy legitimately
 * overwrote. Streams each file rather than buffering it, for large GLBs.
 */
export async function copyAssets(
  from: FileSystemDirectoryHandle,
  to: FileSystemDirectoryHandle,
  srcs: readonly string[],
): Promise<void> {
  for (const src of srcs) {
    try {
      const file = await (await fileHandleAt(from, src, false)).getFile();
      const writable = await (await fileHandleAt(to, src, true)).createWritable();
      // pipeTo closes the destination on success and aborts it on failure.
      await file.stream().pipeTo(writable);
    } catch (err) {
      throw new AssetCopyError(src, copyFailureReason(err));
    }
  }
}

/**
 * Reads, validates, and builds a full `Scene` from one named file in a picked
 * folder (spec §14.4). All-or-nothing: every step (read the file,
 * parse/validate, load every referenced GLB, build the merged mesh) must succeed
 * before this resolves — nothing here touches app state, so a thrown error
 * leaves the caller free to leave the current scene completely untouched (§14.8).
 *
 * **Splat captures are deliberately not part of that gate.** The geometry is
 * what coverage is measured against, so a broken GLB invalidates the scene;
 * a capture is a backdrop that cannot change a single number, so a missing or
 * undecodable one leaves the import successful and reports on the row instead
 * (`gaussian_splats.md` §9). Captures therefore load asynchronously, after the
 * import commits — nothing here reads a capture's bytes.
 *
 * The file is re-read here even when the Load dialog already parsed it for a
 * summary, so this stays the single all-or-nothing validation path.
 */
export async function importSceneFile(
  target: SaveTarget<FileSystemDirectoryHandle>,
): Promise<{ scene: Scene; build: GeometryBuild }> {
  const { folder: dir, name } = target;
  let text: string;
  try {
    const fileHandle = await dir.getFileHandle(name);
    const file = await fileHandle.getFile();
    text = await file.text();
  } catch {
    throw new Error(`"${name}" not found in the selected folder`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`"${name}" is not valid JSON`);
  }

  const parsed = parseSceneFile(json);
  if (!parsed.ok) throw new Error(parsed.error);

  const build = await buildSceneGeometry(parsed.scene.geometry, (src) => resolveAssetFromDirectory(dir, src));
  // Section footprints left unset in the file default to the full workspace-AABB
  // extent, resolvable only now that the geometry's world bounds are built (§14.3).
  const sections = resolveSectionFootprints(parsed.scene.sections, build.worldMin, build.worldMax);
  return { scene: { ...parsed.scene, sections }, build };
}

/**
 * Whether a folder already holds a file of this name — what a plain **Save**
 * checks before writing, since replacing a file is confirmed first (spec §14.5).
 * The Save-as dialog needs no probe here: it already holds the folder's whole
 * name set (`fileNamesIn`).
 *
 * A folder we cannot even probe (permission, gone) reads as "no file": raising a
 * confirmation over a folder that may not exist would ask the wrong question,
 * and the write that follows reports the real error (§14.8).
 */
export async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Requests write access on a directory handle picked read-only, from the
 * caller's user activation (spec §14.5) — import never asks to edit files, so
 * the first save is where the prompt belongs. Already-granted handles resolve
 * without prompting again.
 */
export async function ensureWritePermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const descriptor = { mode: 'readwrite' } as const;
  if ((await dir.queryPermission(descriptor)) === 'granted') return true;
  return (await dir.requestPermission(descriptor)) === 'granted';
}

/**
 * Serializes the current `Scene` to the named file and writes it into the chosen
 * folder in place (spec §14.5) — asset bytes under `assets/` are referenced,
 * never written by export, and are shared with every other scene file in the
 * folder (§14.2).
 */
export async function exportSceneFile(
  target: SaveTarget<FileSystemDirectoryHandle>,
  scene: Scene,
): Promise<void> {
  const json = serializeScene(scene);
  const fileHandle = await target.folder.getFileHandle(target.name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(JSON.stringify(json, null, 2));
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}
