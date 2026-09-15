/**
 * The Run gate (`geometry_assets.md` §5.3, §5.4). One pure decision, because the
 * Run button, the auto-run poll and `handleRun` all have to agree on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBlocker } from '../src/scene/runGate.ts';
import { identityTransform, type GeometryObject } from '../src/scene/geometryModel.ts';

function box(id: string, enabled = true): GeometryObject {
  return { kind: 'box', id, name: '', enabled, min: [0, 0, 0], max: [1, 1, 1], ...identityTransform() };
}

function mesh(id: string, src: string): GeometryObject {
  return { kind: 'mesh', id, name: '', enabled: true, src, ...identityTransform() };
}

test('a scene with enabled geometry can run', () => {
  assert.equal(runBlocker([box('geom-1')]), null);
  assert.equal(runBlocker([box('geom-1', false), box('geom-2')]), null);
});

test('an empty geometry list blocks the run, with a reason (§5.3)', () => {
  // Legal — a layout of cameras aimed at a splat capture needs no triangles —
  // but not measurable: there is no collision mesh and no workspace to voxelize.
  assert.equal(runBlocker([]), 'noGeometry');
});

test('unticking every object blocks the run just as deleting them does (§5.1, §5.3)', () => {
  // The checkbox takes an object *out of the scene*, not merely off screen, so
  // "what if none of this were here?" is a scene with nothing to measure.
  assert.equal(runBlocker([box('geom-1', false), box('geom-2', false)]), 'noGeometry');
});

test('a pending import is not a load state, so it never blocks a run (asset_import.md §7.2)', () => {
  // The regression guard on §7.2's claim: what is pending is *where the bytes
  // live*, not whether they are usable. A row drawing from memory occludes and
  // runs exactly as one drawing from `assets/` does — and the gate cannot tell
  // them apart, because nothing in its input says which is which.
  assert.equal(runBlocker([mesh('geom-1', 'assets/rack/rack.glb')]), null);
  assert.equal(runBlocker([mesh('geom-1', 'assets/site.spz')]), null);
});
