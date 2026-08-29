/**
 * The app's aggregation descriptor (spec §3.3): everything the UI derives from a
 * coverage run, expressed in the SDK's four domain-neutral primitives so the
 * reduction happens next to the masks instead of on the main thread.
 *
 * This module is the whole mapping, in one place, in both directions — the
 * descriptor going out and the index coming back. Splitting it across the four
 * consumers is what would let a zone's group index and the group the results are
 * read from drift apart, and that drift reads as a plausible wrong number rather
 * than a crash.
 *
 * | App concept | SDK primitive |
 * |---|---|
 * | sampling volume | a `region` (OBB, exact under rotation) |
 * | zone            | a `group` its volumes declare |
 * | marked set      | the group **enabled** zones' volumes also declare, plus `maskRegions` |
 * | section         | a `columns` slab |
 * | overlay         | `leafCounts` |
 * | probe           | a `probes` entry |
 */
import type {
  AggregateRegion,
  AggregateSlab,
  AggregateSpec,
  Vec3,
} from '@linkervision/camera-coverage-sdk';
import {
  MAX_AGGREGATE_GROUPS,
  MAX_AGGREGATE_PROBES,
  MAX_AGGREGATE_REGIONS,
  MAX_AGGREGATE_SLABS,
  WorkspaceGrid,
} from '@linkervision/camera-coverage-sdk';
import type { SamplingVolume, Zone } from './samplingVolumes.ts';
import type { Section } from './sectionHeatmap.ts';
import { axisIndexRange, axisMapping } from './sectionHeatmap.ts';
import type { Probe } from './probeVisibility.ts';

/**
 * The group index carrying the marked set — the union of the **enabled** zones'
 * volumes (`sampling_volumes.md` §7.3). It takes the last slot so zone *i* can
 * simply be group *i*, which is what keeps the descriptor and the readback in
 * step without a lookup table.
 */
export const MARKED_GROUP = MAX_AGGREGATE_GROUPS - 1;

/** Zones beyond this share no group and cannot be summarized (spec §3.3). */
export const MAX_ZONES = MARKED_GROUP;

/**
 * Every §3.3 cap, in one place, sourced from the SDK's own exports rather than
 * re-typed here — a local copy that drifted from `MAX_AGGREGATE_SLABS` would
 * either drop a section the SDK would have accepted or hand it one too many and
 * throw, and neither reads as a cap problem at the call site.
 */
export const CAPS = {
  zones: MAX_ZONES,
  volumes: MAX_AGGREGATE_REGIONS,
  sections: MAX_AGGREGATE_SLABS,
  probes: MAX_AGGREGATE_PROBES,
} as const;

export type CapKind = keyof typeof CAPS;

/** One kind of entity that overflowed its §3.3 cap and was dropped. */
export interface CapWarning {
  kind: CapKind;
  cap: number;
  requested: number;
  dropped: number;
}

/** The §11 status-area line for a cap overflow. */
export function capWarningMessage(w: CapWarning): string {
  return `${w.requested} ${w.kind} exceeds the limit of ${w.cap}; ${w.dropped} dropped from the coverage summary.`;
}

export interface AggregateIndex {
  /** Zone id → its group index. Zones past {@link MAX_ZONES} are absent. */
  zoneGroup: Map<string, number>;
  /** Section id → its slab index in `spec.columns`. Sections past the cap are absent. */
  sectionSlab: Map<string, number>;
  /** Probe id → its index in `spec.probes`. Probes past the cap are absent. */
  probeIndex: Map<string, number>;
  /** Whether any zone declared the marked group — i.e. the filter is live. */
  marked: boolean;
}

/** A descriptor and the index that reads its results back — never separated. */
export interface AggregateDescriptor {
  spec: AggregateSpec;
  index: AggregateIndex;
  /** Empty on the normal path; one entry per §3.3 cap the scene overflowed. */
  warnings: CapWarning[];
}

export interface AggregateInputs {
  grid: WorkspaceGrid;
  zones: Zone[];
  volumes: SamplingVolume[];
  sections: Section[];
  probes: Probe[];
  /** `useZones && volumes.length > 0` — the marked set is meaningless otherwise. */
  samplingActive: boolean;
}

/**
 * Build the descriptor and the index that reads its results back.
 *
 * Over-cap entities are **dropped from the descriptor, never clamped into a
 * neighbour's slot** (spec §3.3): a section that silently aggregated another
 * section's column is exactly the plausible wrong number this descriptor exists
 * to avoid, and failing the build outright would take every other panel down
 * with it. So the index omits them, every read is `?? null`, and each drop is
 * reported in `warnings` for §11 to surface.
 */
export function buildAggregateSpec(input: AggregateInputs): AggregateDescriptor {
  const { grid, zones, volumes, sections, probes, samplingActive } = input;
  const warnings: CapWarning[] = [];
  const capped = <T,>(kind: CapKind, items: T[]): T[] => {
    const cap = CAPS[kind];
    if (items.length > cap) {
      warnings.push({ kind, cap, requested: items.length, dropped: items.length - cap });
    }
    return items.slice(0, cap);
  };

  const keptZones = capped('zones', zones);
  const zoneGroup = new Map<string, number>();
  keptZones.forEach((z, i) => zoneGroup.set(z.id, i));
  // Zone lookup by id, built once. `zones.find` inside the volume loop below is
  // O(zones × volumes), and at the caps that is 64 × 31 scans per descriptor
  // edit — on the drag path, per frame.
  const zoneById = new Map(keptZones.map((z) => [z.id, z]));

  // Volume order is the descriptor's region order and never changes within a
  // build, so `maskRegions` can name regions by position.
  const regions: AggregateRegion[] = [];
  const markedRegions: number[] = [];
  for (const v of capped('volumes', volumes)) {
    const group = zoneGroup.get(v.zoneId);
    if (group === undefined) continue; // orphan volume, or a zone past the cap
    const zone = zoneById.get(v.zoneId)!;
    const groups = [group];
    if (samplingActive && zone.enabled) {
      groups.push(MARKED_GROUP);
      markedRegions.push(regions.length);
    }
    regions.push({
      center: v.position,
      rotation: v.rotation,
      halfSize: [v.size[0] / 2, v.size[1] / 2, v.size[2] / 2],
      groups,
    });
  }

  // The filter is the enabled zones' volumes. With no zone enabled it stays
  // empty, which the SDK reads as "no filter" — the same full-volume fallback
  // the app had before (`sampling_volumes.md` §7.3).
  const maskRegions = markedRegions;

  const sectionSlab = new Map<string, number>();
  const columns: AggregateSlab[] = [];
  for (const s of capped('sections', sections)) {
    const slab = slabForSection(grid, s, maskRegions);
    if (!slab) continue;
    sectionSlab.set(s.id, columns.length);
    columns.push(slab);
  }

  const probeIndex = new Map<string, number>();
  const probePoints: Vec3[] = [];
  for (const p of capped('probes', probes)) {
    probeIndex.set(p.id, probePoints.length);
    probePoints.push(p.position);
  }

  const spec: AggregateSpec = {
    regions,
    columns,
    // Always requested: the overlay needs a camera count per voxel on every run,
    // and it is the one output whose absence would leave the viewport blank.
    leafCounts: { maskRegions: regions.length > 0 ? maskRegions : [] },
    probes: probePoints,
  };

  return {
    spec,
    index: {
      zoneGroup,
      sectionSlab,
      probeIndex,
      marked: maskRegions.length > 0,
    },
    warnings,
  };
}

/**
 * One section → one slab. The collapse axis comes from the orientation and the
 * ranges from the footprint of spec §13.2, converted to the **global** voxel
 * indices the SDK's slabs are expressed in.
 */
function slabForSection(
  grid: WorkspaceGrid,
  section: Section,
  maskRegions: number[],
): AggregateSlab | null {
  const { collapseAxis, axisA, axisB } = axisMapping(section.orientation);
  const rangeA = axisIndexRange(grid, axisA, section.minA, section.maxA);
  const rangeB = axisIndexRange(grid, axisB, section.minB, section.maxB);
  const rangeC = axisIndexRange(grid, collapseAxis, section.min, section.max);

  const range: AggregateSlab['range'] = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  range[axisA] = [rangeA.start, rangeA.end];
  range[axisB] = [rangeB.start, rangeB.end];
  range[collapseAxis] = [rangeC.start, rangeC.end];

  return { axis: collapseAxis, range, maskRegions };
}

/**
 * The number of voxels a section's column spans — the denominator the app needs
 * to tell "no chunk covered these" from "every voxel here was an obstacle"
 * (spec §13.4). The SDK reports what it counted, never what was missing.
 */
export function sectionColumnLength(grid: WorkspaceGrid, section: Section): number {
  const { collapseAxis } = axisMapping(section.orientation);
  const r = axisIndexRange(grid, collapseAxis, section.min, section.max);
  return r.end - r.start + 1;
}
