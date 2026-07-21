/**
 * Viewport click-to-select decision logic (spec §5.2).
 *
 * A plain DOM `click` also fires at the end of a camera-orbit or
 * TransformControls drag, which must not change the selection. This module is
 * the single source of truth for distinguishing a genuine click from a
 * drag-tail click and for the resulting selection, kept pure so it can be
 * unit-tested without a React/DOM harness (test/viewportSelection.test.ts).
 *
 * Selection is unified across cameras, probes, sections, zones, and volumes
 * (spec §5.5, §12.4, §13.8; `sampling_volumes.md` §4.1): a single value picks out
 * one entity, so selecting one deselects the others. Sections and zones are only
 * ever reachable via `hit` from the hierarchy (their bodies aren't pickable);
 * cameras, probes, and volumes are also pickable in the viewport. This module
 * doesn't care which caller produced `hit`, it just applies the click-vs-drag
 * decision.
 */

/** The unified selection: one entity across every type, or nothing (spec §5.5). */
export type Selection = { kind: 'camera' | 'probe' | 'section' | 'zone' | 'volume'; id: string } | null;

/** Screen-space pointer position in CSS pixels. */
export interface PointerPos {
  x: number;
  y: number;
}

/** Max pointer travel (px) between press and release still counted as a click. */
export const DRAG_THRESHOLD_PX = 5;

/** True when the pointer barely moved — a genuine click, not the tail of a drag. */
export function isClick(down: PointerPos, up: PointerPos, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= threshold;
}

/**
 * Selection after a viewport click (spec §5.2). A drag-tail click leaves the
 * current selection unchanged; a genuine click selects the picked gizmo's entity
 * (`hit`) or, on a miss (`null`), deselects.
 */
export function selectionAfterClick(
  current: Selection,
  hit: Selection,
  down: PointerPos,
  up: PointerPos,
  threshold = DRAG_THRESHOLD_PX,
): Selection {
  if (!isClick(down, up, threshold)) return current;
  return hit;
}
