/**
 * Import/export orchestration against the File System Access API (spec §14.4,
 * §14.5) — the only impure I/O layer for the scene-file feature. Validation and
 * (de)serialization logic lives in `sceneFile.ts` (pure, unit-tested); this
 * module just wires that logic to real file reads/writes and GLTFLoader asset
 * resolution, and is intentionally thin so there's as little untested surface
 * as possible (this app's tests target pure functions only — see
 * `ai/CONVENTIONS.md`).
 */
import { buildSceneGeometry, type GeometryBuild } from './sceneGeometryBuild.ts';
import { parseSceneFile, resolveSectionFootprints, serializeScene } from './sceneFile.ts';
import type { Scene } from './sceneModel.ts';

const SCENE_JSON_NAME = 'scene.json';

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
 * Which of `srcs` the destination folder already holds — the asset half of the
 * overwrite confirmation (spec §14.5).
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
 * `scene.json` is written, and throws `AssetCopyError` on the first failure so
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
 * Reads, validates, and builds a full `Scene` from a picked folder (spec
 * §14.4). All-or-nothing: every step (read `scene.json`, parse/validate, load
 * every referenced GLB, build the merged mesh) must succeed before this
 * resolves — nothing here touches app state, so a thrown error leaves the
 * caller free to leave the current scene completely untouched (§14.8).
 */
export async function importSceneFromDirectory(dir: FileSystemDirectoryHandle): Promise<{ scene: Scene; build: GeometryBuild }> {
  let text: string;
  try {
    const fileHandle = await dir.getFileHandle(SCENE_JSON_NAME);
    const file = await fileHandle.getFile();
    text = await file.text();
  } catch {
    throw new Error(`"${SCENE_JSON_NAME}" not found in the selected folder`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`"${SCENE_JSON_NAME}" is not valid JSON`);
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
 * Whether a folder already holds a `scene.json` — the overwrite check for a
 * freshly picked folder (spec §14.5). A folder we can't even probe (permission,
 * gone) reads as "no scene": the write that follows raises the real error.
 */
export async function sceneJsonExists(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await dir.getFileHandle(SCENE_JSON_NAME);
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
 * Serializes the current `Scene` to `scene.json` and writes it into the chosen
 * folder in place (spec §14.5) — asset bytes under `assets/` are referenced,
 * never written by export.
 */
export async function exportSceneToDirectory(dir: FileSystemDirectoryHandle, scene: Scene): Promise<void> {
  const json = serializeScene(scene);
  const fileHandle = await dir.getFileHandle(SCENE_JSON_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(JSON.stringify(json, null, 2));
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}
