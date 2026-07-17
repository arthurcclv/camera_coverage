import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import {
  buildSceneTree,
  cameraIdForNode,
  flattenVisible,
  nodeIdForCamera,
} from '../src/scene/sceneTree.ts';

function cam(id: string): CameraConfig {
  return { id, position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 };
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
