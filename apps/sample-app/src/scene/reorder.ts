/**
 * Hierarchy drag-reorder (spec §5.5.1) — the pure half.
 *
 * Two concerns, both kept free of DOM and React so they unit-test directly:
 *
 * 1. **Hit-testing** — {@link insertionTargetAt} turns a pointer Y plus the
 *    rendered rows' vertical extents into "insert before this sibling" (or `null`
 *    for last), rejecting anything that isn't a legal sibling slot.
 * 2. **The splice** — {@link moveBefore} / {@link moveVolumeBefore} rewrite the
 *    canonical arrays. Order *is* the persistence (§14.3): reordering a row is
 *    reordering `cameras`/`probes`/`sections`/`zones`/`volumes`, which serialize in
 *    order, so no separate order field exists.
 *
 * The volume case is the subtle one. A zone's rows are derived by filtering the
 * global `volumes` array (`buildSceneTree`), and that array interleaves zones
 * because volumes always append on create (§14.3). So a volume reorder **permutes
 * the entities among the slots that zone's volumes already occupy**, leaving every
 * other element — including other zones' volumes — exactly where it was.
 */
import type { RenderRow } from './sceneTree.ts';

/** Kinds whose rows can be dragged to reorder (spec §5.5.1 — group headers cannot). */
export type ReorderableKind = 'camera' | 'probe' | 'section' | 'zone' | 'volume';

/** The vertical extent of one rendered row, in the scroll container's client space. */
export interface RowBox {
  /** The row's tree-node id (`cam:…`, `zone:…`, …), matching `RenderRow.node.id`. */
  nodeId: string;
  top: number;
  bottom: number;
}

/**
 * A resolved drop position: insert the dragged entity immediately before
 * `beforeId`, or at the end of its group when `beforeId` is null.
 *
 * Carries the insertion line's geometry too — it falls straight out of the
 * hit-test's own measurements, so computing it here keeps the pixel math in the
 * unit-tested layer rather than in the pointer handlers.
 */
export interface InsertionTarget {
  /** Entity id (`cam-1`, `volume-2`, …) to insert before; null means last. */
  beforeId: string | null;
  /** Tree-node id of the row the line sits above; null when appending. */
  beforeNodeId: string | null;
  /** Where to draw the line, in the same coordinate space as the supplied boxes. */
  lineY: number;
  /** The sibling run's indent depth, so the line can be inset to match (§5.5.1). */
  depth: number;
}

/** The reorderable kind a tree node belongs to, or null for a group header. */
function reorderableKindOf(row: RenderRow): ReorderableKind | null {
  const { kind } = row.node;
  return kind === 'group' ? null : kind;
}

/** The entity id behind a node (cameraId/probeId/…), or null for a group header. */
function entityIdOf(row: RenderRow): string | null {
  const n = row.node;
  switch (n.kind) {
    case 'camera':
      return n.cameraId;
    case 'probe':
      return n.probeId;
    case 'section':
      return n.sectionId;
    case 'zone':
      return n.zoneId;
    case 'volume':
      return n.volumeId;
    default:
      return null;
  }
}

/**
 * The dragged row's siblings, in render order — the rows it may legally be
 * repositioned among (spec §5.5.1: within-group only, no reparenting).
 *
 * Siblings share the dragged row's kind *and* depth. Depth is what separates one
 * zone's volumes from another's: every volume row sits at the same depth, but only
 * those under the same zone are contiguous with the dragged one, so the run is
 * additionally clipped to the **contiguous** block containing the dragged row. That
 * also makes a zone's volumes invisible as slots during a zone drag — a zone row is
 * shallower, so its siblings are the other zone rows, and their volume children are
 * simply not in the run (the "zone drags as a subtree" rule).
 */
export function siblingRows(rows: RenderRow[], draggedNodeId: string): RenderRow[] {
  const index = rows.findIndex((r) => r.node.id === draggedNodeId);
  if (index < 0) return [];
  const dragged = rows[index];
  const kind = reorderableKindOf(dragged);
  if (kind === null) return [];

  // Walk out from the dragged row while rows stay at or below its depth, keeping
  // the same-kind, same-depth ones. A shallower row (the group header above, the
  // next zone header below) ends the run.
  const run: RenderRow[] = [];
  const matches = (r: RenderRow) => r.depth === dragged.depth && reorderableKindOf(r) === kind;
  for (let i = index; i >= 0; i--) {
    if (rows[i].depth < dragged.depth) break;
    if (matches(rows[i])) run.unshift(rows[i]);
  }
  for (let i = index + 1; i < rows.length; i++) {
    if (rows[i].depth < dragged.depth) break;
    if (matches(rows[i])) run.push(rows[i]);
  }
  return run;
}

/**
 * The bottom edge of `row` including any descendant rows rendered beneath it (an
 * expanded zone's volumes). A leaf's subtree is itself.
 */
function subtreeBottom(rows: RenderRow[], boxes: Map<string, RowBox>, row: RenderRow): number {
  let bottom = boxes.get(row.node.id)?.bottom ?? Number.NEGATIVE_INFINITY;
  const start = rows.findIndex((r) => r.node.id === row.node.id);
  for (let i = start + 1; i < rows.length && rows[i].depth > row.depth; i++) {
    const box = boxes.get(rows[i].node.id);
    if (box) bottom = Math.max(bottom, box.bottom);
  }
  return bottom;
}

/**
 * Resolve a pointer position to a drop target (spec §5.5.1), or null when the drop
 * is illegal and must be a no-op.
 *
 * `boxes` are the measured extents of the *visible* rows, keyed by node id; only
 * the dragged row's siblings are consulted. The pointer lands before a sibling when
 * it is above that sibling's vertical midpoint, and at the end when it is below the
 * last sibling's midpoint. Returns null when:
 *
 * - the pointer is outside the sibling run's vertical span (i.e. over another
 *   group, or over a zone's volume children during a zone drag) — no insertion line
 *   is shown there and releasing does nothing;
 * - the resolved slot is where the row already is (dropping onto itself, or into
 *   the gap immediately after itself) — both are no-ops, not moves.
 */
export function insertionTargetAt(
  pointerY: number,
  rows: RenderRow[],
  boxes: Map<string, RowBox>,
  draggedNodeId: string,
): InsertionTarget | null {
  const siblings = siblingRows(rows, draggedNodeId).filter((r) => boxes.has(r.node.id));
  if (siblings.length === 0) return null;

  const first = boxes.get(siblings[0].node.id)!;
  // The run's span reaches to the bottom of the *last sibling's subtree*, not just
  // its own row: dropping below an expanded final zone's last volume still means
  // "after that zone" (§5.5.1 — a zone occupies its whole subtree).
  const spanBottom = subtreeBottom(rows, boxes, siblings[siblings.length - 1]);
  if (pointerY < first.top || pointerY > spanBottom) return null;

  // First sibling whose midpoint the pointer sits above; past them all → append.
  const draggedIndex = siblings.findIndex((r) => r.node.id === draggedNodeId);
  let slot = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const box = boxes.get(siblings[i].node.id)!;
    if (pointerY < (box.top + box.bottom) / 2) {
      slot = i;
      break;
    }
  }

  // Landing in your own slot, or the one right after it, leaves the order
  // unchanged — treat both as "no target" so no line is drawn (§5.5.1).
  if (draggedIndex >= 0 && (slot === draggedIndex || slot === draggedIndex + 1)) return null;

  const beforeRow = slot < siblings.length ? siblings[slot] : null;
  return {
    beforeId: beforeRow ? entityIdOf(beforeRow) : null,
    beforeNodeId: beforeRow ? beforeRow.node.id : null,
    lineY: beforeRow ? boxes.get(beforeRow.node.id)!.top : spanBottom,
    depth: siblings[0].depth,
  };
}

/**
 * Move the element with `id` so it sits immediately before `beforeId` (or last when
 * `beforeId` is null). Returns the original array unchanged when `id` is unknown,
 * when `beforeId` names no element, or when the move is a no-op — so a caller can
 * use referential identity to skip a state update.
 *
 * Used for cameras, probes, sections, and zones, whose arrays hold exactly one
 * group's worth of siblings. Volumes go through {@link moveVolumeBefore}.
 */
export function moveBefore<T extends { id: string }>(items: T[], id: string, beforeId: string | null): T[] {
  const from = items.findIndex((i) => i.id === id);
  if (from < 0 || id === beforeId) return items;

  const rest = items.filter((_, i) => i !== from);
  if (beforeId === null) {
    if (from === items.length - 1) return items;
    return [...rest, items[from]];
  }
  const at = rest.findIndex((i) => i.id === beforeId);
  if (at < 0) return items;
  // Already immediately before `beforeId` — nothing to do.
  if (at === from) return items;
  return [...rest.slice(0, at), items[from], ...rest.slice(at)];
}

/**
 * Move a volume within its own zone (spec §5.5.1). The global `volumes` array
 * interleaves zones, so this permutes the zone's volumes among **the slots they
 * already occupy** and writes every other element back untouched — a volume of
 * another zone can never shift, and the array's zone-interleaving is preserved
 * exactly (§14.3).
 *
 * `beforeId` must name a volume of the same zone; anything else (a dangling id, or
 * a volume of a different zone — dragging never reparents) returns the array
 * unchanged, as does a no-op move.
 */
export function moveVolumeBefore<T extends { id: string; zoneId: string }>(
  volumes: T[],
  id: string,
  beforeId: string | null,
): T[] {
  const target = volumes.find((v) => v.id === id);
  if (!target) return volumes;

  // The slots this zone's volumes occupy, in array order.
  const slots: number[] = [];
  for (const [i, v] of volumes.entries()) if (v.zoneId === target.zoneId) slots.push(i);

  const within = slots.map((i) => volumes[i]);
  if (beforeId !== null && !within.some((v) => v.id === beforeId)) return volumes; // other zone / unknown

  const reordered = moveBefore(within, id, beforeId);
  if (reordered === within) return volumes;

  const next = volumes.slice();
  for (const [k, slot] of slots.entries()) next[slot] = reordered[k];
  return next;
}
