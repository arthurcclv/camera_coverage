/**
 * Section model + column aggregation + stats (spec §13). Pure data layer — no
 * Three.js here; `sectionGizmos.ts` consumes `SectionCellGrid` /
 * `sectionHeatmapTextureData` to build the renderable plane. The shared Turbo
 * colormap and the legend-scale builders live in `heatmapLegend.ts`; this module
 * imports `turboColormap` for the heatmap texture and re-uses it there only.
 *
 * A section is one `columns` slab of the run's aggregation descriptor (spec §3.3,
 * §13.4): the reduction runs in the worker, next to the masks, and this module
 * turns the merged per-cell accumulator into the `SectionCellGrid` the renderer
 * and the stats panel read.
 */
import { COLUMN_MIN_EMPTY, type ColumnAccum, type Vec3, type WorkspaceGrid } from '@linkervision/camera-coverage-sdk';
import { turboColormap } from './heatmapLegend.ts';
import { maskBitSet, type RunCameras } from './runCameras.ts';

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
/**
 * Whether a slab's in-plane axes arrive transposed relative to the section's own
 * `axisA`/`axisB`. The SDK numbers a slab's plane axes in **ascending** order; a
 * `vertical-x` section spans Z×Y, which is descending (spec §3.3).
 *
 * Derived from {@link axisMapping}, never carried alongside it: the two would
 * be the same fact stored twice, and the failure mode of them disagreeing is a
 * silently mirrored heatmap rather than anything that throws.
 */
export function slabTransposed(orientation: SectionOrientation): boolean {
  const { axisA, axisB } = axisMapping(orientation);
  return axisA > axisB;
}

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

/** Everything one section's cell grid is derived from (spec §13.3, §13.4). */
export interface CellGridInput {
  grid: Pick<WorkspaceGrid, 'worldMin' | 'voxelSize' | 'gridDims'>;
  section: Pick<Section, 'orientation' | 'min' | 'max' | 'minA' | 'maxA' | 'minB' | 'maxB'>;
  /** The merged slab for this section, across every chunk of the run. */
  acc: ColumnAccum;
  camWords: number;
  cams: RunCameras;
  /** Voxels the collapse axis spans — the denominator for "no chunk covered this". */
  columnLength: number;
}

/**
 * Euler rotation (radians, XYZ order) for a section's heatmap plane group
 * (`sectionGizmos.ts`), chosen so the heatmap's in-plane axes map to
 * **increasing** world axisA/axisB — not mirrored. This matters because
 * `PlaneGeometry`'s UV increases with local X/Y, `DataTexture` defaults to
 * `flipY = false` (texture row/column 0 = data index 0 = the *smallest*
 * axisA/axisB index per `cellGridFromColumns`), and a single-axis rotation has
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
  /** Mask-bit index of each `cameraIds` entry (spec §5.4) — not the array index. */
  cameraBits: number[];
  /**
   * Grid-aligned world extent of the selected columns along `axisA`/`axisB`
   * (spec §13.3): the footprint snapped to voxel-column boundaries, so the
   * heatmap plane can be sized/positioned to span exactly the drawn cells.
   */
  extentA: { min: number; max: number };
  extentB: { min: number; max: number };
}

/**
 * Turn a section's merged column accumulator into its cell grid (spec §13.3,
 * §13.4).
 *
 * Two things happen here that the SDK deliberately does not do:
 *
 * **Fractions are derived, not accumulated.** Every value is
 * `popcount / enabledCameras` over a denominator constant for the run, so the
 * aggregation sums integer popcounts and the division happens once, here. That is
 * exact rather than an approximation of a float reduction — and it is what makes
 * the same numbers come back bit-identical from the GPU (SDK spec §19.2).
 *
 * **Cells are classified here.** The accumulator reports what it *counted*;
 * "no data" is what it did **not** — a column longer than `valid + obstacle +
 * filtered` contains voxels no chunk covered. §13.3's precedence (valid data wins
 * → colored; else no-data/empty → transparent; else all-obstacle → black) is the
 * app's, so it stays in the app.
 *
 * The in-plane axes are un-swapped for `vertical-x` per {@link slabTransposed},
 * which is derived from the orientation here rather than passed in.
 */
export function cellGridFromColumns(input: CellGridInput): SectionCellGrid {
  const { grid, section, acc, camWords, cams, columnLength } = input;
  const transposed = slabTransposed(section.orientation);
  const { axisA, axisB } = axisMapping(section.orientation);
  const rangeA = axisIndexRange(grid, axisA, section.minA, section.maxA);
  const rangeB = axisIndexRange(grid, axisB, section.minB, section.maxB);
  const dimsA = transposed ? acc.dimsB : acc.dimsA;
  const dimsB = transposed ? acc.dimsA : acc.dimsB;
  const denom = Math.max(1, cams.ids.length);

  const cells: SectionCellStats[] = new Array(dimsA * dimsB);
  for (let b = 0; b < dimsB; b++) {
    for (let a = 0; a < dimsA; a++) {
      const src = transposed ? b + acc.dimsA * a : a + acc.dimsA * b;
      const valid = acc.validCount[src];
      const obstacle = acc.obstacleCount[src];
      const filtered = acc.filteredCount[src];
      const noData = columnLength - (valid + obstacle + filtered) > 0;
      const idx = a + dimsA * b;

      if (valid > 0) {
        const min = acc.camCountMin[src];
        cells[idx] = {
          valid: true,
          black: false,
          meanFraction: clamp01(acc.camCountSum[src] / (valid * denom)),
          maxFraction: clamp01(acc.camCountMax[src] / denom),
          // The empty sentinel cannot appear alongside `valid > 0`, but reading
          // it as a coverage of 255/denom if it ever did would be a silently
          // saturated cell rather than a visible one.
          minFraction: min === COLUMN_MIN_EMPTY ? 0 : clamp01(min / denom),
          blindFraction: acc.blindCount[src] / valid,
          seenWords: acc.seenWords.slice(src * camWords, (src + 1) * camWords),
        };
      } else {
        cells[idx] = {
          valid: false,
          black: obstacle > 0 && !noData,
          meanFraction: 0,
          maxFraction: 0,
          minFraction: 0,
          blindFraction: 0,
          seenWords: new Uint32Array(camWords),
        };
      }
    }
  }

  return {
    dimsA,
    dimsB,
    cells,
    camWords,
    cameraIds: cams.ids,
    cameraBits: cams.bits,
    extentA: {
      min: grid.worldMin[axisA] + rangeA.start * grid.voxelSize,
      max: grid.worldMin[axisA] + (rangeA.end + 1) * grid.voxelSize,
    },
    extentB: {
      min: grid.worldMin[axisB] + rangeB.start * grid.voxelSize,
      max: grid.worldMin[axisB] + (rangeB.end + 1) * grid.voxelSize,
    },
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
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
  const { cells, cameraIds, cameraBits, camWords } = grid;
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
      if (maskBitSet((w) => cell.seenWords[w], camWords, cameraBits[n])) seenCounts[n]++;
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
