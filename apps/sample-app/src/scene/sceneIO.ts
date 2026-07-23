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

async function resolveAssetFromDirectory(dir: FileSystemDirectoryHandle, src: string): Promise<ArrayBuffer> {
  const segments = src.split('/');
  let current = dir;
  for (let i = 0; i < segments.length - 1; i++) {
    current = await current.getDirectoryHandle(segments[i]);
  }
  const fileHandle = await current.getFileHandle(segments[segments.length - 1]);
  const file = await fileHandle.getFile();
  return file.arrayBuffer();
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
