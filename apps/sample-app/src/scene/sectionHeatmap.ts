/**
 * Section model + column aggregation + stats (spec §13). Pure data layer — no
 * Three.js here; `sectionGizmos.ts` consumes `SectionCellGrid` /
 * `sectionHeatmapTextureData` to build the renderable plane. The shared Turbo
 * colormap and the legend-scale builders live in `heatmapLegend.ts`; this module
 * imports `turboColormap` for the heatmap texture and re-uses it there only.
 *
 * Like `probeVisibility.ts`, this reads the **retained `ChunkResult`s of the most
 * recent completed run** (a third stream consumer alongside the overlay and the
 * probe store, spec §13.4) rather than a fresh ray cast, decoding masks against
 * a snapshot of that run's ordered enabled-camera list.
 */
import { accessor, type ChunkResult, type Vec3, type VoxelAccessor, type WorkspaceGrid } from '@linkervision/camera-coverage-sdk';
import { chunkLocalForGlobalIndex } from './probeVisibility.ts';
import { coverageFraction, popcount32 } from './coverageOverlay.ts';
import { turboColormap } from './heatmapLegend.ts';
import type { MarkedFilter } from './samplingVolumes.ts';

export type SectionOrientation = 'horizontal' | 'vertical-x' | 'vertical-z';
export type SectionAggregation = 'mean' | 'max' | 'min' | 'blind';

/** A user-placed, axis-aligned coverage box (spec §13.1). */
export interface Section {
  id: string;
  orientation: SectionOrientation;
  /** Thickness bounds in world meters along the collapse axis, `min <= max`. */
  min: number;
  max: number;
  /** Footprint bounds in world meters along in-plane `axisA`, `minA <= maxA` (spec §13.1). */
  minA: number;
  maxA: number;
  /** Footprint bounds in world meters along in-plane `axisB`, `minB <= maxB` (spec §13.1). */
  minB: number;
  maxB: number;
  aggregation: SectionAggregation;
  /** Whether this section's heatmap is drawn/aggregated (subject to the master
   * layer toggle, spec §2.4). The per-entity analog of a camera's enabled state. */
  enabled: boolean;
  /** Total width (world m) of the clip band, centered on the cut plane
   * `(min+max)/2` (spec §13.9). Clamped to `[MIN_CLIP_RANGE, collapse-axis extent]`. */
  clipRange: number;
  /** User-editable display label (§13.1, §5.6); blank → falls back to `Section N`. */
  name: string;
}

/** The default `Section N` label derived from a `section-N` id (§5.6). */
export function defaultSectionName(id: string): string {
  const m = /^section-(\d+)$/.exec(id);
  return m ? `Section ${m[1]}` : id;
}

/**
 * The label to display for a section (§5.6): the trimmed `name`, or the default
 * `Section N` when blank/all-whitespace. Never returns an empty string.
 */
export function sectionLabel(section: Section): string {
  const trimmed = section.name.trim();
  return trimmed.length > 0 ? trimmed : defaultSectionName(section.id);
}

export const SECTION_ORIENTATIONS: SectionOrientation[] = ['horizontal', 'vertical-x', 'vertical-z'];
export const SECTION_AGGREGATIONS: SectionAggregation[] = ['mean', 'max', 'min', 'blind'];

interface AxisMapping {
  /** World axis (0=X,1=Y,2=Z) that collapses — the section normal. */
  collapseAxis: 0 | 1 | 2;
  /** World axis for in-plane column 'a' (heatmap texture X). */
  axisA: 0 | 1 | 2;
  /** World axis for in-plane row 'b' (heatmap texture Y). */
  axisB: 0 | 1 | 2;
}

/** Collapse axis + in-plane axes for each orientation (spec §13.1). */
export function axisMapping(orientation: SectionOrientation): AxisMapping {
  switch (orientation) {
    case 'horizontal':
      return { collapseAxis: 1, axisA: 0, axisB: 2 }; // collapse Y, span X×Z
    case 'vertical-x':
      return { collapseAxis: 0, axisA: 2, axisB: 1 }; // collapse X, span Z×Y
    case 'vertical-z':
      return { collapseAxis: 2, axisA: 0, axisB: 1 }; // collapse Z, span X×Y
  }
}

/** The world-AABB extent of a section's collapse axis (spec §13.2 range bounds). */
export function collapseAxisExtent(
  worldMin: Vec3,
  worldMax: Vec3,
  orientation: SectionOrientation,
): { min: number; max: number } {
  const { collapseAxis } = axisMapping(orientation);
  return { min: worldMin[collapseAxis], max: worldMax[collapseAxis] };
}

/**
 * Euler rotation (radians, XYZ order) for a section's heatmap plane group
 * (`sectionGizmos.ts`), chosen so the heatmap's in-plane axes map to
 * **increasing** world axisA/axisB — not mirrored. This matters because
 * `PlaneGeometry`'s UV increases with local X/Y, `DataTexture` defaults to
 * `flipY = false` (texture row/column 0 = data index 0 = the *smallest*
 * axisA/axisB index per `computeSectionCells`), and a single-axis rotation has
 * only one degree of freedom — get the sign wrong and the whole heatmap
 * (and, for `horizontal`/`vertical-x`, specifically the in-plane Z axis)
 * renders as a mirror image. Verified in `test/sectionHeatmap.test.ts` against
 * actual `PlaneGeometry` vertex/UV output, not derived by hand alone.
 */
export function sectionPlaneRotation(orientation: SectionOrientation): Vec3 {
  switch (orientation) {
    case 'horizontal':
      return [Math.PI / 2, 0, 0];
    case 'vertical-x':
      return [0, -Math.PI / 2, 0];
    case 'vertical-z':
      return [0, 0, 0];
  }
}

/**
 * Whether the plane group's local +Z (its normal) maps to the *positive* or
 * *negative* world collapse-axis direction under `sectionPlaneRotation` — a
 * single-axis rotation can't un-mirror the in-plane axes without also flipping
 * which way the normal points, so this is needed to keep the min/max bound
 * outlines (offset along local Z in `sectionGizmos.ts`) on the correct side.
 */
export function collapseAxisNormalSign(orientation: SectionOrientation): 1 | -1 {
  switch (orientation) {
    case 'horizontal':
      return -1;
    case 'vertical-x':
      return -1;
    case 'vertical-z':
      return 1;
  }
}

/** The slab's midpoint along its collapse axis — `(min + max) / 2` (spec §13.2). */
export function sectionCenter(section: Pick<Section, 'min' | 'max'>): number {
  return (section.min + section.max) / 2;
}

/** The footprint's midpoint along `axisA` — `(minA + maxA) / 2` (spec §13.2). */
export function sectionCenterA(section: Pick<Section, 'minA' | 'maxA'>): number {
  return (section.minA + section.maxA) / 2;
}

/** The footprint's midpoint along `axisB` — `(minB + maxB) / 2` (spec §13.2). */
export function sectionCenterB(section: Pick<Section, 'minB' | 'maxB'>): number {
  return (section.minB + section.maxB) / 2;
}

/** Thickness slider bounds (spec §13.2). */
export const MIN_SECTION_THICKNESS = 0.1;
export const MAX_SECTION_THICKNESS = 30;

/**
 * A new section's default thickness (spec §13.2) — deliberately independent of
 * `MAX_SECTION_THICKNESS`: sections start as thin slabs the slider can widen.
 */
export const DEFAULT_SECTION_THICKNESS = 5;

/** Footprint (width/height) slider min bound (spec §13.2); the max is per-axis, see `footprintSliderMax`. */
export const MIN_SECTION_FOOTPRINT = 0.1;

/** The world-AABB extents of a section's two in-plane axes (spec §13.2 footprint bounds). */
export function inPlaneExtent(
  worldMin: Vec3,
  worldMax: Vec3,
  orientation: SectionOrientation,
): { a: { min: number; max: number }; b: { min: number; max: number } } {
  const { axisA, axisB } = axisMapping(orientation);
  return {
    a: { min: worldMin[axisA], max: worldMax[axisA] },
    b: { min: worldMin[axisB], max: worldMax[axisB] },
  };
}

/**
 * The footprint (width/height) slider's max along an in-plane axis: the full
 * workspace-AABB extent along that axis (spec §13.2). Never below the min bound.
 */
export function footprintSliderMax(extent: { min: number; max: number }): number {
  return Math.max(MIN_SECTION_FOOTPRINT, extent.max - extent.min);
}

/**
 * The default in-plane footprint for `orientation`: the **full** workspace-AABB
 * extent on both in-plane axes (spec §13.2) — unlike thickness, footprint is not
 * capped, so a new section spans the whole workspace in-plane.
 */
export function defaultFootprintForOrientation(
  worldMin: Vec3,
  worldMax: Vec3,
  orientation: SectionOrientation,
): { minA: number; maxA: number; minB: number; maxB: number } {
  const { a, b } = inPlaneExtent(worldMin, worldMax, orientation);
  return { minA: a.min, maxA: a.max, minB: b.min, maxB: b.max };
}

/**
 * The collapse axis's world extent for `orientation`, centered and clamped to
 * `DEFAULT_SECTION_THICKNESS` (spec §13.2, §5.5) — the workspace AABB is usually
 * thicker than a new section should start, so "full extent" means at most the
 * default thickness, centered on the axis, rather than the raw AABB span. The
 * slider can then widen it up to `MAX_SECTION_THICKNESS`.
 */
export function defaultRangeForOrientation(
  worldMin: Vec3,
  worldMax: Vec3,
  orientation: SectionOrientation,
): { min: number; max: number } {
  const { min, max } = collapseAxisExtent(worldMin, worldMax, orientation);
  const center = (min + max) / 2;
  const half = Math.min(max - min, DEFAULT_SECTION_THICKNESS) / 2;
  return { min: center - half, max: center + half };
}

/** Clip range slider bounds (spec §13.9). The max is dynamic — see `maxClipRange`. */
export const MIN_CLIP_RANGE = 0.1;
/** Default clip band width for a new section (spec §13.9). */
export const DEFAULT_CLIP_RANGE = 2;

/**
 * The clip range slider's max for an orientation: the full workspace-AABB
 * extent along that orientation's collapse axis (spec §13.9). At this width the
 * band spans the whole scene, so nothing is clipped. Never below the min bound.
 */
export function maxClipRange(worldMin: Vec3, worldMax: Vec3, orientation: SectionOrientation): number {
  const { min, max } = collapseAxisExtent(worldMin, worldMax, orientation);
  return Math.max(MIN_CLIP_RANGE, max - min);
}

/**
 * A new section: Horizontal, thickness the full (5 m-clamped) collapse-axis extent,
 * footprint the full workspace-AABB extent on both in-plane axes (spec §5.5, §13.2).
 */
export function defaultSection(id: string, worldMin: Vec3, worldMax: Vec3): Section {
  const { min, max } = defaultRangeForOrientation(worldMin, worldMax, 'horizontal');
  const footprint = defaultFootprintForOrientation(worldMin, worldMax, 'horizontal');
  return {
    id,
    orientation: 'horizontal',
    min,
    max,
    ...footprint,
    aggregation: 'mean',
    enabled: true,
    clipRange: DEFAULT_CLIP_RANGE,
    // Blank name (spec §14.1) — a new section displays as `Section N`.
    name: '',
  };
}

/** A world-space clip band along a section's normal (collapse axis) (spec §13.9). */
export interface ClipBand {
  /** The collapse axis the band is measured along (0=X, 1=Y, 2=Z). */
  axis: 0 | 1 | 2;
  /** Band bounds in world meters along `axis`, `min <= max`. */
  min: number;
  max: number;
}

/**
 * The world-space clip band for a section (spec §13.9). The band is `clipRange`
 * metres wide — clamped to `[MIN_CLIP_RANGE, collapse-axis extent]` — centred on
 * the cut plane `(min+max)/2`, so it follows the slab as it is dragged (§13.8).
 * *Whether* this band is applied is decided by the caller (the scene-level
 * `clipSectionId`, §14.1), not here.
 */
export function sectionClipBand(
  section: Pick<Section, 'orientation' | 'min' | 'max' | 'clipRange'>,
  worldMin: Vec3,
  worldMax: Vec3,
): ClipBand {
  const { collapseAxis } = axisMapping(section.orientation);
  const extent = maxClipRange(worldMin, worldMax, section.orientation);
  const range = Math.min(Math.max(section.clipRange, MIN_CLIP_RANGE), extent);
  const mid = sectionCenter(section);
  return { axis: collapseAxis, min: mid - range / 2, max: mid + range / 2 };
}

/**
 * Global voxel index range on `axis` covered by `[min, max]`, clamped to the
 * grid (spec §13.3: the slab clips the column). Falls back to a single voxel if
 * clamping would otherwise invert the range (defensive against a transient
 * `min > max` while a drag is mid-flight).
 */
export function axisIndexRange(
  grid: Pick<WorkspaceGrid, 'worldMin' | 'voxelSize' | 'gridDims'>,
  axis: 0 | 1 | 2,
  min: number,
  max: number,
): { start: number; end: number } {
  const axisWorldMin = grid.worldMin[axis];
  const axisDim = grid.gridDims[axis];
  let start = Math.floor((min - axisWorldMin) / grid.voxelSize);
  let end = Math.ceil((max - axisWorldMin) / grid.voxelSize) - 1;
  start = Math.max(0, Math.min(axisDim - 1, start));
  end = Math.max(0, Math.min(axisDim - 1, end));
  if (end < start) end = start;
  return { start, end };
}

/** One heatmap cell: the aggregate of one voxel column (spec §13.3). */
export interface SectionCellStats {
  /** True ("colored") if the column holds ≥ 1 in-zone valid voxel with data. */
  valid: boolean;
  /**
   * Only meaningful when `!valid`: `true` = **obstacle** (black — the column is
   * entirely geometry), `false` = **transparent** (no coverage data anywhere in
   * the column: no-data / out-of-region / empty). Spec §13.3.
   */
  black: boolean;
  meanFraction: number;
  maxFraction: number;
  minFraction: number;
  /** Share of the column's voxels that are blind (mask == 0). */
  blindFraction: number;
  /** OR of every voxel's mask along the column, one word per element. */
  seenWords: Uint32Array;
}

export interface SectionCellGrid {
  /** In-plane texture dimensions: selected column count (a) × row count (b), spec §13.3. */
  dimsA: number;
  dimsB: number;
  /** Row-major over the selected sub-rectangle: index = a + dimsA * b. */
  cells: SectionCellStats[];
  camWords: number;
  /** Enabled-camera ids in mask-bit order, snapshotted from the retained run. */
  cameraIds: string[];
  /**
   * Grid-aligned world extent of the selected columns along `axisA`/`axisB`
   * (spec §13.3): the footprint snapped to voxel-column boundaries, so the
   * heatmap plane can be sized/positioned to span exactly the drawn cells.
   */
  extentA: { min: number; max: number };
  extentB: { min: number; max: number };
}

/**
 * Aggregate every in-plane column of the slab into a `SectionCellGrid` (spec
 * §13.3). `accessors` must have one `VoxelAccessor` per retained chunk id.
 *
 * Valid data wins: a column with ≥ 1 in-zone valid voxel is **colored** (aggregating
 * those voxels, ignoring any obstacle/no-data voxels sharing it). Otherwise a column
 * with any no-data voxel — or no in-zone voxel at all — is **transparent**, and a column
 * that is entirely obstacle (no valid, no no-data) is **black** (spec §13.3).
 * When a `marked` filter is supplied (`sampling_volumes.md` §7.3), voxels outside
 * the marked set (the enabled zones' union) are **skipped** — they neither classify
 * the cell nor count toward its aggregation; the cell aggregates only its in-zone
 * valid voxels, and a column with no in-zone voxel at all is **transparent** (spec §13.3).
 */
export function computeSectionCells(
  grid: Pick<WorkspaceGrid, 'worldMin' | 'voxelSize' | 'gridDims'>,
  accessors: ReadonlyMap<number, VoxelAccessor>,
  cameraIds: string[],
  camWords: number,
  section: Pick<Section, 'orientation' | 'min' | 'max'> &
    Partial<Pick<Section, 'minA' | 'maxA' | 'minB' | 'maxB'>>,
  marked: MarkedFilter | null = null,
): SectionCellGrid {
  const { collapseAxis, axisA, axisB } = axisMapping(section.orientation);
  // The footprint (spec §13.2) selects a grid-aligned sub-rectangle of whole
  // voxel columns: only columns inside [minA,maxA]×[minB,maxB] are aggregated,
  // so the texture dims are the selected column counts, not the full grid (§13.3).
  // A missing footprint bound falls back to the whole grid on that axis (the
  // pre-footprint behavior), which the SectionHeatmapStore never relies on but
  // keeps the aggregation callable with just the slab fields.
  const rangeA =
    section.minA !== undefined && section.maxA !== undefined
      ? axisIndexRange(grid, axisA, section.minA, section.maxA)
      : { start: 0, end: grid.gridDims[axisA] - 1 };
  const rangeB =
    section.minB !== undefined && section.maxB !== undefined
      ? axisIndexRange(grid, axisB, section.minB, section.maxB)
      : { start: 0, end: grid.gridDims[axisB] - 1 };
  const dimsA = rangeA.end - rangeA.start + 1;
  const dimsB = rangeB.end - rangeB.start + 1;
  const { start, end } = axisIndexRange(grid, collapseAxis, section.min, section.max);

  const cells: SectionCellStats[] = new Array(dimsA * dimsB);
  const g: [number, number, number] = [0, 0, 0];

  for (let lb = 0; lb < dimsB; lb++) {
    const b = rangeB.start + lb;
    g[axisB] = b;
    for (let la = 0; la < dimsA; la++) {
      const a = rangeA.start + la;
      g[axisA] = a;

      let sum = 0;
      let max = -Infinity;
      let min = Infinity;
      let blindCount = 0;
      let count = 0; // in-zone valid voxels aggregated
      let sawObstacle = false; // in-zone voxel marked invalid by the SDK (wall/box/interior)
      let sawNoData = false; // in-zone voxel with no retained chunk (out of sampled region)
      const seenWords = new Uint32Array(camWords);

      for (let c = start; c <= end; c++) {
        g[collapseAxis] = c;
        // The zone filter is applied **first**, before any validity check: when
        // zones are active the SDK samples only the enabled volumes' neighborhood,
        // so a voxel outside the marked set is unsampled and reads *invalid* —
        // indistinguishable from an obstacle via `isValid` alone. Skipping it here
        // (not classifying) is what keeps a section from blacking/vanishing wherever
        // its column pokes outside a shorter volume (spec §13.3).
        if (
          marked &&
          !marked(
            grid.worldMin[0] + (g[0] + 0.5) * grid.voxelSize,
            grid.worldMin[1] + (g[1] + 0.5) * grid.voxelSize,
            grid.worldMin[2] + (g[2] + 0.5) * grid.voxelSize,
          )
        ) {
          continue;
        }
        const loc = chunkLocalForGlobalIndex(grid as WorkspaceGrid, g[0], g[1], g[2]);
        const acc = loc ? accessors.get(loc.chunkId) : undefined;
        if (!loc || !acc) {
          // No retained chunk at this position — no coverage data (spec §13.3).
          // No-data makes a valueless column transparent, winning over obstacle.
          sawNoData = true;
          continue;
        }
        if (!acc.isValid(loc.i, loc.j, loc.k)) {
          // An in-zone obstacle voxel (wall/box/interior). Ignored here — it only
          // blacks the cell if the whole column turns out to be obstacle (spec §13.3).
          sawObstacle = true;
          continue;
        }
        let camCount = 0;
        for (let w = 0; w < camWords; w++) {
          const word = acc.getMaskWord(loc.i, loc.j, loc.k, w);
          seenWords[w] |= word;
          camCount += popcount32(word);
        }
        const frac = coverageFraction(camCount, cameraIds.length);
        sum += frac;
        if (frac > max) max = frac;
        if (frac < min) min = frac;
        if (camCount === 0) blindCount++;
        count++;
      }

      // Valid data wins → colored; else no-data/empty → transparent; else the
      // column is entirely obstacle → black (spec §13.3, precedence order).
      const idx = la + dimsA * lb;
      cells[idx] = count > 0
        ? {
            valid: true,
            black: false,
            meanFraction: sum / count,
            maxFraction: max,
            minFraction: min,
            blindFraction: blindCount / count,
            seenWords,
          }
        : { valid: false, black: sawObstacle && !sawNoData, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(camWords) };
    }
  }

  // Grid-aligned world extent of the selected columns (spec §13.3): the column
  // start's low edge to the column end's high edge, so the rendered plane spans
  // exactly the drawn cells.
  const extentA = {
    min: grid.worldMin[axisA] + rangeA.start * grid.voxelSize,
    max: grid.worldMin[axisA] + (rangeA.end + 1) * grid.voxelSize,
  };
  const extentB = {
    min: grid.worldMin[axisB] + rangeB.start * grid.voxelSize,
    max: grid.worldMin[axisB] + (rangeB.end + 1) * grid.voxelSize,
  };

  return { dimsA, dimsB, cells, camWords, cameraIds, extentA, extentB };
}

/** The display value a cell contributes to the heatmap for a given aggregation (spec §13.3). */
export function cellDisplayValue(cell: SectionCellStats, aggregation: SectionAggregation): number {
  switch (aggregation) {
    case 'mean':
      return cell.meanFraction;
    case 'max':
      return cell.maxFraction;
    case 'min':
      return cell.minFraction;
    case 'blind':
      return cell.blindFraction;
  }
}

/**
 * Whether the floating section-heatmap legend is shown (spec §2.2, §13.6): the
 * master **Section** layer is visible *and* `clipSectionId` references an existing,
 * **enabled** section that is currently clipping the scene (§13.9). The `enabled`
 * check ties the legend to a heatmap that is actually drawn — a section's heatmap
 * plane renders only when the master toggle is on and that section is enabled
 * (§13.5) — and the existence check guarantees `sections` is non-empty. Purely
 * presentational — it never affects `compute()` or the heatmaps themselves.
 */
export function sectionLegendVisible(
  sectionsVisible: boolean,
  sections: readonly Pick<Section, 'id' | 'enabled'>[],
  clipSectionId: string | null,
): boolean {
  return sectionsVisible && clipSectionId !== null && sections.some((s) => s.id === clipSectionId && s.enabled);
}

/**
 * RGBA8 texture data for a cell grid (spec §13.5): colored cells map their
 * display value through Turbo (opaque), obstacle cells are pure opaque black,
 * and transparent (no-data / empty) cells are fully transparent (alpha 0) so
 * the scene shows through. Row-major, matching `SectionCellGrid`'s cell order
 * (bottom-to-top in texture-space, left as the caller's `THREE.DataTexture`
 * flip convention to handle).
 */
export function sectionHeatmapTextureData(grid: SectionCellGrid, aggregation: SectionAggregation): Uint8Array {
  const data = new Uint8Array(grid.cells.length * 4);
  for (let i = 0; i < grid.cells.length; i++) {
    const cell = grid.cells[i];
    const o = i * 4;
    if (!cell.valid) {
      // Obstacle → opaque black; transparent (no-data/empty) → alpha 0 (spec §13.3/§13.5).
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = cell.black ? 255 : 0;
      continue;
    }
    const [r, g, b] = turboColormap(cellDisplayValue(cell, aggregation));
    data[o] = Math.round(r * 255);
    data[o + 1] = Math.round(g * 255);
    data[o + 2] = Math.round(b * 255);
    data[o + 3] = 255;
  }
  return data;
}

/**
 * Mean of the cell display value (per the section's own aggregation) over
 * colored cells — the number the scene-hierarchy row badge shows (spec §5.5,
 * e.g. "H · mean 47%"). 0 if there are no colored cells.
 */
export function averageDisplayValue(grid: SectionCellGrid, aggregation: SectionAggregation): number {
  let sum = 0;
  let count = 0;
  for (const cell of grid.cells) {
    if (!cell.valid) continue;
    sum += cellDisplayValue(cell, aggregation);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// --- Section stats (spec §13.7) ----------------------------------------------

export interface SectionStats {
  /** Region of interest: colored + obstacle cells (transparent cells excluded, spec §13.7). */
  totalCells: number;
  /** Colored cells (the base for all coverage numbers below). */
  validCells: number;
  /** Obstacle (black) cells — fully-solid columns within the region (spec §13.3). */
  obstacleCells: number;
  /** Mean of colored cells' meanFraction (analog of overallRate). 0 if none. */
  sectionCoverage: number;
  /** Colored cells whose whole column is blind. */
  blindCells: number;
  blindCellsPct: number;
  /** Lowest/highest colored-cell meanFraction. 0 if no colored cells. */
  minCoverage: number;
  maxCoverage: number;
  /** Per enabled camera: fraction of colored cells it sees in >= 1 voxel. */
  perCamera: { id: string; seenFraction: number }[];
}

/** Coverage stats over a section's colored cells, independent of display aggregation (spec §13.7). */
export function computeSectionStats(grid: SectionCellGrid): SectionStats {
  const { cells, cameraIds, camWords } = grid;
  let validCells = 0;
  let obstacleCells = 0;
  let sum = 0;
  let blindCells = 0;
  let min = Infinity;
  let max = -Infinity;
  const seenCounts = new Array(cameraIds.length).fill(0) as number[];

  for (const cell of cells) {
    if (!cell.valid) {
      if (cell.black) obstacleCells++;
      continue;
    }
    validCells++;
    sum += cell.meanFraction;
    if (cell.blindFraction === 1) blindCells++;
    if (cell.meanFraction < min) min = cell.meanFraction;
    if (cell.meanFraction > max) max = cell.meanFraction;
    for (let n = 0; n < cameraIds.length; n++) {
      const word = n >>> 5;
      const bit = n & 31;
      if (word < camWords && ((cell.seenWords[word] >>> bit) & 1) === 1) seenCounts[n]++;
    }
  }

  return {
    totalCells: validCells + obstacleCells,
    validCells,
    obstacleCells,
    sectionCoverage: validCells > 0 ? sum / validCells : 0,
    blindCells,
    blindCellsPct: validCells > 0 ? blindCells / validCells : 0,
    minCoverage: validCells > 0 ? min : 0,
    maxCoverage: validCells > 0 ? max : 0,
    perCamera: cameraIds.map((id, n) => ({ id, seenFraction: validCells > 0 ? seenCounts[n] / validCells : 0 })),
  };
}

// --- Retained-run store (spec §13.4) -----------------------------------------

/**
 * Retains the current run's chunks (like `ProbeVisibility`) and computes cell
 * grids for sections on demand. `VoxelAccessor`s are cached per chunk id since
 * many sections/cells reuse the same chunks within one recompute.
 */
export class SectionHeatmapStore {
  private grid: WorkspaceGrid | null = null;
  private chunks = new Map<number, ChunkResult>();
  private accessorCache = new Map<number, VoxelAccessor>();
  private cameraIds: string[] = [];
  private camWords = 1;

  /** Start retaining a new run's chunks; snapshot its ordered enabled-camera list. */
  reset(grid: WorkspaceGrid, cameraIds: string[]): void {
    this.grid = grid;
    this.cameraIds = [...cameraIds];
    this.chunks.clear();
    this.accessorCache.clear();
    this.camWords = 1;
  }

  /** Retain a streamed chunk (in parallel with the overlay + probe store, spec §13.4). */
  addChunk(result: ChunkResult): void {
    this.chunks.set(result.chunkId, result);
    this.accessorCache.delete(result.chunkId);
    this.camWords = Math.max(this.camWords, result.camWords);
  }

  /** Whether any run has been retained yet. */
  hasRun(): boolean {
    return this.grid !== null;
  }

  /** Discard the retained run so `computeCells()` reads `null` until the next run (spec §14.4). */
  clear(): void {
    this.grid = null;
    this.chunks.clear();
    this.accessorCache.clear();
  }

  private accessorFor(chunkId: number): VoxelAccessor | undefined {
    let acc = this.accessorCache.get(chunkId);
    if (!acc) {
      const chunk = this.chunks.get(chunkId);
      if (!chunk) return undefined;
      acc = accessor(chunk);
      this.accessorCache.set(chunkId, acc);
    }
    return acc;
  }

  /**
   * Compute a section's current cell grid, or null before any run is retained.
   * An optional `marked` filter skips voxels outside the marked set
   * (`sampling_volumes.md` §7.3) — applied client-side, so enabling/disabling a
   * zone re-filters without a recompute.
   */
  computeCells(
    section: Pick<Section, 'orientation' | 'min' | 'max'> &
      Partial<Pick<Section, 'minA' | 'maxA' | 'minB' | 'maxB'>>,
    marked: MarkedFilter | null = null,
  ): SectionCellGrid | null {
    if (!this.grid) return null;
    const accessors = new Map<number, VoxelAccessor>();
    for (const chunkId of this.chunks.keys()) {
      const acc = this.accessorFor(chunkId);
      if (acc) accessors.set(chunkId, acc);
    }
    return computeSectionCells(this.grid, accessors, this.cameraIds, this.camWords, section, marked);
  }
}
