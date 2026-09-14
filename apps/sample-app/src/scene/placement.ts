/**
 * "Place on surface" tool logic for the viewport toolbar (spec §2.4.2).
 *
 * The tool sets a **target's** position from a click on the scene geometry. This
 * module is the single source of truth for **what it can target** and for the
 * button's tooltip, kept pure so it can be unit-tested without a React/DOM
 * harness (test/placement.test.ts) — the same split the transform-space toggle
 * uses (`transformSpace.ts`).
 *
 * The geometry side of the tool (resolving a ray's intersections to one world
 * point) lives in `sceneView/surfaceHit.ts`.
 */
import type { Selection } from './viewportSelection.ts';

/**
 * A selection kind the tool can act on (spec §2.4.2). Derived from
 * {@link Selection} rather than spelled out independently, so renaming a kind
 * fails the build here instead of silently narrowing the supported set.
 */
export type PlaceableKind = Extract<NonNullable<Selection>['kind'], 'camera' | 'probe' | 'constraint'>;

/**
 * The supported kinds, in one place (spec §2.4.2). A section is a set of bounds
 * rather than a point, a zone has no transform, and a volume's `position` is its
 * box *centre* — placing one on a surface would bury half the box — so none of
 * the three is here.
 *
 * `constraint` is here for **one** case: a polyline's selected vertex
 * (`camera_placement.md` §6.2). A constraint selection alone is not placeable —
 * a polyline has no `position` of its own — which is why the predicate below
 * takes the vertex sub-selection as well as the selection.
 *
 * Widening this list is deliberate: every consumer switches exhaustively over
 * {@link PlaceTarget}, so adding a kind fails to compile until it is handled.
 */
export const PLACEABLE_KINDS: readonly PlaceableKind[] = ['camera', 'probe', 'constraint'];

/**
 * What an armed click writes. A vertex is the one target that is a
 * **sub-selection** rather than an entity, so it carries its index alongside the
 * constraint's id (`camera_placement.md` §6.1).
 */
export type PlaceTarget =
  | { kind: 'camera'; id: string }
  | { kind: 'probe'; id: string }
  | { kind: 'vertex'; id: string; vertex: number };

/**
 * The target of an armed click, or `null` when the tool is unavailable — the
 * button's enablement rule and the click's dispatch, resolved once (spec §2.4.2).
 *
 * `vertex` is the caller's polyline sub-selection: non-null **only** when the
 * selected constraint is a polyline (`camera_placement.md` §6.1, which resolves
 * it). Taking it as a number rather than the constraint keeps this module out of
 * the constraint model, exactly as it stays out of the camera and probe models.
 */
export function placeTarget(selection: Selection, vertex: number | null): PlaceTarget | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case 'camera':
    case 'probe':
      return { kind: selection.kind, id: selection.id };
    case 'constraint':
      return vertex === null ? null : { kind: 'vertex', id: selection.id, vertex };
    default:
      return null;
  }
}

/** Whether the tool is available (spec §2.4.2) — the button's enablement rule. */
export function canPlace(selection: Selection, vertex: number | null): boolean {
  return placeTarget(selection, vertex) !== null;
}

/**
 * The i18n key (spec §18.4, `common` namespace) for the button's tooltip/
 * `aria-label`, naming why it is disabled when it is. Returns a key rather than
 * formatted English so this stays testable without a React/i18next harness;
 * the caller runs it through `t()`.
 */
export function placeTooltipKey(selection: Selection, vertex: number | null, armed: boolean): string {
  const target = placeTarget(selection, vertex);
  if (!target) return 'placeTooltipDisabled';
  const isVertex = target.kind === 'vertex';
  if (armed) return isVertex ? 'placeTooltipVertexArmed' : 'placeTooltipEntityArmed';
  return isVertex ? 'placeTooltipVertex' : 'placeTooltipEntity';
}
