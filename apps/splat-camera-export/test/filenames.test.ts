/** Tests for `export/filenames.ts` (spec §9.2, §12). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFilenames, sanitizeStem } from '../src/export/filenames.ts';

test('leaves an already-clean label alone', () => {
  assert.equal(sanitizeStem('Entrance'), 'Entrance');
  assert.equal(sanitizeStem('Camera_7-b'), 'Camera_7-b');
});

test('replaces path separators and Windows-illegal characters', () => {
  assert.equal(sanitizeStem('north/south'), 'north-south');
  assert.equal(sanitizeStem('a\\b'), 'a-b');
  assert.equal(sanitizeStem('why?'), 'why');
  assert.equal(sanitizeStem('a<b>c:d"e|f?g*h'), 'a-b-c-d-e-f-g-h');
});

test('replaces whitespace and collapses runs of separators', () => {
  assert.equal(sanitizeStem('Loading bay'), 'Loading-bay');
  assert.equal(sanitizeStem('a    b'), 'a-b');
  assert.equal(sanitizeStem('a -- b'), 'a-b');
  assert.equal(sanitizeStem('a\tb\nc'), 'a-b-c');
});

test('replaces control characters', () => {
  assert.equal(sanitizeStem(`a${String.fromCharCode(1)}b`), 'a-b');
  assert.equal(sanitizeStem(`a${String.fromCharCode(0x7f)}b`), 'a-b');
});

test('strips leading and trailing separators and dots', () => {
  assert.equal(sanitizeStem('  Entrance  '), 'Entrance');
  assert.equal(sanitizeStem('--Entrance--'), 'Entrance');
  assert.equal(sanitizeStem('Entrance...'), 'Entrance');
  assert.equal(sanitizeStem('.hidden'), 'hidden');
});

test('returns empty when nothing usable survives', () => {
  assert.equal(sanitizeStem(''), '');
  assert.equal(sanitizeStem('   '), '');
  assert.equal(sanitizeStem('///'), '');
  assert.equal(sanitizeStem('...'), '');
});

test('prefixes Windows reserved device names, case-insensitively', () => {
  assert.equal(sanitizeStem('CON'), '_CON');
  assert.equal(sanitizeStem('con'), '_con');
  assert.equal(sanitizeStem('LPT9'), '_LPT9');
  assert.equal(sanitizeStem('NUL'), '_NUL');
  // Not reserved — only the exact names are.
  assert.equal(sanitizeStem('CONSOLE'), 'CONSOLE');
  assert.equal(sanitizeStem('COM10'), 'COM10');
});

test('names each file after its camera, with no index prefix (§9.2)', () => {
  const names = buildFilenames(
    [
      { id: 'cam-1', label: 'Entrance' },
      { id: 'cam-2', label: 'Loading bay' },
    ],
    'png',
  );
  assert.deepEqual(names, ['Entrance.png', 'Loading-bay.png']);
});

test('falls back to the id, then to `camera`, for an unusable label', () => {
  const names = buildFilenames(
    [
      { id: 'cam-1', label: '///' },
      { id: '???', label: '   ' },
    ],
    'jpg',
  );
  assert.deepEqual(names, ['cam-1.jpg', 'camera.jpg']);
});

test('duplicate names gain -2, -3 suffixes in file order', () => {
  const names = buildFilenames(
    [
      { id: 'cam-1', label: 'Entrance' },
      { id: 'cam-2', label: 'Entrance' },
      { id: 'cam-3', label: 'Entrance' },
    ],
    'png',
  );
  assert.deepEqual(names, ['Entrance.png', 'Entrance-2.png', 'Entrance-3.png']);
});

test('names colliding only after sanitization are still deduped', () => {
  // Both sanitize to `Bay-1`, which the raw labels do not reveal.
  const names = buildFilenames(
    [
      { id: 'cam-1', label: 'Bay 1' },
      { id: 'cam-2', label: 'Bay/1' },
    ],
    'png',
  );
  assert.deepEqual(names, ['Bay-1.png', 'Bay-1-2.png']);
});

test('labels differing only by case collide, since the filesystem may not care', () => {
  const names = buildFilenames(
    [
      { id: 'cam-1', label: 'Entrance' },
      { id: 'cam-2', label: 'ENTRANCE' },
    ],
    'png',
  );
  assert.deepEqual(names, ['Entrance.png', 'ENTRANCE-2.png']);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 2);
});

test('a name that already ends in -2 does not collide with a generated suffix', () => {
  const names = buildFilenames(
    [
      { id: 'cam-1', label: 'Gate' },
      { id: 'cam-2', label: 'Gate' },
      { id: 'cam-3', label: 'Gate-2' },
    ],
    'png',
  );
  assert.deepEqual(names, ['Gate.png', 'Gate-2.png', 'Gate-2-2.png']);
  assert.equal(new Set(names).size, 3);
});

test('blank names fall back to distinct Camera N labels, so they do not collide', () => {
  // `cameraLabel` resolves a blank name to `Camera N` before reaching here (§5.4).
  const names = buildFilenames(
    [
      { id: 'cam-1', label: 'Camera 1' },
      { id: 'cam-2', label: 'Camera 2' },
    ],
    'png',
  );
  assert.deepEqual(names, ['Camera-1.png', 'Camera-2.png']);
});

test('the extension is applied verbatim', () => {
  assert.deepEqual(buildFilenames([{ id: 'cam-1', label: 'A' }], 'jpg'), ['A.jpg']);
});
