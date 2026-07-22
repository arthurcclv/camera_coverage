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
