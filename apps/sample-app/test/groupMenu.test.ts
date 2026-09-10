import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupMenuItems, type GroupMenuHandlers } from '../src/ui/groupMenu.ts';
import type { GroupKind } from '../src/scene/sceneTree.ts';

const KINDS: GroupKind[] = ['cameras', 'probes', 'sections', 'zones', 'constraints', 'splats'];

function spies(exportCameraInfoBlocker: string | null = null) {
  const calls: string[] = [];
  const handlers: GroupMenuHandlers = {
    onExportCameraInfo: () => calls.push('exportCameraInfo'),
    exportCameraInfoBlocker,
  };
  return { handlers, calls };
}

test('every group declares a list — empty counts, absent does not (§15.1)', () => {
  const { handlers } = spies();
  const items = groupMenuItems(handlers);
  // The record is the compile-time guard; this is the runtime half of it. A group
  // added to the tree without an entry here shows up as a missing key.
  assert.deepEqual(Object.keys(items).sort(), [...KINDS].sort());
  for (const kind of KINDS) assert.ok(Array.isArray(items[kind]), kind);
});

test('Cameras offers exactly one item, and it fires its handler (§15.1)', () => {
  const { handlers, calls } = spies();
  const items = groupMenuItems(handlers).cameras;
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Export camera info');
  assert.equal(items[0].disabled, null);
  items[0].run();
  assert.deepEqual(calls, ['exportCameraInfo']);
});

test('an in-flight export disables the item, with a reason (§15.1)', () => {
  // The blocker is a string, not a boolean, so the disabled row explains itself
  // in its `title` — the shape the "+" menu's splat entry already uses.
  const { handlers } = spies('Still casting the camera rays…');
  const [item] = groupMenuItems(handlers).cameras;
  assert.equal(item.disabled, 'Still casting the camera rays…');
});

test('every other group offers nothing, so its header opens no menu (§15.1)', () => {
  const items = groupMenuItems(spies().handlers);
  for (const kind of KINDS.filter((k) => k !== 'cameras')) {
    assert.deepEqual(items[kind], [], kind);
  }
});

test('no label carries a trailing ellipsis — nothing opens (§15.1, §14.7)', () => {
  // "…" is this app's mark for an item that opens a dialog. The export downloads.
  const items = groupMenuItems(spies().handlers);
  for (const kind of KINDS) {
    for (const item of items[kind]) {
      assert.ok(!item.label.endsWith('…'), `${kind}: ${item.label}`);
      assert.ok(!item.label.endsWith('...'), `${kind}: ${item.label}`);
    }
  }
});
