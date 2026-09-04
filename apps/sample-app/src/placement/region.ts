/**
 * Camera constraints — the mount regions a placement analysis draws from
 * (`camera_placement.md` §3.1, §3.2).
 *
 * Pure data and geometry, no Three.js and no engine (gizmos live in
 * `scene/constraintGizmos.ts`, the trial loop in `analyze.ts`). Owns:
 *  - the {@link ConstraintGroup} / {@link CameraConstraint} entities (§3.1);
 *  - the region test, which is a *distance* to the primitive rather than a
 *    box containment: `region(c) = { p : dist(p, c) ≤ c.distance }` (§1.1);
 *  - the primitive **measure** the pool split weights by (§4.1);
 *  - the **projection** the drag clamp writes through (§6.3);
 *  - the primitive parameterization the pool draws positions along (§4.1).
 *
 * `distance` is a **tolerance, not a standoff**: at `distance = 0` a region is
 * the primitive itself, which is how a fixed bracket, a bare rail, and a wall
 * surface are expressed (§1.1).
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import { applyQuat, applyQuatConj } from '../scene/quatMath.ts';

// --- Entities (§3.1) ---------------------------------------------------------

/**
 * A named container of constraints: the unit a search runs over, carrying the
 * **camera template** it plans for, its pool size, and the **strategy** it runs with.
 *
 * The template is on the group and not on the app defaults because the build step
 * rig shares the camera's range (§2.1) — so `far` must be known *before* the pool
 * is built, when no camera exists yet (§3.1.1). It is three fields, not five:
 * `near` and `aspect` are placement-wide constants living in
 * {@link DEFAULT_TEMPLATE}, because `aspect` provably cannot change a reachable
 * set and `near` is a build-step input with no decision behind it (§3.1.1).
 */
export interface ConstraintGroup {
  id: string; // 'cg-N', unique, stable identity (never renamed)
  name: string; // user-editable label (§3.1); defaults to 'Group N'
  /** Skipped entirely by the analysis when false. Default true. */
  enabled: boolean;

  // Camera template — the model of camera this group plans for (§3.1.1).
  fov: number; // degrees, vertical
  far: number; // range in metres; a build-step input (§2.1)
  /** Placed cameras are named `${namePrefix} N`; '' ⇒ blank names (§5.3). */
  namePrefix: string;

  // Draw inputs (§4.1) — which positions the pool holds, rather than how the
  // analysis searches them. Both are spent on the GPU with Build, and both
  // resolve into its label (§3.3.1), so the panel shows them together (§5.1).
  poolSize: number; // P, positions built
  seed: number; // integer; offsets every constraint's sub-sequence, and picks each trial's subset

  // Analysis strategy (§4.4) — persisted, so a seeded analysis is reproducible (§9).
  maxCount: number; // the largest layout the analysis considers
  trials: number; // T, layouts drawn
  epsilon: number; // knee tolerance, percentage points of the score rate (§4.5)
}

/** Fields every constraint carries, whatever its kind. */
interface ConstraintBase {
  id: string; // 'con-N', unique across all constraints
  groupId: string; // the owning group (exactly one, §3.1)
  name: string; // user-editable label; defaults to 'Constraint N'
  /** Contributes pool positions when true (§4.1). Default true. */
  enabled: boolean;
  /** Dilation tolerance in metres, ≥ 0 (§1.1). */
  distance: number;
}

/** A single mount point. `distance` dilates it to a ball. */
export interface PointConstraint extends ConstraintBase {
  kind: 'point';
  position: Vec3;
}

/**
 * An ordered vertex list, **open** — a closed perimeter repeats its first
 * vertex as its last, since a `closed` flag would have to be honoured by every
 * sampler, measure, renderer, and the file format for a case the list already
 * states (§3.1). `distance` dilates it to a chain of capsules.
 */
export interface PolylineConstraint extends ConstraintBase {
  kind: 'polyline';
  points: Vec3[]; // ≥ 2 vertices
}

/**
 * A bounded rectangle spanning its **local X and Z**, normal along local Y —
 * the same convention a sampling volume's box uses (`sampling_volumes.md`
 * §2.3), so `{position, rotation}` maps to a Three.js object with no
 * conversion. `distance` dilates it to a rounded slab.
 */
export interface PlaneConstraint extends ConstraintBase {
  kind: 'plane';
  position: Vec3; // rectangle centre
  rotation: Quat; // local frame [x,y,z,w]; identity ⇒ spans world XZ
  size: [number, number]; // full edge lengths along local X and Z, both > 0
}

export type CameraConstraint = PointConstraint | PolylineConstraint | PlaneConstraint;

export type ConstraintKind = CameraConstraint['kind'];

/** Minimum plane edge length (m) — a rectangle with a zero edge has no area. */
export const MIN_PLANE_SIZE = 0.05;

// --- Labels (§3.1, `spec.md` §5.5) -------------------------------------------

/** The default 'Group N' label derived from a `cg-N` id. */
export function defaultGroupName(id: string): string {
  const m = /^cg-(\d+)$/.exec(id);
  return m ? `Group ${m[1]}` : id;
}

/** The default 'Constraint N' label derived from a `con-N` id. */
export function defaultConstraintName(id: string): string {
  const m = /^con-(\d+)$/.exec(id);
  return m ? `Constraint ${m[1]}` : id;
}

/** The label to display for a group: trimmed `name`, else the default. */
export function groupLabel(group: ConstraintGroup): string {
  const trimmed = group.name.trim();
  return trimmed.length > 0 ? trimmed : defaultGroupName(group.id);
}

/** The label to display for a constraint: trimmed `name`, else the default. */
export function constraintLabel(c: CameraConstraint): string {
  const trimmed = c.name.trim();
  return trimmed.length > 0 ? trimmed : defaultConstraintName(c.id);
}

// --- Vector helpers ----------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// --- Nearest point on the primitive (§3.2) -----------------------------------

/** Nearest point to `p` on segment `a`→`b`; `a` when the segment is degenerate. */
function nearestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 === 0) return [...a] as Vec3;
  const t = clamp(dot(sub(p, a), ab) / len2, 0, 1);
  return add(a, scale(ab, t));
}

/**
 * Nearest point to `p` on a plane constraint's rectangle: into the local frame
 * by the conjugate rotation, clamp X and Z to the half-extents, zero Y, back out.
 */
function nearestOnRect(p: Vec3, c: PlaneConstraint): Vec3 {
  const local = applyQuatConj(c.rotation, sub(p, c.position));
  const clamped: Vec3 = [
    clamp(local[0], -c.size[0] / 2, c.size[0] / 2),
    0,
    clamp(local[2], -c.size[1] / 2, c.size[1] / 2),
  ];
  return add(c.position, applyQuat(c.rotation, clamped));
}

/**
 * The nearest point to `p` on the constraint's **primitive** — before dilation.
 * A polyline takes the minimum over its segments, which is what makes its
 * dilated region a swept ball with round joints and caps (§3.1).
 */
export function nearestOnPrimitive(p: Vec3, c: CameraConstraint): Vec3 {
  switch (c.kind) {
    case 'point':
      return [...c.position] as Vec3;
    case 'plane':
      return nearestOnRect(p, c);
    case 'polyline': {
      let best: Vec3 = [...c.points[0]] as Vec3;
      let bestD = Infinity;
      for (let i = 0; i + 1 < c.points.length; i++) {
        const q = nearestOnSegment(p, c.points[i], c.points[i + 1]);
        const d = length(sub(p, q));
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      return best;
    }
  }
}

// --- Membership, measure, projection (§3.2) ----------------------------------

/** Distance from `p` to the constraint's primitive. */
export function distToPrimitive(p: Vec3, c: CameraConstraint): number {
  return length(sub(p, nearestOnPrimitive(p, c)));
}

/**
 * Slack on the membership test, in metres (§3.2).
 *
 * `projectIntoRegion` reaches the region's surface by scaling a vector, and that
 * arithmetic can land an ulp outside: `0.4 / 30 * 30` is `0.4000000000000001`.
 * Without slack the clamp of §6.3 could produce a position that fails the very
 * test it was projected into, and a validator would flag a camera the app itself
 * just placed. A nanometre is far below any physical meaning on a metre-scale
 * site, so the tolerance costs nothing and makes "a projected point is in the
 * region" true by construction rather than by luck.
 */
export const REGION_EPSILON = 1e-9;

/** World point `p` inside the dilated region? `dist ≤ distance` (§1.1). */
export function inRegion(p: Vec3, c: CameraConstraint): boolean {
  return distToPrimitive(p, c) <= c.distance + REGION_EPSILON;
}

/**
 * The **primitive's own** measure, independent of `distance` (§4.1): a point
 * weighs 1, a polyline its total length, a plane its area.
 *
 * Dimension-stable, which the dilated region's volume is not: at `distance = 0`
 * every region's volume is 0 and the pool split would collapse exactly when the
 * user pins things down.
 */
export function primitiveMeasure(c: CameraConstraint): number {
  switch (c.kind) {
    case 'point':
      return 1;
    case 'plane':
      return c.size[0] * c.size[1];
    case 'polyline': {
      let total = 0;
      for (let i = 0; i + 1 < c.points.length; i++) total += length(sub(c.points[i + 1], c.points[i]));
      return total;
    }
  }
}

/**
 * Project `p` into the region: the nearest point on the primitive, then out
 * along `p − q` by at most `distance` (§3.2).
 *
 * Always returns a point in the region, is continuous, and is the identity on a
 * point already inside. For a non-convex polyline it is not guaranteed to be the
 * *globally* nearest point of the region, which is immaterial for a clamp (§6.3).
 */
export function projectIntoRegion(p: Vec3, c: CameraConstraint): Vec3 {
  const q = nearestOnPrimitive(p, c);
  const away = sub(p, q);
  const d = length(away);
  if (d <= c.distance) return [...p] as Vec3;
  if (d === 0) return q;
  return add(q, scale(away, c.distance / d));
}

// --- Primitive parameterization (§4.1) ---------------------------------------

/**
 * A point on the primitive from unit parameters `u`, `v` ∈ [0, 1):
 * a polyline by **arc length** (so a long segment gets its proportional share
 * of the pool, not an equal one), a plane by `(u, v)` over its rectangle, a
 * point ignoring both.
 */
export function pointOnPrimitive(c: CameraConstraint, u: number, v: number): Vec3 {
  switch (c.kind) {
    case 'point':
      return [...c.position] as Vec3;
    case 'plane': {
      const local: Vec3 = [(u - 0.5) * c.size[0], 0, (v - 0.5) * c.size[1]];
      return add(c.position, applyQuat(c.rotation, local));
    }
    case 'polyline': {
      const total = primitiveMeasure(c);
      if (total === 0) return [...c.points[0]] as Vec3;
      let target = u * total;
      for (let i = 0; i + 1 < c.points.length; i++) {
        const seg = length(sub(c.points[i + 1], c.points[i]));
        if (target <= seg || i + 2 === c.points.length) {
          const t = seg === 0 ? 0 : clamp(target / seg, 0, 1);
          return add(c.points[i], scale(sub(c.points[i + 1], c.points[i]), t));
        }
        target -= seg;
      }
      return [...c.points[c.points.length - 1]] as Vec3;
    }
  }
}

// --- Validation (§9) ---------------------------------------------------------

/**
 * Why this constraint cannot be used, or `null` when it is well-formed. Shared
 * by the scene-file reader (`spec.md` §14.8) and the panels, so an imported
 * constraint and a hand-edited one are rejected for the same reasons.
 */
export function constraintProblem(c: CameraConstraint): string | null {
  if (!Number.isFinite(c.distance) || c.distance < 0) return 'distance must be a finite number ≥ 0';
  const finite = (v: Vec3) => v.length === 3 && v.every((n) => Number.isFinite(n));
  switch (c.kind) {
    case 'point':
      return finite(c.position) ? null : 'position must be three finite numbers';
    case 'polyline':
      if (c.points.length < 2) return 'a polyline needs at least 2 vertices';
      return c.points.every(finite) ? null : 'every vertex must be three finite numbers';
    case 'plane':
      if (!finite(c.position)) return 'position must be three finite numbers';
      if (c.rotation.length !== 4 || !c.rotation.every((n) => Number.isFinite(n))) {
        return 'rotation must be four finite numbers';
      }
      return c.size.every((n) => Number.isFinite(n) && n > 0) ? null : 'both size components must be > 0';
  }
}

/** Why this group's template, pool size or strategy cannot be used, or `null` (§9). */
export function groupProblem(g: ConstraintGroup): string | null {
  if (!(g.fov > 0 && g.fov < 180)) return 'fov must be in (0, 180)';
  if (!(g.far > 0) || !Number.isFinite(g.far)) return 'far must be > 0';
  if (!Number.isInteger(g.poolSize) || g.poolSize < 1) return 'poolSize must be an integer ≥ 1';
  if (!Number.isInteger(g.maxCount) || g.maxCount < 1) return 'maxCount must be an integer ≥ 1';
  if (!Number.isInteger(g.trials) || g.trials < 1) return 'trials must be an integer ≥ 1';
  if (!Number.isFinite(g.epsilon) || g.epsilon < 0) return 'epsilon must be a finite number ≥ 0';
  if (!Number.isInteger(g.seed)) return 'seed must be an integer';
  return null;
}

// --- Defaults (§3.1, §9) -----------------------------------------------------

/**
 * The pool size and strategy a new group starts with (§9).
 *
 * 200 positions is a few minutes of building on a large site and plenty of
 * granularity on a small one; 1000 trials is seconds of CPU on a cached pool,
 * which is the whole reason the pool is cached (§2.2). `epsilon` is in
 * percentage points of the reachable rate (§4.5).
 */
export const DEFAULT_RECIPE = {
  poolSize: 200,
  maxCount: 10,
  trials: 1000,
  epsilon: 1,
  seed: 1,
} as const;

/**
 * The camera optics placement works in — the same optics a camera added from the
 * "+" menu gets (`spec.md` §5.5), so a group plans for the app's default camera
 * until the user says otherwise (§3.1.1).
 *
 * `fov` and `far` are the group's own starting values, editable in the mode's
 * `New camera defaults` card (§5.1). `aspect` and `near` are **constants**: the
 * capture rig runs at this `near`, Apply writes it onto every moved camera,
 * and a created camera gets both — no group ever carries a copy (§3.1.1).
 */
export const DEFAULT_TEMPLATE = { fov: 60, aspect: 16 / 9, near: 0.1, far: 30 } as const;

/** The template fields a {@link ConstraintGroup} actually stores. */
const DEFAULT_GROUP_TEMPLATE = { fov: DEFAULT_TEMPLATE.fov, far: DEFAULT_TEMPLATE.far } as const;

/** Edge length (m) of a plane constraint spawned from the "+" menu (`spec.md` §5.5). */
export const NEW_PLANE_SIZE: [number, number] = [4, 4];

export function defaultConstraintGroup(id: string): ConstraintGroup {
  return {
    id,
    name: defaultGroupName(id),
    enabled: true,
    ...DEFAULT_GROUP_TEMPLATE,
    namePrefix: '',
    ...DEFAULT_RECIPE,
  };
}

/**
 * A constraint spawned from the "+" menu or the draw mode (`spec.md` §5.5,
 * §6.2). `distance` starts at 0 — the primitive itself — because a tolerance is
 * something the user opts into once they know they want one.
 */
export function defaultConstraint(
  id: string,
  groupId: string,
  kind: ConstraintKind,
  at: Vec3,
  points?: Vec3[],
): CameraConstraint {
  const base = { id, groupId, name: defaultConstraintName(id), enabled: true, distance: 0 };
  switch (kind) {
    case 'point':
      return { ...base, kind: 'point', position: [...at] as Vec3 };
    case 'plane':
      return {
        ...base,
        kind: 'plane',
        position: [...at] as Vec3,
        rotation: [0, 0, 0, 1],
        size: [...NEW_PLANE_SIZE] as [number, number],
      };
    case 'polyline':
      return {
        ...base,
        kind: 'polyline',
        points: (points ?? [[...at] as Vec3, [...at] as Vec3]).map((p) => [...p] as Vec3),
      };
  }
}
