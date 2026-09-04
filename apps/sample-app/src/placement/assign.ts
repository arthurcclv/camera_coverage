/**
 * The Apply plan (`camera_placement.md` §5.3): which of the group's cameras move
 * where, which positions need a new camera, and which cameras the chosen count
 * makes surplus.
 *
 * Pure — no engine, no React, no SDK. The whole of §5.3's arithmetic is a
 * function of two position lists, which is what lets the destructive part (a
 * delete, in an app with no undo) be pinned by tests rather than by inspection.
 *
 * **Apply moves before it creates.** A site already has cameras on its rails; the
 * answer to "where should eight cameras go" is *these eight, moved there*, not
 * eight more bolted up beside them.
 *
 * **And it disables rather than deletes.** A camera the layout does not need is a
 * mount the site still has, so the surplus is switched off where it stands
 * (§5.3.1) — no name, position, or per-camera edit is lost, and a re-search at a
 * higher count picks those same cameras straight back up.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

/** A camera the plan may move: its identity and where it stands today. */
export interface MovableCamera {
  id: string;
  position: Vec3;
}

/** A position the layout wants staffed, and the constraint it came from. */
export interface TargetPosition {
  position: Vec3;
  constraintId: string;
}

/** An existing camera re-arranged onto a chosen position (§5.3.3). */
export interface PlacementMove {
  cameraId: string;
  position: Vec3;
  /** That position's constraint — possibly a *different* one of the same group. */
  constraintId: string;
  /** Metres this camera travels; every one is a physical re-installation. */
  distance: number;
}

/** A position the group could not staff from what it already has (§5.3.1). */
export interface PlacementCreate {
  position: Vec3;
  constraintId: string;
  /** 1-based index in the layout — the created camera's name suffix (§5.3.3). */
  ordinal: number;
}

export interface PlacementPlan {
  moves: PlacementMove[];
  creates: PlacementCreate[];
  /**
   * Camera ids the chosen count makes surplus — switched **off**, never removed
   * (§5.3.1). They keep their id, name, position, rotation, lens, and binding,
   * so the only thing Apply spends is a flag, and the hierarchy's eye toggle
   * undoes it by hand.
   */
  disables: string[];
  /** Σ of every move's distance, for the panel. */
  totalDistance: number;
}

export const EMPTY_PLAN: PlacementPlan = { moves: [], creates: [], disables: [], totalDistance: 0 };

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const INF = Number.POSITIVE_INFINITY;

/**
 * Minimum-cost assignment over a rectangular cost matrix, `rows ≤ cols`
 * (Hungarian / Jonker–Volgenant shortest-augmenting-path form, `O(n³)`).
 *
 * Returns, per row, the column it takes — every row is matched, and
 * `cols − rows` columns are left over.
 *
 * `O(n³)` is microseconds at these sizes, so there is no reason to approximate:
 * greedy-nearest can be forced into an arbitrarily long move by one early pick.
 * Every comparison is a **strict** `<`, so a tie is resolved in favour of the
 * lower index — which is hierarchy order for rows and layout order for columns,
 * and is what makes the plan deterministic (§5.3.2).
 */
function assignRowsToCols(cost: number[][], rows: number, cols: number): number[] {
  // 1-indexed internally, as the algorithm is conventionally written; `u`/`v`
  // are the row/column potentials and `p[j]` the row currently holding column j.
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const p = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);

  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(cols + 1).fill(INF);
    const used = new Array<boolean>(cols + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const colOfRow = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= cols; j++) if (p[j] !== 0) colOfRow[p[j] - 1] = j - 1;
  return colOfRow;
}

/**
 * Derive the §5.3 plan.
 *
 * `bound` must be the group's cameras in **hierarchy order** and `targets` the
 * selected layout's positions in layout order — both orders are the tiebreak, so
 * passing them shuffled would make the plan non-reproducible.
 *
 * The two lopsided cases are deliberately not symmetric in what they *keep*:
 *
 * - more targets than cameras ⇒ every camera moves, and the unstaffed positions
 *   become `creates`;
 * - more cameras than targets ⇒ every position is staffed, and the cameras that
 *   win none become `disables`. Because the assignment runs over the positions,
 *   the cameras switched off are the ones furthest from anywhere the layout
 *   wants — the right set to stand down (§5.3.2).
 *
 * `bound` includes **already-disabled** cameras: they are hardware on the rail,
 * not scene clutter, and including them is what lets a re-search at a higher
 * count switch them back on instead of creating new ones beside them. Their cost
 * is plain distance like everyone else's — being disabled buys no discount,
 * since flipping a flag costs nothing on site while a metre of travel is a
 * physical re-installation (§5.3.2).
 */
export function planApply(
  bound: readonly MovableCamera[],
  targets: readonly TargetPosition[],
): PlacementPlan {
  const n = bound.length;
  const m = targets.length;
  if (m === 0) return { ...EMPTY_PLAN, disables: bound.map((c) => c.id) };
  if (n === 0) {
    return {
      moves: [],
      creates: targets.map((t, j) => ({ position: t.position, constraintId: t.constraintId, ordinal: j + 1 })),
      disables: [],
      totalDistance: 0,
    };
  }

  const moves: PlacementMove[] = [];
  const creates: PlacementCreate[] = [];
  const disables: string[] = [];
  const takenTarget = new Array<boolean>(m).fill(false);
  const movedCamera = new Array<boolean>(n).fill(false);

  if (n <= m) {
    // Cameras are the scarce side: each one takes a position.
    const cost = bound.map((c) => targets.map((t) => distance(c.position, t.position)));
    const colOfRow = assignRowsToCols(cost, n, m);
    for (let i = 0; i < n; i++) {
      const j = colOfRow[i];
      takenTarget[j] = true;
      movedCamera[i] = true;
      moves.push({
        cameraId: bound[i].id,
        position: targets[j].position,
        constraintId: targets[j].constraintId,
        distance: cost[i][j],
      });
    }
  } else {
    // Positions are the scarce side: each one claims a camera, and the cameras
    // left over are the surplus the chosen count does not need — switched off,
    // not removed.
    const cost = targets.map((t) => bound.map((c) => distance(c.position, t.position)));
    const rowOfTarget = assignRowsToCols(cost, m, n);
    for (let j = 0; j < m; j++) {
      const i = rowOfTarget[j];
      takenTarget[j] = true;
      movedCamera[i] = true;
      moves.push({
        cameraId: bound[i].id,
        position: targets[j].position,
        constraintId: targets[j].constraintId,
        distance: cost[j][i],
      });
    }
  }

  for (let j = 0; j < m; j++) {
    if (!takenTarget[j]) {
      creates.push({ position: targets[j].position, constraintId: targets[j].constraintId, ordinal: j + 1 });
    }
  }
  for (let i = 0; i < n; i++) if (!movedCamera[i]) disables.push(bound[i].id);

  // World order (x, then y, then z), so the panel, the preview, and the reducer
  // all present the plan the same way however the assignment happened to resolve
  // it. Any total order would do; this one is stable under a re-run and needs no
  // tie-break, since two moves never share a target position.
  moves.sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1] || a.position[2] - b.position[2]);

  return { moves, creates, disables, totalDistance: moves.reduce((n2, mv) => n2 + mv.distance, 0) };
}

/** The one-line summary the Apply button carries (§5.3.1). */
export function planLabel(plan: PlacementPlan): string {
  const parts: string[] = [];
  if (plan.moves.length > 0) parts.push(`move ${plan.moves.length}`);
  if (plan.creates.length > 0) parts.push(`add ${plan.creates.length}`);
  // Named last and named explicitly — not as a warning (nothing is lost, §5.3.1)
  // but because the count is part of what the user is approving.
  if (plan.disables.length > 0) parts.push(`disable ${plan.disables.length}`);
  return parts.length > 0 ? `Apply · ${parts.join(' · ')}` : 'Apply';
}

/**
 * The line shown once a plan has been applied (§5.3.3).
 *
 * It exists to say what Apply deliberately did *not* do: every placed camera
 * carries the identity rotation, so a layout the curve scored is not the layout
 * the scene renders until the aims are optimized. Moves and creates both count —
 * they are the contributing cameras the chosen count promised.
 */
export function appliedLabel(plan: PlacementPlan): string {
  const placed = plan.moves.length + plan.creates.length;
  return `${placed} camera${placed === 1 ? '' : 's'} placed. Run Optimize all aims to aim them.`;
}

/**
 * Cameras a plan may move: bound to **any** constraint of this group (§5.3),
 * **enabled or not** — a disabled camera is still a mount (§5.3.2).
 */
export function boundCameras<C extends { id: string; constraintId?: string; position: Vec3 }>(
  cameras: readonly C[],
  groupConstraintIds: ReadonlySet<string>,
): C[] {
  return cameras.filter((c) => c.constraintId !== undefined && groupConstraintIds.has(c.constraintId));
}
