/**
 * Routing a `.ply` by its **header** (`asset_import.md` §4.2).
 *
 * `.ply` is a legal member of both accepted-extension lists: a **mesh** PLY
 * holds triangles the coverage engine measures against, a **splat** PLY holds
 * Gaussians it cannot intersect. They share an extension and are different
 * files entirely, so the import entry the user chose is checked against what the
 * file actually is, and a mismatch is refused naming the other entry.
 *
 * They are distinguishable from the header alone — plain ASCII at the head of
 * every PLY, binary variants included, terminated by `end_header`.
 *
 * A **pure function over the header text**, so it is unit-tested against
 * fixtures with no file system involved (`ai/CONVENTIONS.md`): `sceneIO` reads
 * the first {@link PLY_SNIFF_BYTES} and hands the text over.
 */

/** What a PLY header says the file is (`asset_import.md` §4.2). */
export type PlyKind =
  /** Declares `element face` — triangles. */
  | 'mesh'
  /** Declares Gaussian per-vertex properties — a 3DGS capture. */
  | 'splat'
  /** Vertices, but neither faces nor Gaussians — a bare point cloud. */
  | 'points'
  /** Not a PLY, or a header that has not ended within the sniff window. */
  | 'unreadable';

/**
 * How many leading bytes are read to classify a PLY (`asset_import.md` §4.2).
 *
 * 4 KB is comfortably past `end_header` in every real file; a header that has
 * not ended by then reports `unreadable` rather than reading further, which is
 * what keeps the sniff a bounded read rather than a parse.
 */
export const PLY_SNIFF_BYTES = 4096;

/**
 * The per-vertex properties that mark a PLY as a Gaussian capture rather than a
 * mesh. Matched as whole property names, so a mesh property merely *containing*
 * one of these substrings cannot be mistaken for a capture.
 */
const GAUSSIAN_PROPERTIES = ['f_dc_0', 'scale_0', 'rot_0', 'opacity'];

/**
 * Classify a PLY from the leading text of its file (`asset_import.md` §4.2).
 *
 * Gaussian properties are checked **before** `element face`: the table in §4.2
 * qualifies the mesh row with "no Gaussian properties" and leaves the splat row
 * unqualified, so a file declaring both is a capture.
 *
 * `element face` is taken at face value with no count check. A `element face 0`
 * is a mesh that happens to hold nothing, and §4.3's zero-triangle refusal
 * catches it at parse — where it can say *"no faces — nothing to occlude"* about
 * the geometry rather than guessing from a header.
 */
export function classifyPlyHeader(head: string): PlyKind {
  const lines = headerLines(head);
  if (lines == null) return 'unreadable';
  let hasFace = false;
  for (const line of lines) {
    const words = line.split(/\s+/);
    if (words[0] === 'property' && GAUSSIAN_PROPERTIES.includes(words[words.length - 1])) return 'splat';
    if (words[0] === 'element' && words[1] === 'face') hasFace = true;
  }
  return hasFace ? 'mesh' : 'points';
}

/**
 * The header's lines, or `null` when this is not a readable PLY header — no
 * `ply` magic, or no `end_header` within the text handed over.
 *
 * Tolerates CRLF (PLY files authored on Windows are common) and a leading BOM,
 * which some exporters emit despite the format being magic-first.
 */
function headerLines(head: string): string[] | null {
  const text = head.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== 'ply') return null;
  const end = lines.findIndex((l) => l.trim() === 'end_header');
  if (end < 0) return null;
  return lines.slice(1, end).map((l) => l.trim());
}
