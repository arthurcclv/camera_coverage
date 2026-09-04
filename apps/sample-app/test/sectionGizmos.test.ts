import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SectionGizmoSet } from '../src/scene/sectionGizmos.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';

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
