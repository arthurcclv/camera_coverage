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
  probeIdForNode,
  sectionIdForNode,
} from '../src/scene/sceneTree.ts';

function cam(id: string): CameraConfig {
  return { id, position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 };
}

function probe(id: string): Probe {
  return { id, position: [0, 0, 0] };
}

function section(id: string): Section {
  return { id, orientation: 'horizontal', min: 0, max: 1, aggregation: 'mean', visible: true };
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
