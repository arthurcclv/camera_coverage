/**
 * The armed polyline draw mode and the vertex-editing rules (`camera_placement.md`
 * §6.1, §6.2).
 *
 * A **repeating** variant of "Place on surface" (`spec.md` §2.4.2): it reuses
 * that tool's every rule — the detached gizmo, the crosshair, the suspended pick
 * and deselect, the surviving orbit/pan/zoom, the click-vs-drag threshold, and
 * the geometry-only hit test with clipped hits discarded — and differs only in
 * that it **appends** rather than assigns and is not one-shot.
 *
 * Pure: the draft is data and every transition is a function of it, so the
 * commit rule is unit-tested without a viewport. The viewport supplies world
 * points; App holds the draft in state and renders it.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import type { ConstraintKind } from '../placement/region.ts';
import { isClick, type PointerPos } from './viewportSelection.ts';

/** An in-progress polyline: the committed vertices, and the hovered cursor. */
export interface PolylineDraft {
  points: Vec3[];
  /** The last hovered surface point, for the rubber-band segment (§6.2). */
  cursor: Vec3 | null;
}

export const EMPTY_DRAFT: PolylineDraft = { points: [], cursor: null };

/** Append a clicked surface point (§6.2). */
export function appendVertex(draft: PolylineDraft, point: Vec3): PolylineDraft {
  return { ...draft, points: [...draft.points, [...point] as Vec3] };
}

/** Backspace: drop the last vertex; a no-op on an empty draft (§6.2). */
export function removeLastVertex(draft: PolylineDraft): PolylineDraft {
  return draft.points.length === 0 ? draft : { ...draft, points: draft.points.slice(0, -1) };
}

/** Track the hovered surface point so the rubber band follows the cursor. */
export function moveCursor(draft: PolylineDraft, point: Vec3 | null): PolylineDraft {
  return { ...draft, cursor: point === null ? null : ([...point] as Vec3) };
}

/** The vertices to draw: the committed ones plus the rubber-band cursor (§6.2). */
export function draftPolyline(draft: PolylineDraft): Vec3[] {
  return draft.cursor && draft.points.length > 0 ? [...draft.points, draft.cursor] : draft.points;
}

/**
 * The draft a **double-click** commits (§6.2): the vertex its own first click
 * appended, taken back out.
 *
 * Ending the line is the gesture, so the double-click contributes no vertex —
 * the polyline ends at the last single-clicked vertex. `Enter` commits the draft
 * as drawn instead, having added no click to take back. Named rather than
 * inlined because it is the rule, not plumbing: appending both clicks of the
 * pair would leave a zero-length final segment behind.
 */
export function draftAfterDoubleClick(draft: PolylineDraft): PolylineDraft {
  return removeLastVertex(draft);
}

/**
 * What committing this draft should create (§6.2).
 *
 * A single vertex becomes a **point** constraint — that is what the user drew,
 * and it beats both refusing the commit and creating a degenerate polyline the
 * region test would then have to special-case. Nothing at all commits to `null`.
 */
export function commitDraft(draft: PolylineDraft): { kind: ConstraintKind; points: Vec3[] } | null {
  if (draft.points.length === 0) return null;
  if (draft.points.length === 1) return { kind: 'point', points: draft.points };
  return { kind: 'polyline', points: draft.points };
}

/** What one viewport click does while the draw mode is armed (§6.2). */
export type DrawClickAction = 'append' | 'commit' | 'ignore';

/**
 * The decision a draw-mode click resolves to (§6.2), kept pure so the rule is
 * tested without a viewport — the same split the selection pick uses.
 *
 * `detail` is the DOM click event's own streak counter. The **second** click of a
 * double-click commits and does not append; the vertex its *partner* appended is
 * dropped by {@link draftAfterDoubleClick}, so the pair contributes none. A
 * longer streak (3, 4, …) commits too, which by then is a no-op on an emptied
 * draft — better than appending a stray vertex to the polyline the double-click
 * just finished.
 *
 * The click-vs-drag threshold applies to both outcomes: the click that fires at
 * the end of an orbit drag neither appends nor commits.
 */
export function drawClickAction(detail: number, down: PointerPos, up: PointerPos): DrawClickAction {
  if (!isClick(down, up)) return 'ignore';
  return detail >= 2 ? 'commit' : 'append';
}

/** Which end of a committed polyline **Extend** grows (§6.2). */
export type PolylineEnd = 'start' | 'end';

/**
 * The end an Extend grows, from the selected vertex (§6.2).
 *
 * **Vertex 1 prepends, every other vertex appends.** That is what lets a rail be
 * grown at either end without reversing it, and it composes with §6.1's
 * select-the-last-vertex default: the common case — keep drawing the polyline just
 * finished — needs no selection at all. The rule is over the *index* rather than
 * "the nearer end by distance", because the user is holding an index, not a
 * distance, and a rule they can restate is worth more than one that measures.
 */
export function extendEnd(vertex: number): PolylineEnd {
  return vertex === 0 ? 'start' : 'end';
}

/**
 * Where an Extend click's vertex goes (§6.2): the front, or past the last.
 *
 * `count` is the polyline's current vertex count, so the returned index is also
 * the **new vertex's own index** once inserted — which is what makes it the
 * vertex to select, and keeps a run of clicks growing the same end.
 */
export function extendInsertAt(end: PolylineEnd, count: number): number {
  return end === 'start' ? 0 : count;
}

/**
 * The panel's **Insert** (§6.2): a vertex midway between the selected one and the
 * next, or `null` when there is no next vertex — the last vertex is Extend's job,
 * and the button is disabled there rather than quietly meaning something else.
 */
export function insertMidpoint(
  points: readonly Vec3[],
  vertex: number,
): { at: number; position: Vec3 } | null {
  const from = points[vertex];
  const to = points[vertex + 1];
  if (!from || !to) return null;
  return {
    at: vertex + 1,
    position: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
  };
}

/**
 * The vertex a polyline acts on, given its sub-selection (§6.1).
 *
 * A polyline **always has one vertex selected**, so an unset or out-of-range
 * sub-selection resolves to the **last** vertex. That single clamp covers three
 * cases at once: a freshly selected polyline (nothing sub-selected yet), a
 * deleted vertex (the index falls on whichever vertex took its place, or on the
 * new last if the deleted one was last), and a scene load that shortened the
 * polyline under a stale index.
 */
export function effectiveVertex(count: number, selected: number | null): number | null {
  if (count === 0) return null;
  if (selected === null || selected < 0 || selected > count - 1) return count - 1;
  return selected;
}

/**
 * The draft polyline's segments, as flat endpoint pairs — `[from, to, from, to, …]`
 * ready for a `LineSegments` (§6.2).
 *
 * **Explicit pairs, drawn solid.** Two earlier attempts at this line were drawn
 * and could not be seen — a `LineDashedMaterial`, which discards fragments by a
 * `lineDistance` attribute, then dashes built as geometry in an over-allocated
 * buffer cut to length by `setDrawRange` — but neither was the reason it stayed
 * invisible: the geometry underneath them reached the scene with no `position`
 * attribute at all, which permanently costs the object its vertex buffer under
 * three's WebGPU path (`PlacementOverlay.emptyLineGeometry`). Explicit pairs, a
 * fresh attribute per update, are what the rest of the app's lines do
 * (`CONVENTIONS.md`), so the draft does too.
 *
 * Zero-length segments contribute nothing: a click that lands exactly on the
 * previous vertex, or a cursor that has not moved off it, would otherwise emit a
 * segment of length zero.
 */
export function segmentPairs(points: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (from[0] === to[0] && from[1] === to[1] && from[2] === to[2]) continue;
    out.push([...from] as Vec3, [...to] as Vec3);
  }
  return out;
}
