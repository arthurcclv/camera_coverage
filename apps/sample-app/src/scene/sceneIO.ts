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
 * The **Add 3DGS** dialog's listing and a splat's asset resolution follow the
 * same split, against `splatAssets.ts` (`gaussian_splats.md` §3.2, §11).
 */
import { buildSceneGeometry, type GeometryBuild } from './sceneGeometryBuild.ts';
import { isSafeAssetPath, parseSceneFile, resolveSectionFootprints, serializeScene } from './sceneFile.ts';
import { describeSceneFileRow, planSceneFileList, type SceneFileEntry } from './sceneFileList.ts';
import type { SaveTarget } from './saveTarget.ts';
import type { Scene } from './sceneModel.ts';
import { planSplatAssetList, type SplatAssetFile } from './splatAssets.ts';
import { SPLAT_ASSET_DIR } from './splats.ts';

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

async function resolveAssetFromDirectory(dir: FileSystemDirectoryHandle, src: string): Promise<ArrayBuffer> {
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

/** What the **Add 3DGS** dialog lists (`gaussian_splats.md` §3.2). */
export interface SplatAssetListing {
  /** False when the scene folder has no `assets/` at all — the dialog says so. */
  hasAssetDir: boolean;
  files: SplatAssetFile[];
}

/**
 * The capture files already sitting in a scene folder's `assets/`
 * (`gaussian_splats.md` §3.2) — the root of `assets/` only, **non-recursive**,
 * the same flatness rule §14.2 applies to scene files.
 *
 * Which names are listed and in what order is `planSplatAssetList`'s decision;
 * this only reads the folder and each handle's **metadata**. **No file is read or
 * decoded to build the list** — a site capture can run to hundreds of megabytes,
 * and opening a dialog must not touch those bytes.
 */
export async function listSplatAssets(dir: FileSystemDirectoryHandle): Promise<SplatAssetListing> {
  let assets: FileSystemDirectoryHandle;
  try {
    assets = await dir.getDirectoryHandle(SPLAT_ASSET_DIR);
  } catch {
    // No `assets/`, or it cannot be read. The dialog says so and offers no
    // commit; it does **not** create the folder (§3.2, §9).
    return { hasAssetDir: false, files: [] };
  }
  const fileNames: string[] = [];
  for await (const [name, handle] of assets.entries()) {
    if (handle.kind === 'file') fileNames.push(name);
  }
  const files: SplatAssetFile[] = [];
  for (const entry of planSplatAssetList(fileNames)) {
    files.push({ ...entry, size: await fileSizeAt(assets, entry.name) });
  }
  return { hasAssetDir: true, files };
}

/** One entry's byte size, or `null` when the metadata could not be read (§3.2). */
async function fileSizeAt(dir: FileSystemDirectoryHandle, name: string): Promise<number | null> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch {
    return null;
  }
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
