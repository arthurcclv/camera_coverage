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
  defaultRangeForOrientation,
  defaultSection,
  MAX_SECTION_THICKNESS,
  SECTION_ORIENTATIONS,
  SectionHeatmapStore,
  sectionCenter,
  sectionHeatmapTextureData,
  sectionLegendScale,
  sectionPlaneRotation,
  turboColormap,
  turboCssGradient,
  type SectionCellGrid,
} from '../src/scene/sectionHeatmap.ts';
import { accessor } from '@linkervision/camera-coverage-sdk';

// --- axisMapping / collapseAxisExtent / defaultSection (spec §13.1, §5.5) ----

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

test('defaultRangeForOrientation returns the full extent when it fits within the thickness cap', () => {
  // Y span is 4 m, under the 5 m cap, so it's returned unclamped.
  assert.deepEqual(defaultRangeForOrientation([0, -1, 0], [4, 3, 2], 'horizontal'), { min: -1, max: 3 });
});

test('defaultRangeForOrientation clamps to MAX_SECTION_THICKNESS, centered on the axis (spec §13.2)', () => {
  // Y span is 20 m (worldMin.y=-10, worldMax.y=10), well over the 5 m cap;
  // center stays 0, thickness clamps to exactly MAX_SECTION_THICKNESS.
  const { min, max } = defaultRangeForOrientation([0, -10, 0], [4, 10, 2], 'horizontal');
  assert.equal((min + max) / 2, 0);
  assert.equal(max - min, MAX_SECTION_THICKNESS);
});

test('defaultSection is Horizontal, full (clamped) Y extent, mean aggregation, enabled (spec §5.5)', () => {
  const s = defaultSection('section-1', [0, -1, 0], [4, 3, 2]);
  assert.deepEqual(s, { id: 'section-1', orientation: 'horizontal', min: -1, max: 3, aggregation: 'mean', enabled: true });
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
    ['cam-a', 'cam-b'],
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

test('computeSectionCells marks a column black if any voxel is invalid, even mid-chunk', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], {});
  const chunk1 = denseChunk(1, [2, 0, 0], { invalidAt: [[1, 0, 0]] }); // global x=3 invalid
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    ['cam-a'],
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
});

test('computeSectionCells reports black for a column with no retained chunk', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], {});
  // chunk1 never retained.
  const cells = computeSectionCells(grid, accessorsFor([chunk0]), ['cam-a'], 1, {
    orientation: 'vertical-x',
    min: 0,
    max: 4,
  });
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
});

test('computeSectionCells clips the column to the section range', () => {
  // Restrict to x in [0, 0.9] -> only global x=0 (chunk0) is walked.
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const cells = computeSectionCells(grid, accessorsFor([chunk0]), ['cam-a'], 1, {
    orientation: 'vertical-x',
    min: 0,
    max: 0.9,
  });
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, true);
  assert.equal(cell.meanFraction, 1); // only x=0, coverage fraction 1/1
});

// --- computeSectionCells: marked-set filter (sampling_volumes.md §7.3) --------
//
// A column is black if any voxel in range is invalid OR outside the marked set.
// Voxel centers along x are 0.5,1.5,2.5,3.5 (voxelSize 1, worldMin.x 0).

test('computeSectionCells marks a column black if any voxel is outside the marked set (§7.3)', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const chunk1 = denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  // Every voxel is valid, but the marked set excludes x≥2 (centers 2.5, 3.5), so
  // the column crossing x=0..3 contains an unmarked voxel and goes black.
  const marked = (cx: number) => cx < 2;
  const cells = computeSectionCells(
    grid,
    accessorsFor([chunk0, chunk1]),
    ['cam-a'],
    1,
    { orientation: 'vertical-x', min: 0, max: 4 },
    marked,
  );
  const cell = cells.cells[0 + cells.dimsA * 0];
  assert.equal(cell.valid, false);
});

test('computeSectionCells: a column fully inside the marked set colors identically to no filter (§7.3)', () => {
  const chunk0 = denseChunk(0, [0, 0, 0], { visibleAt: [[0, 0, 0, 0b1]] });
  const chunk1 = denseChunk(1, [2, 0, 0], { visibleAt: [[0, 0, 0, 0b11]] });
  const section = { orientation: 'vertical-x' as const, min: 0, max: 4 };
  const accessors = accessorsFor([chunk0, chunk1]);
  const unfiltered = computeSectionCells(grid, accessors, ['cam-a', 'cam-b'], 1, section);
  // A filter marking the whole workspace must leave the aggregation unchanged.
  const filtered = computeSectionCells(grid, accessors, ['cam-a', 'cam-b'], 1, section, () => true);
  const at = (g: SectionCellGrid) => g.cells[0 + g.dimsA * 0];
  assert.equal(at(filtered).valid, true);
  assert.equal(at(filtered).meanFraction, at(unfiltered).meanFraction);
  assert.equal(at(filtered).blindFraction, at(unfiltered).blindFraction);
});

// --- cellDisplayValue / turboColormap / texture data (spec §13.3, §13.5) ----

test('cellDisplayValue picks the field matching the aggregation', () => {
  const cell = { valid: true, meanFraction: 0.4, maxFraction: 0.9, minFraction: 0.1, blindFraction: 0.2, seenWords: new Uint32Array(1) };
  assert.equal(cellDisplayValue(cell, 'mean'), 0.4);
  assert.equal(cellDisplayValue(cell, 'max'), 0.9);
  assert.equal(cellDisplayValue(cell, 'min'), 0.1);
  assert.equal(cellDisplayValue(cell, 'blind'), 0.2);
});

test('turboColormap: blue end (t=0) stays distinct from black; red end (t=1) is red-dominant', () => {
  const [r0, , b0] = turboColormap(0);
  assert.ok(b0 > r0, 'low end should be blue-dominant, not black');
  assert.ok(b0 > 0.05);
  const [r1, , b1] = turboColormap(1);
  assert.ok(r1 > b1, 'high end should be red-dominant');
});

test('turboCssGradient starts blue and ends red, one stop per control point', () => {
  const gradient = turboCssGradient();
  assert.match(gradient, /^linear-gradient\(to right, /);
  const [r0, g0, b0] = turboColormap(0);
  const [r1, g1, b1] = turboColormap(1);
  assert.ok(gradient.includes(`rgb(${Math.round(r0 * 255)}, ${Math.round(g0 * 255)}, ${Math.round(b0 * 255)}) 0%`));
  assert.ok(gradient.includes(`rgb(${Math.round(r1 * 255)}, ${Math.round(g1 * 255)}, ${Math.round(b1 * 255)}) 100%`));
});

test('turboColormap interpolates linearly between control points', () => {
  const [r0, g0, b0] = turboColormap(0);
  assert.ok(Math.abs(r0 - 0.19) < 1e-9 && Math.abs(g0 - 0.07) < 1e-9 && Math.abs(b0 - 0.23) < 1e-9);
  const [r1, g1, b1] = turboColormap(1);
  assert.ok(Math.abs(r1 - 0.62) < 1e-9 && Math.abs(g1 - 0.09) < 1e-9 && Math.abs(b1 - 0.06) < 1e-9);
});

test('turboColormap clamps outside [0, 1]', () => {
  assert.deepEqual(turboColormap(-5), turboColormap(0));
  assert.deepEqual(turboColormap(5), turboColormap(1));
});

// --- sectionLegendScale (spec §13.6) -----------------------------------------

test('sectionLegendScale: no section / no run falls back to coverage fraction 0..1', () => {
  const noSel = sectionLegendScale(null, 10);
  const noRun = sectionLegendScale('mean', null);
  const zeroCams = sectionLegendScale('mean', 0);
  for (const scale of [noSel, noRun, zeroCams]) {
    assert.equal(scale.caption, 'Coverage fraction');
    assert.deepEqual(scale.ticks.map((t) => t.label), ['0', '0.25', '0.5', '0.75', '1']);
    assert.deepEqual(scale.ticks.map((t) => t.pos), [0, 0.25, 0.5, 0.75, 1]);
  }
});

test('sectionLegendScale: blind shows a 0..100% share scale regardless of camera count', () => {
  const scale = sectionLegendScale('blind', 10);
  assert.equal(scale.caption, 'Blind-voxel share');
  assert.deepEqual(scale.ticks.map((t) => t.label), ['0%', '50%', '100%']);
  assert.deepEqual(scale.ticks.map((t) => t.pos), [0, 0.5, 1]);
});

test('sectionLegendScale: coverage aggregations show whole camera counts, 0..N', () => {
  for (const agg of ['mean', 'max', 'min'] as const) {
    const scale = sectionLegendScale(agg, 8);
    assert.equal(scale.caption, 'Cameras seeing voxel');
    // N=8 → step 1 → every integer 0..8
    assert.deepEqual(scale.ticks.map((t) => t.label), ['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    // Count k sits at position k/N (linear), first at 0, last at 1.
    assert.equal(scale.ticks[0].pos, 0);
    assert.equal(scale.ticks[scale.ticks.length - 1].pos, 1);
    assert.ok(Math.abs(scale.ticks[4].pos - 0.5) < 1e-9);
  }
});

test('sectionLegendScale: adaptive step keeps ~5-9 ticks and always includes 0 and N', () => {
  for (const n of [1, 2, 4, 7, 10, 15, 50, 100, 128]) {
    const scale = sectionLegendScale('mean', n);
    const labels = scale.ticks.map((t) => Number(t.label));
    assert.equal(labels[0], 0, `N=${n} starts at 0`);
    assert.equal(labels[labels.length - 1], n, `N=${n} ends at N`);
    assert.ok(scale.ticks.length <= 10, `N=${n} not overcrowded (${scale.ticks.length} ticks)`);
    // Labels are whole numbers, strictly increasing, correctly positioned.
    for (let i = 0; i < scale.ticks.length; i++) {
      assert.ok(Number.isInteger(labels[i]), `N=${n} label ${labels[i]} is integer`);
      assert.ok(Math.abs(scale.ticks[i].pos - labels[i] / n) < 1e-9, `N=${n} tick ${labels[i]} positioned at k/N`);
      if (i > 0) assert.ok(labels[i] > labels[i - 1], `N=${n} strictly increasing`);
    }
  }
});

test('sectionLegendScale: N=100 uses a nice step of 20', () => {
  const scale = sectionLegendScale('max', 100);
  assert.deepEqual(scale.ticks.map((t) => t.label), ['0', '20', '40', '60', '80', '100']);
});

test('sectionHeatmapTextureData: invalid cells are pure black, colored cells map through Turbo', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 2,
    dimsB: 1,
    cells: [
      { valid: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) },
      { valid: true, meanFraction: 0.5, maxFraction: 0.5, minFraction: 0.5, blindFraction: 0, seenWords: new Uint32Array(1) },
    ],
    camWords: 1,
    cameraIds: ['cam-a'],
  };
  const data = sectionHeatmapTextureData(cellGrid, 'mean');
  assert.deepEqual([data[0], data[1], data[2], data[3]], [0, 0, 0, 255]);
  const [r, g, b] = turboColormap(0.5);
  assert.deepEqual([data[4], data[5], data[6], data[7]], [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255]);
});

test('averageDisplayValue averages the aggregation-selected value over colored cells only', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 2,
    dimsB: 1,
    cells: [
      { valid: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) },
      { valid: true, meanFraction: 0.4, maxFraction: 0.9, minFraction: 0.1, blindFraction: 0.3, seenWords: new Uint32Array(1) },
    ],
    camWords: 1,
    cameraIds: [],
  };
  assert.equal(averageDisplayValue(cellGrid, 'mean'), 0.4);
  assert.equal(averageDisplayValue(cellGrid, 'max'), 0.9);
  assert.equal(averageDisplayValue(cellGrid, 'blind'), 0.3);
});

test('averageDisplayValue is 0 with no colored cells', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 1,
    dimsB: 1,
    cells: [{ valid: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }],
    camWords: 1,
    cameraIds: [],
  };
  assert.equal(averageDisplayValue(cellGrid, 'mean'), 0);
});

// --- computeSectionStats (spec §13.7) ----------------------------------------

test('computeSectionStats aggregates only colored cells', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 2,
    dimsB: 1,
    cells: [
      { valid: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) },
      { valid: true, meanFraction: 0.5, maxFraction: 0.8, minFraction: 0.2, blindFraction: 0, seenWords: new Uint32Array([0b1]) },
    ],
    camWords: 1,
    cameraIds: ['cam-a', 'cam-b'],
  };
  const stats = computeSectionStats(cellGrid);
  assert.equal(stats.totalCells, 2);
  assert.equal(stats.validCells, 1);
  assert.equal(stats.invalidCells, 1);
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
    cells: [{ valid: true, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 1, seenWords: new Uint32Array(1) }],
    camWords: 1,
    cameraIds: [],
  };
  const stats = computeSectionStats(cellGrid);
  assert.equal(stats.blindCells, 1);
  assert.equal(stats.blindCellsPct, 1);
});

test('computeSectionStats: no colored cells yields zeroed numbers, not NaN', () => {
  const cellGrid: SectionCellGrid = {
    dimsA: 1,
    dimsB: 1,
    cells: [{ valid: false, meanFraction: 0, maxFraction: 0, minFraction: 0, blindFraction: 0, seenWords: new Uint32Array(1) }],
    camWords: 1,
    cameraIds: ['cam-a'],
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
