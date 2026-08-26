/**
 * Colour conversion for the background control (spec §10.3).
 *
 * The declarative `<Camera clearColor>` prop is typed as a CSS string (the React
 * layer maps engine `Color` props to strings), while the export rig sets a real
 * `Color` imperatively — so the canonical state is a 0..1 RGBA tuple and both
 * consumers convert from it.
 */

export type Rgba = [number, number, number, number];

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** `#rrggbb` → a 0..1 RGB triple. Alpha is not carried by the hex form. */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** A 0..1 RGBA tuple → `#rrggbb`, dropping alpha. */
export function rgbToHex([r, g, b]: Rgba): string {
  const to = (n: number) =>
    Math.round(clamp01(n) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
