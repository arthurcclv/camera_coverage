import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  COLUMN_MIN_EMPTY,
  WorkspaceGrid,
  type ColumnAccum,
} from '@linkervision/camera-coverage-sdk';
import {
  averageDisplayValue,
  axisIndexRange,
  axisMapping,
  cellDisplayValue,
  collapseAxisExtent,
  collapseAxisNormalSign,
  cellGridFromColumns,
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
  sectionCenter,
  sectionCenterA,
  sectionCenterB,
  sectionHeatmapTextureData,
  sectionLegendVisible,
  sectionPlaneRotation,
  type SectionCellGrid,
} from '../src/scene/sectionHeatmap.ts';
import { turboColormap } from '../src/scene/heatmapLegend.ts';
import { runCameras } from '../src/scene/runCameras.ts';

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

// --- cellGridFromColumns: merged slab → cell grid (spec §13.3, §13.4) --------
//
// The engine reports what it *counted*; the app derives the fractions and
// classifies the cells. These cover that boundary — nothing here needs a run.

/** A 4×2×2 workspace of 1 m voxels, so a collapse-axis column is 2 voxels long. */
const CELL_GRID = new WorkspaceGrid({ worldMin: [0, 0, 0], worldMax: [4, 2, 2], voxelSize: 1, chunkSizeXZ: 2 });

/** One-cell accumulator; every field defaults to "counted nothing". */
function slab(fields: Partial<Record<keyof ColumnAccum, number>> & { seen?: number }): ColumnAccum {
  const one = (v = 0) => Uint32Array.of(v);
  return {
    dimsA: 1,
    dimsB: 1,
    camCountSum: one(fields.camCountSum as number),
    camCountMax: Uint8Array.of((fields.camCountMax as number) ?? 0),
    camCountMin: Uint8Array.of((fields.camCountMin as number) ?? COLUMN_MIN_EMPTY),
    blindCount: one(fields.blindCount as number),
    validCount: one(fields.validCount as number),
    obstacleCount: one(fields.obstacleCount as number),
    filteredCount: one(fields.filteredCount as number),
    seenWords: one(fields.seen ?? 0),
  };
}

/** A one-cell section: vertical-z, footprint pinned to a single voxel column. */
const ONE_CELL = {
  orientation: 'vertical-z' as const,
  min: 0,
  max: 2,
  minA: 0,
  maxA: 1,
  minB: 0,
  maxB: 1,
};

const TWO_CAMS = runCameras([
  { id: 'cam-a', enabled: true },
  { id: 'cam-b', enabled: true },
]);

function oneCell(acc: ColumnAccum, cams = TWO_CAMS, columnLength = 2) {
  return cellGridFromColumns({
    grid: CELL_GRID,
    section: ONE_CELL,
    acc,
    camWords: 1,
    cams,
    columnLength,
  }).cells[0];
}

test('cellGridFromColumns derives mean/max/min from integer counts (spec §13.3)', () => {
  // Two counted voxels seen by 2 and 1 of the 2 enabled cameras.
  const cell = oneCell(slab({ validCount: 2, camCountSum: 3, camCountMax: 2, camCountMin: 1 }));
  assert.equal(cell.valid, true);
  assert.equal(cell.meanFraction, 0.75); // 3 / (2 voxels × 2 cameras)
  assert.equal(cell.maxFraction, 1);
  assert.equal(cell.minFraction, 0.5);
  assert.equal(cell.blindFraction, 0);
});

test('cellGridFromColumns: valid data wins over an obstacle sharing the column (§13.3)', () => {
  const cell = oneCell(slab({ validCount: 1, obstacleCount: 1, camCountSum: 2, camCountMax: 2, camCountMin: 2 }));
  assert.equal(cell.valid, true);
  assert.equal(cell.black, false);
  assert.equal(cell.meanFraction, 1);
});

test('cellGridFromColumns: an all-obstacle column is black (§13.3)', () => {
  const cell = oneCell(slab({ obstacleCount: 2 }));
  assert.equal(cell.valid, false);
  assert.equal(cell.black, true);
});

test('cellGridFromColumns: a column no chunk covered is transparent, not black (§13.3)', () => {
  // Nothing counted at all: 2 voxels long, 0 accounted for ⇒ no-data.
  const cell = oneCell(slab({}));
  assert.equal(cell.valid, false);
  assert.equal(cell.black, false);
});

test('cellGridFromColumns: no-data wins over obstacle in a valueless column (§13.3)', () => {
  // One obstacle counted, one voxel unaccounted for — the no-data case must win,
  // or a column poking outside the sampled region would read as solid geometry.
  const cell = oneCell(slab({ obstacleCount: 1 }));
  assert.equal(cell.valid, false);
  assert.equal(cell.black, false);
});

test('cellGridFromColumns: filtered-out voxels are accounted for, not read as no-data (§7.3)', () => {
  // One voxel counted, one removed by the marked filter: nothing is missing, so
  // the cell is coloured from what it has rather than dragged to transparent.
  const cell = oneCell(slab({ validCount: 1, filteredCount: 1, camCountSum: 1, camCountMax: 1, camCountMin: 1 }));
  assert.equal(cell.valid, true);
  assert.equal(cell.meanFraction, 0.5);
});

test('cellGridFromColumns: a fully blind column is coloured at 0, not transparent (§13.3)', () => {
  const cell = oneCell(slab({ validCount: 2, camCountMin: 0, blindCount: 2 }));
  assert.equal(cell.valid, true);
  assert.equal(cell.meanFraction, 0);
  assert.equal(cell.blindFraction, 1);
});

test('a disabled camera does not inflate the coverage denominator (spec §5.4, §13.3)', () => {
  // Three cameras passed to setCameras, the middle one disabled. The voxel is
  // seen by both *enabled* cameras, so its fraction must be 1 — counting the
  // disabled slot would cap every cell in the workspace below 1.
  const cams = runCameras([
    { id: 'cam-a', enabled: true },
    { id: 'cam-b', enabled: false },
    { id: 'cam-c', enabled: true },
  ]);
  const cell = oneCell(
    slab({ validCount: 1, camCountSum: 2, camCountMax: 2, camCountMin: 2, seen: 0b101 }),
    cams,
    1,
  );
  assert.equal(cell.maxFraction, 1, 'seen by both enabled cameras ⇒ fully covered');
  const g = cellGridFromColumns({
    grid: CELL_GRID,
    section: ONE_CELL,
    acc: slab({}),
    camWords: 1,
    cams,
    columnLength: 2,
  });
  assert.deepEqual(g.cameraIds, ['cam-a', 'cam-c']);
  assert.deepEqual(g.cameraBits, [0, 2]);
});

test('cellGridFromColumns un-transposes a vertical-x slab (spec §3.3)', () => {
  // The SDK numbers a slab's plane axes ascending (Y then Z); a vertical-x
  // section spans Z×Y. Reading the accumulator straight through would render the
  // heatmap rotated a quarter turn — a plausible-looking picture, not a crash.
  const acc: ColumnAccum = {
    dimsA: 2, // SDK axis 1 (Y)
    dimsB: 3, // SDK axis 2 (Z)
    camCountSum: Uint32Array.from([0, 1, 2, 3, 4, 5]),
    camCountMax: Uint8Array.from([0, 1, 2, 3, 4, 5]),
    camCountMin: Uint8Array.from([0, 1, 2, 3, 4, 5]),
    blindCount: new Uint32Array(6),
    validCount: Uint32Array.from([1, 1, 1, 1, 1, 1]),
    obstacleCount: new Uint32Array(6),
    filteredCount: new Uint32Array(6),
    seenWords: new Uint32Array(6),
  };
  const section = { orientation: 'vertical-x' as const, min: 0, max: 1, minA: 0, maxA: 3, minB: 0, maxB: 2 };
  // Six enabled cameras so the six distinct counts stay distinct as fractions —
  // a denominator of 2 would clamp four of them to 1 and the test would pass on
  // a wrong mapping.
  const sixCams = runCameras(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, enabled: true })),
  );
  const g = cellGridFromColumns({
    grid: CELL_GRID,
    section,
    acc,
    camWords: 1,
    cams: sixCams,
    columnLength: 1,
  });
  assert.equal(g.dimsA, 3, 'app axisA is Z');
  assert.equal(g.dimsB, 2, 'app axisB is Y');
  // App cell (a, b) must read SDK cell (b, a).
  for (let b = 0; b < 2; b++) {
    for (let a = 0; a < 3; a++) {
      const src = b + acc.dimsA * a;
      assert.equal(g.cells[a + 3 * b].maxFraction, acc.camCountMax[src] / 6, `cell ${a},${b}`);
    }
  }
});

test('cellGridFromColumns reports grid-aligned extents for the footprint (spec §13.3)', () => {
  const section = { ...ONE_CELL, minA: 1.2, maxA: 2.8, minB: 0, maxB: 2 };
  const acc = { ...slab({}), dimsA: 2, dimsB: 2 } as ColumnAccum;
  const g = cellGridFromColumns({
    grid: CELL_GRID,
    section,
    acc,
    camWords: 1,
    cams: TWO_CAMS,
    columnLength: 2,
  });
  // axisA is X: 1.2..2.8 snaps to voxel columns 1..2 ⇒ world 1..3.
  assert.deepEqual(g.extentA, { min: 1, max: 3 });
  assert.deepEqual(g.extentB, { min: 0, max: 2 });
});
