import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ConstraintGizmoSet, fillOpacity } from '../src/scene/constraintGizmos.ts';
import type { CameraConstraint } from '../src/placement/region.ts';

function plane(id: string, distance = 0): CameraConstraint {
  return {
    id,
    groupId: 'cg-1',
    name: '',
    kind: 'plane',
    position: [0, 2, 0],
    rotation: [0, 0, 0, 1],
    size: [4, 4],
    distance,
    enabled: true,
  };
}

function polyline(id: string): CameraConstraint {
  return {
    id,
    groupId: 'cg-1',
    name: '',
    kind: 'polyline',
    position: [0, 2, 0],
    points: [
      [0, 2, 0],
      [4, 2, 0],
    ],
    distance: 0,
    enabled: true,
  };
}

/** Every fill material under a set's gizmos, in traversal order. */
function fills(gizmos: ConstraintGizmoSet): THREE.MeshBasicMaterial[] {
  const found: THREE.MeshBasicMaterial[] = [];
  gizmos.group.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (mat && mat.userData.fill === true) found.push(mat);
  });
  return found;
}

test("a plane's rectangle draws translucent, like the point constraint's ball (§6.1)", () => {
  // The bug: `place` inferred "translucent" from being parented under the dilation
  // group, so a plane's rectangle — a fill that is not a dilation — was forced to
  // `opacity: 1`, `transparent: false`. It rendered as a solid violet slab hiding the
  // geometry behind it, matching neither §6.1 nor VISUAL_DESIGN's 0.10 fill.
  const gizmos = new ConstraintGizmoSet();
  gizmos.update([plane('con-1')], null, null);

  const [rect, ...rest] = fills(gizmos);
  assert.equal(rest.length, 0, 'distance 0 draws the primitive alone — no dilation');
  assert.equal(rect.transparent, true);
  assert.equal(rect.opacity, fillOpacity(false, true));

  gizmos.dispose();
});

test("a plane's rectangle keeps its translucency across selection and disabling (§6.1)", () => {
  const gizmos = new ConstraintGizmoSet();

  gizmos.update([plane('con-1')], 'con-1', null);
  assert.equal(fills(gizmos)[0].opacity, fillOpacity(true, true), 'selected reads stronger');

  gizmos.update([{ ...plane('con-1'), enabled: false }], null, null);
  assert.equal(fills(gizmos)[0].opacity, fillOpacity(false, false), 'disabled fades');

  for (const mat of fills(gizmos)) assert.equal(mat.transparent, true, 'never turns opaque');

  gizmos.dispose();
});

test('a dilation and a primitive fill take the same ramp (§6.1)', () => {
  // One rule for every body, which is what "render it like the point constraint" means.
  const gizmos = new ConstraintGizmoSet();
  gizmos.update([plane('con-1', 0.5)], null, null);

  const all = fills(gizmos);
  assert.ok(all.length >= 2, 'rectangle plus its dilation slab');
  for (const mat of all) assert.equal(mat.opacity, fillOpacity(false, true));

  gizmos.dispose();
});

test('handles and polyline segments stay opaque — the fill rule leaves edges alone (§6.1)', () => {
  // The crisp part of a constraint is still crisp; only bodies are see-through.
  const gizmos = new ConstraintGizmoSet();
  gizmos.update([polyline('con-1')], null, null);

  assert.equal(fills(gizmos).length, 0, 'a polyline with distance 0 has no fill');
  const handles: THREE.MeshBasicMaterial[] = [];
  gizmos.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.MeshBasicMaterial | undefined;
    if (mat && mat.userData.fill !== true && (mesh as unknown as { isMesh?: boolean }).isMesh) handles.push(mat);
  });
  assert.ok(handles.length > 0, 'vertex handles exist');
  for (const mat of handles) assert.equal(mat.opacity, 1);

  gizmos.dispose();
});

test('fillOpacity: selected reads strongest, disabled weakest', () => {
  assert.ok(fillOpacity(true, true) > fillOpacity(false, true));
  assert.ok(fillOpacity(false, true) > fillOpacity(false, false));
});

// --- The mount filter's dimming (`camera_placement.md` §5, §4.1.1) -----------

/** Every non-fill mesh/line material — the crisp part: handles and edges. */
function edges(gizmos: ConstraintGizmoSet): THREE.Material[] {
  const found: THREE.Material[] = [];
  gizmos.group.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (mat && mat.userData.fill !== true && 'color' in mat) found.push(mat);
  });
  return found;
}

test('a constraint the mount filter excludes draws weaker than the same one unfiltered (§4.1.1)', () => {
  // The property, not the constant: a wall with no zone overlap has to look
  // different from a good one *before* Build is pressed.
  const gizmos = new ConstraintGizmoSet();

  gizmos.update([plane('con-1')], null, null);
  const live = fills(gizmos)[0].opacity;

  gizmos.update([plane('con-1')], null, null, new Set(['con-1']));
  assert.ok(fills(gizmos)[0].opacity < live, 'excluded fades');
  for (const mat of edges(gizmos)) {
    assert.equal(mat.opacity, 0.35, 'edges take the disabled treatment');
    assert.equal(mat.transparent, true);
  }

  gizmos.dispose();
});

test('an excluded constraint still reads stronger when selected, and recovers when the set clears', () => {
  const gizmos = new ConstraintGizmoSet();

  gizmos.update([plane('con-1')], null, null, new Set(['con-1']));
  const unselected = fills(gizmos)[0].opacity;
  gizmos.update([plane('con-1')], 'con-1', null, new Set(['con-1']));
  assert.ok(fills(gizmos)[0].opacity > unselected, 'selection still reads through the dimming');

  // Clearing the filter is a plain update, not a rebuild: the entry flag is what
  // the renderer reads, so a stale `true` would leave a good wall dimmed forever.
  gizmos.update([plane('con-1')], null, null);
  assert.equal(fills(gizmos)[0].opacity, fillOpacity(false, true));
  for (const mat of edges(gizmos)) assert.equal(mat.opacity, 1);

  gizmos.dispose();
});

test('the mount filter names one constraint without touching its neighbours', () => {
  const gizmos = new ConstraintGizmoSet();
  gizmos.update([plane('con-1'), plane('con-2')], null, null, new Set(['con-2']));

  const [first, second] = fills(gizmos);
  assert.equal(first.opacity, fillOpacity(false, true), 'con-1 is untouched');
  assert.ok(second.opacity < first.opacity, 'con-2 is the one excluded');

  gizmos.dispose();
});
