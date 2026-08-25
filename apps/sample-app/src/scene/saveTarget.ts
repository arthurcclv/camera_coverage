/**
 * Save-target logic for the scene file (spec §14.5, §14.7) — which folder a Save
 * writes to, when a picker is shown, and when an overwrite needs confirming.
 *
 * The target is the folder the current scene is associated with: a successful
 * import sets it, a successful Save As… retargets it, and a failure leaves it
 * alone. Save therefore round-trips back to where the scene was *opened* rather
 * than to whichever folder happened to be saved to last.
 *
 * Pure and generic over the handle type (only `.name` is ever read), so the
 * decisions are unit-testable with plain objects and no File System Access API
 * (`test/saveTarget.test.ts`); the impure handle juggling stays in `App.tsx` and
 * the writes in `sceneIO.ts` (see `ai/CONVENTIONS.md`).
 */
import type { GeometryObject } from './geometryModel.ts';

/** How long the transient "Saved to <folder>" status stays up (§14.7). */
export const SAVED_STATUS_MS = 2000;

/** Stable picker id, so this app keeps its own remembered-directory bucket (§14.5). */
export const SCENE_PICKER_ID = 'camera-coverage-scene-folder';

/** Which button was pressed: plain **Save** or **Save As…** (§14.5). */
export type SaveIntent = 'save' | 'saveAs';

/**
 * What a save should do. `confirmIfExists` carries the overwrite rule (§14.5):
 * a folder chosen from a picker in this same interaction confirms before
 * replacing an existing `scene.json`; an already-established target never does.
 */
export type SaveAction =
  | { kind: 'write'; confirmIfExists: false }
  | { kind: 'pick'; confirmIfExists: true };

/**
 * Resolve a Save/Save As… press against the current target. Only a plain Save
 * with a target writes silently — Save As… always picks, and so does Save at
 * boot, when there is no target yet (§14.5).
 */
export function resolveSaveAction(hasTarget: boolean, intent: SaveIntent): SaveAction {
  if (intent === 'save' && hasTarget) return { kind: 'write', confirmIfExists: false };
  return { kind: 'pick', confirmIfExists: true };
}

/**
 * Outcome of a scene-file interaction, as it bears on the target: a completed
 * import or write adopts its folder; anything else (failed write, denied
 * permission, missing folder, cancelled picker or overwrite prompt) keeps the
 * current target so the user can retry or redirect with Save As… (§14.8).
 */
export type SaveTargetEvent<T> =
  | { kind: 'imported'; folder: T }
  | { kind: 'saved'; folder: T }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

/** Fold an interaction outcome into the next save target (§14.5, §14.8). */
export function nextSaveTarget<T>(current: T | null, event: SaveTargetEvent<T>): T | null {
  switch (event.kind) {
    case 'imported':
    case 'saved':
      return event.folder;
    case 'failed':
    case 'cancelled':
      return current;
  }
}

/**
 * The referenced-asset paths a Save As… must copy alongside `scene.json`
 * (§14.5) — every `gltf` object's `src`, in scene order, each once. Only
 * *referenced* paths: unrelated files under the source's `assets/` are not
 * copied, so a Save As… also prunes.
 */
export function planAssetCopy(geometry: readonly GeometryObject[]): string[] {
  const srcs: string[] = [];
  for (const obj of geometry) {
    if (obj.kind === 'gltf' && !srcs.includes(obj.src)) srcs.push(obj.src);
  }
  return srcs;
}

/** What a completed save wrote, for the status line (§14.7). */
export interface LastSave {
  assetsCopied: number;
}

/**
 * The Scene panel's status line (§14.7). A silent Save closes no dialog, so a
 * successful write says so for `SAVED_STATUS_MS`; otherwise the line names the
 * folder Save would write to. Only the handle's leaf `name` is available through
 * the File System Access API — never a full path.
 */
export function describeSceneFileStatus(target: { name: string } | null, lastSave: LastSave | null): string {
  if (target == null) return 'No folder chosen — Save will ask where to write.';
  if (lastSave == null) return `Folder: ${target.name}`;
  if (lastSave.assetsCopied === 0) return `Saved to ${target.name}`;
  const assets = lastSave.assetsCopied === 1 ? '1 asset' : `${lastSave.assetsCopied} assets`;
  return `Saved to ${target.name} — ${assets} copied`;
}

/** What a picked destination folder already holds that a save would replace (§14.5). */
export interface DestinationClashes {
  sceneExists: boolean;
  assetClashes: number;
}

/**
 * Overwrite confirmation for a picked folder (§14.5), covering the `scene.json`
 * and the referenced assets a Save As… would replace. `null` when the
 * destination holds neither — nothing to warn about, so nothing is asked.
 */
export function describeOverwritePrompt(name: string, clashes: DestinationClashes): string | null {
  const { sceneExists, assetClashes } = clashes;
  const assets = assetClashes === 1 ? "1 of this scene's assets" : `${assetClashes} of this scene's assets`;
  if (sceneExists && assetClashes > 0) return `"${name}" already contains a scene.json and ${assets}. Replace them?`;
  if (sceneExists) return `"${name}" already contains a scene.json. Replace it?`;
  if (assetClashes > 0) {
    return `"${name}" already contains ${assets}. Replace ${assetClashes === 1 ? 'it' : 'them'}?`;
  }
  return null;
}

/**
 * A referenced asset that couldn't be copied to the destination (§14.8). The
 * save is abandoned before `scene.json` is written, so the destination is left
 * visibly incomplete rather than holding a scene file that can't import.
 */
export function describeAssetCopyFailure(src: string, reason: string): string {
  return `Couldn't copy "${src}": ${reason}. Nothing was saved.`;
}

/** Failure to write into the target folder, pointing at the way out (§14.8). */
export function describeSaveFailure(name: string, reason: string): string {
  return `Couldn't save to "${name}": ${reason}. Use Save As… to choose another folder.`;
}
