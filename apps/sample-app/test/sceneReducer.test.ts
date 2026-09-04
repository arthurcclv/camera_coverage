import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initSceneState,
  sceneReducer,
  type SceneAction,
  type SceneDocState,
} from '../src/scene/sceneReducer.ts';
import type { SceneCamera } from '../src/cameras/camera.ts';
import type { Probe } from '../src/scene/probeVisibility.ts';
import type { Section } from '../src/scene/sectionHeatmap.ts';
import type { SamplingVolume, Zone } from '../src/scene/samplingVolumes.ts';
import type { Scene } from '../src/scene/sceneModel.ts';

const cam = (id: string): SceneCamera => ({ id, name: '', enabled: true, position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60, aspect: 16 / 9, near: 0.1, far: 30 });
const probe = (id: string): Probe => ({ id, name: '', position: [0, 0, 0] });
const zone = (id: string, enabled = true): Zone => ({ id, name: id, enabled });
const volume = (id: string, zoneId: string): SamplingVolume => ({ id, zoneId, position: [0, 0, 0], rotation: [0, 0, 0, 1], size: [1, 1, 1] });
const section = (id: string): Section => ({
  id, orientation: 'horizontal', min: 0, max: 2, minA: 0, maxA: 4, minB: 0, maxB: 6,
  aggregation: 'mean', enabled: true, clipRange: 1, name: '',
});

/** A base doc state; `hasRunOnce` defaults true so stale-marking is exercisable. */
function base(overrides: Partial<SceneDocState> = {}): SceneDocState {
  const scene: Scene = { geometry: [], cameras: [cam('cam-1')], probes: [], sections: [], clipSectionId: null, zones: [], volumes: [], useZones: false, constraintGroups: [], constraints: [] };
  return { ...initSceneState(scene), hasRunOnce: true, ...overrides };
}

const run = (state: SceneDocState, ...actions: SceneAction[]): SceneDocState =>
  actions.reduce(sceneReducer, state);

// --- init ------------------------------------------------------------------
test('initSceneState selects the first camera and starts clean', () => {
  const s = initSceneState({ geometry: [], cameras: [cam('cam-1'), cam('cam-2')], probes: [], sections: [], clipSectionId: null, zones: [], volumes: [], useZones: false, constraintGroups: [], constraints: [] });
  assert.deepEqual(s.selection, { kind: 'camera', id: 'cam-1' });
  assert.equal(s.stale, false);
  assert.equal(s.hasRunOnce, false);
  assert.equal(s.samplingDirty, false);
});

// --- add -------------------------------------------------------------------
test('addCamera appends the next id, selects it, and marks stale after a run', () => {
  const s = run(base(), { type: 'addCamera', position: [1, 2, 3] });
  assert.equal(s.cameras.length, 2);
  assert.equal(s.cameras[1].id, 'cam-2');
  assert.deepEqual(s.cameras[1].position, [1, 2, 3]);
  assert.deepEqual(s.selection, { kind: 'camera', id: 'cam-2' });
  assert.equal(s.stale, true);
});

test('addCamera before any run does not latch stale', () => {
  const s = run(base({ hasRunOnce: false, stale: false }), { type: 'addCamera', position: [0, 0, 0] });
  assert.equal(s.stale, false);
});

test('addProbe / addSection never mark stale (spec §12.5, §8.1)', () => {
  const p = run(base(), { type: 'addProbe', position: [0, 0, 0] });
  assert.equal(p.stale, false);
  assert.deepEqual(p.selection, { kind: 'probe', id: 'probe-1' });
  const sec = run(base(), { type: 'addSection', worldMin: [0, 0, 0], worldMax: [10, 10, 10] });
  assert.equal(sec.stale, false);
  assert.equal(sec.sections.length, 1);
  assert.equal(sec.selection?.kind, 'section');
});

test('addZone creates an empty zone without marking stale/dirty (§4)', () => {
  const s = run(base(), { type: 'addZone' });
  assert.equal(s.zones.length, 1);
  assert.equal(s.stale, false);
  assert.equal(s.samplingDirty, false);
});

test('addVolume marks stale + dirty and creates "Zone 1" when none exist (§4)', () => {
  const s = run(base(), { type: 'addVolume', position: [0, 0, 0] });
  assert.equal(s.zones.length, 1);
  assert.equal(s.volumes.length, 1);
  assert.equal(s.volumes[0].zoneId, s.zones[0].id);
  assert.equal(s.stale, true);
  assert.equal(s.samplingDirty, true);
  assert.deepEqual(s.selection, { kind: 'volume', id: s.volumes[0].id });
});

test('addVolume targets the selected volume\'s zone', () => {
  const start = base({ zones: [zone('zone-1'), zone('zone-2')], volumes: [volume('volume-1', 'zone-2')], selection: { kind: 'volume', id: 'volume-1' } });
  const s = run(start, { type: 'addVolume', position: [0, 0, 0] });
  assert.equal(s.volumes[1].zoneId, 'zone-2');
});

// --- rename: never stale, for any entity including cameras (spec §5.6) ------
test('renameEntity never marks stale — cameras included (matches spec §5.6)', () => {
  for (const kind of ['camera', 'probe', 'section', 'zone'] as const) {
    const start = base({ probes: [probe('probe-1')], sections: [section('section-1')], zones: [zone('zone-1')] });
    const id = kind === 'camera' ? 'cam-1' : `${kind === 'probe' ? 'probe' : kind}-1`;
    const s = run(start, { type: 'renameEntity', kind, id, name: 'renamed' });
    assert.equal(s.stale, false, `${kind} rename must not mark stale`);
    assert.equal(s.samplingDirty, false, `${kind} rename must not dirty sampling`);
  }
});

// --- change ----------------------------------------------------------------
test('changeCamera marks stale; changeProbe and changeSection do not', () => {
  assert.equal(run(base(), { type: 'changeCamera', id: 'cam-1', patch: { far: 40 } }).stale, true);
  assert.equal(run(base({ probes: [probe('probe-1')] }), { type: 'changeProbe', id: 'probe-1', position: [1, 1, 1] }).stale, false);
  assert.equal(run(base({ sections: [section('section-1')] }), { type: 'changeSection', id: 'section-1', patch: { clipRange: 3 } }).stale, false);
});

test('changeVolume marks stale + dirty', () => {
  const start = base({ zones: [zone('zone-1')], volumes: [volume('volume-1', 'zone-1')] });
  const s = run(start, { type: 'changeVolume', id: 'volume-1', patch: { zoneId: 'zone-1' } });
  assert.equal(s.stale, true);
  assert.equal(s.samplingDirty, true);
});

// --- toggle ----------------------------------------------------------------
test('toggleEnabled camera marks stale; section/zone toggles are re-filters (not stale)', () => {
  assert.equal(run(base(), { type: 'toggleEnabled', kind: 'camera', id: 'cam-1' }).cameras[0].enabled, false);
  assert.equal(run(base(), { type: 'toggleEnabled', kind: 'camera', id: 'cam-1' }).stale, true);
  assert.equal(run(base({ sections: [section('section-1')] }), { type: 'toggleEnabled', kind: 'section', id: 'section-1' }).stale, false);
  assert.equal(run(base({ zones: [zone('zone-1')] }), { type: 'toggleEnabled', kind: 'zone', id: 'zone-1' }).stale, false);
});

test('toggleUseZones marks stale + dirty', () => {
  const s = run(base(), { type: 'toggleUseZones', value: true });
  assert.equal(s.useZones, true);
  assert.equal(s.stale, true);
  assert.equal(s.samplingDirty, true);
});

// --- delete ----------------------------------------------------------------
test('deleteEntity clears the selection only when it pointed at the deleted entity', () => {
  const start = base({ cameras: [cam('cam-1'), cam('cam-2')], selection: { kind: 'camera', id: 'cam-2' } });
  assert.equal(run(start, { type: 'deleteEntity', kind: 'camera', id: 'cam-2' }).selection, null);
  assert.deepEqual(run(start, { type: 'deleteEntity', kind: 'camera', id: 'cam-1' }).selection, { kind: 'camera', id: 'cam-2' });
});

test('deleting the clipping section clears the clip (spec §13.9)', () => {
  const start = base({ sections: [section('section-1')], clipSectionId: 'section-1' });
  assert.equal(run(start, { type: 'deleteEntity', kind: 'section', id: 'section-1' }).clipSectionId, null);
});

test('deleting a NON-empty zone marks dirty; an EMPTY zone does not (documented intent)', () => {
  const nonEmpty = base({ zones: [zone('zone-1')], volumes: [volume('volume-1', 'zone-1')] });
  const a = run(nonEmpty, { type: 'deleteEntity', kind: 'zone', id: 'zone-1' });
  assert.equal(a.volumes.length, 0);
  assert.equal(a.samplingDirty, true);
  assert.equal(a.stale, true);

  const empty = base({ zones: [zone('zone-1')] });
  const b = run(empty, { type: 'deleteEntity', kind: 'zone', id: 'zone-1' });
  assert.equal(b.samplingDirty, false);
  assert.equal(b.stale, false);
});

test('deleting a probe/section never marks stale', () => {
  assert.equal(run(base({ probes: [probe('probe-1')] }), { type: 'deleteEntity', kind: 'probe', id: 'probe-1' }).stale, false);
  assert.equal(run(base({ sections: [section('section-1')] }), { type: 'deleteEntity', kind: 'section', id: 'section-1' }).stale, false);
});

// --- duplicate -------------------------------------------------------------
test('duplicateEntity selects the copy; camera copy marks stale', () => {
  const s = run(base(), { type: 'duplicateEntity', kind: 'camera', id: 'cam-1' });
  assert.equal(s.cameras.length, 2);
  assert.deepEqual(s.selection, { kind: 'camera', id: 'cam-2' });
  assert.equal(s.stale, true);
});

test('duplicating a zone marks dirty only when it brings volumes', () => {
  const withVols = base({ zones: [zone('zone-1')], volumes: [volume('volume-1', 'zone-1')] });
  const a = run(withVols, { type: 'duplicateEntity', kind: 'zone', id: 'zone-1' });
  assert.equal(a.volumes.length, 2);
  assert.equal(a.samplingDirty, true);

  const empty = base({ zones: [zone('zone-1')] });
  const b = run(empty, { type: 'duplicateEntity', kind: 'zone', id: 'zone-1' });
  assert.equal(b.zones.length, 2);
  assert.equal(b.samplingDirty, false);
});

// --- transformApplied ------------------------------------------------------
test('transformApplied: camera → stale, probe/section → not, volume → dirty', () => {
  assert.equal(run(base(), { type: 'transformApplied', change: { kind: 'camera', id: 'cam-1', position: [1, 1, 1], rotation: [0, 0, 0, 1] } }).stale, true);
  assert.equal(run(base({ probes: [probe('probe-1')] }), { type: 'transformApplied', change: { kind: 'probe', id: 'probe-1', position: [1, 1, 1] } }).stale, false);
  assert.equal(run(base({ sections: [section('section-1')] }), { type: 'transformApplied', change: { kind: 'section', id: 'section-1', min: 0, max: 1, minA: 0, maxA: 1, minB: 0, maxB: 1 } }).stale, false);
  const v = run(base({ zones: [zone('zone-1')], volumes: [volume('volume-1', 'zone-1')] }), { type: 'transformApplied', change: { kind: 'volume', id: 'volume-1', position: [2, 2, 2], rotation: [0, 0, 0, 1], size: [3, 3, 3] } });
  assert.equal(v.samplingDirty, true);
  assert.deepEqual(v.volumes[0].size, [3, 3, 3]);
});

// --- clip / collapse / selection -------------------------------------------
test('toggleSectionClip sets then clears the clip', () => {
  const start = base({ sections: [section('section-1')] });
  const on = run(start, { type: 'toggleSectionClip', id: 'section-1' });
  assert.equal(on.clipSectionId, 'section-1');
  assert.equal(run(on, { type: 'toggleSectionClip', id: 'section-1' }).clipSectionId, null);
});

test('toggleCollapse adds then removes a node id', () => {
  const on = run(base(), { type: 'toggleCollapse', id: 'group:cameras' });
  assert.equal(on.collapsedIds.has('group:cameras'), true);
  assert.equal(run(on, { type: 'toggleCollapse', id: 'group:cameras' }).collapsedIds.has('group:cameras'), false);
});

test('selectionChanged replaces the selection', () => {
  assert.deepEqual(run(base(), { type: 'selectionChanged', selection: null }).selection, null);
});

// --- generated -------------------------------------------------------------
test('generated replaces zones/volumes, selects the first zone, marks dirty', () => {
  const s = run(base(), { type: 'generated', zones: [zone('zone-1'), zone('zone-2')], volumes: [volume('volume-1', 'zone-1')] });
  assert.equal(s.zones.length, 2);
  assert.deepEqual(s.selection, { kind: 'zone', id: 'zone-1' });
  assert.equal(s.samplingDirty, true);
  assert.equal(s.stale, true);
});

// --- run lifecycle ---------------------------------------------------------
test('runCompleted clears stale and latches hasRunOnce; samplingApplied clears dirty', () => {
  const s = run(base({ hasRunOnce: false, stale: true, samplingDirty: true }), { type: 'runCompleted' });
  assert.equal(s.stale, false);
  assert.equal(s.hasRunOnce, true);
  assert.equal(run(s, { type: 'samplingApplied' }).samplingDirty, false);
});

test('markStale latches only after a run', () => {
  assert.equal(run(base({ hasRunOnce: false, stale: false }), { type: 'markStale' }).stale, false);
  assert.equal(run(base({ hasRunOnce: true, stale: false }), { type: 'markStale' }).stale, true);
});

// --- reorderEntity (spec §5.5.1) -------------------------------------------
test('reorderEntity moves a camera before a sibling', () => {
  const start = base({ cameras: [cam('cam-1'), cam('cam-2'), cam('cam-3')] });
  const s = run(start, { type: 'reorderEntity', kind: 'camera', id: 'cam-3', beforeId: 'cam-1' });
  assert.deepEqual(s.cameras.map((c) => c.id), ['cam-3', 'cam-1', 'cam-2']);
});

test('reorderEntity with a null beforeId moves the row last', () => {
  const start = base({ cameras: [cam('cam-1'), cam('cam-2'), cam('cam-3')] });
  const s = run(start, { type: 'reorderEntity', kind: 'camera', id: 'cam-1', beforeId: null });
  assert.deepEqual(s.cameras.map((c) => c.id), ['cam-2', 'cam-3', 'cam-1']);
});

test('reorderEntity handles probes, sections and zones the same way', () => {
  const start = base({
    probes: [probe('probe-1'), probe('probe-2')],
    sections: [section('section-1'), section('section-2')],
    zones: [zone('zone-1'), zone('zone-2')],
  });
  const s = run(
    start,
    { type: 'reorderEntity', kind: 'probe', id: 'probe-2', beforeId: 'probe-1' },
    { type: 'reorderEntity', kind: 'section', id: 'section-2', beforeId: 'section-1' },
    { type: 'reorderEntity', kind: 'zone', id: 'zone-2', beforeId: 'zone-1' },
  );
  assert.deepEqual(s.probes.map((p) => p.id), ['probe-2', 'probe-1']);
  assert.deepEqual(s.sections.map((x) => x.id), ['section-2', 'section-1']);
  assert.deepEqual(s.zones.map((z) => z.id), ['zone-2', 'zone-1']);
});

test('reorderEntity permutes a volume within its own zone only', () => {
  // Interleaved across zones, as appending on create naturally produces.
  const start = base({
    zones: [zone('zone-1'), zone('zone-2')],
    volumes: [volume('volume-1', 'zone-1'), volume('volume-2', 'zone-2'), volume('volume-3', 'zone-1')],
  });
  const s = run(start, { type: 'reorderEntity', kind: 'volume', id: 'volume-3', beforeId: 'volume-1' });
  assert.deepEqual(s.volumes.map((v) => v.id), ['volume-3', 'volume-2', 'volume-1']);
  // zone-2's volume never moved.
  assert.equal(s.volumes[1], start.volumes[1]);
});

test('reorderEntity never reparents a volume across zones', () => {
  const start = base({
    zones: [zone('zone-1'), zone('zone-2')],
    volumes: [volume('volume-1', 'zone-1'), volume('volume-2', 'zone-2')],
  });
  const s = run(start, { type: 'reorderEntity', kind: 'volume', id: 'volume-1', beforeId: 'volume-2' });
  assert.deepEqual(s.volumes.map((v) => v.id), ['volume-1', 'volume-2']);
  assert.equal(s.volumes[0].zoneId, 'zone-1');
});

test('reorderEntity marks neither stale nor sampling-dirty, and keeps the selection', () => {
  const start = base({
    cameras: [cam('cam-1'), cam('cam-2')],
    zones: [zone('zone-1')],
    volumes: [volume('volume-1', 'zone-1'), volume('volume-2', 'zone-1')],
    selection: { kind: 'camera', id: 'cam-2' },
    stale: false,
    samplingDirty: false,
    hasRunOnce: true,
  });
  const s = run(
    start,
    { type: 'reorderEntity', kind: 'camera', id: 'cam-2', beforeId: 'cam-1' },
    // A volume move is the case that would otherwise dirty sampling.
    { type: 'reorderEntity', kind: 'volume', id: 'volume-2', beforeId: 'volume-1' },
  );
  assert.deepEqual(s.cameras.map((c) => c.id), ['cam-2', 'cam-1']);
  assert.deepEqual(s.volumes.map((v) => v.id), ['volume-2', 'volume-1']);
  assert.equal(s.stale, false);
  assert.equal(s.samplingDirty, false);
  assert.deepEqual(s.selection, { kind: 'camera', id: 'cam-2' });
});

test('reorderEntity is a no-op for an unknown id or a position that changes nothing', () => {
  const start = base({ cameras: [cam('cam-1'), cam('cam-2')] });
  const unknown = run(start, { type: 'reorderEntity', kind: 'camera', id: 'nope', beforeId: 'cam-1' });
  assert.equal(unknown.cameras, start.cameras);
  const noop = run(start, { type: 'reorderEntity', kind: 'camera', id: 'cam-1', beforeId: 'cam-2' });
  assert.equal(noop.cameras, start.cameras);
});

// --- sceneReplaced ---------------------------------------------------------
test('sceneReplaced resets flags, forces sampling re-apply, keeps collapse, selects first camera', () => {
  const start = base({ stale: true, hasRunOnce: true, collapsedIds: new Set(['group:cameras']) });
  const s = run(start, { type: 'sceneReplaced', doc: { cameras: [cam('cam-9')], probes: [], sections: [], clipSectionId: null, zones: [], volumes: [], useZones: false, constraintGroups: [], constraints: [] } });
  assert.deepEqual(s.selection, { kind: 'camera', id: 'cam-9' });
  assert.equal(s.stale, false);
  assert.equal(s.hasRunOnce, false);
  assert.equal(s.samplingDirty, true);
  assert.equal(s.collapsedIds.has('group:cameras'), true); // collapse state survives import
});

test('toggleAimLock flips the flag and never marks stale (aim_optimization.md §4.5)', () => {
  // The lock is app-only: it changes which cameras the optimizer touches, not
  // anything the engine computes, so a toggle must not trigger a recompute.
  const s = run(base(), { type: 'toggleAimLock', id: 'cam-1' });
  assert.equal(s.cameras[0].aimLocked, true);
  assert.equal(s.stale, false);
  const back = run(s, { type: 'toggleAimLock', id: 'cam-1' });
  assert.equal(back.cameras[0].aimLocked, false);
  assert.equal(back.stale, false);
});

test('applyAims writes every proposal in one edit and marks stale once (aim_optimization.md §6.2)', () => {
  const scene: Scene = {
    geometry: [], cameras: [cam('cam-1'), cam('cam-2'), cam('cam-3')], probes: [], sections: [],
    clipSectionId: null, zones: [], volumes: [], useZones: false,
  };
  const start = { ...initSceneState(scene), hasRunOnce: true };
  const rotations = new Map<string, [number, number, number, number]>([
    ['cam-1', [0, 1, 0, 0]],
    ['cam-3', [0, 0, 1, 0]],
  ]);

  const s = run(start, { type: 'applyAims', rotations });
  assert.deepEqual(s.cameras[0].rotation, [0, 1, 0, 0]);
  assert.deepEqual(s.cameras[1].rotation, start.cameras[1].rotation, 'a camera with no proposal moved');
  assert.deepEqual(s.cameras[2].rotation, [0, 0, 1, 0]);
  assert.equal(s.stale, true);
});

// --- camera constraints (`camera_placement.md` §6.3, §7) --------------------
// The through-line of this block: a constraint edit is **not** a coverage input
// (§1.1), so nothing here marks the result stale — except the one case that
// moves a bound camera, which is a camera edit however it was triggered.

const constraintBase = () =>
  run(
    base(),
    { type: 'addConstraintGroup' },
    { type: 'addConstraint', kind: 'point', position: [1, 5, 1] },
  );

test('adding a constraint group or constraint never marks the result stale', () => {
  const s = constraintBase();
  assert.equal(s.constraintGroups.length, 1);
  assert.equal(s.constraintGroups[0].id, 'cg-1');
  assert.equal(s.constraints.length, 1);
  assert.equal(s.constraints[0].id, 'con-1');
  assert.equal(s.constraints[0].groupId, 'cg-1');
  assert.deepEqual(s.selection, { kind: 'constraint', id: 'con-1' });
  // Deliberately unlike a zone: a constraint changes no coverage number.
  assert.equal(s.stale, false);
  assert.equal(s.samplingDirty, false);
});

test('addConstraint creates a group when none exists, and targets the selected one', () => {
  const fresh = run(base(), { type: 'addConstraint', kind: 'plane', position: [0, 0, 0] });
  assert.equal(fresh.constraintGroups.length, 1);
  assert.equal(fresh.constraints[0].groupId, fresh.constraintGroups[0].id);

  // With a second group selected, the next constraint lands in *that* one.
  const two = run(constraintBase(), { type: 'addConstraintGroup' });
  assert.deepEqual(two.selection, { kind: 'constraintGroup', id: 'cg-2' });
  const added = run(two, { type: 'addConstraint', kind: 'point', position: [0, 0, 0] });
  assert.equal(added.constraints[1].groupId, 'cg-2');
});

test('a polyline commits with the vertices the draw mode collected', () => {
  const s = run(base(), {
    type: 'addConstraint',
    kind: 'polyline',
    position: [0, 0, 0],
    points: [
      [0, 5, 0],
      [0, 5, 8],
      [6, 5, 8],
    ],
  });
  const c = s.constraints[0];
  assert.equal(c.kind, 'polyline');
  if (c.kind !== 'polyline') return;
  assert.equal(c.points.length, 3);
  assert.deepEqual(c.points[2], [6, 5, 8]);
});

test('deleting a group removes its constraints and unbinds their cameras', () => {
  const s0 = run(constraintBase(), { type: 'bindCamera', id: 'cam-1', constraintId: 'con-1' });
  assert.equal(s0.cameras[0].constraintId, 'con-1');
  const s = run(s0, { type: 'deleteEntity', kind: 'constraintGroup', id: 'cg-1' });
  assert.equal(s.constraintGroups.length, 0);
  assert.equal(s.constraints.length, 0);
  // The camera and its position stay; only the binding goes (§6.3).
  assert.equal(s.cameras.length, 1);
  assert.equal('constraintId' in s.cameras[0], false);
});

test('deleting one constraint unbinds only the cameras that referenced it', () => {
  const s0 = run(
    constraintBase(),
    { type: 'addConstraint', kind: 'point', position: [2, 5, 2] },
    { type: 'bindCamera', id: 'cam-1', constraintId: 'con-2' },
  );
  const s = run(s0, { type: 'deleteEntity', kind: 'constraint', id: 'con-1' });
  assert.deepEqual(s.constraints.map((c) => c.id), ['con-2']);
  assert.equal(s.cameras[0].constraintId, 'con-2');
});

test('duplicating a group deep-copies its constraints into the copy', () => {
  const s = run(constraintBase(), { type: 'duplicateEntity', kind: 'constraintGroup', id: 'cg-1' });
  assert.equal(s.constraintGroups.length, 2);
  assert.equal(s.constraints.length, 2);
  assert.equal(s.constraints[1].groupId, 'cg-2');
  assert.notEqual(s.constraints[1].id, s.constraints[0].id);
  assert.deepEqual(s.selection, { kind: 'constraintGroup', id: 'cg-2' });
});

test('a bound camera is clamped on bind, on drag, and on a typed position', () => {
  // A point constraint with distance 0 pins the camera exactly (§3.2).
  const s0 = run(base(), {
    type: 'addConstraint',
    kind: 'point',
    position: [1, 5, 1],
  });
  const bound = run(s0, { type: 'bindCamera', id: 'cam-1', constraintId: 'con-1' });
  // Binding clamps at once — a binding that left the camera off its mount would
  // not be a constraint.
  assert.deepEqual(bound.cameras[0].position, [1, 5, 1]);

  const typed = run(bound, { type: 'changeCamera', id: 'cam-1', patch: { position: [40, 0, 0] } });
  assert.deepEqual(typed.cameras[0].position, [1, 5, 1]);

  const dragged = run(bound, {
    type: 'transformApplied',
    change: { kind: 'camera', id: 'cam-1', position: [-9, 9, 9], rotation: [0, 0, 0, 1] },
  });
  assert.deepEqual(dragged.cameras[0].position, [1, 5, 1]);
});

test('an unbound camera, or one whose constraint vanished, is never clamped', () => {
  const free = run(base(), { type: 'changeCamera', id: 'cam-1', patch: { position: [40, 1, 2] } });
  assert.deepEqual(free.cameras[0].position, [40, 1, 2]);

  // A dangling binding must not freeze a camera in place.
  const dangling = run(base({ cameras: [{ ...cam('cam-1'), constraintId: 'con-404' }] }), {
    type: 'changeCamera',
    id: 'cam-1',
    patch: { position: [7, 7, 7] },
  });
  assert.deepEqual(dangling.cameras[0].position, [7, 7, 7]);
});

test('reshaping a constraint re-clamps its bound cameras, and that IS a camera edit', () => {
  const s0 = run(
    base(),
    { type: 'addConstraint', kind: 'point', position: [1, 5, 1] },
    { type: 'bindCamera', id: 'cam-1', constraintId: 'con-1' },
    { type: 'runCompleted' },
  );
  assert.equal(s0.stale, false);
  // Moving the constraint drags the camera with it — so unlike every other
  // constraint edit, this one marks the result stale (§6.3).
  const moved = run(s0, { type: 'changeConstraint', id: 'con-1', patch: { position: [20, 5, 1] } });
  assert.deepEqual(moved.cameras[0].position, [20, 5, 1]);
  assert.equal(moved.stale, true);
});

test('reshaping a constraint that moves nothing marks nothing stale', () => {
  const s0 = run(
    base(),
    { type: 'addConstraint', kind: 'point', position: [1, 5, 1] },
    { type: 'bindCamera', id: 'cam-1', constraintId: 'con-1' },
    { type: 'runCompleted' },
  );
  // Widening the tolerance leaves the camera inside, so no camera moved and no
  // recompute is owed.
  const widened = run(s0, { type: 'changeConstraint', id: 'con-1', patch: { distance: 5 } });
  assert.equal(widened.stale, false);
  assert.deepEqual(widened.cameras[0].position, [1, 5, 1]);
});

test('polyline vertices move, insert, and delete — but never below two', () => {
  const s0 = run(base(), {
    type: 'addConstraint',
    kind: 'polyline',
    position: [0, 0, 0],
    points: [
      [0, 5, 0],
      [0, 5, 8],
    ],
  });
  const moved = run(s0, { type: 'moveConstraintVertex', id: 'con-1', vertex: 1, position: [0, 5, 12] });
  const c1 = moved.constraints[0];
  assert.equal(c1.kind === 'polyline' && c1.points[1][2], 12);

  const inserted = run(moved, { type: 'insertConstraintVertex', id: 'con-1', at: 1, position: [3, 5, 6] });
  const c2 = inserted.constraints[0];
  assert.equal(c2.kind === 'polyline' && c2.points.length, 3);
  assert.deepEqual(c2.kind === 'polyline' ? c2.points[1] : null, [3, 5, 6]);

  const deleted = run(inserted, { type: 'deleteConstraintVertex', id: 'con-1', vertex: 1 });
  const c3 = deleted.constraints[0];
  assert.equal(c3.kind === 'polyline' && c3.points.length, 2);

  // Refused, not silently converted to a point (§6.2).
  const refused = run(deleted, { type: 'deleteConstraintVertex', id: 'con-1', vertex: 0 });
  assert.equal(refused, deleted);
});

test('a vertex drag reads back as that vertex, not as a whole-constraint move', () => {
  const s0 = run(base(), {
    type: 'addConstraint',
    kind: 'polyline',
    position: [0, 0, 0],
    points: [
      [0, 5, 0],
      [0, 5, 8],
    ],
  });
  const s = run(s0, {
    type: 'transformApplied',
    change: { kind: 'constraintVertex', id: 'con-1', vertex: 0, position: [2, 5, 0] },
  });
  const c = s.constraints[0];
  assert.deepEqual(c.kind === 'polyline' ? c.points[0] : null, [2, 5, 0]);
  assert.deepEqual(c.kind === 'polyline' ? c.points[1] : null, [0, 5, 8]);
});

test('a plane drag writes position, rotation, and the two in-plane edges', () => {
  const s0 = run(base(), { type: 'addConstraint', kind: 'plane', position: [0, 0, 0] });
  const s = run(s0, {
    type: 'transformApplied',
    change: { kind: 'constraint', id: 'con-1', position: [1, 2, 3], rotation: [0, 1, 0, 0], size: [9, 4] },
  });
  const c = s.constraints[0];
  assert.equal(c.kind, 'plane');
  if (c.kind !== 'plane') return;
  assert.deepEqual(c.position, [1, 2, 3]);
  assert.deepEqual(c.rotation, [0, 1, 0, 0]);
  assert.deepEqual(c.size, [9, 4]);
});

test('applyPlacement re-arranges, creates, and disables in one edit', () => {
  // One state update for the whole plan: dispatching per camera would mark the
  // result stale N times and fire N auto-runs (§5.3).
  const start = run(
    base({
      cameras: [
        { ...cam('cam-1'), position: [0, 0, 0], name: 'Dock 1', far: 20 },
        { ...cam('cam-2'), position: [9, 9, 9] },
      ],
      hasRunOnce: true,
    }),
    // At the position the plan sends cam-1 to: a plan's positions come from the
    // pool, so they are always inside their own region (§4.1).
    { type: 'addConstraint', kind: 'point', position: [1, 2, 3] },
  );
  const s = run(start, {
    type: 'applyPlacement',
    moves: [{ cameraId: 'cam-1', position: [1, 2, 3], constraintId: 'con-1', near: 0.2, far: 50 }],
    creates: [{ ...cam('cam-9'), position: [7, 7, 7], constraintId: 'con-1' }],
    disables: ['cam-2'],
  });

  // The surplus camera is still there — switched off, everything else intact
  // (§5.3.1). Deleting it was the earlier design.
  assert.deepEqual(s.cameras.map((c) => c.id), ['cam-1', 'cam-2', 'cam-9']);
  const surplus = s.cameras[1];
  assert.equal(surplus.enabled, false);
  assert.deepEqual(surplus.position, [9, 9, 9]);
  const moved = s.cameras[0];
  // Only what the search depended on is written (§5.3.3) …
  assert.deepEqual(moved.position, [1, 2, 3]);
  assert.equal(moved.constraintId, 'con-1');
  assert.equal(moved.near, 0.2);
  assert.equal(moved.far, 50);
  // … and the camera's own identity is left alone.
  assert.equal(moved.name, 'Dock 1');
  assert.equal(moved.fov, 60);
  assert.deepEqual(moved.rotation, [0, 0, 0, 1]);
  assert.equal(s.stale, true);
});

test('a move switches its camera back on, so N placed is N contributing', () => {
  // An earlier Apply disabled cam-1 as surplus; a re-search at a higher count
  // hands it a position, and it has to come back on or the count on the button
  // is not the count in the scene (§5.3.3).
  const start = run(
    base({ cameras: [{ ...cam('cam-1'), enabled: false, constraintId: 'con-1' }], hasRunOnce: true }),
    { type: 'addConstraint', kind: 'point', position: [1, 2, 3] },
  );
  const s = run(start, {
    type: 'applyPlacement',
    moves: [{ cameraId: 'cam-1', position: [1, 2, 3], constraintId: 'con-1', near: 0.1, far: 30 }],
    creates: [],
    disables: [],
  });
  assert.equal(s.cameras[0].enabled, true);
});

test('applyPlacement never clears the selection, because it removes nothing', () => {
  const start = base({
    cameras: [cam('cam-1'), cam('cam-2')],
    selection: { kind: 'camera', id: 'cam-2' },
    hasRunOnce: true,
  });
  // The selected camera is the one the plan stands down: it stays selected and
  // inspectable, which is how the user switches it back on (§5.3.1).
  const disabled = run(start, { type: 'applyPlacement', moves: [], creates: [], disables: ['cam-2'] });
  assert.deepEqual(disabled.selection, { kind: 'camera', id: 'cam-2' });
  assert.equal(disabled.cameras[1].enabled, false);

  // A re-arrange must not yank the inspector off what the user was looking at.
  const kept = run(start, {
    type: 'applyPlacement',
    moves: [{ cameraId: 'cam-1', position: [1, 1, 1], constraintId: 'con-1', near: 0.1, far: 30 }],
    creates: [],
    disables: [],
  });
  assert.deepEqual(kept.selection, { kind: 'camera', id: 'cam-2' });
});

test('toggling and renaming a group or constraint marks nothing stale', () => {
  const s0 = run(constraintBase(), { type: 'runCompleted' });
  const s = run(
    s0,
    { type: 'toggleEnabled', kind: 'constraintGroup', id: 'cg-1' },
    { type: 'toggleEnabled', kind: 'constraint', id: 'con-1' },
    { type: 'renameEntity', kind: 'constraintGroup', id: 'cg-1', name: 'Dock' },
    { type: 'renameEntity', kind: 'constraint', id: 'con-1', name: 'Post' },
  );
  assert.equal(s.constraintGroups[0].enabled, false);
  assert.equal(s.constraints[0].enabled, false);
  assert.equal(s.constraintGroups[0].name, 'Dock');
  assert.equal(s.constraints[0].name, 'Post');
  assert.equal(s.stale, false);
});

test('constraints reorder within their own group only', () => {
  const s0 = run(
    constraintBase(),
    { type: 'addConstraint', kind: 'point', position: [2, 5, 2] },
    { type: 'addConstraintGroup' },
    { type: 'addConstraint', kind: 'point', position: [3, 5, 3] },
  );
  assert.deepEqual(s0.constraints.map((c) => `${c.id}@${c.groupId}`), [
    'con-1@cg-1',
    'con-2@cg-1',
    'con-3@cg-2',
  ]);
  const s = run(s0, { type: 'reorderEntity', kind: 'constraint', id: 'con-2', beforeId: 'con-1' });
  assert.deepEqual(s.constraints.map((c) => c.id), ['con-2', 'con-1', 'con-3']);
  // Across groups is a no-op: dragging never reparents (spec §5.5.1). The array
  // itself is returned unchanged, which is the reducer's actual contract — the
  // wrapping state object is rebuilt either way.
  const across = run(s, { type: 'reorderEntity', kind: 'constraint', id: 'con-3', beforeId: 'con-1' });
  assert.equal(across.constraints, s.constraints);
});

test('a move is clamped like any other position write', () => {
  // A plan's positions come from the pool and are already in their regions, so
  // this can only fire on a corrupt plan — which is exactly why it runs (§6.3).
  const start = run(base({ hasRunOnce: true }), {
    type: 'addConstraint',
    kind: 'point',
    position: [5, 5, 5],
  });
  const s = run(start, {
    type: 'applyPlacement',
    moves: [{ cameraId: 'cam-1', position: [40, 0, 0], constraintId: 'con-1', near: 0.1, far: 30 }],
    creates: [],
    disables: [],
  });
  assert.deepEqual(s.cameras[0].position, [5, 5, 5]);
});
