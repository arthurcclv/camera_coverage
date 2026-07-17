/**
 * Left-column hierarchy/detail split logic (spec §2.2).
 *
 * A draggable divider sets the object-detail panel's height in pixels; the
 * hierarchy panel takes the remaining column height. This module holds the pure
 * clamp + localStorage (de)serialization so it can be unit-tested without a
 * React/DOM harness (test/leftPanelSplit.test.ts). `null` means "no explicit
 * height chosen yet" — the detail panel uses its natural height until dragged.
 */

/** Minimum height (px) each side of the divider is allowed to shrink to. */
export const MIN_HIERARCHY_HEIGHT = 100;
export const MIN_DETAIL_HEIGHT = 100;
/** Divider handle thickness (px), reserved out of the column when splitting. */
export const DIVIDER_HEIGHT = 8;

/** localStorage key for the remembered detail-panel height. */
export const DETAIL_HEIGHT_STORAGE_KEY = 'camera-coverage.leftPanel.detailHeight';

/**
 * Clamp a proposed detail-panel height to what fits in a column of `columnHeight`
 * px while leaving the hierarchy at least its minimum. Returns `MIN_DETAIL_HEIGHT`
 * as a floor even when the column is too short to honor both minimums (the
 * hierarchy then scrolls), so the divider never collapses the detail panel to 0.
 */
export function clampDetailHeight(raw: number, columnHeight: number): number {
  const max = columnHeight - DIVIDER_HEIGHT - MIN_HIERARCHY_HEIGHT;
  const upper = Math.max(MIN_DETAIL_HEIGHT, max);
  return Math.min(upper, Math.max(MIN_DETAIL_HEIGHT, raw));
}

/**
 * Parse a stored detail-height string into a usable number, or `null` when
 * absent/blank/non-finite (falls back to the natural-height default).
 */
export function parseStoredDetailHeight(stored: string | null): number | null {
  if (stored == null || stored.trim() === '') return null;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Serialize a detail height for storage. `null` yields `null` (nothing to store). */
export function serializeDetailHeight(height: number | null): string | null {
  return height == null ? null : String(Math.round(height));
}
