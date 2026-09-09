/**
 * Pure entity-duplication logic for the hierarchy "Duplicate" context menu
 * (spec §5.5). Each helper produces a deep verbatim copy of the source entity
 * with the next free id (same id prefix), coincident with the original. A camera's
 * `enabled` state (spec §5.4) rides on the entity, so the verbatim copy inherits it
 * for free. App-level side effects — selecting the copy and the stale-marking that
 * flows from the state setters — stay in `App.tsx`; this module is the pure, testable
 * core.
 */
import type { SceneCamera } from '../cameras/camera.ts';
import type { Probe } from './probeVisibility.ts';
import type { Section } from './sectionHeatmap.ts';
import type { SamplingVolume, Zone } from './samplingVolumes.ts';
import type { CameraConstraint, ConstraintGroup } from '../placement/region.ts';
import type { SplatObject } from './splats.ts';

/** Next free `prefix-N` id given the existing ids (spec §5.5). */
export function nextFreeId(prefix: string, ids: string[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

/** Verbatim copy of camera `id` with the next free `cam-N` id, or null if absent. */
export function duplicateCamera(cameras: SceneCamera[], id: string): SceneCamera | null {
  const src = cameras.find((c) => c.id === id);
  if (!src) return null;
  return { ...src, id: nextFreeId('cam', cameras.map((c) => c.id)) };
}

/** Verbatim copy of probe `id` with the next free `probe-N` id, or null if absent. */
export function duplicateProbe(probes: Probe[], id: string): Probe | null {
  const src = probes.find((p) => p.id === id);
  if (!src) return null;
  return { ...src, id: nextFreeId('probe', probes.map((p) => p.id)) };
}

/**
 * Verbatim copy of section `id` with the next free `section-N` id, or null if
 * absent. Clip state lives app-level (§13.9), not on the record, so it never
 * transfers — the copy is created not clipping.
 */
export function duplicateSection(sections: Section[], id: string): Section | null {
  const src = sections.find((s) => s.id === id);
  if (!src) return null;
  return { ...src, id: nextFreeId('section', sections.map((s) => s.id)) };
}

/**
 * Verbatim copy of volume `id` with the next free `volume-N` id, in the *same*
 * zone as the original (§5.5), or null if absent.
 */
export function duplicateVolume(volumes: SamplingVolume[], id: string): SamplingVolume | null {
  const src = volumes.find((v) => v.id === id);
  if (!src) return null;
  return { ...src, id: nextFreeId('volume', volumes.map((v) => v.id)) };
}

/**
 * Deep copy of zone `id`: a new zone (next free `zone-N`, original `enabled`
 * preserved) plus fresh copies of all its volumes (each with a new `volume-N` id,
 * referencing the new zone). Returns null if the zone is absent.
 */
export function duplicateZone(
  zones: Zone[],
  volumes: SamplingVolume[],
  id: string,
): { zone: Zone; volumes: SamplingVolume[] } | null {
  const src = zones.find((z) => z.id === id);
  if (!src) return null;
  const newZoneId = nextFreeId('zone', zones.map((z) => z.id));
  const existingVolIds = volumes.map((v) => v.id);
  const newVolumes = volumes
    .filter((v) => v.zoneId === id)
    .map((v) => {
      const volId = nextFreeId('volume', existingVolIds);
      existingVolIds.push(volId);
      return { ...v, id: volId, zoneId: newZoneId };
    });
  return { zone: { ...src, id: newZoneId }, volumes: newVolumes };
}

/** Verbatim copy of constraint `id`, in the **same group**, or null if absent. */
export function duplicateConstraint(
  constraints: CameraConstraint[],
  id: string,
): CameraConstraint | null {
  const src = constraints.find((c) => c.id === id);
  if (!src) return null;
  const copy = { ...src, id: nextFreeId('con', constraints.map((c) => c.id)) };
  // Deep-copy the only nested payload a constraint has, so dragging one
  // polyline's vertices cannot move the other's (`camera_placement.md` §7).
  return copy.kind === 'polyline' ? { ...copy, points: copy.points.map((p) => [...p] as typeof p) } : copy;
}

/**
 * Deep copy of constraint group `id`: a new group (next free `cg-N`, carrying
 * the camera template, pool size and strategy verbatim) plus fresh copies of all its
 * constraints. Returns null if the group is absent.
 *
 * The copy holds **no pool and no search result** — those are derived from the
 * scene, not properties of the entity (`camera_placement.md` §3.3.1, §7), and
 * they live in the placement session rather than in the document anyway.
 */
export function duplicateConstraintGroup(
  groups: ConstraintGroup[],
  constraints: CameraConstraint[],
  id: string,
): { group: ConstraintGroup; constraints: CameraConstraint[] } | null {
  const src = groups.find((g) => g.id === id);
  if (!src) return null;
  const newGroupId = nextFreeId('cg', groups.map((g) => g.id));
  const existingIds = constraints.map((c) => c.id);
  const copies = constraints
    .filter((c) => c.groupId === id)
    .map((c) => {
      const conId = nextFreeId('con', existingIds);
      existingIds.push(conId);
      const copy = { ...c, id: conId, groupId: newGroupId };
      return copy.kind === 'polyline' ? { ...copy, points: copy.points.map((p) => [...p] as typeof p) } : copy;
    });
  // `zoneIds` is copied, not shared: the duplicate plans for the same place
  // (`camera_placement.md` §7), but editing one group's list must not edit the
  // other's.
  return { group: { ...src, id: newGroupId, zoneIds: [...src.zoneIds] }, constraints: copies };
}

/**
 * Verbatim copy of splat `id` with the next free `splat-N` id, or null if
 * absent (`gaussian_splats.md` §6.4).
 *
 * Carries **every** property, `src` included — so the copy is labelled by the
 * same filename (§2.3), reads as an obvious duplicate rather than an unrelated
 * second capture, and **shares the original's decode** (§3.3): duplicating to
 * compare two registrations of one capture costs a row, not a second copy of a
 * 400 MB capture in memory. `position`/`rotation` are copied out so moving one
 * row's gizmo cannot move the other's.
 */
export function duplicateSplat(splats: SplatObject[], id: string): SplatObject | null {
  const src = splats.find((s) => s.id === id);
  if (!src) return null;
  return {
    ...src,
    id: nextFreeId('splat', splats.map((s) => s.id)),
    position: [...src.position] as SplatObject['position'],
    rotation: [...src.rotation] as SplatObject['rotation'],
  };
}
