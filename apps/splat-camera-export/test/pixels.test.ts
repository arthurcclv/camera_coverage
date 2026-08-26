/** Tests for `render/pixels.ts` (spec §8.4, §12). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flipVertical,
  forceOpaque,
  isBlankReadback,
  prepareForEncode,
} from '../src/render/pixels.ts';

/** Builds a `width`x`height` RGBA buffer whose red channel encodes the row index. */
function rows(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = y;
      out[i + 1] = x;
      out[i + 2] = 0;
      out[i + 3] = 128;
    }
  }
  return out;
}

/** The red channel of column 0 for each row, i.e. the row order. */
function rowOrder(pixels: Uint8Array, width: number, height: number): number[] {
  return Array.from({ length: height }, (_, y) => pixels[y * width * 4]);
}

test('flips an odd-height buffer, leaving the middle row in place', () => {
  const width = 3;
  const height = 5;
  const pixels = rows(width, height);
  flipVertical(pixels, width, height);
  assert.deepEqual(rowOrder(pixels, width, height), [4, 3, 2, 1, 0]);
});

test('flips an even-height buffer', () => {
  const width = 2;
  const height = 4;
  const pixels = rows(width, height);
  flipVertical(pixels, width, height);
  assert.deepEqual(rowOrder(pixels, width, height), [3, 2, 1, 0]);
});

test('flipping twice is the identity', () => {
  const width = 3;
  const height = 7;
  const original = rows(width, height);
  const pixels = rows(width, height);
  flipVertical(pixels, width, height);
  flipVertical(pixels, width, height);
  assert.deepEqual([...pixels], [...original]);
});

test('preserves within-row pixel order (only rows move)', () => {
  const width = 4;
  const height = 2;
  const pixels = rows(width, height);
  flipVertical(pixels, width, height);
  // Row 0 is now old row 1; its green channel still runs 0,1,2,3 across x.
  const green = Array.from({ length: width }, (_, x) => pixels[x * 4 + 1]);
  assert.deepEqual(green, [0, 1, 2, 3]);
});

test('a single-row buffer is unchanged', () => {
  const pixels = rows(3, 1);
  const before = [...pixels];
  flipVertical(pixels, 3, 1);
  assert.deepEqual([...pixels], before);
});

test('throws rather than silently corrupting an undersized buffer', () => {
  assert.throws(() => flipVertical(new Uint8Array(10), 4, 4), /need 64/);
});

test('forceOpaque sets every alpha byte to 255 and touches nothing else', () => {
  const pixels = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 17]);
  forceOpaque(pixels);
  assert.deepEqual([...pixels], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('prepareForEncode flips and forces alpha for a bottom-up readback (WebGL2)', () => {
  const width = 1;
  const height = 2;
  const pixels = rows(width, height);
  prepareForEncode(pixels, width, height, false, true);
  assert.deepEqual(rowOrder(pixels, width, height), [1, 0]);
  assert.equal(pixels[3], 255);
  assert.equal(pixels[7], 255);
});

test('prepareForEncode does NOT flip a top-down readback (WebGPU) — §8.4', () => {
  // WebGPU's copyTextureToBuffer is already in PNG row order; flipping it anyway is
  // exactly what exports vertically mirrored images.
  const width = 1;
  const height = 2;
  const pixels = rows(width, height);
  prepareForEncode(pixels, width, height, false, false);
  assert.deepEqual(rowOrder(pixels, width, height), [0, 1]);
  assert.equal(pixels[3], 255);
});

test('the two row-order modes are exact vertical mirrors of each other', () => {
  const width = 2;
  const height = 5;
  const flipped = prepareForEncode(rows(width, height), width, height, false, true);
  const asIs = prepareForEncode(rows(width, height), width, height, false, false);
  assert.deepEqual(rowOrder(flipped, width, height), [...rowOrder(asIs, width, height)].reverse());
});

test('an all-zero buffer is detected as a failed readback (§8.6)', () => {
  assert.equal(isBlankReadback(new Uint8Array(64), false), true);
});

test('a clear-colour-only frame is NOT a failed readback — the camera just saw nothing', () => {
  // Opaque clear colour: alpha is 255, so the buffer is not all-zero.
  const pixels = new Uint8Array(16);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 20;
    pixels[i + 1] = 23;
    pixels[i + 2] = 28;
    pixels[i + 3] = 255;
  }
  assert.equal(isBlankReadback(pixels, false), false);
});

test('a single non-zero byte anywhere disproves a failed readback', () => {
  for (const at of [0, 3, 31, 63]) {
    const pixels = new Uint8Array(64);
    pixels[at] = 1;
    assert.equal(isBlankReadback(pixels, false), false, `byte ${at} should count`);
  }
});

test('the check is skipped for a transparent background, where all-zero is legitimate', () => {
  assert.equal(isBlankReadback(new Uint8Array(64), true), false);
});

test('an empty buffer is not reported as a failed readback', () => {
  assert.equal(isBlankReadback(new Uint8Array(0), false), false);
});

test('prepareForEncode preserves alpha for a transparent background', () => {
  const width = 1;
  const height = 2;
  const pixels = rows(width, height);
  prepareForEncode(pixels, width, height, true, true);
  assert.deepEqual(rowOrder(pixels, width, height), [1, 0]);
  assert.equal(pixels[3], 128);
});
