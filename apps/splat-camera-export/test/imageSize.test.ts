/** Tests for `render/imageSize.ts` (spec §9.1, §12). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageSizeFor, MIN_DIMENSION, rigAspect } from '../src/render/imageSize.ts';

const MAX = 8192;

test('derive: height is the base height, width follows the camera aspect', () => {
  const size = imageSizeFor(16 / 9, { kind: 'derive', baseHeight: 1080 }, MAX);
  assert.deepEqual(size, { width: 1920, height: 1080, clamped: false });
});

test('derive: a 4:3 camera keeps 4:3', () => {
  const size = imageSizeFor(4 / 3, { kind: 'derive', baseHeight: 1080 }, MAX);
  assert.deepEqual(size, { width: 1440, height: 1080, clamped: false });
});

test('derive: a square camera keeps square', () => {
  const size = imageSizeFor(1, { kind: 'derive', baseHeight: 1024 }, MAX);
  assert.deepEqual(size, { width: 1024, height: 1024, clamped: false });
});

test('fixed: applies the explicit size regardless of aspect', () => {
  const size = imageSizeFor(4 / 3, { kind: 'fixed', width: 1920, height: 1080 }, MAX);
  assert.deepEqual(size, { width: 1920, height: 1080, clamped: false });
});

test('both dimensions are rounded to even', () => {
  const derived = imageSizeFor(1.777, { kind: 'derive', baseHeight: 1081 }, MAX);
  assert.equal(derived.height % 2, 0);
  assert.equal(derived.width % 2, 0);

  const fixed = imageSizeFor(1, { kind: 'fixed', width: 1921, height: 1081 }, MAX);
  assert.equal(fixed.width % 2, 0);
  assert.equal(fixed.height % 2, 0);
});

test('clamps up to the minimum dimension and reports it', () => {
  const size = imageSizeFor(1, { kind: 'fixed', width: 2, height: 2 }, MAX);
  assert.equal(size.width, MIN_DIMENSION);
  assert.equal(size.height, MIN_DIMENSION);
  assert.equal(size.clamped, true);
});

test('clamps down to the device max texture size and reports it', () => {
  const size = imageSizeFor(1, { kind: 'fixed', width: 20000, height: 20000 }, 4096);
  assert.deepEqual(size, { width: 4096, height: 4096, clamped: true });
});

test('an extreme aspect clamps width but not height', () => {
  const size = imageSizeFor(100, { kind: 'derive', baseHeight: 1080 }, 4096);
  assert.equal(size.height, 1080);
  assert.equal(size.width, 4096);
  assert.equal(size.clamped, true);
});

test('a size exactly at the limits is not reported as clamped', () => {
  const size = imageSizeFor(1, { kind: 'fixed', width: 4096, height: 4096 }, 4096);
  assert.equal(size.clamped, false);
});

test('rigAspect always follows the output size, so images are never stretched', () => {
  assert.equal(rigAspect({ width: 1920, height: 1080, clamped: false }), 1920 / 1080);
  // Fixed mode over a 4:3 camera: the rig uses the output aspect, not the camera's.
  const size = imageSizeFor(4 / 3, { kind: 'fixed', width: 1920, height: 1080 }, MAX);
  assert.equal(rigAspect(size), 1920 / 1080);
});
