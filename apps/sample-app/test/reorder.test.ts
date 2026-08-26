import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SceneCamera } from '../src/cameras/camera.ts';
import { buildSceneTree, flattenVisible, type RenderRow } from '../src/scene/sceneTree.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';
import {
  insertionTargetAt,
  moveBefore,
  moveVolumeBefore,
  siblingRows,
  type RowBox,
} from '../src/scene/reorder.ts';

function cam(id: string): SceneCamera {
  return { id, name: '', enabled: true, position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 };
}

function zone(id: string): Zone {
  return { id, name: id, enabled: true };
}

function volume(id: string, zoneId: string): SamplingVolume {
  return { id, zoneId, position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1] };
}

/** Lay the visible rows out as uniform 20px-tall boxes starting at y=0. */
const ROW_H = 20;
function layout(rows: RenderRow[]): Map<string, RowBox> {
  const boxes = new Map<string, RowBox>();
  rows.forEach((r, i) => {
    boxes.set(r.node.id, { nodeId: r.node.id, top: i * ROW_H, bottom: (i + 1) * ROW_H });
  });
  return boxes;
}

/** Midpoint-crossing Y for the row at visible index `i` (just past its middle). */
const belowMidOf = (i: number) => i * ROW_H + ROW_H / 2 + 1;
const aboveMidOf = (i: number) => i * ROW_H + ROW_H / 2 - 1;

// --- moveBefore: the splice for cameras / probes / sections / zones ----------

test('moveBefore moves an element before a later sibling', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveBefore(items, 'a', 'c'), [{ id: 'b' }, { id: 'a' }, { id: 'c' }]);
});

test('moveBefore moves an element before an earlier sibling', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveBefore(items, 'c', 'b'), [{ id: 'a' }, { id: 'c' }, { id: 'b' }]);
});

test('moveBefore with a null beforeId appends to the end', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveBefore(items, 'a', null), [{ id: 'b' }, { id: 'c' }, { id: 'a' }]);
});

test('moveBefore returns the same array reference on every no-op', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  // Already immediately before the target.
  assert.equal(moveBefore(items, 'a', 'b'), items);
  // Already last.
  assert.equal(moveBefore(items, 'c', null), items);
  // Onto itself.
  assert.equal(moveBefore(items, 'b', 'b'), items);
  // Unknown ids.
  assert.equal(moveBefore(items, 'zz', 'a'), items);
  assert.equal(moveBefore(items, 'a', 'zz'), items);
});

// --- moveVolumeBefore: permute within the zone's own slots -------------------

test('moveVolumeBefore reorders within a zone, leaving other zones untouched', () => {
  // Interleaved, as the array naturally becomes (volumes always append on create).
  const volumes = [volume('v1', 'z1'), volume('v2', 'z2'), volume('v3', 'z1'), volume('v4', 'z2')];
  const next = moveVolumeBefore(volumes, 'v3', 'v1');
  // z1's two slots (0 and 2) swap contents; z2's slots (1 and 3) are byte-identical.
  assert.deepEqual(
    next.map((v) => v.id),
    ['v3', 'v2', 'v1', 'v4'],
  );
  assert.equal(next[1], volumes[1]);
  assert.equal(next[3], volumes[3]);
});

test('moveVolumeBefore with null appends within the zone, not the array', () => {
  const volumes = [volume('v1', 'z1'), volume('v2', 'z2'), volume('v3', 'z1')];
  const next = moveVolumeBefore(volumes, 'v1', null);
  // v1 goes to z1's LAST slot (index 2), not the array's end past z2's volume.
  assert.deepEqual(
    next.map((v) => v.id),
    ['v3', 'v2', 'v1'],
  );
});

test('moveVolumeBefore refuses to reparent across zones', () => {
  const volumes = [volume('v1', 'z1'), volume('v2', 'z2')];
  // v2 belongs to another zone — dragging never changes zoneId (§5.5.1).
  assert.equal(moveVolumeBefore(volumes, 'v1', 'v2'), volumes);
  assert.equal(moveVolumeBefore(volumes, 'v1', 'nope'), volumes);
  assert.equal(moveVolumeBefore(volumes, 'nope', 'v1'), volumes);
});

test('moveVolumeBefore returns the same reference on a no-op', () => {
  const volumes = [volume('v1', 'z1'), volume('v2', 'z1')];
  assert.equal(moveVolumeBefore(volumes, 'v1', 'v2'), volumes);
  assert.equal(moveVolumeBefore(volumes, 'v2', null), volumes);
});

// --- siblingRows: who a row may be reordered among ---------------------------

test('siblingRows for a camera is the camera run, excluding the group header', () => {
  const rows = flattenVisible(buildSceneTree([cam('cam-1'), cam('cam-2')], [], [], [], []), new Set());
  const siblings = siblingRows(rows, 'cam:cam-1').map((r) => r.node.id);
  assert.deepEqual(siblings, ['cam:cam-1', 'cam:cam-2']);
});

test('siblingRows for a volume is only its OWN zone’s volumes', () => {
  const zones = [zone('z1'), zone('z2')];
  const volumes = [volume('v1', 'z1'), volume('v2', 'z2'), volume('v3', 'z1')];
  const rows = flattenVisible(buildSceneTree([], [], [], zones, volumes), new Set());
  // z1 renders v1 then v3; z2 renders v2. v2 is a same-depth volume but not contiguous.
  assert.deepEqual(
    siblingRows(rows, 'volume:v1').map((r) => r.node.id),
    ['volume:v1', 'volume:v3'],
  );
  assert.deepEqual(
    siblingRows(rows, 'volume:v2').map((r) => r.node.id),
    ['volume:v2'],
  );
});

test('siblingRows for a zone is the zone run, skipping their volume children', () => {
  const zones = [zone('z1'), zone('z2')];
  const volumes = [volume('v1', 'z1'), volume('v2', 'z2')];
  const rows = flattenVisible(buildSceneTree([], [], [], zones, volumes), new Set());
  assert.deepEqual(
    siblingRows(rows, 'zone:z1').map((r) => r.node.id),
    ['zone:z1', 'zone:z2'],
  );
});

test('siblingRows is empty for a group header (not draggable)', () => {
  const rows = flattenVisible(buildSceneTree([cam('cam-1')], [], [], [], []), new Set());
  assert.deepEqual(siblingRows(rows, 'group:cameras'), []);
  assert.deepEqual(siblingRows(rows, 'nope'), []);
});

// --- insertionTargetAt -------------------------------------------------------

test('insertionTargetAt resolves above a sibling’s midpoint to "before" it', () => {
  // rows: 0 group:cameras, 1 cam-1, 2 cam-2, 3 cam-3
  const rows = flattenVisible(
    buildSceneTree([cam('cam-1'), cam('cam-2'), cam('cam-3')], [], [], [], []),
    new Set(),
  );
  const boxes = layout(rows);
  const t = insertionTargetAt(aboveMidOf(3), rows, boxes, 'cam:cam-1');
  assert.deepEqual(t, { beforeId: 'cam-3', beforeNodeId: 'cam:cam-3', lineY: 60, depth: 1 });
});

test('insertionTargetAt past the last sibling’s midpoint appends (beforeId null)', () => {
  const rows = flattenVisible(
    buildSceneTree([cam('cam-1'), cam('cam-2'), cam('cam-3')], [], [], [], []),
    new Set(),
  );
  const boxes = layout(rows);
  const t = insertionTargetAt(belowMidOf(3), rows, boxes, 'cam:cam-1');
  assert.equal(t?.beforeId, null);
  assert.equal(t?.beforeNodeId, null);
  // The line sits at the bottom of the last sibling's subtree.
  assert.equal(t?.lineY, 80);
});

test('insertionTargetAt returns null for both no-op adjacencies', () => {
  const rows = flattenVisible(
    buildSceneTree([cam('cam-1'), cam('cam-2'), cam('cam-3')], [], [], [], []),
    new Set(),
  );
  const boxes = layout(rows);
  // Onto its own row (slot === draggedIndex).
  assert.equal(insertionTargetAt(aboveMidOf(2), rows, boxes, 'cam:cam-2'), null);
  // Into the gap right after itself (slot === draggedIndex + 1).
  assert.equal(insertionTargetAt(belowMidOf(2), rows, boxes, 'cam:cam-2'), null);
});

test('insertionTargetAt rejects a pointer outside the sibling run', () => {
  const cams = [cam('cam-1'), cam('cam-2')];
  const rows = flattenVisible(buildSceneTree(cams, [], [], [zone('z1')], [volume('v1', 'z1')]), new Set());
  const boxes = layout(rows);
  // rows: 0 group:cameras, 1 cam-1, 2 cam-2, 3 group:zones, 4 zone:z1, 5 volume:v1
  // Over the Cameras header (above the camera run) — illegal.
  assert.equal(insertionTargetAt(5, rows, boxes, 'cam:cam-1'), null);
  // Over a zone row, dragging a camera — cross-group, illegal (§5.5.1).
  assert.equal(insertionTargetAt(4 * ROW_H + 5, rows, boxes, 'cam:cam-1'), null);
});

test('insertionTargetAt lets a zone drop past an expanded zone’s last volume', () => {
  const zones = [zone('z1'), zone('z2')];
  const volumes = [volume('v1', 'z1'), volume('v2', 'z2')];
  const rows = flattenVisible(buildSceneTree([], [], [], zones, volumes), new Set());
  // rows: 0 group:cameras (always emitted), 1 group:zones, 2 zone:z1,
  //       3 volume:v1, 4 zone:z2, 5 volume:v2
  const boxes = layout(rows);
  // Over z2's volume child — below the last zone row, but still inside z2's
  // subtree, so it means "after z2": append.
  const t = insertionTargetAt(5 * ROW_H + 10, rows, boxes, 'zone:z1');
  assert.equal(t?.beforeId, null);
  assert.equal(t?.lineY, 120); // bottom of the last sibling's subtree, not its row
});

test('insertionTargetAt treats a zone’s own children as a no-op zone', () => {
  const zones = [zone('z1'), zone('z2')];
  const volumes = [volume('v1', 'z1'), volume('v2', 'z2')];
  const rows = flattenVisible(buildSceneTree([], [], [], zones, volumes), new Set());
  const boxes = layout(rows);
  // Dragging z1 over its own volume child (row 3) resolves to "before z2" ===
  // where it already is, so no line and no move.
  assert.equal(insertionTargetAt(3 * ROW_H + 10, rows, boxes, 'zone:z1'), null);
});

test('insertionTargetAt reports the sibling run’s depth for the line inset', () => {
  const rows = flattenVisible(
    buildSceneTree([], [], [], [zone('z1')], [volume('v1', 'z1'), volume('v2', 'z1')]),
    new Set(),
  );
  const boxes = layout(rows);
  // rows: 0 group:cameras (d0), 1 group:zones (d0), 2 zone:z1 (d1),
  //       3 volume:v1 (d2), 4 volume:v2 (d2)
  const t = insertionTargetAt(aboveMidOf(3), rows, boxes, 'volume:v2');
  assert.equal(t?.beforeId, 'v1');
  assert.equal(t?.depth, 2);
});

test('insertionTargetAt ignores rows it has no measurement for', () => {
  const rows = flattenVisible(buildSceneTree([cam('cam-1'), cam('cam-2')], [], [], [], []), new Set());
  assert.equal(insertionTargetAt(10, rows, new Map(), 'cam:cam-1'), null);
});
