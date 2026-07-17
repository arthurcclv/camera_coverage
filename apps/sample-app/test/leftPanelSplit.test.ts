import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIVIDER_HEIGHT,
  MIN_DETAIL_HEIGHT,
  MIN_HIERARCHY_HEIGHT,
  clampDetailHeight,
  parseStoredDetailHeight,
  serializeDetailHeight,
} from '../src/ui/leftPanelSplit.ts';

test('clampDetailHeight leaves a mid-range height untouched (spec §2.2)', () => {
  // Column 800: max detail = 800 - 8 - 100 = 692.
  assert.equal(clampDetailHeight(300, 800), 300);
});

test('clampDetailHeight floors at the detail minimum', () => {
  assert.equal(clampDetailHeight(10, 800), MIN_DETAIL_HEIGHT);
  assert.equal(clampDetailHeight(-50, 800), MIN_DETAIL_HEIGHT);
});

test('clampDetailHeight caps so the hierarchy keeps its minimum', () => {
  const columnHeight = 800;
  const max = columnHeight - DIVIDER_HEIGHT - MIN_HIERARCHY_HEIGHT;
  assert.equal(clampDetailHeight(10_000, columnHeight), max);
  // Hierarchy retains at least its minimum.
  assert.ok(columnHeight - DIVIDER_HEIGHT - max >= MIN_HIERARCHY_HEIGHT);
});

test('clampDetailHeight never collapses below the detail minimum in a short column', () => {
  // Column too short to honor both minimums: detail still gets its floor.
  assert.equal(clampDetailHeight(500, 120), MIN_DETAIL_HEIGHT);
  assert.equal(clampDetailHeight(10, 120), MIN_DETAIL_HEIGHT);
});

test('parseStoredDetailHeight returns null for absent/blank/invalid values', () => {
  assert.equal(parseStoredDetailHeight(null), null);
  assert.equal(parseStoredDetailHeight(''), null);
  assert.equal(parseStoredDetailHeight('   '), null);
  assert.equal(parseStoredDetailHeight('abc'), null);
  assert.equal(parseStoredDetailHeight('0'), null);
  assert.equal(parseStoredDetailHeight('-20'), null);
});

test('parseStoredDetailHeight reads a valid positive number', () => {
  assert.equal(parseStoredDetailHeight('240'), 240);
  assert.equal(parseStoredDetailHeight('180.5'), 180.5);
});

test('serializeDetailHeight round-trips through parse', () => {
  assert.equal(serializeDetailHeight(null), null);
  assert.equal(serializeDetailHeight(240), '240');
  assert.equal(serializeDetailHeight(180.7), '181'); // rounded
  assert.equal(parseStoredDetailHeight(serializeDetailHeight(300)), 300);
});
