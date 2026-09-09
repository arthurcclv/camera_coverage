/**
 * Tests for the transparent-layer draw-order convention (spec §13.5;
 * sampling_volumes.md §5). The two overlapping in-scene transparent layers —
 * section heatmap plane and sampling-volume fill — are ordered so the depth-writing
 * plane draws first and the fill depth-tests against it. This pins the values in one
 * place (`scene/renderOrder.ts`) and checks each consumer actually applies them.
 *
 * The **coverage fog is not one of them**: it renders in its own pass and composites
 * over the finished scene (`volumetric_rendering.md` §4), so it has no entry here and
 * no draw order to assert. `test/volumetric.test.ts` covers its compositing instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RenderOrder } from '../src/scene/renderOrder.ts';
import { SectionGizmoSet } from '../src/scene/sectionGizmos.ts';
import { SamplingVolumeGizmoSet } from '../src/scene/samplingVolumeGizmos.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import type { SamplingVolume } from '../src/scene/samplingVolumes.ts';

test('draw order is plane < fill so the depth writer goes first', () => {
  assert.ok(
    RenderOrder.sectionPlane < RenderOrder.volumeFill,
    'section plane must draw before the volume fill',
  );
  // The draft is what the user is doing right now, so it draws above both
  // (`camera_placement.md` §6.2; its materials switch off `depthTest` to match).
  assert.ok(
    RenderOrder.volumeFill < RenderOrder.draftOverlay,
    'the draw-mode draft must draw above every scene layer',
  );
});

test('the coverage fog has no draw order — it is not an in-scene layer', () => {
  // Guards the two-target pass against a well-meaning re-add: the fog is alone in
  // its own scene, so an entry here would order it against nothing while implying
  // it participates (`volumetric_rendering.md` §4).
  assert.ok(
    !('coverageFog' in RenderOrder),
    'the fog composites over the scene; it takes no place in the layer table',
  );
});

test('section heatmap plane draws at the section-plane render order', () => {
  const gizmos = new SectionGizmoSet();
  const section: Section = {
    id: 'section-1',
    orientation: 'horizontal',
    min: 0,
    max: 1,
    aggregation: 'mean',
    enabled: true,
    clipRange: 1,
    name: '',
  };
  gizmos.update([section], new Map(), true, false, [0, 0, 0], [4, 3, 5]);

  const mesh = findMesh(gizmos.group, THREE.Mesh);
  assert.ok(mesh, 'expected a heatmap Mesh in the section gizmo group');
  assert.equal(mesh!.renderOrder, RenderOrder.sectionPlane);
  gizmos.dispose();
});

test('sampling-volume fill draws at the volume-fill render order', () => {
  const gizmos = new SamplingVolumeGizmoSet();
  const volume: SamplingVolume = {
    id: 'volume-1',
    zoneId: 'zone-1',
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    size: [2, 2, 2],
  };
  gizmos.update([volume], null, new Set(['zone-1']));

  const mesh = findMesh(gizmos.group, THREE.Mesh);
  assert.ok(mesh, 'expected a fill Mesh in the volume gizmo group');
  assert.equal(mesh!.renderOrder, RenderOrder.volumeFill);
  gizmos.dispose();
});

/** First descendant that is exactly a `THREE.Mesh` (skips LineSegments outlines/edges). */
function findMesh(root: THREE.Object3D, Ctor: typeof THREE.Mesh): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!found && o instanceof Ctor) found = o as THREE.Mesh;
  });
  return found;
}
