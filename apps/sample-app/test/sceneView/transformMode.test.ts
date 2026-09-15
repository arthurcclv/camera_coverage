/**
 * Which gizmo mode each selection gets (`geometry_assets.md` §7, spec §2.4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isScaleCapable, resolveMode } from '../../src/scene/sceneView/transformMode.ts';

test('a geometry object is scale-capable, like a sampling volume (§7)', () => {
  // A triangle mesh takes a non-uniform scale correctly — no triangle has a
  // covariance to shear — so geometry joins volume as a Scale selection.
  assert.equal(resolveMode('scale', { kind: 'geometry', id: 'geom-1' }), 'scale');
  assert.equal(resolveMode('scale', { kind: 'volume', id: 'volume-1' }), 'scale');
});

test('geometry keeps Move and Rotate too', () => {
  assert.equal(resolveMode('translate', { kind: 'geometry', id: 'geom-1' }), 'translate');
  assert.equal(resolveMode('rotate', { kind: 'geometry', id: 'geom-1' }), 'rotate');
});

test('a splat still falls back to Move on Scale (`gaussian_splats.md` §2.1)', () => {
  // The deliberate exclusion: a per-axis drag would shear the capture's
  // Gaussians, so its scale is one number in its panel instead.
  assert.equal(resolveMode('scale', { kind: 'splat', id: 'splat-1' }), 'translate');
});

test('probes and sections stay translate-only whatever the mode', () => {
  assert.equal(resolveMode('rotate', { kind: 'probe', id: 'probe-1' }), 'translate');
  assert.equal(resolveMode('scale', { kind: 'section', id: 'section-1' }), 'translate');
});

test('an empty selection falls back to Move', () => {
  assert.equal(resolveMode('scale', null), 'translate');
});

test('the toolbar and the gizmo share one scale-capable predicate', () => {
  // The Scale *button* used to hard-code `kind !== 'volume'` for its disabled
  // state, so a second scale-capable kind left a button the gizmo would have
  // honoured but nobody could press.
  for (const selection of [
    { kind: 'geometry', id: 'geom-1' },
    { kind: 'volume', id: 'volume-1' },
  ] as const) {
    assert.equal(isScaleCapable(selection), true, selection.kind);
    assert.equal(resolveMode('scale', selection), 'scale');
  }
  for (const selection of [
    { kind: 'camera', id: 'cam-1' },
    { kind: 'splat', id: 'splat-1' },
    null,
  ] as const) {
    assert.equal(isScaleCapable(selection), false, String(selection?.kind));
    assert.equal(resolveMode('scale', selection), 'translate');
  }
});
