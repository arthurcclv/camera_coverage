import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SamplingVolumeGizmoSet } from '../src/scene/samplingVolumeGizmos.ts';
import type { SamplingVolume } from '../src/scene/samplingVolumes.ts';

function volume(id: string): SamplingVolume {
  return { id, zoneId: 'zone-1', position: [0, 1, 0], rotation: [0, 0, 0, 1], size: [2, 2, 2] };
}

// The viewport "Zones" visibility toggle (spec §2.4) drives `group.visible`.
// update() must never reset it, or a re-render (moving/adding a volume, changing
// selection) would silently un-hide gizmos the user hid.
test('update() preserves group.visible so the Zones toggle sticks (spec §2.4)', () => {
  const gizmos = new SamplingVolumeGizmoSet();
  const enabled = new Set(['zone-1']);

  gizmos.update([volume('volume-1')], null, enabled);
  assert.equal(gizmos.group.visible, true, 'gizmos start visible');

  // User hides zones via the layer menu.
  gizmos.group.visible = false;

  // A subsequent state push (new volume added, selection changed) must not
  // flip visibility back on.
  gizmos.update([volume('volume-1'), volume('volume-2')], 'volume-2', enabled);
  assert.equal(gizmos.group.visible, false, 'still hidden after update');

  gizmos.dispose();
});

// --- Volumes of hidden zones (spec §2.4.3) ----------------------------------

/** The entry root for a volume id — its `visible` is the hide switch. */
function rootFor(gizmos: SamplingVolumeGizmoSet, id: string) {
  return gizmos.getAttachTarget(id)!;
}

test("a volume outside the visible-zone set draws nothing, and returns as the selection (spec §2.4.3)", () => {
  const gizmos = new SamplingVolumeGizmoSet();
  const none = new Set<string>();

  gizmos.update([volume('volume-1')], null, none);
  assert.equal(rootFor(gizmos, 'volume-1').visible, false, 'zone off: gone');

  // Selected, it comes back at the selected-disabled tier — visibly weaker than a
  // selected volume whose zone is on, so "this zone is off" survives selection.
  gizmos.update([volume('volume-1')], 'volume-1', none);
  const root = rootFor(gizmos, 'volume-1');
  assert.equal(root.visible, true, 'zone off but selected: back');
  const hiddenEdges = edgeOpacity(gizmos);
  const hiddenFill = fillOpacityOf(gizmos);

  gizmos.update([volume('volume-1')], 'volume-1', new Set(['zone-1']));
  assert.ok(edgeOpacity(gizmos) > hiddenEdges, 'selected-visible edges read stronger');
  assert.ok(fillOpacityOf(gizmos) > hiddenFill, 'selected-visible fill reads stronger');

  gizmos.dispose();
});

test('a volume of a visible zone draws whether or not it is selected (spec §2.4.3)', () => {
  const gizmos = new SamplingVolumeGizmoSet();
  const on = new Set(['zone-1']);

  gizmos.update([volume('volume-1')], null, on);
  assert.equal(rootFor(gizmos, 'volume-1').visible, true);
  gizmos.update([volume('volume-1')], 'volume-1', on);
  assert.equal(rootFor(gizmos, 'volume-1').visible, true);

  gizmos.dispose();
});

function edgeOpacity(gizmos: SamplingVolumeGizmoSet): number {
  let found = -1;
  gizmos.group.traverse((o) => {
    const line = o as { isLineSegments?: boolean; material?: { opacity: number } };
    if (line.isLineSegments && line.material) found = line.material.opacity;
  });
  return found;
}

function fillOpacityOf(gizmos: SamplingVolumeGizmoSet): number {
  let found = -1;
  gizmos.group.traverse((o) => {
    const mesh = o as { isMesh?: boolean; material?: { opacity: number } };
    if (mesh.isMesh && mesh.material) found = mesh.material.opacity;
  });
  return found;
}
