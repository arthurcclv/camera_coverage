/**
 * Which entities the viewport draws (`spec.md` §2.4.3).
 *
 * `enabled: false` hides an entity outright, and selection is the one exception —
 * both of which each gizmo set applies for itself, from flags it already has. The
 * two *derived* sets live here instead, because neither is a property of one
 * entity: a constraint's visibility depends on its **group**, and a zone volume's
 * on whichever **groups target that zone**. Pure so the inheritance is tested
 * without a renderer, and shared so App and the gizmo sets cannot disagree about
 * it.
 */
import type { ConstraintGroup } from '../placement/region.ts';
import type { Zone } from './samplingVolumes.ts';

/**
 * The groups whose constraints may draw: every **enabled** group, plus the group
 * placement mode is open on, which counts as selected (`camera_placement.md`
 * §5.1). Nothing stops the mode being entered on a disabled group, and without
 * that second term Build would scatter a pool of candidate dots over rails that
 * are not drawn.
 */
export function drawableGroupIds(
  groups: readonly ConstraintGroup[],
  placementGroupId: string | null,
): ReadonlySet<string> {
  const ids = new Set(groups.filter((g) => g.enabled).map((g) => g.id));
  if (placementGroupId !== null) ids.add(placementGroupId);
  return ids;
}

/**
 * The zones whose volumes draw: the enabled zones **union** every drawable
 * group's target `zoneIds`.
 *
 * A group's non-empty target overrides each zone's own `enabled`
 * (`camera_placement.md` §3.1.2), so a globally disabled zone that a group targets
 * is still the region that group's pool is being built into — hide its box and the
 * scatter floats in nothing. This governs **drawing** only; what is *counted*
 * still follows the enabled zones alone (`sampling_volumes.md` §7.3), which is
 * exactly the mismatch that makes an unticked zone row with a drawn box correct
 * rather than a bug.
 */
export function visibleZoneIds(
  zones: readonly Zone[],
  groups: readonly ConstraintGroup[],
  drawable: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set(zones.filter((z) => z.enabled).map((z) => z.id));
  for (const group of groups) {
    if (drawable.has(group.id)) for (const id of group.zoneIds) ids.add(id);
  }
  return ids;
}
