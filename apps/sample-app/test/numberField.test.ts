import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitNumberField, resolveFieldCommit, seedFieldValue } from '../src/ui/numberField.ts';

// The pure parse → clamp → revert decision behind every numeric text field
// (spec §5.2.1). Only external behavior is asserted here; the React wrapper is
// glue over this function.

test('commits a valid numeric string (spec §5.2.1)', () => {
  assert.equal(commitNumberField('1.5', { fallback: 0 }), 1.5);
  assert.equal(commitNumberField('-3.4', { fallback: 0 }), -3.4);
  assert.equal(commitNumberField('0', { fallback: 9 }), 0);
});

test('trims surrounding whitespace before parsing', () => {
  assert.equal(commitNumberField('  2.0  ', { fallback: 0 }), 2);
});

test('accepts scientific notation as a finite number', () => {
  assert.equal(commitNumberField('1e3', { fallback: 0 }), 1000);
});

test('reverts to the fallback on empty or whitespace-only input', () => {
  // Number('') and Number('   ') are both 0 — must NOT be treated as a 0 commit.
  assert.equal(commitNumberField('', { fallback: 7 }), 7);
  assert.equal(commitNumberField('   ', { fallback: 7 }), 7);
});

test('reverts to the fallback on non-numeric or non-finite input', () => {
  assert.equal(commitNumberField('abc', { fallback: 5 }), 5);
  assert.equal(commitNumberField('1.2.3', { fallback: 5 }), 5);
  assert.equal(commitNumberField('-', { fallback: 5 }), 5);
  assert.equal(commitNumberField('Infinity', { fallback: 5 }), 5);
  assert.equal(commitNumberField('NaN', { fallback: 5 }), 5);
});

test('clamps to a lower bound when min is given (e.g. pitch, size floor)', () => {
  assert.equal(commitNumberField('-90', { min: -89, max: 89, fallback: 0 }), -89);
  assert.equal(commitNumberField('0.05', { min: 0.2, fallback: 1 }), 0.2);
});

test('clamps to an upper bound when max is given', () => {
  assert.equal(commitNumberField('120', { min: -89, max: 89, fallback: 0 }), 89);
});

test('leaves an in-range value untouched when bounds are given', () => {
  assert.equal(commitNumberField('45', { min: -89, max: 89, fallback: 0 }), 45);
});

test('accepts any finite value when no bounds are given (free position/yaw/roll)', () => {
  assert.equal(commitNumberField('9999', { fallback: 0 }), 9999);
  assert.equal(commitNumberField('-9999', { fallback: 0 }), -9999);
});

test('an out-of-range fallback is only returned for invalid input, never clamped', () => {
  // The fallback is the last committed (already-valid) value; invalid input
  // returns it verbatim without re-clamping.
  assert.equal(commitNumberField('abc', { min: 0, max: 10, fallback: 3 }), 3);
});

// resolveFieldCommit — the "commit or not" decision (spec §5.2.1).

test('resolveFieldCommit: no commit when the field is untouched, even if the value carries extra precision', () => {
  // The regression, at any precision: 45.4 displays "45" at digits=0; focus-then-blur
  // seeds and returns "45" — comparing against the raw 45.4 prop would spuriously commit.
  assert.equal(resolveFieldCommit('45', 45.4, 0, { min: -89, max: 89 }), null);
  assert.equal(resolveFieldCommit('1.23', 1.23456, 2, {}), null);
});

test('resolveFieldCommit: rotation fields guard the no-op at 2 decimals (spec §5.2.1)', () => {
  // Rotation displays 2 decimals: a pitch of 45.001 seeds "45.00", so focus-then-blur
  // must not commit — the guard compares against the 2-decimal display, not the prop.
  assert.equal(resolveFieldCommit('45.00', 45.001, 2, { min: -89, max: 89 }), null);
  // A yaw carrying quat round-trip noise seeds "-30.00" and likewise commits nothing.
  assert.equal(resolveFieldCommit('-30.00', -29.999999, 2, {}), null);
  // But an edit inside the newly visible precision is a genuine commit.
  assert.equal(resolveFieldCommit('45.25', 45, 2, { min: -89, max: 89 }), 45.25);
});

test('resolveFieldCommit: FOV slider field displays 2 decimals and still commits fractions', () => {
  assert.equal(resolveFieldCommit('60.00', 60, 2, { min: 10, max: 150 }), null);
  assert.equal(resolveFieldCommit('42.37', 60, 2, { min: 10, max: 150 }), 42.37);
});

test('resolveFieldCommit: no commit on invalid/empty input (reverts to current)', () => {
  assert.equal(resolveFieldCommit('abc', 45.4, 0, {}), null);
  assert.equal(resolveFieldCommit('', 45.4, 0, {}), null);
});

test('resolveFieldCommit: commits a genuine new value', () => {
  assert.equal(resolveFieldCommit('60', 45.4, 0, { min: -89, max: 89 }), 60);
  assert.equal(resolveFieldCommit('-3.4', 1.2, 2, {}), -3.4);
});

test('resolveFieldCommit: commits the clamped value when input is out of range', () => {
  assert.equal(resolveFieldCommit('200', 45.4, 0, { min: -89, max: 89 }), 89);
});

test('resolveFieldCommit: no commit when a typed value clamps back to the current value', () => {
  // Already at the pitch ceiling; typing past it must not mark stale.
  assert.equal(resolveFieldCommit('200', 89, 0, { min: -89, max: 89 }), null);
});

test('resolveFieldCommit: preserves precision the user types beyond display digits', () => {
  assert.equal(resolveFieldCommit('1.234', 1.23, 2, {}), 1.234);
});

// seedFieldValue: full-precision focus seed for slider value fields (spec §5.2.1).
test('seedFieldValue: shows precision the rounded readout hides', () => {
  // 42.37 stored in a 0-decimal FOV field seeds "42.37", not "42".
  assert.equal(seedFieldValue(42.37), '42.37');
  assert.equal(seedFieldValue(0.37), '0.37');
});

test('seedFieldValue: strips trailing zeros and any bare decimal point', () => {
  assert.equal(seedFieldValue(2), '2');
  assert.equal(seedFieldValue(0.5), '0.5');
  assert.equal(seedFieldValue(12.5), '12.5');
  assert.equal(seedFieldValue(0), '0');
});

test('seedFieldValue: hides float noise from a viewport drag', () => {
  assert.equal(seedFieldValue(0.1 + 0.2), '0.3'); // 0.30000000000000004
  assert.equal(seedFieldValue(-3.4), '-3.4');
});

test('seedFieldValue: reverts non-finite input to an empty string (never NaN)', () => {
  assert.equal(seedFieldValue(Number.NaN), '');
  assert.equal(seedFieldValue(Number.POSITIVE_INFINITY), '');
});
