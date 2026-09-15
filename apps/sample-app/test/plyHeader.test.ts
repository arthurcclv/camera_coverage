/**
 * Routing a `.ply` by its header (`asset_import.md` §4.2) — the one sniff that
 * keeps a mesh PLY and a 3DGS capture, which share an extension and nothing
 * else, from being imported as each other.
 *
 * A pure function over header text, so every case here is a string fixture with
 * no file system involved (`ai/CONVENTIONS.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPlyHeader, PLY_SNIFF_BYTES } from '../src/scene/plyHeader.ts';

const meshPly = [
  'ply',
  'format ascii 1.0',
  'element vertex 8',
  'property float x',
  'property float y',
  'property float z',
  'element face 12',
  'property list uchar int vertex_indices',
  'end_header',
].join('\n');

const splatPly = [
  'ply',
  'format binary_little_endian 1.0',
  'element vertex 1000000',
  'property float x',
  'property float f_dc_0',
  'property float scale_0',
  'property float rot_0',
  'property float opacity',
  'end_header',
].join('\n');

const pointsPly = ['ply', 'format ascii 1.0', 'element vertex 500', 'property float x', 'end_header'].join('\n');

test('`element face` with no Gaussian properties is a mesh (§4.2)', () => {
  assert.equal(classifyPlyHeader(meshPly), 'mesh');
});

test('Gaussian per-vertex properties are a capture (§4.2)', () => {
  assert.equal(classifyPlyHeader(splatPly), 'splat');
});

test('any one Gaussian property is enough', () => {
  for (const prop of ['f_dc_0', 'scale_0', 'rot_0', 'opacity']) {
    const head = ['ply', 'element vertex 3', `property float ${prop}`, 'end_header'].join('\n');
    assert.equal(classifyPlyHeader(head), 'splat', prop);
  }
});

test('Gaussian properties win over `element face`, since §4.2 leaves the splat row unqualified', () => {
  const both = ['ply', 'element vertex 3', 'property float opacity', 'element face 1', 'end_header'].join('\n');
  assert.equal(classifyPlyHeader(both), 'splat');
});

test('vertices with neither faces nor Gaussians are a point cloud (§4.2)', () => {
  assert.equal(classifyPlyHeader(pointsPly), 'points');
});

test('a property merely containing a Gaussian name is not one', () => {
  // `property float scale_0_backup` is a mesh property; matching on substrings
  // would route the whole file to the wrong entry.
  const head = ['ply', 'element vertex 3', 'property float scale_0_backup', 'element face 1', 'end_header'].join('\n');
  assert.equal(classifyPlyHeader(head), 'mesh');
});

test('a binary_little_endian header classifies like any other — the header is always ASCII', () => {
  assert.equal(classifyPlyHeader(splatPly), 'splat');
  assert.equal(
    classifyPlyHeader(meshPly.replace('format ascii 1.0', 'format binary_little_endian 1.0')),
    'mesh',
  );
});

test('CRLF line endings are tolerated', () => {
  assert.equal(classifyPlyHeader(meshPly.replace(/\n/g, '\r\n')), 'mesh');
  assert.equal(classifyPlyHeader(splatPly.replace(/\n/g, '\r\n')), 'splat');
});

test('a leading BOM is tolerated, despite the format being magic-first', () => {
  assert.equal(classifyPlyHeader(`﻿${meshPly}`), 'mesh');
});

test('a header with no `end_header` in the sniff window is unreadable (§4.2)', () => {
  const runaway = ['ply', 'format ascii 1.0', ...Array(400).fill('comment padding')].join('\n');
  assert.ok(runaway.length > PLY_SNIFF_BYTES);
  assert.equal(classifyPlyHeader(runaway.slice(0, PLY_SNIFF_BYTES)), 'unreadable');
});

test('a non-PLY magic is unreadable (§4.2)', () => {
  assert.equal(classifyPlyHeader('glTF binary container'), 'unreadable');
  assert.equal(classifyPlyHeader(''), 'unreadable');
  assert.equal(classifyPlyHeader('plywood\nend_header'), 'unreadable');
});
