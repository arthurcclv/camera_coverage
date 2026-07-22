/**
 * Pure entity-duplication logic for the hierarchy "Duplicate" context menu
 * (spec §5.5). Each helper produces a deep verbatim copy of the source entity
 * with the next free id (same id prefix), coincident with the original. App-level
 * side effects — selecting the copy, inheriting a camera's disabled state, and the
 * stale-marking that flows from the state setters — stay in `App.tsx`; this module
 * is the pure, testable core.
 */
import type { SceneCamera } from '../cameras/camera.ts';
import type { Probe } from './probeVisibility.ts';
import type { Section } from './sectionHeatmap.ts';
import type { SamplingVolume, Zone } from './samplingVolumes.ts';

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
