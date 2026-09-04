/**
 * Tests for the transparent-layer draw-order convention (spec §9, §13.5;
 * volumetric_rendering.md §4; sampling_volumes.md §5). The three overlapping
 * transparent layers — section heatmap plane, coverage fog, sampling-volume fill —
 * are ordered so the depth-writing plane draws first and the fog/fill depth-test
 * against it. This pins the values in one place (`scene/renderOrder.ts`) and checks
 * each consumer actually applies them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RenderOrder } from '../src/scene/renderOrder.ts';
import { VoxelVolumetricRenderer } from '../src/scene/volumetric.ts';
import { CoverageOverlay } from '../src/scene/coverageOverlay.ts';
import { SectionGizmoSet } from '../src/scene/sectionGizmos.ts';
import { SamplingVolumeGizmoSet } from '../src/scene/samplingVolumeGizmos.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import type { SamplingVolume } from '../src/scene/samplingVolumes.ts';

test('draw order is plane < fog < fill so the depth writer goes first', () => {
  assert.ok(
    RenderOrder.sectionPlane < RenderOrder.coverageFog,
    'section plane must draw before the fog',
  );
  assert.ok(
    RenderOrder.coverageFog < RenderOrder.volumeFill,
    'fog must draw before the volume fill',
  );
  // The draft is what the user is doing right now, so it draws above all three
  // (`camera_placement.md` §6.2; its materials switch off `depthTest` to match).
  assert.ok(
    RenderOrder.volumeFill < RenderOrder.draftOverlay,
    'the draw-mode draft must draw above every scene layer',
  );
});

test('volumetric renderer applies setRenderOrder and keeps it across reallocation', () => {
  const renderer = new VoxelVolumetricRenderer();
  renderer.setRenderOrder(RenderOrder.coverageFog);
  assert.equal(renderer.object.children[0].renderOrder, RenderOrder.coverageFog);

  // Grow past INITIAL_CAPACITY (1024) to force a mesh rebuild; the order must
  // survive it (otherwise the fog would silently revert to 0 the first time the
  // buffers grow).
  const voxels = Array.from({ length: 1100 }, (_, i) => ({
    center: [i, 0, 0] as [number, number, number],
    size: 1,
    intensity: 1,
    color: [1, 0, 0] as [number, number, number],
  }));
  renderer.addVoxels(voxels);
  assert.equal(
    renderer.object.children[0].renderOrder,
    RenderOrder.coverageFog,
    'render order lost when the instance buffers were rebuilt',
  );
  renderer.dispose();
});

test('coverage overlay draws its fog at the fog render order', () => {
  const overlay = new CoverageOverlay();
  assert.equal(overlay.object.children[0].renderOrder, RenderOrder.coverageFog);
  overlay.dispose();
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
