import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryObject } from '../src/scene/geometryModel.ts';
import { duplicateConstraint, duplicateConstraintGroup, duplicateGeometry, duplicateSplat } from '../src/scene/entityDuplication.ts';
import type { CameraConstraint, ConstraintGroup } from '../src/placement/region.ts';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

import type { SceneCamera } from '../src/cameras/camera.ts';
import type { Probe } from '../src/scene/probeVisibility.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';
import {
  duplicateCamera,
  duplicateProbe,
  duplicateSection,
  duplicateVolume,
  duplicateZone,
  nextFreeId,
} from '../src/scene/entityDuplication.ts';

// Distinctive property values so "verbatim copy" is actually asserted, not just id.
function cam(id: string, name = 'Front door', enabled = true): SceneCamera {
  return { id, name, enabled, position: [1, 2, 3], rotation: [0, 0.5, 0, 0.866], fov: 42 };
}
function probe(id: string, name = 'P'): Probe {
  return { id, position: [4, 5, 6], name };
}
function section(id: string): Section {
  return { id, orientation: 'vertical-x', min: 0.25, max: 0.75, aggregation: 'max', enabled: false, clipRange: 3, name: 'Sec' };
}
function zone(id: string, name = id, enabled = true): Zone {
  return { id, name, enabled };
}
function volume(id: string, zoneId: string): SamplingVolume {
  return { id, zoneId, position: [7, 8, 9], rotation: [0, 0, 0, 1], size: [2, 3, 4] };
}

test('nextFreeId returns prefix-(max+1), ignoring foreign prefixes and gaps', () => {
  assert.equal(nextFreeId('cam', []), 'cam-1');
  assert.equal(nextFreeId('cam', ['cam-1', 'cam-3']), 'cam-4');
  assert.equal(nextFreeId('cam', ['probe-9', 'cam-2']), 'cam-3');
});

test('duplicateCamera copies every property verbatim with the next free id', () => {
  const cams = [cam('cam-1'), cam('cam-2')];
  const copy = duplicateCamera(cams, 'cam-1');
  assert.ok(copy);
  assert.equal(copy!.id, 'cam-3');
  // Same properties (name/position/rotation/fov), only the id differs.
  assert.deepEqual({ ...copy, id: undefined }, { ...cam('cam-1'), id: undefined });
});

test('duplicateCamera returns null for an unknown id', () => {
  assert.equal(duplicateCamera([cam('cam-1')], 'cam-9'), null);
});

test('duplicateCamera inherits the source camera enabled state (spec §5.4, §5.5)', () => {
  const copy = duplicateCamera([cam('cam-1', 'Off', false)], 'cam-1');
  assert.ok(copy);
  assert.equal(copy!.enabled, false); // a disabled camera duplicates to a disabled one
});

test('duplicateProbe copies verbatim with the next free probe id', () => {
  const copy = duplicateProbe([probe('probe-1')], 'probe-1');
  assert.ok(copy);
  assert.equal(copy!.id, 'probe-2');
  assert.deepEqual(copy!.position, [4, 5, 6]);
  assert.equal(copy!.name, 'P');
});

test('duplicateSection copies the record verbatim (clip is app-level, not on the record)', () => {
  const copy = duplicateSection([section('section-1')], 'section-1');
  assert.ok(copy);
  assert.equal(copy!.id, 'section-2');
  // The record carries no clip flag, so nothing clip-related can transfer here.
  assert.deepEqual({ ...copy, id: undefined }, { ...section('section-1'), id: undefined });
});

test('duplicateVolume copies into the SAME zone with the next free volume id', () => {
  const vols = [volume('volume-1', 'zone-1'), volume('volume-2', 'zone-2')];
  const copy = duplicateVolume(vols, 'volume-1');
  assert.ok(copy);
  assert.equal(copy!.id, 'volume-3');
  assert.equal(copy!.zoneId, 'zone-1'); // same zone, not reassigned
  assert.deepEqual(copy!.size, [2, 3, 4]);
});

test('duplicateZone deep-copies the zone and all its volumes with fresh ids', () => {
  const zones = [zone('zone-1', 'Kitchen', false)];
  const vols = [
    volume('volume-1', 'zone-1'),
    volume('volume-2', 'zone-1'),
    volume('volume-3', 'other'), // belongs to a different zone — must NOT be copied
  ];
  const result = duplicateZone(zones, vols, 'zone-1');
  assert.ok(result);
  // New zone: fresh id, name + enabled preserved.
  assert.equal(result!.zone.id, 'zone-2');
  assert.equal(result!.zone.name, 'Kitchen');
  assert.equal(result!.zone.enabled, false);
  // Two child volumes copied, each with a fresh, non-colliding id pointing at the new zone.
  assert.equal(result!.volumes.length, 2);
  assert.deepEqual(
    result!.volumes.map((v) => v.id),
    ['volume-4', 'volume-5'],
  );
  assert.ok(result!.volumes.every((v) => v.zoneId === 'zone-2'));
  assert.deepEqual(result!.volumes[0].size, [2, 3, 4]); // geometry preserved
});

test('duplicateZone on an empty zone yields no volumes', () => {
  const result = duplicateZone([zone('zone-1')], [volume('volume-1', 'other')], 'zone-1');
  assert.ok(result);
  assert.equal(result!.volumes.length, 0);
});

test('duplicateZone returns null for an unknown id', () => {
  assert.equal(duplicateZone([zone('zone-1')], [], 'zone-9'), null);
});

// --- camera constraints (`camera_placement.md` §7) --------------------------

const dupGroup = (id: string): ConstraintGroup => ({
  id,
  name: 'Dock',
  enabled: false,
  fov: 90,
  aspect: 1,
  near: 0.2,
  far: 45,
  namePrefix: 'Dock',
  zoneIds: ['zone-3', 'zone-7'],
  restrictScoring: true,
  restrictMounts: true,
  poolSize: 120,
  maxCount: 6,
  trials: 500,
  epsilon: 2,
  seed: 7,
});

const dupRail = (id: string, groupId: string): CameraConstraint => ({
  id,
  groupId,
  name: 'Rail',
  enabled: true,
  distance: 0.4,
  kind: 'polyline',
  points: [
    [0, 5, 0],
    [0, 5, 8],
  ],
});

test('duplicateConstraint copies verbatim into the same group', () => {
  const constraints = [dupRail('con-1', 'cg-1')];
  const copy = duplicateConstraint(constraints, 'con-1')!;
  assert.equal(copy.id, 'con-2');
  assert.equal(copy.groupId, 'cg-1');
  assert.equal(copy.distance, 0.4);
  assert.equal(duplicateConstraint(constraints, 'con-404'), null);
});

test('a duplicated polyline owns its vertices, so dragging one cannot move the other', () => {
  const constraints = [dupRail('con-1', 'cg-1')];
  const copy = duplicateConstraint(constraints, 'con-1')!;
  assert.equal(copy.kind, 'polyline');
  if (copy.kind !== 'polyline' || constraints[0].kind !== 'polyline') return;
  assert.notEqual(copy.points, constraints[0].points);
  assert.notEqual(copy.points[0], constraints[0].points[0]);
  copy.points[0][0] = 99;
  assert.equal(constraints[0].points[0][0], 0);
});

test('duplicateConstraintGroup deep-copies the group, its strategy, and its constraints', () => {
  const groups = [dupGroup('cg-1')];
  const constraints = [dupRail('con-1', 'cg-1'), dupRail('con-2', 'cg-9')];
  const copy = duplicateConstraintGroup(groups, constraints, 'cg-1')!;
  assert.equal(copy.group.id, 'cg-2');
  // The template, the pool size and the whole strategy ride along, and so does `enabled`.
  assert.equal(copy.group.far, 45);
  assert.equal(copy.group.seed, 7);
  assert.equal(copy.group.poolSize, 120);
  assert.equal(copy.group.enabled, false);
  // The target zones ride along — the copy plans for the same place (§7) — but
  // as a fresh array, so editing one group's list does not edit the other's.
  assert.deepEqual(copy.group.zoneIds, ['zone-3', 'zone-7']);
  assert.equal(copy.group.restrictMounts, true);
  assert.notEqual(copy.group.zoneIds, groups[0].zoneIds);
  copy.group.zoneIds.push('zone-9');
  assert.deepEqual(groups[0].zoneIds, ['zone-3', 'zone-7']);
  // Only this group's constraints, each renumbered and repointed at the copy.
  assert.equal(copy.constraints.length, 1);
  assert.equal(copy.constraints[0].id, 'con-3');
  assert.equal(copy.constraints[0].groupId, 'cg-2');
  assert.equal(duplicateConstraintGroup(groups, constraints, 'cg-404'), null);
});

// --- 3D Gaussian Splats (`gaussian_splats.md` §6.4) ------------------------

test('duplicateSplat copies everything verbatim under the next free id', () => {
  const splats = [
    {
      id: 'splat-1',
      name: 'North dock',
      src: 'assets/dock.sog',
      enabled: false,
      position: [12, 0, -40] as Vec3,
      rotation: [0, 0.707, 0, 0.707] as Quat,
      scale: 0.98,
    },
  ];
  const copy = duplicateSplat(splats, 'splat-1');
  assert.ok(copy);
  assert.equal(copy.id, 'splat-2');
  // The same `src` is the point: the copy is labelled by the same filename and
  // **shares the original's decode**, so comparing two registrations of one
  // capture costs a row rather than a second gigabyte (§3.3).
  assert.equal(copy.src, 'assets/dock.sog');
  assert.equal(copy.name, 'North dock');
  assert.equal(copy.enabled, false);
  assert.equal(copy.scale, 0.98);
  assert.deepEqual(copy.position, [12, 0, -40]);
  assert.deepEqual(copy.rotation, [0, 0.707, 0, 0.707]);
});

test('duplicateSplat deep-copies the transform arrays and rejects an unknown id', () => {
  const original = {
    id: 'splat-1',
    name: '',
    src: 'assets/site.spz',
    enabled: true,
    position: [0, 0, 0] as Vec3,
    rotation: [0, 0, 0, 1] as Quat,
    scale: 1,
  };
  const copy = duplicateSplat([original], 'splat-1');
  assert.ok(copy);
  // Otherwise dragging one row's gizmo would move the other's.
  assert.notEqual(copy.position, original.position);
  assert.notEqual(copy.rotation, original.rotation);
  assert.equal(duplicateSplat([original], 'splat-9'), null);
});

test('duplicateGeometry copies every property with a fresh id, sharing nothing (`geometry_assets.md` §6.4)', () => {
  const objects: GeometryObject[] = [
    { kind: 'mesh', id: 'geom-1', name: '', enabled: false, src: 'assets/rack.obj', position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 1, 1] },
  ];
  const copy = duplicateGeometry(objects, 'geom-1')!;
  assert.equal(copy.id, 'geom-2');
  assert.equal(copy.kind === 'mesh' && copy.src, 'assets/rack.obj');
  // The copy inherits the original's enabled state, like a camera's.
  assert.equal(copy.enabled, false);
  // Coincides with the original — no offset, like every other kind.
  assert.deepEqual(copy.position, [1, 2, 3]);
  assert.notEqual(copy.position, objects[0].position);
  assert.notEqual(copy.scale, objects[0].scale);
  assert.equal(duplicateGeometry(objects, 'nope'), null);
});
