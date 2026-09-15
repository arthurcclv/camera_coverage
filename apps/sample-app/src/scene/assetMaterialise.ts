/**
 * What a save must do to the target's `assets/` before it writes the scene file
 * (`asset_import.md` §8), as a **pure function of a listing** — which pending
 * assets are already on disk, which folders would be created, which would be
 * replaced, and which of those replacements must be refused outright.
 *
 * The plan is computed whole and asserted whole, with the writes left thin
 * (`ai/CONVENTIONS.md`). That is what lets the guardrails on §8.5's folder
 * replace — the one irreversible operation in this app, on a path derived from a
 * picked file's basename — be *tested* rather than reviewed.
 */
import { importFolderName, ASSET_DIR } from './assetImport.ts';
import { isSafeAssetPath } from './sceneFile.ts';
import { assetFiles, type PendingAssets } from './pendingAssets.ts';
import type { Message } from './saveTarget.ts';
import type { Scene } from './sceneModel.ts';

/** One pending asset, reduced to the paths its bytes would occupy (§8.7). */
export interface PendingPaths {
  /** The store key, and the `src` its row carries today. */
  src: string;
  /**
   * Every folder-relative path this asset writes — the asset itself first, then
   * each dependency at the path the model spells out (§5.1).
   */
  paths: readonly string[];
}

/** One folder's worth of writing (§8.7 step 6). */
export interface PlannedWrite extends PendingPaths {
  /** `assets/<name>` — created if absent, emptied first when `replaces` (§8.5). */
  folder: string;
  /** Whether a directory of that name already exists and would be replaced. */
  replaces: boolean;
}

/**
 * The plan, or the reason the save must abort before touching anything (§8.6).
 *
 * The reason is an **i18n key** with its params, never English — this module is
 * pure and composes user-facing text, so the message is data and `App.tsx`
 * resolves it (`spec.md` §18.4, `ai/CONVENTIONS.md`).
 */
export type MaterialisePlan =
  | { ok: false; reason: Message }
  | {
      ok: true;
      /** Folders to write, in order; each emptied immediately before its own files. */
      writes: readonly PlannedWrite[];
      /** `src` rewrites from the dedupe — old → the path the file actually lives at (§8.3). */
      rewrites: ReadonlyMap<string, string>;
      /** The `assets/<name>` folders this save would replace — what the confirmation names (§8.4). */
      replaced: readonly string[];
    };

/** One direct child of the target's `assets/`, as a listing reports it. */
export interface AssetDirEntry {
  name: string;
  kind: 'file' | 'directory';
}

export interface MaterialiseInput {
  /** The pending assets and the paths they would write. */
  pending: readonly PendingPaths[];
  /**
   * Which pending `src`s the `isSameEntry` walk matched, mapped to the
   * folder-relative path the matched file actually lives at (§8.3). A match
   * writes nothing.
   */
  deduped: ReadonlyMap<string, string>;
  /** Direct children of `<target>/assets/`; empty when the folder does not exist. */
  assetDir: readonly AssetDirEntry[];
  /** Every `src` the scene being saved references — meshes and captures alike. */
  sceneSrcs: readonly string[];
}

/**
 * Plan the materialisation (`asset_import.md` §8.3–§8.6).
 *
 * Order matters and is the spec's: **dedupe first**, because a pending asset
 * that turns out to already be on disk writes nothing and therefore cannot
 * collide with anything; only what survives that is checked for collisions and
 * guardrails.
 *
 * Every refusal here aborts the save **before** anything is written or removed,
 * and before the overwrite confirmation is raised — so the user is never asked
 * to confirm something that will then be refused.
 */
export function planMaterialisation(input: MaterialiseInput): MaterialisePlan {
  const rewrites = new Map<string, string>();
  const writes: PlannedWrite[] = [];
  const replaced: string[] = [];
  const byName = new Map(input.assetDir.map((e) => [e.name, e] as const));

  for (const entry of input.pending) {
    // §8.3 — the file is already in this folder. Nothing is written, and the row
    // points at where it actually lives. A matched **multi-file** model resolves
    // its siblings from the on-disk copy, so its pending dependencies are
    // discarded with it: a sibling genuinely absent there is reported by the
    // row, not papered over by a copy.
    const matched = input.deduped.get(entry.src);
    if (matched != null) {
      if (matched !== entry.src) rewrites.set(entry.src, matched);
      continue;
    }

    const name = importFolderName(entry.src);
    // Unreachable through the import (`importSrc` builds the shape), so this is
    // the guard that keeps a hand-forced `src` from reaching a removal.
    if (name == null || !isSafeAssetPath(`${ASSET_DIR}/${name}`)) {
      return { ok: false, reason: { key: 'materialiseNotImportPath', params: { src: entry.src } } };
    }
    const folder = `${ASSET_DIR}/${name}`;

    const existing = byName.get(name);
    if (existing?.kind === 'file') {
      return { ok: false, reason: { key: 'materialiseFolderIsFile', params: { folder } } };
    }
    const replaces = existing?.kind === 'directory';

    // §8.6 — replacing this folder would delete an asset the scene being saved
    // still references. No confirmation dialog should be able to authorise that,
    // so it is refused here rather than offered.
    if (replaces) {
      const trapped = input.sceneSrcs.find((src) => src !== entry.src && src.startsWith(`${folder}/`));
      if (trapped != null) {
        return { ok: false, reason: { key: 'materialiseFolderInUse', params: { folder, src: trapped } } };
      }
      replaced.push(folder);
    }
    writes.push({ ...entry, folder, replaces });
  }

  return { ok: true, writes, rewrites, replaced };
}

/**
 * Each pending asset's paths, in write order: the asset itself, then every
 * dependency at the path its model spells out (§5.1). Derived from the store so
 * the plan never has to hold `File`s.
 */
export function pendingPaths(pending: PendingAssets): PendingPaths[] {
  const out: PendingPaths[] = [];
  for (const [src, asset] of pending) out.push({ src, paths: assetFiles(src, asset).map(([path]) => path) });
  return out;
}

/**
 * Apply a plan's `src` rewrites to one row's `src` (§8.3) — the single place the
 * mapping is read, so the scene, the pending store and the parse cache are all
 * re-pointed the same way.
 */
export function rewriteSrc(rewrites: ReadonlyMap<string, string>, src: string): string {
  return rewrites.get(src) ?? src;
}

/**
 * The scene with every rewritten `src` applied (§8.3) — what is serialized to
 * disk, so the file and the rows agree without waiting on a re-render.
 *
 * The `rewriteAssetSrcs` reducer action applies the same mapping to state
 * through this very function, so there is one definition of "this row moved" and
 * the file on disk cannot disagree with the rows on screen. Generic over the
 * carrier for that reason: the reducer's state is a `Scene` plus everything the
 * UI hangs off it, and only the two asset-bearing arrays are touched.
 */
export function withRewrittenSrcs<T extends Pick<Scene, 'geometry' | 'splats'>>(
  scene: T,
  rewrites: ReadonlyMap<string, string>,
): T {
  if (rewrites.size === 0) return scene;
  return {
    ...scene,
    geometry: scene.geometry.map((o) => (o.kind === 'mesh' ? { ...o, src: rewriteSrc(rewrites, o.src) } : o)),
    splats: scene.splats.map((sp) => ({ ...sp, src: rewriteSrc(rewrites, sp.src) })),
  };
}
