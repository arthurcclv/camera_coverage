import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SceneCamera } from '../src/cameras/camera.ts';
import type { Probe } from '../src/scene/probeVisibility.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import {
  buildSceneTree,
  cameraIdForNode,
  flattenVisible,
  nodeIdForCamera,
  nodeIdForConstraint,
  nodeIdForConstraintGroup,
  nodeIdForProbe,
  nodeIdForSelection,
  nodeIdForSection,
  nodeIdForVolume,
  nodeIdForZone,
  nodeSelection,
  probeIdForNode,
  sectionIdForNode,
  volumeIdForNode,
  zoneIdForNode,
} from '../src/scene/sceneTree.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';
import type { CameraConstraint, ConstraintGroup } from '../src/placement/region.ts';

function cam(id: string): SceneCamera {
  return { id, name: '', position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 };
}

function probe(id: string): Probe {
  return { id, position: [0, 0, 0], name: '' };
}

function section(id: string): Section {
  return { id, orientation: 'horizontal', min: 0, max: 1, aggregation: 'mean', enabled: true, clipRange: 2, name: '' };
}

function zone(id: string, name = id): Zone {
  return { id, name, enabled: true };
}

function volume(id: string, zoneId: string): SamplingVolume {
  return { id, zoneId, position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1] };
}

test('buildSceneTree yields a Cameras group over one node per camera, in order', () => {
  const cameras = [cam('a'), cam('b'), cam('c')];
  const nodes = buildSceneTree(cameras);

  const group = nodes[0];
  assert.equal(group.kind, 'group');
  assert.equal(group.kind === 'group' && group.label, 'Cameras');
  assert.deepEqual(
    group.kind === 'group' && group.childIds,
    cameras.map((c) => nodeIdForCamera(c.id)),
  );

  const cameraNodes = nodes.slice(1);
  assert.equal(cameraNodes.length, 3);
  assert.deepEqual(
    cameraNodes.map((n) => n.kind === 'camera' && n.cameraId),
    ['a', 'b', 'c'],
  );
});

test('camera node ids round-trip through nodeIdForCamera / cameraIdForNode', () => {
  assert.equal(cameraIdForNode(nodeIdForCamera('cam-7')), 'cam-7');
  assert.equal(cameraIdForNode('group:cameras'), null);
});

test('flattenVisible lists the group then its children when expanded', () => {
  const nodes = buildSceneTree([cam('a'), cam('b')]);
  const rows = flattenVisible(nodes, new Set());

  assert.deepEqual(
    rows.map((r) => [r.node.id, r.depth]),
    [
      ['group:cameras', 0],
      [nodeIdForCamera('a'), 1],
      [nodeIdForCamera('b'), 1],
    ],
  );
  assert.equal(rows[0].hasChildren, true);
  assert.equal(rows[0].collapsed, false);
});

test('flattenVisible hides descendants of a collapsed group', () => {
  const nodes = buildSceneTree([cam('a'), cam('b')]);
  const rows = flattenVisible(nodes, new Set(['group:cameras']));

  assert.deepEqual(
    rows.map((r) => r.node.id),
    ['group:cameras'],
  );
  assert.equal(rows[0].hasChildren, true);
  assert.equal(rows[0].collapsed, true);
});

test('empty camera list yields an empty (childless) group', () => {
  const nodes = buildSceneTree([]);
  assert.equal(nodes.length, 1);
  const rows = flattenVisible(nodes, new Set());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasChildren, false);
});

test('no Probes group when there are no probes (spec §5.5)', () => {
  const nodes = buildSceneTree([cam('a')], []);
  assert.equal(nodes.some((n) => n.kind === 'group' && n.label === 'Probes'), false);
});

test('buildSceneTree adds a Probes group over one node per probe (spec §5.5)', () => {
  const nodes = buildSceneTree([cam('a')], [probe('p1'), probe('p2')]);
  const probeGroup = nodes.find((n) => n.kind === 'group' && n.label === 'Probes');
  assert.ok(probeGroup);
  assert.deepEqual(
    probeGroup.kind === 'group' && probeGroup.childIds,
    [nodeIdForProbe('p1'), nodeIdForProbe('p2')],
  );
  const probeNodes = nodes.filter((n) => n.kind === 'probe');
  assert.deepEqual(
    probeNodes.map((n) => n.kind === 'probe' && n.probeId),
    ['p1', 'p2'],
  );
});

test('probe node ids round-trip and stay disjoint from camera ids', () => {
  assert.equal(probeIdForNode(nodeIdForProbe('probe-3')), 'probe-3');
  assert.equal(probeIdForNode(nodeIdForCamera('cam-1')), null);
  assert.equal(cameraIdForNode(nodeIdForProbe('probe-3')), null);
});

test('flattenVisible lists Cameras then Probes groups with their children', () => {
  const nodes = buildSceneTree([cam('a')], [probe('p1')]);
  const rows = flattenVisible(nodes, new Set());
  assert.deepEqual(
    rows.map((r) => r.node.id),
    ['group:cameras', nodeIdForCamera('a'), 'group:probes', nodeIdForProbe('p1')],
  );
});

test('no Sections group when there are no sections (spec §5.5)', () => {
  const nodes = buildSceneTree([cam('a')], [], []);
  assert.equal(nodes.some((n) => n.kind === 'group' && n.label === 'Sections'), false);
});

test('buildSceneTree adds a Sections group over one node per section (spec §5.5, §13)', () => {
  const nodes = buildSceneTree([cam('a')], [], [section('s1'), section('s2')]);
  const sectionGroup = nodes.find((n) => n.kind === 'group' && n.label === 'Sections');
  assert.ok(sectionGroup);
  assert.deepEqual(
    sectionGroup.kind === 'group' && sectionGroup.childIds,
    [nodeIdForSection('s1'), nodeIdForSection('s2')],
  );
  const sectionNodes = nodes.filter((n) => n.kind === 'section');
  assert.deepEqual(
    sectionNodes.map((n) => n.kind === 'section' && n.sectionId),
    ['s1', 's2'],
  );
});

test('section node ids round-trip and stay disjoint from camera/probe ids', () => {
  assert.equal(sectionIdForNode(nodeIdForSection('section-2')), 'section-2');
  assert.equal(sectionIdForNode(nodeIdForCamera('cam-1')), null);
  assert.equal(cameraIdForNode(nodeIdForSection('section-2')), null);
  assert.equal(probeIdForNode(nodeIdForSection('section-2')), null);
});

test('flattenVisible lists Cameras, Probes, then Sections groups with their children', () => {
  const nodes = buildSceneTree([cam('a')], [probe('p1')], [section('s1')]);
  const rows = flattenVisible(nodes, new Set());
  assert.deepEqual(
    rows.map((r) => r.node.id),
    ['group:cameras', nodeIdForCamera('a'), 'group:probes', nodeIdForProbe('p1'), 'group:sections', nodeIdForSection('s1')],
  );
});

test('no Zones umbrella when there are no zones (sampling_volumes.md §4.1)', () => {
  const nodes = buildSceneTree([cam('a')], [], [], [], []);
  assert.equal(nodes.some((n) => n.kind === 'group' && n.label === 'Zones'), false);
  assert.equal(nodes.some((n) => n.kind === 'zone'), false);
});

test('an empty zone (no volumes yet) still shows under the Zones umbrella (sampling_volumes.md §4.1)', () => {
  const nodes = buildSceneTree([cam('a')], [], [], [zone('zone-1')], []);
  const umbrella = nodes.find((n) => n.kind === 'group' && n.label === 'Zones');
  assert.ok(umbrella);
  const zoneNode = nodes.find((n) => n.kind === 'zone' && n.zoneId === 'zone-1');
  assert.ok(zoneNode && zoneNode.kind === 'zone');
  assert.deepEqual(zoneNode.childIds, []); // no volumes yet
  // It flattens to a visible row.
  const rows = flattenVisible(nodes, new Set());
  assert.ok(rows.some((r) => r.node.id === nodeIdForZone('zone-1')));
});

test('buildSceneTree adds a Zones umbrella with selectable+expandable zone nodes over their volumes', () => {
  const zones = [zone('zone-1', 'West'), zone('zone-2', 'East')];
  const volumes = [volume('volume-1', 'zone-1'), volume('volume-2', 'zone-1'), volume('volume-3', 'zone-2')];
  const nodes = buildSceneTree([cam('a')], [], [], zones, volumes);

  const umbrella = nodes.find((n) => n.kind === 'group' && n.label === 'Zones');
  assert.ok(umbrella);
  assert.deepEqual(
    umbrella.kind === 'group' && umbrella.childIds,
    [nodeIdForZone('zone-1'), nodeIdForZone('zone-2')],
  );

  const zone1 = nodes.find((n) => n.kind === 'zone' && n.zoneId === 'zone-1');
  assert.ok(zone1 && zone1.kind === 'zone');
  assert.equal(zone1.label, 'West'); // display label
  assert.deepEqual(zone1.childIds, [nodeIdForVolume('volume-1'), nodeIdForVolume('volume-2')]);
});

test('zone/volume node ids round-trip and stay disjoint from other ids', () => {
  assert.equal(zoneIdForNode(nodeIdForZone('zone-3')), 'zone-3');
  assert.equal(volumeIdForNode(nodeIdForVolume('volume-9')), 'volume-9');
  assert.equal(zoneIdForNode(nodeIdForVolume('volume-9')), null);
  assert.equal(volumeIdForNode(nodeIdForZone('zone-3')), null);
  assert.equal(cameraIdForNode(nodeIdForZone('zone-3')), null);
});

test('flattenVisible expands a zone into its volumes, and a collapsed zone hides them', () => {
  const zones = [zone('zone-1')];
  const volumes = [volume('volume-1', 'zone-1'), volume('volume-2', 'zone-1')];
  const nodes = buildSceneTree([cam('a')], [], [], zones, volumes);

  const expanded = flattenVisible(nodes, new Set());
  assert.deepEqual(
    expanded.filter((r) => r.node.kind === 'zone' || r.node.kind === 'volume').map((r) => r.node.id),
    [nodeIdForZone('zone-1'), nodeIdForVolume('volume-1'), nodeIdForVolume('volume-2')],
  );
  const zoneRow = expanded.find((r) => r.node.id === nodeIdForZone('zone-1'));
  assert.equal(zoneRow?.hasChildren, true);

  const collapsed = flattenVisible(nodes, new Set([nodeIdForZone('zone-1')]));
  assert.equal(collapsed.some((r) => r.node.kind === 'volume'), false);
});

test('the tree follows array order, so a reorder shows up as a row reorder (§5.5.1)', () => {
  const cameras = [cam('cam-1'), cam('cam-2'), cam('cam-3')];
  const before = flattenVisible(buildSceneTree(cameras, [], [], [], []), new Set());
  assert.deepEqual(
    before.filter((r) => r.node.kind === 'camera').map((r) => r.node.id),
    [nodeIdForCamera('cam-1'), nodeIdForCamera('cam-2'), nodeIdForCamera('cam-3')],
  );

  // The reducer's splice: cam-3 moved to the front.
  const after = flattenVisible(
    buildSceneTree([cameras[2], cameras[0], cameras[1]], [], [], [], []),
    new Set(),
  );
  assert.deepEqual(
    after.filter((r) => r.node.kind === 'camera').map((r) => r.node.id),
    [nodeIdForCamera('cam-3'), nodeIdForCamera('cam-1'), nodeIdForCamera('cam-2')],
  );
});

test('a zone renders only its own volumes, in their array order, ignoring interleaving', () => {
  const zones = [zone('zone-1'), zone('zone-2')];
  // Interleaved, as appending on create produces (§14.3).
  const volumes = [volume('volume-1', 'zone-1'), volume('volume-2', 'zone-2'), volume('volume-3', 'zone-1')];
  const rows = flattenVisible(buildSceneTree([], [], [], zones, volumes), new Set());
  assert.deepEqual(
    rows.filter((r) => r.node.kind === 'zone' || r.node.kind === 'volume').map((r) => r.node.id),
    [
      nodeIdForZone('zone-1'),
      nodeIdForVolume('volume-1'),
      nodeIdForVolume('volume-3'),
      nodeIdForZone('zone-2'),
      nodeIdForVolume('volume-2'),
    ],
  );
});

// --- camera constraints (`camera_placement.md` §7) --------------------------

const cgroup = (id: string, name = ''): ConstraintGroup => ({
  id,
  name,
  enabled: true,
  fov: 60,
  aspect: 16 / 9,
  near: 0.1,
  far: 30,
  namePrefix: '',
  poolSize: 200,
  maxCount: 10,
  trials: 1000,
  epsilon: 1,
  seed: 1,
});

const con = (id: string, groupId: string, name = ''): CameraConstraint => ({
  id,
  groupId,
  name,
  enabled: true,
  distance: 0,
  kind: 'point',
  position: [0, 0, 0],
});

test('the Constraints umbrella appears once a group exists, even an empty one', () => {
  const nodes = buildSceneTree([], [], [], [], [], [cgroup('cg-1')], []);
  const umbrella = nodes.find((n) => n.kind === 'group' && n.label === 'Constraints');
  assert.ok(umbrella, 'expected a Constraints umbrella');
  assert.equal(nodes.some((n) => n.kind === 'constraintGroup' && n.groupId === 'cg-1'), true);
});

test('each group holds its own constraints as children, in array order', () => {
  const nodes = buildSceneTree(
    [],
    [],
    [],
    [],
    [],
    [cgroup('cg-1'), cgroup('cg-2')],
    [con('con-1', 'cg-1'), con('con-2', 'cg-2'), con('con-3', 'cg-1')],
  );
  const g1 = nodes.find((n) => n.kind === 'constraintGroup' && n.groupId === 'cg-1');
  const g2 = nodes.find((n) => n.kind === 'constraintGroup' && n.groupId === 'cg-2');
  assert.ok(g1 && g1.kind === 'constraintGroup');
  assert.ok(g2 && g2.kind === 'constraintGroup');
  // A flat `constraints` array may interleave groups (new ones append), and each
  // group takes only its own, in the order they appear.
  assert.deepEqual(g1.childIds, [nodeIdForConstraint('con-1'), nodeIdForConstraint('con-3')]);
  assert.deepEqual(g2.childIds, [nodeIdForConstraint('con-2')]);
});

test('a constraint group expands, so its constraints hide when it collapses', () => {
  const nodes = buildSceneTree([], [], [], [], [], [cgroup('cg-1')], [con('con-1', 'cg-1')]);
  const open = flattenVisible(nodes, new Set());
  assert.equal(open.some((r) => r.node.kind === 'constraint'), true);
  const groupRow = open.find((r) => r.node.kind === 'constraintGroup')!;
  assert.equal(groupRow.hasChildren, true);
  const shut = flattenVisible(nodes, new Set([groupRow.node.id]));
  assert.equal(shut.some((r) => r.node.kind === 'constraint'), false);
});

test('Constraints is the last root group: Cameras → Probes → Sections → Zones → Constraints', () => {
  const nodes = buildSceneTree(
    [cam('cam-1')],
    [{ id: 'probe-1', name: '', position: [0, 0, 0] }],
    [],
    [{ id: 'zone-1', name: '', enabled: true }],
    [],
    [cgroup('cg-1')],
    [],
  );
  const roots = flattenVisible(nodes, new Set())
    .filter((r) => r.depth === 0)
    .map((r) => r.node.label);
  assert.deepEqual(roots, ['Cameras', 'Probes', 'Zones', 'Constraints']);
});

test('group and constraint labels fall back to their id-derived defaults', () => {
  const nodes = buildSceneTree([], [], [], [], [], [cgroup('cg-3')], [con('con-7', 'cg-3', ' Rail ')]);
  const group = nodes.find((n) => n.kind === 'constraintGroup')!;
  const constraint = nodes.find((n) => n.kind === 'constraint')!;
  assert.equal(group.label, 'Group 3');
  assert.equal(constraint.label, 'Rail');
});

// --- selection → highlighted node (spec §5.5, `camera_placement.md` §7) --------

test('nodeIdForSelection: a constraint selection highlights its own row', () => {
  // The gap: the ternary chain this replaced ended in `: null`, so a constraint
  // selection resolved to no node and the row never highlighted — even though the
  // row dispatches `{ kind: 'constraint' }` on click and renders a highlight for
  // whatever is selected.
  assert.equal(nodeIdForSelection({ kind: 'constraint', id: 'con-1' }), nodeIdForConstraint('con-1'));
});

test('nodeIdForSelection: a constraint group selection highlights its own row', () => {
  assert.equal(
    nodeIdForSelection({ kind: 'constraintGroup', id: 'cg-1' }),
    nodeIdForConstraintGroup('cg-1'),
  );
});

test('nodeIdForSelection: every selectable kind resolves to its own node id', () => {
  // The regression net: `Record<Selection['kind'], …>` makes a *missing* kind a
  // compile error; this makes a kind pointed at the wrong node a test failure.
  assert.equal(nodeIdForSelection({ kind: 'camera', id: 'cam-1' }), nodeIdForCamera('cam-1'));
  assert.equal(nodeIdForSelection({ kind: 'probe', id: 'probe-1' }), nodeIdForProbe('probe-1'));
  assert.equal(nodeIdForSelection({ kind: 'section', id: 'section-1' }), nodeIdForSection('section-1'));
  assert.equal(nodeIdForSelection({ kind: 'zone', id: 'zone-1' }), nodeIdForZone('zone-1'));
  assert.equal(nodeIdForSelection({ kind: 'volume', id: 'vol-1' }), nodeIdForVolume('vol-1'));
});

test('nodeIdForSelection: the ids are namespaced, so no two kinds collide on one row', () => {
  // Same raw id, different kinds: the highlight must not follow a stale selection
  // onto an unrelated row.
  const ids = new Set(
    (['camera', 'probe', 'section', 'zone', 'volume', 'constraintGroup', 'constraint'] as const).map(
      (kind) => nodeIdForSelection({ kind, id: 'x' }),
    ),
  );
  assert.equal(ids.size, 7);
});

test('nodeIdForSelection: an empty selection highlights nothing', () => {
  assert.equal(nodeIdForSelection(null), null);
});

// --- Row selection (spec §5.5, §4.1) -----------------------------------------

test('nodeSelection maps each row kind to its own entity, and a group to nothing', () => {
  // The bare `else` this replaced claimed `constraint`, so every kind added to
  // `SceneNode` afterwards would have been selected as a constraint with an
  // undefined id. Each kind is named here so the mapping is pinned, not just
  // the two ends of it.
  assert.deepEqual(nodeSelection({ kind: 'group', id: 'g', label: '', childIds: [] }), null);
  assert.deepEqual(nodeSelection({ kind: 'camera', id: 'n', label: '', cameraId: 'cam-1' }), {
    kind: 'camera',
    id: 'cam-1',
  });
  assert.deepEqual(nodeSelection({ kind: 'probe', id: 'n', label: '', probeId: 'p-1' }), {
    kind: 'probe',
    id: 'p-1',
  });
  assert.deepEqual(nodeSelection({ kind: 'section', id: 'n', label: '', sectionId: 's-1' }), {
    kind: 'section',
    id: 's-1',
  });
  assert.deepEqual(nodeSelection({ kind: 'zone', id: 'n', label: '', zoneId: 'z-1', childIds: [] }), {
    kind: 'zone',
    id: 'z-1',
  });
  assert.deepEqual(nodeSelection({ kind: 'volume', id: 'n', label: '', volumeId: 'v-1' }), {
    kind: 'volume',
    id: 'v-1',
  });
  assert.deepEqual(
    nodeSelection({ kind: 'constraintGroup', id: 'n', label: '', groupId: 'cg-1', childIds: [] }),
    { kind: 'constraintGroup', id: 'cg-1' },
  );
  assert.deepEqual(nodeSelection({ kind: 'constraint', id: 'n', label: '', constraintId: 'con-1' }), {
    kind: 'constraint',
    id: 'con-1',
  });
});
