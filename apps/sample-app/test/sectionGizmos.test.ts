import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SectionGizmoSet } from '../src/scene/sectionGizmos.ts';
import type { Section, SectionCellGrid, SectionCellStats } from '../src/scene/sectionHeatmap.ts';

function section(enabled: boolean): Section {
  return {
    id: 'sec-1',
    orientation: 'horizontal',
    min: 1,
    max: 2,
    minA: -5,
    maxA: 5,
    minB: -5,
    maxB: 5,
    aggregation: 'mean',
    enabled,
    clipRange: 1,
    name: '',
  };
}

const NO_GRIDS = new Map<string, null>();

/** The entry group holding one section's heatmap plane and its two outlines. */
function groupOf(gizmos: SectionGizmoSet): THREE.Object3D {
  return gizmos.group.children.find((c) => c.type === 'Group')!;
}

/** The heatmap plane inside a section's entry group. */
function heatmap(gizmos: SectionGizmoSet): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  groupOf(gizmos).traverse((o) => {
    if ((o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found!;
}

test('a disabled section draws nothing, enabled or master-hidden (spec §2.4.3, §13.4)', () => {
  const gizmos = new SectionGizmoSet();

  gizmos.update([section(true)], NO_GRIDS, true, false, null);
  assert.equal(groupOf(gizmos).visible, true, 'enabled: drawn');

  gizmos.update([section(false)], NO_GRIDS, true, false, null);
  assert.equal(groupOf(gizmos).visible, false, 'disabled: gone');

  // The master layer toggle still wins over an enabled section (§2.4).
  gizmos.update([section(true)], NO_GRIDS, false, false, null);
  assert.equal(groupOf(gizmos).visible, false, 'layer off: gone');

  gizmos.dispose();
});

test('a selected disabled section draws its outlines and not its heatmap (spec §2.4.3)', () => {
  // This is what fixes the standing defect: a disabled section was invisible yet
  // still had TransformControls attached (§13.8), so it could be dragged blind.
  const gizmos = new SectionGizmoSet();

  gizmos.update([section(false)], NO_GRIDS, true, false, 'sec-1');
  assert.equal(groupOf(gizmos).visible, true, 'selected: back');
  assert.equal(gizmos.getAttachTarget('sec-1')!.visible, true, 'the drag target is visible');
  assert.equal(heatmap(gizmos).visible, false, 'the heatmap stays off — it is data this section is out of');

  // Enabled again, the heatmap returns.
  gizmos.update([section(true)], NO_GRIDS, true, false, 'sec-1');
  assert.equal(heatmap(gizmos).visible, true);

  gizmos.dispose();
});

/** A 2x2 grid of coloured cells — enough for the texture to be visibly real. */
function cellGrid(): SectionCellGrid {
  const cell = (meanFraction: number): SectionCellStats => ({
    valid: true,
    black: false,
    meanFraction,
    maxFraction: meanFraction,
    minFraction: meanFraction,
    blindFraction: 0,
    seenWords: new Uint32Array([1]),
  });
  return {
    dimsA: 2,
    dimsB: 2,
    cells: [cell(0.25), cell(0.5), cell(0.75), cell(1)],
    camWords: 1,
    cameraIds: ['cam-1'],
    cameraBits: [0],
    extentA: { min: -5, max: 5 },
    extentB: { min: -5, max: 5 },
  };
}

/** The heatmap's texture, which the material's `map` points at. */
function texture(gizmos: SectionGizmoSet): THREE.DataTexture {
  return (heatmap(gizmos).material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
}

test('a section with no retained data draws the no-data plane, not the last run it saw (spec §13.4, §14.4)', () => {
  // The bug this pins: entries are pooled by section id, so a `sec-1` that
  // survives a scene import reused its entry — and the `if (cellGrid)` that
  // writes the texture had no else, leaving the outgoing scene's coverage on
  // screen as a measurement of geometry that is gone.
  const gizmos = new SectionGizmoSet();

  gizmos.update([section(true)], new Map([['sec-1', cellGrid()]]), true, false, null);
  assert.equal(texture(gizmos).image.width, 2, 'the run wrote its 2x2 cells');
  assert.ok((texture(gizmos).image.data as Uint8Array).some((b) => b !== 0), 'and they are not blank');

  // Same id, no data — what `coverageRun.clear()` produces on import (§14.4).
  gizmos.update([section(true)], NO_GRIDS, true, false, null);
  const reset = texture(gizmos);
  assert.equal(reset.image.width, 1, 'back to the 1x1 no-data plane');
  assert.equal(reset.image.height, 1);
  assert.deepEqual(Array.from(reset.image.data as Uint8Array), [0, 0, 0, 0], 'fully transparent (§13.3)');

  gizmos.dispose();
});

test('a fresh section is already the no-data plane, and a run replaces it in place (spec §13.4)', () => {
  const gizmos = new SectionGizmoSet();

  gizmos.update([section(true)], NO_GRIDS, true, false, null);
  const first = texture(gizmos);
  assert.equal(first.image.width, 1, 'no run yet: transparent');

  // A never-measured section must not churn its texture on every update either.
  gizmos.update([section(true)], NO_GRIDS, true, false, null);
  assert.equal(texture(gizmos), first, 'the no-data texture is kept, not rebuilt');

  gizmos.update([section(true)], new Map([['sec-1', cellGrid()]]), true, false, null);
  assert.equal(texture(gizmos).image.width, 2, 'the run takes over');

  gizmos.dispose();
});
