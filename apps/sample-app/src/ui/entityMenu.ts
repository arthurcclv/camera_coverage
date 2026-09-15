/**
 * The hierarchy context menu's per-kind routing (spec §5.5, `camera_placement.md` §7).
 *
 * Extracted from `SceneHierarchy.tsx` after both menu items shipped as if/else
 * chains ending in a bare `else` that assumed `volume`:
 *
 * ```ts
 * if (kind === 'camera') props.onDeleteCamera(id);
 * // …
 * else props.onDeleteVolume(id);   // ← every kind added after `volume`
 * ```
 *
 * Adding constraint groups and constraints extended `DeletableKind` and added the
 * four props, and the chains silently swallowed both: deleting a constraint called
 * `onDeleteVolume` with a constraint id, which filtered the volume array for an id
 * no volume had and returned it unchanged. No error, no throw, nothing removed —
 * the row just sat there.
 *
 * The `Record<DeletableKind, …>` return type is the fix that outlives this bug: the
 * next kind added to the union fails to compile until it has a branch here.
 */

/** Kinds the context menu can duplicate or delete (spec §5.5, `camera_placement.md` §7). */
export type DeletableKind =
  | 'camera'
  | 'probe'
  | 'section'
  | 'zone'
  | 'volume'
  | 'constraintGroup'
  | 'constraint'
  /** A splat capture (`gaussian_splats.md` §6.3, §6.4). */
  | 'splat'
  /** A geometry object — room, box or mesh (`geometry_assets.md` §6.3, §6.4). */
  | 'geometry';

/** The per-kind callbacks the hierarchy takes for its context menu. */
export interface EntityMenuHandlers {
  onDeleteCamera(id: string): void;
  onDeleteProbe(id: string): void;
  onDeleteSection(id: string): void;
  onDeleteZone(id: string): void;
  onDeleteVolume(id: string): void;
  onDeleteConstraintGroup(id: string): void;
  onDeleteConstraint(id: string): void;
  onDeleteSplat(id: string): void;
  onDeleteGeometry(id: string): void;
  onDuplicateCamera(id: string): void;
  onDuplicateProbe(id: string): void;
  onDuplicateSection(id: string): void;
  onDuplicateZone(id: string): void;
  onDuplicateVolume(id: string): void;
  onDuplicateConstraintGroup(id: string): void;
  onDuplicateConstraint(id: string): void;
  onDuplicateSplat(id: string): void;
  onDuplicateGeometry(id: string): void;
}

/** Which handler the Delete item fires, per kind. */
export function deleteHandlers(h: EntityMenuHandlers): Record<DeletableKind, (id: string) => void> {
  return {
    camera: h.onDeleteCamera,
    probe: h.onDeleteProbe,
    section: h.onDeleteSection,
    zone: h.onDeleteZone,
    volume: h.onDeleteVolume,
    constraintGroup: h.onDeleteConstraintGroup,
    constraint: h.onDeleteConstraint,
    splat: h.onDeleteSplat,
    geometry: h.onDeleteGeometry,
  };
}

/** Which handler the Duplicate item fires, per kind. */
export function duplicateHandlers(h: EntityMenuHandlers): Record<DeletableKind, (id: string) => void> {
  return {
    camera: h.onDuplicateCamera,
    probe: h.onDuplicateProbe,
    section: h.onDuplicateSection,
    zone: h.onDuplicateZone,
    volume: h.onDuplicateVolume,
    constraintGroup: h.onDuplicateConstraintGroup,
    constraint: h.onDuplicateConstraint,
    splat: h.onDuplicateSplat,
    geometry: h.onDuplicateGeometry,
  };
}
