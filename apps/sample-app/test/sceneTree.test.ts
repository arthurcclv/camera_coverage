import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import type { Probe } from '../src/scene/probeVisibility.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import {
  buildSceneTree,
  cameraIdForNode,
  flattenVisible,
  nodeIdForCamera,
  nodeIdForProbe,
  nodeIdForSection,
  nodeIdForVolume,
  nodeIdForZone,
  probeIdForNode,
  sectionIdForNode,
  volumeIdForNode,
  zoneIdForNode,
} from '../src/scene/sceneTree.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';

function cam(id: string): CameraConfig {
  return { id, position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 };
}

function probe(id: string): Probe {
  return { id, position: [0, 0, 0] };
}

function section(id: string): Section {
  return { id, orientation: 'horizontal', min: 0, max: 1, aggregation: 'mean', enabled: true, clipRange: 2 };
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
