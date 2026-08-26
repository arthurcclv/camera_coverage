/**
 * Loading a picked splat file into a PlayCanvas `gsplat` Asset (spec §4).
 *
 * Impure: owns blob URLs and the asset registry. Kept thin so the decision logic
 * (which files are accepted, which siblings a SOG bundle needs) stays testable.
 */
import { Asset, type AppBase } from 'playcanvas';

/** Extensions the engine's `gsplat` asset type handles (§4). */
export const ACCEPTED_EXTENSIONS = ['.ply', '.sog', '.compressed.ply', '.meta.json'] as const;

/** The `accept` attribute for the file input. */
export const ACCEPT_ATTRIBUTE = '.ply,.sog,.json,.webp';

/**
 * The recognized extension of a filename, longest-match first so
 * `.compressed.ply` and `.meta.json` win over `.ply` / `.json` (§4).
 */
export function splatExtensionOf(filename: string): string | null {
  const lower = filename.toLowerCase();
  const byLength = [...ACCEPTED_EXTENSIONS].sort((a, b) => b.length - a.length);
  return byLength.find((ext) => lower.endsWith(ext)) ?? null;
}

/** Whether a picked file is the splat entry point (as opposed to a SOG sibling payload). */
export function isSplatEntry(filename: string): boolean {
  return splatExtensionOf(filename) !== null;
}

export interface LoadedSplat {
  asset: Asset;
  filename: string;
  byteSize: number;
  /** Releases the asset and every blob URL it referenced. */
  dispose: () => void;
}

export interface LoadProgress {
  loaded: number;
  total: number;
}

/**
 * A SOG bundle's `meta.json` references sibling `.webp` payloads by relative path,
 * which a single blob URL cannot resolve (§4). Registering each sibling under its
 * relative name lets the engine's loader find them.
 */
function buildUrlMap(files: readonly File[]): { urls: Map<string, string>; release: () => void } {
  const urls = new Map<string, string>();
  for (const file of files) {
    // `webkitRelativePath` is set for directory picks; fall back to the bare name.
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    urls.set(rel, URL.createObjectURL(file));
    // Also key by bare filename so a `meta.json` referencing `means_l.webp`
    // resolves whether or not the pick carried directory paths.
    if (!urls.has(file.name)) urls.set(file.name, URL.createObjectURL(file));
  }
  return {
    urls,
    release: () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

export type LoadSplatResult = { ok: true; splat: LoadedSplat } | { ok: false; error: string };

/**
 * Loads a picked file set as a `gsplat` asset (§4).
 *
 * The entry file is identified by extension; any remaining files are treated as
 * sibling payloads for a SOG bundle. A blob URL carries no filename, so the asset is
 * constructed with the **original filename** so the engine picks the parser from the
 * extension rather than guessing from the URL.
 */
export async function loadSplat(
  app: AppBase,
  files: readonly File[],
  onProgress?: (p: LoadProgress) => void,
): Promise<LoadSplatResult> {
  const entry = files.find((f) => isSplatEntry(f.name));
  if (!entry) {
    return {
      ok: false,
      error: `No splat file in the selection. Expected one of: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
    };
  }

  const { urls, release } = buildUrlMap(files);
  const entryRel = (entry as File & { webkitRelativePath?: string }).webkitRelativePath || entry.name;
  const entryUrl = urls.get(entryRel) ?? urls.get(entry.name);
  if (!entryUrl) {
    release();
    return { ok: false, error: `Could not create a URL for ${entry.name}.` };
  }

  // The resource loader derives the parser-selecting extension from
  // `asset.file.filename` (falling back to the URL), so the real filename must be
  // supplied — a blob URL has no extension of its own (§4).
  const asset = new Asset(entry.name, 'gsplat', { url: entryUrl, filename: entry.name });

  // A SOG bundle resolves its sibling `.webp` payloads through `options.mapUrl`,
  // falling back to resolving them relative to the meta URL — which a blob URL
  // cannot support. Mapping each name to its blob URL is what makes the bundle
  // load (§4). Note `asset.data` must stay unset: the SOG parser treats a present
  // `data` as an already-fetched meta and would skip loading it.
  asset.options = {
    mapUrl: (filename: string) => urls.get(filename) ?? filename,
  };

  const cleanup = () => {
    app.assets.remove(asset);
    asset.unload();
    release();
  };

  const progressHandler = (loaded: number, total: number) => onProgress?.({ loaded, total });
  asset.on('progress', progressHandler);

  app.assets.add(asset);

  try {
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve());
      asset.once('error', (err: unknown) => reject(new Error(String(err))));
      app.assets.load(asset);
    });
  } catch (err) {
    cleanup();
    const message = err instanceof Error ? err.message : String(err);
    // A SOG bundle whose siblings are absent fails here; name what was picked so
    // the user can see what is missing (§11).
    const picked = files.map((f) => f.name).join(', ');
    return {
      ok: false,
      error:
        `Failed to load ${entry.name}: ${message}` +
        (entry.name.toLowerCase().endsWith('.meta.json')
          ? `. A SOG bundle needs its sibling .webp files selected too — picked: ${picked}.`
          : ''),
    };
  } finally {
    asset.off('progress', progressHandler);
  }

  return {
    ok: true,
    splat: { asset, filename: entry.name, byteSize: entry.size, dispose: cleanup },
  };
}
