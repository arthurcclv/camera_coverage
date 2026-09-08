/**
 * The Load dialog's file list as **decisions** rather than I/O (spec §14.4,
 * §14.7): which of a folder's entries are listed and in what order, what each
 * row says about its file, and which row the selection sits on.
 *
 * `sceneIO.listSceneFiles` does the reading and nothing else; every judgement it
 * would otherwise have made inline lives here, so the list is unit-testable with
 * plain strings and no File System Access API (`test/sceneFileList.test.ts`) —
 * the same split `sceneFile.ts` has from `sceneIO.ts` (see `ai/CONVENTIONS.md`).
 */
import { parseSceneFile } from './sceneFile.ts';
import { isSceneFileName, SCENE_FILE_PARSE_CAP, summarizeSceneFile } from './saveTarget.ts';

/** One row of the Load dialog's file list (spec §14.4, §14.7). */
export interface SceneFileEntry {
  name: string;
  /** `96 cams · 12 probes`, or `null` when the file was not parsed. */
  summary: string | null;
  /** Why the row is unselectable, or `null` when it can be loaded. */
  error: string | null;
}

/** A listed candidate, and whether its bytes are worth reading (spec §14.4). */
export interface PlannedSceneFile {
  name: string;
  /** `false` past `SCENE_FILE_PARSE_CAP` — that row lists name-only. */
  parse: boolean;
}

/**
 * Which of a folder's file names the Load dialog lists, in which order, and
 * which of them to read (spec §14.4).
 *
 * The order is stable and case-insensitive: the list is scanned by eye, so a
 * folder's variants must not reshuffle between openings. Everything past
 * `SCENE_FILE_PARSE_CAP` is listed unparsed and validates on selection, which
 * bounds the cost of opening the dialog on a folder someone dumped a pile of
 * JSON exports into.
 */
export function planSceneFileList(fileNames: readonly string[]): PlannedSceneFile[] {
  const candidates = fileNames.filter(isSceneFileName);
  candidates.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return candidates.map((name, i) => ({ name, parse: i < SCENE_FILE_PARSE_CAP }));
}

/**
 * What one row says about its file (spec §14.4) — a summary when it parses as a
 * scene, otherwise the reason it cannot be loaded. `null` text means the file
 * could not be read at all; a stray `package.json` lands here too, which is why
 * an invalid row is listed with its reason rather than being silently dropped.
 */
export function describeSceneFileRow(text: string | null): { summary: string | null; error: string | null } {
  if (text == null) return { summary: null, error: 'could not be read' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { summary: null, error: 'not valid JSON' };
  }
  const parsed = parseSceneFile(json);
  if (!parsed.ok) return { summary: null, error: parsed.error };
  return { summary: summarizeSceneFile(parsed.scene), error: null };
}

/**
 * Which row a freshly-listed folder opens with (spec §14.7): `preferred` when it
 * is there and loadable — the target's own file, when this is the target's
 * folder — otherwise the first loadable row, so the commit key always has a
 * subject. `null` when nothing in the folder can be loaded.
 */
export function nextListSelection(entries: readonly SceneFileEntry[], preferred: string | null): string | null {
  const keep = entries.find((e) => e.name === preferred && e.error == null);
  return (keep ?? entries.find((e) => e.error == null))?.name ?? null;
}

/**
 * Where ArrowUp/ArrowDown moves the selection (spec §14.7). Walks the
 * **loadable** names only — an unselectable row is listed to explain its absence,
 * not to be stopped on — and clamps at both ends rather than wrapping, so
 * holding a key cannot cycle past the file you were aiming for. A selection that
 * is not in the list (nothing selected yet) lands on the first row.
 */
export function moveListSelection(
  loadableNames: readonly string[],
  selected: string | null,
  step: -1 | 1,
): string | null {
  if (loadableNames.length === 0) return null;
  const at = selected == null ? -1 : loadableNames.indexOf(selected);
  if (at < 0) return loadableNames[0];
  return loadableNames[Math.min(loadableNames.length - 1, Math.max(0, at + step))];
}
