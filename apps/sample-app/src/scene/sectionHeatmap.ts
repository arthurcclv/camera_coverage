/**
 * Section model + column aggregation + colormap + stats (spec §13). Pure data
 * layer — no Three.js here; `sectionGizmos.ts` consumes `SectionCellGrid` /
 * `sectionHeatmapTextureData` to build the renderable plane.
 *
 * Like `probeVisibility.ts`, this reads the **retained `ChunkResult`s of the most
 * recent completed run** (a third stream consumer alongside the overlay and the
 * probe store, spec §13.4) rather than a fresh ray cast, decoding masks against
 * a snapshot of that run's ordered enabled-camera list.
 */
import { accessor, type ChunkResult, type Vec3, type VoxelAccessor, type WorkspaceGrid } from '@linkervision/camera-coverage-sdk';
import { chunkLocalForGlobalIndex } from './probeVisibility.ts';
import { coverageFraction, popcount32 } from './coverageOverlay.ts';

export type SectionOrientation = 'horizontal' | 'vertical-x' | 'vertical-z';
export type SectionAggregation = 'mean' | 'max' | 'min' | 'blind';

/** A user-placed, axis-aligned coverage slab (spec §13.1). */
export interface Section {
  id: string;
  orientation: SectionOrientation;
  /** Slab bounds in world meters along the collapse axis, `min <= max`. */
  min: number;
  max: number;
  aggregation: SectionAggregation;
  visible: boolean;
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

/** Thickness slider bounds (spec §13.2). */
export const MIN_SECTION_THICKNESS = 0.1;
export const MAX_SECTION_THICKNESS = 5;

/**
 * The collapse axis's world extent for `orientation`, centered and clamped to
 * `MAX_SECTION_THICKNESS` (spec §13.2, §5.5) — the workspace AABB is usually
 * thicker than the thickness slider allows, so "full extent" means as thick as
 * the slider permits, centered on the axis, rather than the raw AABB span.
 */
export function defaultRangeForOrientation(
  worldMin: Vec3,
  worldMax: Vec3,
  orientation: SectionOrientation,
): { min: number; max: number } {
  const { min, max } = collapseAxisExtent(worldMin, worldMax, orientation);
  const center = (min + max) / 2;
  const half = Math.min(max - min, MAX_SECTION_THICKNESS) / 2;
  return { min: center - half, max: center + half };
}

/** A new section: Horizontal, full (clamped) extent of the workspace AABB (spec §5.5). */
export function defaultSection(id: string, worldMin: Vec3, worldMax: Vec3): Section {
  const { min, max } = defaultRangeForOrientation(worldMin, worldMax, 'horizontal');
  return { id, orientation: 'horizontal', min, max, aggregation: 'mean', visible: true };
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
  /** False ("black") if any voxel in the column was invalid. */
  valid: boolean;
  meanFraction: number;
  maxFraction: number;
  minFraction: number;
  /** Share of the column's voxels that are blind (mask == 0). */
  blindFraction: number;
  /** OR of every voxel's mask along the column, one word per element. */
  seenWords: Uint32Array;
}

export interface SectionCellGrid {
  /** In-plane texture dimensions: column count (a) × row count (b). */
  dimsA: number;
  dimsB: number;
  /** Row-major: index = a + dimsA * b. */
  cells: SectionCellStats[];
  camWords: number;
  /** Enabled-camera ids in mask-bit order, snapshotted from the retained run. */
  cameraIds: string[];
}

/**
 * Aggregate every in-plane column of the slab into a `SectionCellGrid` (spec
 * §13.3). `accessors` must have one `VoxelAccessor` per retained chunk id.
 */
export function computeSectionCells(
  grid: Pick<WorkspaceGrid, 'worldMin' | 'voxelSize' | 'gridDims'>,
  accessors: ReadonlyMap<number, VoxelAccessor>,
  cameraIds: string[],
  camWords: number,
  section: Pick<Section, 'orientation' | 'min' | 'max'>,
): SectionCellGrid {
  const { collapseAxis, axisA, axisB } = axisMapping(section.orientation);
  const dimsA = grid.gridDims[axisA];
  const dimsB = grid.gridDims[axisB];
  const { start, end } = axisIndexRange(grid, collapseAxis, section.min, section.max);

  const cells: SectionCellStats[] = new Array(dimsA * dimsB);
  const g: [number, number, number] = [0, 0, 0];

  for (let b = 0; b < dimsB; b++) {
    g[axisB] = b;
    for (let a = 0; a < dimsA; a++) {
      g[axisA] = a;

      let allValid = true;
      let sum = 0;
      let max = -Infinity;
      let min = Infinity;
      let blindCount = 0;
      let count = 0;
      const seenWords = new Uint32Array(camWords);

      for (let c = start; c <= end; c++) {
        g[collapseAxis] = c;
        const loc = chunkLocalForGlobalIndex(grid as WorkspaceGrid, g[0], g[1], g[2]);
        const acc = loc ? accessors.get(loc.chunkId) : undefined;
        if (!loc || !acc || !acc.isValid(loc.i, loc.j, loc.k)) {
          allValid = false;
          break;
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

      const idx = a + dimsA * b;
      cells[idx] = allValid && count > 0
        ? {
            valid: true,
            meanFraction: sum / count,
            maxFraction: max,
            minFraction: min,
            blindFraction: blindCount / count,
            seenWords,
          }
        : { valid: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(camWords) };
    }
  }

  return { dimsA, dimsB, cells, camWords, cameraIds };
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

// --- Turbo-style colormap (spec §13.5): dark blue (0) through cyan, green,
// yellow, orange, to red (1). Piecewise-linear over a fixed set of control
// points rather than a fitted polynomial, so the curve is exact-by-construction
// and easy to verify (see test/sectionHeatmap.test.ts). -----------------------
const TURBO_STOPS: [number, number, number][] = [
  [0.19, 0.07, 0.23], // 0.00 — dark blue/violet
  [0.16, 0.40, 0.85], // 0.14 — blue
  [0.14, 0.65, 0.86], // 0.29 — cyan
  [0.17, 0.82, 0.56], // 0.43 — teal-green
  [0.52, 0.86, 0.27], // 0.57 — green
  [0.86, 0.80, 0.20], // 0.71 — yellow
  [0.97, 0.55, 0.17], // 0.86 — orange
  [0.62, 0.09, 0.06], // 1.00 — dark red
];

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** CSS `linear-gradient` string over the same control points, for the legend bar (spec §13.6). */
export function turboCssGradient(): string {
  const n = TURBO_STOPS.length - 1;
  const stops = TURBO_STOPS.map(([r, g, b], i) => {
    const pct = (i / n) * 100;
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}) ${pct}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Turbo-style colormap: value 0..1 -> RGB components 0..1 (spec §13.5). */
export function turboColormap(t: number): [number, number, number] {
  const x = clamp01(t) * (TURBO_STOPS.length - 1);
  const i0 = Math.min(TURBO_STOPS.length - 2, Math.floor(x));
  const i1 = i0 + 1;
  const f = x - i0;
  const a = TURBO_STOPS[i0];
  const b = TURBO_STOPS[i1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * RGBA8 texture data for a cell grid (spec §13.5): invalid cells are pure
 * black, colored cells map their display value through Turbo. Row-major,
 * matching `SectionCellGrid`'s cell order (bottom-to-top in texture-space,
 * left as the caller's `THREE.DataTexture` flip convention to handle).
 */
export function sectionHeatmapTextureData(grid: SectionCellGrid, aggregation: SectionAggregation): Uint8Array {
  const data = new Uint8Array(grid.cells.length * 4);
  for (let i = 0; i < grid.cells.length; i++) {
    const cell = grid.cells[i];
    const o = i * 4;
    if (!cell.valid) {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 255;
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
  totalCells: number;
  validCells: number;
  invalidCells: number;
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
  let sum = 0;
  let blindCells = 0;
  let min = Infinity;
  let max = -Infinity;
  const seenCounts = new Array(cameraIds.length).fill(0) as number[];

  for (const cell of cells) {
    if (!cell.valid) continue;
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

  const totalCells = cells.length;
  return {
    totalCells,
    validCells,
    invalidCells: totalCells - validCells,
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

  /** Compute a section's current cell grid, or null before any run is retained. */
  computeCells(section: Pick<Section, 'orientation' | 'min' | 'max'>): SectionCellGrid | null {
    if (!this.grid) return null;
    const accessors = new Map<number, VoxelAccessor>();
    for (const chunkId of this.chunks.keys()) {
      const acc = this.accessorFor(chunkId);
      if (acc) accessors.set(chunkId, acc);
    }
    return computeSectionCells(this.grid, accessors, this.cameraIds, this.camWords, section);
  }
}
