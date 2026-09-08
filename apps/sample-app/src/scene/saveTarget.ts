/**
 * Save-target logic for the scene file (spec §14.5, §14.7) — which file a Save
 * writes to, what a name may be, and what a save or load would replace.
 *
 * The target is the **pair** `{ folder, name }` the current scene is associated
 * with (§14.5): a successful import sets it, a successful Save As… retargets it,
 * and a failure leaves it alone. Save therefore round-trips back to the file the
 * scene was *opened* from rather than to whichever file happened to be saved to
 * last — and because a folder holds any number of scene files sharing one
 * `assets/` (§14.2), the name is the half that distinguishes a variant.
 *
 * Pure and generic over the handle type (only `.name` is ever read), so the
 * decisions are unit-testable with plain objects and no File System Access API
 * (`test/saveTarget.test.ts`); the impure handle juggling stays in `App.tsx` and
 * the dialogs, and the reads/writes in `sceneIO.ts` (see `ai/CONVENTIONS.md`).
 */
import type { GeometryObject } from './geometryModel.ts';

/** How long the transient "Saved <file>" status stays up (§14.7). */
export const SAVED_STATUS_MS = 2000;

/** Stable picker id, so this app keeps its own remembered-directory bucket (§14.5). */
export const SCENE_PICKER_ID = 'camera-coverage-scene-folder';

/** The name a first save proposes — a convention, never a requirement (§14.2). */
export const DEFAULT_SCENE_FILE_NAME = 'scene.json';

/**
 * How many of a folder's `*.json` the Load dialog parses for its summaries
 * (§14.4). Beyond this the rows list name-only and validate on selection —
 * insurance against a folder someone dumped a pile of JSON exports into, not a
 * limit anyone authoring scenes should ever meet.
 */
export const SCENE_FILE_PARSE_CAP = 200;

/** The extension every scene file carries, so the Load dialog can find it (§14.2). */
const SCENE_FILE_EXT = '.json';

/** Which file, in which folder, a plain Save writes to (§14.5). */
export interface SaveTarget<T> {
  folder: T;
  name: string;
}

/** Which button was pressed: plain **Save** or **Save As…** (§14.5). */
export type SaveIntent = 'save' | 'saveAs';

/**
 * What a save should do. Only a plain Save with a target writes straight
 * through; everything else routes via the **Save scene as** dialog, which is
 * also the no-target Save fallback — one code path, so a scene built from
 * scratch gets named like any other (§14.5).
 */
export type SaveAction = { kind: 'write' } | { kind: 'dialog' };

/** Resolve a Save/Save As… press against the current target (§14.5). */
export function resolveSaveAction(hasTarget: boolean, intent: SaveIntent): SaveAction {
  if (intent === 'save' && hasTarget) return { kind: 'write' };
  return { kind: 'dialog' };
}

/**
 * Outcome of a scene-file interaction, as it bears on the target: a completed
 * import or write adopts its folder *and* name; anything else (failed write,
 * denied permission, missing folder, cancelled picker or dialog) keeps the
 * current target so the user can retry or redirect with Save As… (§14.8).
 */
export type SaveTargetEvent<T> =
  | { kind: 'imported'; folder: T; name: string }
  | { kind: 'saved'; folder: T; name: string }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

/** Fold an interaction outcome into the next save target (§14.5, §14.8). */
export function nextSaveTarget<T>(current: SaveTarget<T> | null, event: SaveTargetEvent<T>): SaveTarget<T> | null {
  switch (event.kind) {
    case 'imported':
    case 'saved':
      return { folder: event.folder, name: event.name };
    case 'failed':
    case 'cancelled':
      return current;
  }
}

/** A name the user typed, normalized (§14.5), or the rule it broke. */
export type SceneFileName = { ok: true; name: string } | { ok: false; error: string };

/**
 * Characters no portable filename may carry. Scene folders travel between
 * machines, and `/` or `\` would silently mean a *subfolder* — which §14.2 does
 * not allow, since a scene one level down could not reach `assets/`.
 */
const FORBIDDEN_NAME_CHARS = /[/\\:*?"<>|]/;

/**
 * Normalize a typed scene-file name (§14.5): trimmed, with `.json` appended
 * unless it already ends that way. The extension is not optional the way it
 * looks — the Load dialog lists `*.json` (§14.4), so a name saved under any
 * other extension would write a file the app could never find again.
 */
export function normalizeSceneFileName(raw: string): SceneFileName {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a file name.' };
  if (FORBIDDEN_NAME_CHARS.test(trimmed)) {
    return { ok: false, error: 'A file name cannot contain / \\ : * ? " < > |' };
  }
  // A leading dot hides the file on Unix and would make `.json` itself a legal
  // name — an extension with nothing in front of it.
  if (trimmed.startsWith('.')) return { ok: false, error: 'A file name cannot start with a dot.' };
  const name = trimmed.toLowerCase().endsWith(SCENE_FILE_EXT) ? trimmed : `${trimmed}${SCENE_FILE_EXT}`;
  return { ok: true, name };
}

/** Whether a folder entry is a scene-file candidate the Load dialog should list (§14.2, §14.4). */
export function isSceneFileName(name: string): boolean {
  return name.toLowerCase().endsWith(SCENE_FILE_EXT) && !name.startsWith('.');
}

/**
 * The one-line summary under a file's name in the Load dialog (§14.4, §14.7).
 * Cameras and probes always, since those are what a variant differs in;
 * sections only when there are any, so the common case stays one short line.
 */
export function summarizeSceneFile(scene: {
  cameras: readonly unknown[];
  probes: readonly unknown[];
  sections: readonly unknown[];
}): string {
  const parts = [count(scene.cameras.length, 'cam'), count(scene.probes.length, 'probe')];
  if (scene.sections.length > 0) parts.push(count(scene.sections.length, 'section'));
  return parts.join(' · ');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The referenced-asset paths a cross-folder Save As… must copy alongside the
 * scene file (§14.5) — every `gltf` object's `src`, in scene order, each once.
 * Only *referenced* paths: unrelated files under the source's `assets/` are not
 * copied, so a cross-folder Save As… also prunes.
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
 * file Save would write to.
 *
 * Idle it composes `<folder>/<file>`, because two folders granted in one session
 * can both hold a `scene.json` and the name alone would not say which one Save
 * means. The `/` is **display only** — the File System Access API exposes each
 * handle's leaf `name` and never a real path.
 */
export function describeSceneFileStatus(
  target: SaveTarget<{ name: string }> | null,
  lastSave: LastSave | null,
): string {
  if (target == null) return 'No file chosen — Save will ask where to write.';
  if (lastSave == null) return `${target.folder.name}/${target.name}`;
  // The folder only changes on a cross-folder Save As…, which is also the only
  // save that copies — so the copy count is what earns the longer line.
  if (lastSave.assetsCopied === 0) return `Saved ${target.name}`;
  const assets = count(lastSave.assetsCopied, 'asset');
  return `Saved to ${target.folder.name}/${target.name} — ${assets} copied`;
}

/** What a picked destination already holds that this save would replace (§14.5). */
export interface DestinationClashes {
  fileExists: boolean;
  assetClashes: number;
}

/**
 * The Save-as dialog's inline replace warning (§14.5), covering the scene file
 * and the referenced assets the save would overwrite. `null` when the
 * destination holds neither — nothing to warn about, so nothing is said, and the
 * commit button stays **Save** rather than **Replace**.
 */
export function describeReplaceWarning(name: string, clashes: DestinationClashes): string | null {
  const { fileExists, assetClashes } = clashes;
  // Partitive, so the count leads and the noun stays plural: "1 of this
  // scene's assets" reads correctly and needs no singular branch.
  const assets = `${assetClashes} of this scene's assets`;
  if (fileExists && assetClashes > 0) return `Replaces "${name}" and ${assets}.`;
  if (fileExists) return `Replaces "${name}".`;
  if (assetClashes > 0) return `Replaces ${assets}.`;
  return null;
}

/**
 * What a settled `{ folder, name }` commit should do (§14.5). A write that would
 * replace an existing file is confirmed first; one that creates a file writes
 * straight through, since there is nothing to destroy and asking would train the
 * click away.
 */
export type WriteAction = { kind: 'confirm' } | { kind: 'write' };

/**
 * Route a commit against what the destination already holds (§14.5). Both write
 * paths come through here — a plain Save onto its target and a Save As… commit —
 * so the two cannot drift into asking different questions about the same act.
 *
 * Only the **scene file** decides. Replacing referenced assets is reported *in*
 * the confirmation, but never raises one on its own: a cross-folder Save As…
 * under a fresh name is a creation, and the assets it copies alongside are part
 * of making the destination whole rather than something the user is losing.
 */
export function resolveWriteAction(clashes: DestinationClashes): WriteAction {
  return clashes.fileExists ? { kind: 'confirm' } : { kind: 'write' };
}

/**
 * The overwrite confirmation's body, one line per paragraph (§14.5, §14.7).
 *
 * Composes `<folder>/<file>` for the same reason the status line does: two
 * folders granted in one session can both hold a `scene.json`, and the name
 * alone would not say which file is about to be destroyed. The asset line only
 * appears for a cross-folder save, which is the only save that copies.
 */
export function describeOverwriteConfirm(
  target: SaveTarget<{ name: string }>,
  clashes: DestinationClashes,
): string[] {
  const lines = [`${target.folder.name}/${target.name} already exists. Saving replaces it.`];
  // Partitive, like the inline warning: the count leads and the noun stays
  // plural, so "1 of this scene's assets" needs no singular branch.
  if (clashes.assetClashes > 0) {
    lines.push(`Also replaces ${clashes.assetClashes} of this scene's assets in that folder.`);
  }
  return lines;
}

/**
 * The Load dialog's unsaved-changes warning (§14.4, §14.7). Named when the scene
 * came from a file, so it is clear *which* work is at stake; anonymous for a
 * scene built from the boot state, which has no name yet.
 */
export function describeUnsavedWarning(name: string | null): string {
  const subject = name == null ? 'This scene has' : `"${name}" has`;
  return `${subject} unsaved changes — loading discards them.`;
}

/**
 * A referenced asset that couldn't be copied to the destination (§14.8). The
 * save is abandoned before the scene file is written, so the destination is left
 * visibly incomplete rather than holding a scene file that can't import.
 */
export function describeAssetCopyFailure(src: string, reason: string): string {
  return `Couldn't copy "${src}": ${reason}. Nothing was saved.`;
}

/** Failure to write the target file, pointing at the way out (§14.8). */
export function describeSaveFailure(name: string, reason: string): string {
  return `Couldn't save "${name}": ${reason}. Use Save As… to choose another folder.`;
}
