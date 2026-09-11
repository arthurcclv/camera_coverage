/**
 * The pure half of the camera name labels (spec §5.3): the label's type metrics
 * and its ellipsis rule.
 *
 * Kept apart from `cameraLabels.ts` because that module needs a 2D canvas and this
 * one does not — the truncation rule is the part worth pinning with tests, and the
 * suite runs in bare `node --test` with no DOM (CONVENTIONS.md).
 */

/** Label type, matching the UI's badge treatment (VISUAL_DESIGN.md). */
export const LABEL_FONT_PX = 11;
export const LABEL_FONT_WEIGHT = 600;
export const LABEL_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** The CSS `font` shorthand the rasteriser sets on its 2D context. */
export const LABEL_FONT = `${LABEL_FONT_WEIGHT} ${LABEL_FONT_PX}px ${LABEL_FONT_FAMILY}`;

/**
 * The transparent margin around the glyphs, the outline's line width, and the line box —
 * all in CSS pixels.
 *
 * The margin exists so the outline is never clipped at the texture's edge (§5.3): with no
 * plate behind it, the widest thing the label draws is the stroke around the tallest
 * ascender. Canvas strokes straddle the path, so {@link LABEL_STROKE_PX} of line width
 * puts half that much *outside* the glyph — 2 px for the 4 px the spec's "2 px outline"
 * asks for.
 */
export const LABEL_PAD_X = 4;
export const LABEL_PAD_Y = 4;
export const LABEL_STROKE_PX = 4;
export const LABEL_LINE_PX = 14;

/**
 * Gap between the camera body's drawn edge and the label's **first glyph**, in CSS
 * pixels (§5.3).
 *
 * To the glyph, not to the quad: {@link LABEL_PAD_X} of the texture is transparent
 * margin for the outline, so a gap measured to the quad's edge would read that much
 * wider on screen than this number claims. {@link LABEL_QUAD_OFFSET_PX} is what the
 * shader is handed.
 */
export const LABEL_OFFSET_PX = 4;

/**
 * Widest a label may draw, in CSS pixels (§5.3). Names are free text, and one long
 * name would otherwise stripe the viewport end to end — at ~100 cameras a few of them
 * would be the view. The full name stays in the camera panel.
 */
export const LABEL_MAX_TEXT_PX = 140;

/** Measures a string in the label font. `CanvasRenderingContext2D.measureText`, or a stub. */
export type MeasureText = (text: string) => number;

const ELLIPSIS = '…';

/**
 * `text`, shortened with an ellipsis until it measures at most `maxPx` (§5.3) —
 * {@link LABEL_MAX_TEXT_PX} for a label, passed rather than defaulted so the limit is
 * visible at the call site.
 *
 * Returns the **ellipsis alone** when not even one character fits, and never an empty
 * string: a label that measures nothing still marks *that there is a name*, which a
 * blank label would not (§5.3). Characters are dropped one at a time from the end rather
 * than by a width ratio, because the font is proportional and a ratio overshoots on
 * names that are mostly narrow glyphs.
 */
export function ellipsise(text: string, measure: MeasureText, maxPx: number): string {
  if (measure(text) <= maxPx) return text;
  const chars = [...text];
  for (let keep = chars.length - 1; keep > 0; keep--) {
    const candidate = chars.slice(0, keep).join('') + ELLIPSIS;
    if (measure(candidate) <= maxPx) return candidate;
  }
  return ELLIPSIS;
}

/** The label's size in CSS pixels for text measuring `textPx` wide, margin included. */
export function labelBoxPx(textPx: number): { width: number; height: number } {
  return { width: textPx + 2 * LABEL_PAD_X, height: LABEL_LINE_PX + 2 * LABEL_PAD_Y };
}

/**
 * The offset to push the label's **quad** out by, in CSS pixels: {@link
 * LABEL_OFFSET_PX} less the transparent margin the quad carries on its left, so the
 * gap that lands on screen is the one §5.3 specifies. Negative if the margin ever
 * exceeds the gap, which is correct — the quad overlaps the body, the glyphs do not.
 */
export const LABEL_QUAD_OFFSET_PX = LABEL_OFFSET_PX - LABEL_PAD_X;
