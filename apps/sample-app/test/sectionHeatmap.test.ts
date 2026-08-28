import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorkspaceGrid, type ChunkResult } from '@linkervision/camera-coverage-sdk';
import {
  averageDisplayValue,
  axisIndexRange,
  axisMapping,
  cellDisplayValue,
  collapseAxisExtent,
  collapseAxisNormalSign,
  computeSectionCells,
  computeSectionStats,
  DEFAULT_CLIP_RANGE,
  DEFAULT_SECTION_THICKNESS,
  defaultFootprintForOrientation,
  defaultRangeForOrientation,
  defaultSection,
  defaultSectionName,
  footprintSliderMax,
  inPlaneExtent,
  sectionLabel,
  MAX_SECTION_THICKNESS,
  maxClipRange,
  MIN_CLIP_RANGE,
  MIN_SECTION_FOOTPRINT,
  sectionClipBand,
  SECTION_ORIENTATIONS,
  SectionHeatmapStore,
  sectionCenter,
  sectionCenterA,
  sectionCenterB,
  sectionHeatmapTextureData,
  sectionLegendVisible,
  sectionPlaneRotation,
  type SectionCellGrid,
} from '../src/scene/sectionHeatmap.ts';
import { turboColormap } from '../src/scene/heatmapLegend.ts';
import { accessor } from '@linkervision/camera-coverage-sdk';

// --- axisMapping / collapseAxisExtent / defaultSection (spec §13.1, §5.5) ----

/** Every listed camera enabled, so bit index == list index (spec §5.4). */
const allEnabled = (ids: string[]) => ({ ids, bits: ids.map((_, n) => n) });

test('axisMapping: horizontal collapses Y, spans X×Z', () => {
  assert.deepEqual(axisMapping('horizontal'), { collapseAxis: 1, axisA: 0, axisB: 2 });
});
test('axisMapping: vertical-x collapses X, spans Z×Y', () => {
  assert.deepEqual(axisMapping('vertical-x'), { collapseAxis: 0, axisA: 2, axisB: 1 });
});
test('axisMapping: vertical-z collapses Z, spans X×Y', () => {
  assert.deepEqual(axisMapping('vertical-z'), { collapseAxis: 2, axisA: 0, axisB: 1 });
});

// --- sectionPlaneRotation / collapseAxisNormalSign (regression: the heatmap
// plane must render un-mirrored — a real bug once slipped through here, so
// this replays the actual PlaneGeometry/rotation math rather than trusting
// hand-derived signs, spec §13.5, §13.8) ------------------------------------

test('sectionPlaneRotation: increasing UV maps to increasing world axisA/axisB (never mirrored)', () => {
  for (const orientation of SECTION_ORIENTATIONS) {
    const { axisA, axisB } = axisMapping(orientation);
    const geom = new THREE.PlaneGeometry(2, 2);
    const posAttr = geom.getAttribute('position');
    const uvAttr = geom.getAttribute('uv');

    const group = new THREE.Group();
    group.rotation.set(...sectionPlaneRotation(orientation));
    group.updateMatrixWorld(true);

    // Corners at uv=(0,0) and uv=(1,0): u increases, axisA's world coordinate
    // (computeSectionCells' column index, "a") must increase too.
    let uv00, uv10, uv01;
    for (let i = 0; i < posAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      const world = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(group.matrixWorld);
      if (u === 0 && v === 0) uv00 = world;
      if (u === 1 && v === 0) uv10 = world;
      if (u === 0 && v === 1) uv01 = world;
    }
    assert.ok(uv00 && uv10 && uv01, `${orientation}: expected corners not found`);

    const axisAAt = (v: THREE.Vector3) => [v.x, v.y, v.z][axisA];
    const axisBAt = (v: THREE.Vector3) => [v.x, v.y, v.z][axisB];
    assert.ok(axisAAt(uv10!) > axisAAt(uv00!), `${orientation}: axisA should increase with u`);
    assert.ok(axisBAt(uv01!) > axisBAt(uv00!), `${orientation}: axisB should increase with v`);
  }
});

test('collapseAxisNormalSign: min/max bound outlines land on the correct side of center', () => {
  for (const orientation of SECTION_ORIENTATIONS) {
    const { collapseAxis } = axisMapping(orientation);
    const group = new THREE.Group();
    group.position.set(10, 20, 30); // arbitrary world center
    group.rotation.set(...sectionPlaneRotation(orientation));
    group.updateMatrixWorld(true);

    const halfThickness = 2.5;
    const normalSign = collapseAxisNormalSign(orientation);
    const minWorld = new THREE.Vector3(0, 0, -halfThickness * normalSign).applyMatrix4(group.matrixWorld);
    const maxWorld = new THREE.Vector3(0, 0, halfThickness * normalSign).applyMatrix4(group.matrixWorld);

    const centerOnAxis = [10, 20, 30][collapseAxis];
    const axisOf = (v: THREE.Vector3) => [v.x, v.y, v.z][collapseAxis];
    assert.ok(
      Math.abs(axisOf(minWorld) - (centerOnAxis - halfThickness)) < 1e-9,
      `${orientation}: minOutline should be at center - halfThickness`,
    );
    assert.ok(
      Math.abs(axisOf(maxWorld) - (centerOnAxis + halfThickness)) < 1e-9,
      `${orientation}: maxOutline should be at center + halfThickness`,
    );
  }
});

test('collapseAxisExtent reads the world AABB along the orientation normal', () => {
  assert.deepEqual(collapseAxisExtent([0, -1, 0], [4, 3, 2], 'horizontal'), { min: -1, max: 3 });
  assert.deepEqual(collapseAxisExtent([0, -1, 0], [4, 3, 2], 'vertical-x'), { min: 0, max: 4 });
  assert.deepEqual(collapseAxisExtent([0, -1, 0], [4, 3, 2], 'vertical-z'), { min: 0, max: 2 });
});

test('defaultRangeForOrientation returns the full extent when it fits within the default thickness', () => {
  // Y span is 4 m, under the 5 m default, so it's returned unclamped.
  assert.deepEqual(defaultRangeForOrientation([0, -1, 0], [4, 3, 2], 'horizontal'), { min: -1, max: 3 });
});

test('defaultRangeForOrientation clamps to DEFAULT_SECTION_THICKNESS, centered on the axis (spec §13.2)', () => {
  // Y span is 20 m (worldMin.y=-10, worldMax.y=10), well over the 5 m default;
  // center stays 0, thickness clamps to exactly DEFAULT_SECTION_THICKNESS.
  const { min, max } = defaultRangeForOrientation([0, -10, 0], [4, 10, 2], 'horizontal');
  assert.equal((min + max) / 2, 0);
  assert.equal(max - min, DEFAULT_SECTION_THICKNESS);
});

test('the default thickness is independent of the 30 m slider cap (spec §13.2)', () => {
  // The slider reaches 30 m, but a new section starts at the 5 m default even
  // when the collapse axis is thick enough to allow more.
  assert.equal(MAX_SECTION_THICKNESS, 30);
  assert.ok(DEFAULT_SECTION_THICKNESS < MAX_SECTION_THICKNESS);
  const { min, max } = defaultRangeForOrientation([0, 0, 0], [4, 25, 2], 'horizontal');
  assert.equal(max - min, DEFAULT_SECTION_THICKNESS);
});

test('defaultSection is Horizontal, full (clamped) Y extent, full X×Z footprint, mean aggregation, enabled (spec §5.5, §13.2, §13.9)', () => {
  const s = defaultSection('section-1', [0, -1, 0], [4, 3, 2]);
  assert.deepEqual(s, {
    id: 'section-1',
    orientation: 'horizontal',
    min: -1,
    max: 3,
    // Footprint defaults to the full workspace-AABB extent on both in-plane
    // axes (X and Z for horizontal) — uncapped, unlike thickness (spec §13.2).
    minA: 0,
    maxA: 4,
    minB: 0,
    maxB: 2,
    aggregation: 'mean',
    enabled: true,
    clipRange: 2,
    name: '',
  });
});

// --- footprint helpers (spec §13.2) ------------------------------------------

test('defaultFootprintForOrientation is the FULL (uncapped) in-plane extent per orientation (spec §13.2)', () => {
  const wMin: [number, number, number] = [0, -1, 0];
  const wMax: [number, number, number] = [4, 3, 2];
  // horizontal spans X×Z → full X [0,4], full Z [0,2].
  assert.deepEqual(defaultFootprintForOrientation(wMin, wMax, 'horizontal'), { minA: 0, maxA: 4, minB: 0, maxB: 2 });
  // vertical-x spans Z×Y → full Z [0,2], full Y [-1,3].
  assert.deepEqual(defaultFootprintForOrientation(wMin, wMax, 'vertical-x'), { minA: 0, maxA: 2, minB: -1, maxB: 3 });
  // vertical-z spans X×Y → full X [0,4], full Y [-1,3].
  assert.deepEqual(defaultFootprintForOrientation(wMin, wMax, 'vertical-z'), { minA: 0, maxA: 4, minB: -1, maxB: 3 });
});

test('footprint default is uncapped, unlike the 5 m default thickness (spec §13.2)', () => {
  // A 20 m span: thickness starts at 5, footprint keeps the full 20.
  const fp = defaultFootprintForOrientation([0, 0, 0], [20, 20, 20], 'horizontal');
  assert.equal(fp.maxA - fp.minA, 20);
  const range = defaultRangeForOrientation([0, 0, 0], [20, 20, 20], 'horizontal');
  assert.equal(range.max - range.min, DEFAULT_SECTION_THICKNESS);
});

test('inPlaneExtent + footprintSliderMax give the per-axis slider max (spec §13.2)', () => {
  const { a, b } = inPlaneExtent([0, -1, 0], [4, 3, 2], 'vertical-x'); // Z×Y
  assert.deepEqual(a, { min: 0, max: 2 });
  assert.deepEqual(b, { min: -1, max: 3 });
  assert.equal(footprintSliderMax(a), 2);
  assert.equal(footprintSliderMax(b), 4);
  // Never below the min bound, even for a degenerate (zero-extent) axis.
  assert.equal(footprintSliderMax({ min: 5, max: 5 }), MIN_SECTION_FOOTPRINT);
});

test('sectionCenterA/B are the footprint midpoints (spec §13.2)', () => {
  assert.equal(sectionCenterA({ minA: -2, maxA: 6 }), 2);
  assert.equal(sectionCenterB({ minB: 1, maxB: 3 }), 2);
});

test('sectionLabel trims the name and falls back to "Section N" when blank (spec §5.6, §13.1)', () => {
  assert.equal(defaultSectionName('section-1'), 'Section 1');
  assert.equal(defaultSectionName('odd'), 'odd');
  const base = defaultSection('section-2', [0, -1, 0], [4, 3, 2]);
  assert.equal(sectionLabel({ ...base, name: 'Ground floor' }), 'Ground floor');
  assert.equal(sectionLabel({ ...base, name: '  Mezzanine  ' }), 'Mezzanine');
  assert.equal(sectionLabel({ ...base, name: '' }), 'Section 2');
  assert.equal(sectionLabel({ ...base, name: '   ' }), 'Section 2');
});

// --- clip band (spec §13.9) -----------------------------------------------
// The band is computed unconditionally; *whether* it is applied is the caller's
// scene-level clipSectionId decision (§14.1), not sectionClipBand's.

test('sectionClipBand centers the band on the cut plane along the collapse axis (spec §13.9)', () => {
  // horizontal → collapse Y; cut plane at (min+max)/2 = 1.5; range 2 → [0.5, 2.5].
  const band = sectionClipBand(
    { orientation: 'horizontal', min: 1, max: 2, clipRange: 2 },
    [0, -5, 0],
    [4, 5, 2],
  );
  assert.deepEqual(band, { axis: 1, min: 0.5, max: 2.5 });
});

test('sectionClipBand uses the orientation collapse axis (spec §13.9)', () => {
  // vertical-x → collapse X; cut plane at 2; range 4 → [0, 4] on axis 0.
  const band = sectionClipBand(
    { orientation: 'vertical-x', min: 1, max: 3, clipRange: 4 },
    [-10, 0, 0],
    [10, 4, 2],
  );
  assert.deepEqual(band, { axis: 0, min: 0, max: 4 });
});

test('sectionClipBand clamps the range to the collapse-axis extent (spec §13.9)', () => {
  // Y extent is [-1, 3] = 4 m; a 100 m request clamps to 4, centered on plane 1.
  const band = sectionClipBand(
    { orientation: 'horizontal', min: 0, max: 2, clipRange: 100 },
    [0, -1, 0],
    [4, 3, 2],
  );
  assert.deepEqual(band, { axis: 1, min: -1, max: 3 });
});

test('sectionClipBand clamps a sub-minimum range up to MIN_CLIP_RANGE (spec §13.9)', () => {
  const band = sectionClipBand(
    { orientation: 'horizontal', min: 2, max: 2, clipRange: 0 },
    [0, -5, 0],
    [4, 5, 2],
  );
  assert.ok(Math.abs(band.max - band.min - MIN_CLIP_RANGE) < 1e-9);
});

test('maxClipRange is the collapse-axis world extent per orientation (spec §13.9)', () => {
  assert.equal(maxClipRange([0, -1, 0], [4, 3, 2], 'horizontal'), 4); // Y: 3 - (-1)
  assert.equal(maxClipRange([-10, 0, 0], [10, 4, 2], 'vertical-x'), 20); // X: 10 - (-10)
  assert.equal(maxClipRange([0, 0, -3], [4, 4, 3], 'vertical-z'), 6); // Z: 3 - (-3)
});

test('maxClipRange never falls below MIN_CLIP_RANGE (spec §13.9)', () => {
  assert.equal(maxClipRange([0, 1, 0], [4, 1, 2], 'horizontal'), MIN_CLIP_RANGE);
});

test('DEFAULT_CLIP_RANGE is 2 m (spec §13.9)', () => {
  assert.equal(DEFAULT_CLIP_RANGE, 2);
});

test('sectionCenter is the midpoint of min/max (spec §13.2)', () => {
  assert.equal(sectionCenter({ min: -1, max: 3 }), 1);
  assert.equal(sectionCenter({ min: 2, max: 2 }), 2);
  assert.equal(sectionCenter({ min: -5, max: -1 }), -3);
});

// --- axisIndexRange (spec §13.3 slab clipping) -------------------------------

const rangeGrid = { worldMin: [0, 0, 0] as const, voxelSize: 1, gridDims: [4, 2, 2] as const };

test('axisIndexRange covers the full grid for the full extent', () => {
  assert.deepEqual(axisIndexRange(rangeGrid, 0, 0, 4), { start: 0, end: 3 });
});
test('axisIndexRange clips to a partial range', () => {
  assert.deepEqual(axisIndexRange(rangeGrid, 0, 1, 3), { start: 1, end: 2 });
});
test('axisIndexRange clamps out-of-grid bounds', () => {
  assert.deepEqual(axisIndexRange(rangeGrid, 0, -5, 100), { start: 0, end: 3 });
});
test('axisIndexRange resolves a zero-thickness range to a single voxel', () => {
  assert.deepEqual(axisIndexRange(rangeGrid, 0, 1.5, 1.5), { start: 1, end: 1 });
});
test('axisIndexRange never inverts even for a malformed min > max', () => {
  const { start, end } = axisIndexRange(rangeGrid, 0, 3, 1);
  assert.ok(end >= start);
});

// --- computeSectionCells: cross-chunk column walk (spec §13.3) --------------
//
// 4×2×2 workspace, chunkSizeXZ=2 → 2 chunks along X (chunkCountX=2), 1 along Z.
// Orientation vertical-x collapses X, so a column at fixed (z,y) walks x=0..3,
// crossing the chunk boundary at x=2 — exercising the multi-chunk case (unlike
// Y, which the SDK never chunks).
const grid = new WorkspaceGrid({ worldMin: [0, 0, 0], worldMax: [4, 2, 2], voxelSize: 1, chunkSizeXZ: 2 });
const li = (i: number, j: number, k: number) => i + 2 * (j + 2 * k); // local index within a 2×2×2 chunk

function denseChunk(chunkId: number, origin: [number, number, number], opts: {
  visibleAt?: [number, number, number, number][]; // (i,j,k,mask)
  invalidAt?: [number, number, number][];
}): ChunkResult {
  const visibility = new Uint32Array(8);
  for (const [i, j, k, mask] of opts.visibleAt ?? []) visibility[li(i, j, k)] = mask;
  const validity = new Uint32Array(1);
  validity[0] = 0xff; // all 8 voxels valid by default
  for (const [i, j, k] of opts.invalidAt ?? []) validity[0] &= ~(1 << li(i, j, k));
  return {
    chunkId,
    encoding: 'dense',
    dims: [2, 2, 2],
    origin,
    voxelSize: 1,
    camWords: 1,
    mode: 1,
    visibility,
    validity,
    stats: { validCount: 8, coveredCount: 0, visibleCount: [0, 0, 0] },
  };
}

function accessorsFor(chunks: ChunkResult[]): Map<number, ReturnType<typeof accessor>> {
  const m = new Map();
  for (const c of chunks) m.set(c.chunkId, accessor(c));
  return m;
}

test('computeSectionCells aggregates a fully-valid column across two chunks', () => {
  // Column at (z=0, y=0): chunk0 voxel (0,0,0) mask 0b1 (1 cam), chunk1 voxel (0,0,0) — global x=2
  // -> chunk1 local i=0 — mask 0b11 (2 cams); both valid.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const chunk1 = denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] });
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a', 'cam-b']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
  );
  // vertical-x: dimsA = gridDims[Z] = 2, dimsB = gridDims[Y] = 2. Column (z=0,y=0) is cell index a=0,b=0.
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, true);
  // fractions over 4 voxels: x=0 -> 1/2, x=1 -> 0, x=2 -> 2/2=1, x=3 -> 0
  assert.equal(cell.meanFraction, (0.5 + 0 + 1 + 0) / 4);
  assert.equal(cell.maxFraction, 1);
  assert.equal(cell.minFraction, 0);
  assert.equal(cell.blindFraction, 2 / 4); // x=1 and x=3 are blind
  assert.equal(cell.seenWords[0], 0b1 | 0b11);
});

test('computeSectionCells colors a column with valid voxels even when it also crosses an obstacle (valid data wins, §13.3)', () => {
  // x=0,1,2 valid, x=3 obstacle. Valid data wins → colored; the obstacle is ignored.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }); // x=0 seen, x=1 blind
  const chunk1 = denseChunk(1, [2, 0, 0], { invalidAt: [[1, 0, 0]] }); // x=2 valid/blind, x=3 obstacle
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, true);
  assert.equal(cell.black, false);
  // Aggregated over the 3 valid voxels (x=0 seen, x=1,2 blind); the obstacle x=3 is excluded.
  assert.equal(cell.meanFraction, (1 + 0 + 0) / 3);
  assert.equal(cell.blindFraction, 2 / 3);
});

test('computeSectionCells is transparent (not black) for an all-no-data column (§13.3)', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], {}); // covers x=0,1 only
  // Section range x∈[2,4] → column walks x=2,3, both in the never-retained chunk1.
  const cells = computeSectionCells(grid, accessorsFor([chunk0]), allEnabled(['cam-a']), 1, {
    orientation: 'vertical-x',
    min: 2,
    max: 4,
  });
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
  assert.equal(cell.black, false); // no coverage data anywhere → transparent
});

test('computeSectionCells is black for a column entirely inside geometry (no valid, no no-data) (§13.3)', () => {
  // Every in-range voxel is an obstacle and all chunks are retained → fully-solid → black.
  const chunk0 = denseChunk(0, [0, 0, 0], { invalidAt: [[0, 0, 0], [1, 0, 0]] }); // x=0,1 obstacle
  const chunk1 = denseChunk(1, [2, 0, 0], { invalidAt: [[0, 0, 0], [1, 0, 0]] }); // x=2,3 obstacle
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
  assert.equal(cell.black, true);
});

test('computeSectionCells: no-data wins over obstacle in a valueless column → transparent (§13.3)', () => {
  // x=0,1 obstacle (retained), x=2,3 no-data (chunk1 never retained). No valid voxel.
  const chunk0 = denseChunk(0, [0, 0, 0], { invalidAt: [[0, 0, 0], [1, 0, 0]] });
  const cells = computeSectionCells(grid, accessorsFor([chunk0]), allEnabled(['cam-a']), 1, {
    orientation: 'vertical-x',
    min: 0,
    max: 4,
  });
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
  assert.equal(cell.black, false); // no-data present → transparent, not black
});

test('computeSectionCells clips the column to the section range', () => {
  // Restrict to x in [0, 0.9] -> only global x=0 (chunk0) is walked.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const cells = computeSectionCells(grid, accessorsFor([chunk0]), allEnabled(['cam-a']), 1, {
    orientation: 'vertical-x',
    min: 0,
    max: 0.9,
  });
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, true);
  assert.equal(cell.meanFraction, 1); // only x=0, coverage fraction 1/1
});

test('computeSectionCells restricts cells to the in-plane footprint and reports grid-aligned extents (spec §13.2, §13.3)', () => {
  // horizontal collapses Y; axisA=X (grid 0..3), axisB=Z (grid 0..1). Footprint
  // selects X columns 1..2 and Z column 0 only → a 2×1 sub-rectangle of columns.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[1, 0, 0, 0b1]] }); // x=1: y=0 seen, y=1 blind
  const chunk1 = denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b1], [0, 1, 0, 0b1]] }); // x=2: y=0,1 both seen
  const cells = computeSectionCells(grid, accessorsFor([chunk0, chunk1]), allEnabled(['cam-a']), 1, {
    orientation: 'horizontal',
    min: 0,
    max: 2, // full Y column
    minA: 1,
    maxA: 3, // X columns 1,2 (centers 1.5, 2.5)
    minB: 0,
    maxB: 1, // Z column 0 only
  });
  // dims are the SELECTED column counts, not the full grid (which would be 4×2).
  assert.equal(cells.dimsA, 2);
  assert.equal(cells.dimsB, 1);
  assert.equal(cells.cells.length, 2);
  // Grid-aligned world extent of the selected columns (column low edge → high edge).
  assert.deepEqual(cells.extentA, { min: 1, max: 3 });
  assert.deepEqual(cells.extentB, { min: 0, max: 1 });
  // Local index la + dimsA*lb: la=0 → x=1 (mean 0.5), la=1 → x=2 (mean 1).
  assert.equal(cells.cells[0].meanFraction, 0.5);
  assert.equal(cells.cells[1].meanFraction, 1);
});

test('computeSectionCells with no footprint spans the whole grid (pre-footprint fallback, spec §13.3)', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const chunk1 = denseChunk(1, [2, 0, 0], {});
  const cells = computeSectionCells(grid, accessorsFor([chunk0, chunk1]), allEnabled(['cam-a']), 1, {
    orientation: 'horizontal',
    min: 0,
    max: 2,
  });
  // gridDims X×Z = 4×2 → full grid, and the extent is the whole workspace.
  assert.equal(cells.dimsA, 4);
  assert.equal(cells.dimsB, 2);
  assert.deepEqual(cells.extentA, { min: 0, max: 4 });
  assert.deepEqual(cells.extentB, { min: 0, max: 2 });
});

// --- computeSectionCells: marked-set filter (sampling_volumes.md §7.3) --------
//
// Out-of-zone voxels are SKIPPED (not classified, spec §13.3): the cell aggregates
// only its in-zone valid voxels. Valid data wins, so a column keeps its color as long
// as any in-zone voxel is valid; only a valueless column is transparent (no-data/empty)
// or black (entirely obstacle).
// Voxel centers along x are 0.5,1.5,2.5,3.5 (voxelSize 1, worldMin.x 0).

test('computeSectionCells skips out-of-zone voxels and aggregates only the in-zone ones (§7.3)', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }); // x=0 seen (1 cam), x=1 blind
  const chunk1 = denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }); // x=2,3 — out of zone
  // Marked set excludes x≥2 (centers 2.5, 3.5): the column keeps only x=0,1.
  const marked = (cx: number) => cx < 2;
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
    marked,
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, true);
  assert.equal(cell.meanFraction, (1 + 0) / 2); // only x=0 (frac 1) and x=1 (frac 0) aggregated
  assert.equal(cell.blindFraction, 1 / 2); // x=1 is blind
});

test('computeSectionCells makes a column transparent when no voxel is in the marked set (§7.3)', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const chunk1 = denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
    () => false, // nothing in the marked set → every voxel skipped → empty column → transparent
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
  assert.equal(cell.black, false); // empty (no in-zone voxel) → transparent, not black
});

test('computeSectionCells skips an out-of-zone voxel that is invalid (unsampled outside the volume) (§7.3, §13.3)', () => {
  // x=3 is both out of zone AND invalid — the realistic case, since the SDK doesn't
  // sample outside the enabled volumes. The zone filter runs first, so it is skipped
  // (not blacked), and the in-zone voxels x=0,1 still color the cell.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const chunk1 = denseChunk(1, [2, 0, 0], { invalidAt: [[0, 0, 0], [1, 0, 0]] }); // x=2,3 invalid + out of zone
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
    (cx: number) => cx < 2,
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, true);
  assert.equal(cell.meanFraction, (1 + 0) / 2); // only x=0 (seen) and x=1 (blind)
});

test('computeSectionCells still colors an in-zone column that mixes a valid voxel and an obstacle (valid wins, §7.3, §13.3)', () => {
  // In-zone x=0 valid (seen), x=1 obstacle. Valid data wins → colored, obstacle ignored.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]], invalidAt: [[1, 0, 0]] });
  const chunk1 = denseChunk(1, [2, 0, 0], {});
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
    (cx: number) => cx < 2,
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, true);
  assert.equal(cell.black, false);
  assert.equal(cell.meanFraction, 1); // only x=0 (seen) aggregated
});

test('computeSectionCells blacks an in-zone column that is entirely obstacle (§7.3, §13.3)', () => {
  // Only x=0 is in-zone (cx < 1) and it is an obstacle → no valid, no no-data → black.
  const chunk0 = denseChunk(0, [0, 0, 0], { invalidAt: [[0, 0, 0]] });
  const chunk1 = denseChunk(1, [2, 0, 0], {});
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    allEnabled(['cam-a']),
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
    (cx: number) => cx < 1,
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
  assert.equal(cell.black, true);
});

test('computeSectionCells: a column fully inside the marked set colors identically to no filter (§7.3)', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const chunk1 = denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] });
  const section = { orientation: 'vertical-x' as const, min: 0, max: 4 };
  const accessors = accessorsFor([chunk0, chunk1]);
  const unfiltered = computeSectionCells(grid, accessors, allEnabled(['cam-a', 'cam-b']), 1, section);
  // A filter marking the whole workspace must leave the aggregation unchanged.
  const filtered = computeSectionCells(grid, accessors, allEnabled(['cam-a', 'cam-b']), 1, section, () => true);
  const at = (g: SectionCellGrid) => g.cells[0 + g.dimsA * 0];
  assert.equal(at(filtered).valid, true);
  assert.equal(at(filtered).meanFraction, at(unfiltered).meanFraction);
  assert.equal(at(filtered).blindFraction, at(unfiltered).blindFraction);
});

// --- cellDisplayValue / texture data (spec §13.3, §13.5) --------------------

test('cellDisplayValue picks the field matching the aggregation', () => {
  const cell = { valid: true, black: false, meanFraction: 0.4, maxFraction: 0.9, minFraction: 0.1, blindFraction: 0.2, seenWords: new Uint32Array(1) };
  assert.equal(cellDisplayValue(cell, 'mean'), 0.4);
  assert.equal(cellDisplayValue(cell, 'max'), 0.9);
  assert.equal(cellDisplayValue(cell, 'min'), 0.1);
  assert.equal(cellDisplayValue(cell, 'blind'), 0.2);
});

// --- sectionLegendVisible (spec §2.2, §13.6) ---------------------------------

test('sectionLegendVisible: shown only when layer visible and clipSectionId references an existing, enabled section', () => {
  const secs = [{ id: 'sec-1', enabled: true }, { id: 'sec-2', enabled: true }];
  // Layer on and the (enabled) clip section exists → shown.
  assert.equal(sectionLegendVisible(true, secs, 'sec-1'), true);
  // No clip active → hidden even with the layer on and sections present.
  assert.equal(sectionLegendVisible(true, secs, null), false);
  // Master Section toggle off → hidden even while a section clips.
  assert.equal(sectionLegendVisible(false, secs, 'sec-1'), false);
  // Dangling clipSectionId (no matching section) → hidden.
  assert.equal(sectionLegendVisible(true, secs, 'ghost'), false);
  // Clip section exists but is disabled (its heatmap isn't drawn) → hidden.
  assert.equal(sectionLegendVisible(true, [{ id: 'sec-1', enabled: false }], 'sec-1'), false);
  // No sections at all → hidden.
  assert.equal(sectionLegendVisible(true, [], 'sec-1'), false);
});

test('sectionHeatmapTextureData: obstacle cells are opaque black, transparent cells are alpha 0, colored cells map through Turbo', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 3,
    dimsB: 1,
    cells: [
      { valid: false, black: true, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }, // obstacle
      { valid: false, black: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }, // transparent (no-data)
      { valid: true, black: false, meanFraction: 0.5, maxFraction: 0.5, minFraction: 0.5, blindFraction: 0, seenWords: new Uint32Array(1) },
    ],
    camWords: 1,
    cameraIds: ['cam-a'], cameraBits: [0],
  };
  const data = sectionHeatmapTextureData(cellGrid, 'mean');
  assert.deepEqual([data[0], data[1], data[2], data[3]], [0, 0, 0, 255]); // obstacle → opaque black
  assert.deepEqual([data[4], data[5], data[6], data[7]], [0, 0, 0, 0]); // no-data → fully transparent
  const [r, g, b] = turboColormap(0.5);
  assert.deepEqual([data[8], data[9], data[10], data[11]], [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255]);
});

test('averageDisplayValue averages the aggregation-selected value over colored cells only', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 2,
    dimsB: 1,
    cells: [
      { valid: false, black: true, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) },
      { valid: true, black: false, meanFraction: 0.4, maxFraction: 0.9, minFraction: 0.1, blindFraction: 0.3, seenWords: new Uint32Array(1) },
    ],
    camWords: 1,
    cameraIds: [], cameraBits: [],
  };
  assert.equal(averageDisplayValue(cellGrid, 'mean'), 0.4);
  assert.equal(averageDisplayValue(cellGrid, 'max'), 0.9);
  assert.equal(averageDisplayValue(cellGrid, 'blind'), 0.3);
});

test('averageDisplayValue is 0 with no colored cells', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 1,
    dimsB: 1,
    cells: [{ valid: false, black: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }],
    camWords: 1,
    cameraIds: [], cameraBits: [],
  };
  assert.equal(averageDisplayValue(cellGrid, 'mean'), 0);
});

// --- computeSectionStats (spec §13.7) ----------------------------------------

test('computeSectionStats counts colored + obstacle in the total and excludes transparent cells', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 3,
    dimsB: 1,
    cells: [
      { valid: false, black: true, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }, // obstacle
      { valid: false, black: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }, // transparent — excluded from total
      { valid: true, black: false, meanFraction: 0.5, maxFraction: 0.8, minFraction: 0.2, blindFraction: 0, seenWords: new Uint32Array([0b1]) },
    ],
    camWords: 1,
    cameraIds: ['cam-a', 'cam-b'], cameraBits: [0, 1],
  };
  const stats = computeSectionStats(cellGrid);
  assert.equal(stats.totalCells, 2); // colored + obstacle; transparent excluded
  assert.equal(stats.validCells, 1);
  assert.equal(stats.obstacleCells, 1);
  assert.equal(stats.sectionCoverage, 0.5);
  assert.equal(stats.blindCells, 0);
  assert.equal(stats.minCoverage, 0.5);
  assert.equal(stats.maxCoverage, 0.5);
  assert.deepEqual(stats.perCamera, [
    { id: 'cam-a', seenFraction: 1 },
    { id: 'cam-b', seenFraction: 0 },
  ]);
});

test('computeSectionStats counts a fully-blind column as a blind cell', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 1,
    dimsB: 1,
    cells: [{ valid: true, black: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 1, seenWords: new Uint32Array(1) }],
    camWords: 1,
    cameraIds: [], cameraBits: [],
  };
  const stats = computeSectionStats(cellGrid);
  assert.equal(stats.blindCells, 1);
  assert.equal(stats.blindCellsPct, 1);
});

test('computeSectionStats: no colored cells yields zeroed numbers, not NaN', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 1,
    dimsB: 1,
    cells: [{ valid: false, black: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }],
    camWords: 1,
    cameraIds: ['cam-a'], cameraBits: [0],
  };
  const stats = computeSectionStats(cellGrid);
  assert.equal(stats.sectionCoverage, 0);
  assert.equal(stats.minCoverage, 0);
  assert.equal(stats.maxCoverage, 0);
  assert.deepEqual(stats.perCamera, [{ id: 'cam-a', seenFraction: 0 }]);
});

// --- SectionHeatmapStore (spec §13.4) ----------------------------------------

test('SectionHeatmapStore.computeCells is null before any run is retained', () => {
  const store = new SectionHeatmapStore();
  assert.equal(store.computeCells({ orientation: 'horizontal', min: 0, max: 2 }), null);
  assert.equal(store.hasRun(), false);
});

test('SectionHeatmapStore retains chunks across a run and computes matching cells', () => {
  const store = new SectionHeatmapStore();
  store.reset(grid, ['cam-a', 'cam-b']);
  store.addChunk(denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }));
  store.addChunk(denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] }));
  assert.equal(store.hasRun(), true);

  const cells = store.computeCells({ orientation: 'vertical-x', min: 0, max: 4 });
  assert.ok(cells);
  const cell = cells!.cells[0 + cells!.dimsA * 0];
  assert.equal(cell.valid, true);
  assert.equal(cell.seenWords[0], 0b1 | 0b11);
});

test('SectionHeatmapStore.reset clears chunks from the prior run', () => {
  const store = new SectionHeatmapStore();
  store.reset(grid, ['cam-a']);
  store.addChunk(denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }));
  store.reset(grid, ['cam-a']); // new run, no chunks yet
  const cells = store.computeCells({ orientation: 'vertical-x', min: 0, max: 4 });
  assert.ok(cells);
  const cell = cells!.cells[0 + cells!.dimsA * 0];
  assert.equal(cell.valid, false);
});

test('SectionHeatmapStore.clear() discards the retained run (spec §14.4)', () => {
  const store = new SectionHeatmapStore();
  store.reset(grid, ['cam-a']);
  store.addChunk(denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }));
  assert.equal(store.hasRun(), true);

  store.clear();
  assert.equal(store.hasRun(), false);
  assert.equal(store.computeCells({ orientation: 'vertical-x', min: 0, max: 4 }), null);
});

test('a disabled camera does not inflate the coverage denominator (spec §5.4, §13.3)', () => {
  // Three cameras passed to setCameras, the middle one disabled. Voxel (0,0,0)
  // is seen by bits 0 and 2 — i.e. by both *enabled* cameras, so its fraction
  // must be 1. Counting the disabled slot would cap it at 2/3 and every cell in
  // the workspace would read as under-covered.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b101]] });
  const chunk1 = denseChunk(1, [2, 0, 0], {});
  const cams = { ids: ['cam-a', 'cam-c'], bits: [0, 2] };
  const cells = computeSectionCells(grid, accessorsFor([chunk0, chunk1]), cams, 1, {
    orientation: 'vertical-x',
    min: 0,
    max: 4,
  });
  const cell = cells.cells[0];
  assert.equal(cell.maxFraction, 1, 'seen by both enabled cameras ⇒ fully covered');
  assert.deepEqual(cells.cameraIds, ['cam-a', 'cam-c']);
  assert.deepEqual(cells.cameraBits, [0, 2]);
});

test('computeSectionStats reads each camera at its own mask bit, not its list index (spec §5.4)', () => {
  // seenWords has bits 0 and 2 set. With 'cam-c' at bit 2, both enabled cameras
  // register; reading by list index would look at bit 1 and miss 'cam-c'.
  const stats = computeSectionStats({
    dimsA: 1,
    dimsB: 1,
    camWords: 1,
    cameraIds: ['cam-a', 'cam-c'],
    cameraBits: [0, 2],
    extentA: { min: 0, max: 1 },
    extentB: { min: 0, max: 1 },
    cells: [
      {
        valid: true,
        black: false,
        meanFraction: 1,
        maxFraction: 1,
        minFraction: 1,
        blindFraction: 0,
        seenWords: new Uint32Array([0b101]),
      },
    ],
  });
  assert.deepEqual(stats.perCamera, [
    { id: 'cam-a', seenFraction: 1 },
    { id: 'cam-c', seenFraction: 1 },
  ]);
});

// --- Cell-grid cache keyed on the chunks a section reads (spec §13.4) --------

const CAMS_AB = [
  { id: 'cam-a', enabled: true },
  { id: 'cam-b', enabled: true },
];

/** Store over the 4×2×2 grid: chunk 0 spans x∈[0,2), chunk 1 spans x∈[2,4). */
function heatStore(chunks: ChunkResult[]): SectionHeatmapStore {
  const s = new SectionHeatmapStore();
  s.reset(grid, CAMS_AB);
  for (const c of chunks) s.addChunk(c);
  return s;
}

const FULL_SECTION = {
  orientation: 'vertical-z' as const,
  min: 0,
  max: 2,
  minA: 0,
  maxA: 4,
  minB: 0,
  maxB: 2,
};
/** Footprint confined to chunk 1's half of X. */
const RIGHT_SECTION = { ...FULL_SECTION, minA: 2.5, maxA: 4 };

test('an unchanged section is served from cache, not recomputed (spec §13.4)', () => {
  const s = heatStore([
    denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }),
    denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] }),
  ]);
  const first = s.computeCells(FULL_SECTION, null);
  const second = s.computeCells(FULL_SECTION, null);
  assert.equal(second, first, 'the identical grid object comes back');
});

test('replacing a chunk the section reads invalidates its cached grid (spec §13.4)', () => {
  const s = heatStore([
    denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }),
    denseChunk(1, [2, 0, 0], {}),
  ]);
  const before = s.computeCells(FULL_SECTION, null)!;
  s.addChunk(denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] }));
  const after = s.computeCells(FULL_SECTION, null)!;
  assert.notEqual(after, before, 'a stale grid must not be served');
  assert.ok(
    after.cells.some((c, n) => c.maxFraction !== before.cells[n].maxFraction),
    'and the new masks are reflected',
  );
});

test('a section keeps its cached grid when a chunk outside its footprint changes (spec §13.4)', () => {
  // The point of the cache under an incremental run: chunks are partitioned on
  // XZ, so a section whose footprint misses chunk 0 cannot read it.
  const s = heatStore([
    denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }),
    denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] }),
  ]);
  const before = s.computeCells(RIGHT_SECTION, null);
  s.addChunk(denseChunk(0, [0, 0, 0], { visibleAt: [[1, 1, 1, 0b11]] }));
  assert.equal(s.computeCells(RIGHT_SECTION, null), before, 'chunk 0 is not a dependency');

  // ...but the full-width section does depend on it.
  const fullBefore = s.computeCells(FULL_SECTION, null);
  s.addChunk(denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] }));
  assert.notEqual(s.computeCells(FULL_SECTION, null), fullBefore);
});

test('a different marked filter is not served from the cache (§7.3, §13.4)', () => {
  const s = heatStore([
    denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] }),
    denseChunk(1, [2, 0, 0], {}),
  ]);
  const unfiltered = s.computeCells(FULL_SECTION, null);
  const filtered = s.computeCells(FULL_SECTION, () => false);
  assert.notEqual(filtered, unfiltered);
  assert.ok(filtered!.cells.every((c) => !c.valid), 'everything filtered out reads as no-data');
});
