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
  const scene: Scene = { geometry: [], cameras: [cam('cam-1')], probes: [], sections: [], clipSectionId: null, zones: [], volumes: [], useZones: false };
  return { ...initSceneState(scene), hasRunOnce: true, ...overrides };
}

const run = (state: SceneDocState, ...actions: SceneAction[]): SceneDocState =>
  actions.reduce(sceneReducer, state);

// --- init ------------------------------------------------------------------
test('initSceneState selects the first camera and starts clean', () => {
  const s = initSceneState({ geometry: [], cameras: [cam('cam-1'), cam('cam-2')], probes: [], sections: [], clipSectionId: null, zones: [], volumes: [], useZones: false });
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
  const s = run(start, { type: 'sceneReplaced', doc: { cameras: [cam('cam-9')], probes: [], sections: [], clipSectionId: null, zones: [], volumes: [], useZones: false } });
  assert.deepEqual(s.selection, { kind: 'camera', id: 'cam-9' });
  assert.equal(s.stale, false);
  assert.equal(s.hasRunOnce, false);
  assert.equal(s.samplingDirty, true);
  assert.equal(s.collapsedIds.has('group:cameras'), true); // collapse state survives import
});
