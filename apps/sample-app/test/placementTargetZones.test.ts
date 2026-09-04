/**
 * A constraint group's **target zones** (`camera_placement.md` §3.1.2, §7, §9).
 *
 * Every property here fails as a plausible number rather than as a crash, which
 * is why they are pinned by outcome: a filter built from the listed zones paired
 * with a denominator from the enabled ones is a percentage of the wrong thing,
 * and nothing on screen would look wrong about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import { buildAggregateSpec, markedFilterForZones } from '../src/scene/aggregateSpec.ts';
import { volumesOfZones, type SamplingVolume, type Zone } from '../src/scene/samplingVolumes.ts';
import { WorkspaceGrid } from '@linkervision/camera-coverage-sdk';
import { initSceneState, sceneReducer, type SceneDocState } from '../src/scene/sceneReducer.ts';
import { parseSceneFile, serializeScene } from '../src/scene/sceneFile.ts';
import { duplicateConstraintGroup } from '../src/scene/entityDuplication.ts';
import { defaultConstraintGroup, type CameraConstraint, type ConstraintGroup } from '../src/placement/region.ts';
import {
  constraintOverlaps,
  NO_UNMOUNTABLE,
  regeneratedTargetsNotice,
  resolveGroupTarget,
  unmountableIds,
  type AppMarkedSet,
} from '../src/placement/pool.ts';
import type { Scene } from '../src/scene/sceneModel.ts';

const IDENTITY: Quat = [0, 0, 0, 1];

const zone = (id: string, enabled = true): Zone => ({ id, name: id, enabled });
const volume = (id: string, zoneId: string, position: Vec3 = [0, 0, 0]): SamplingVolume => ({
  id,
  zoneId,
  position,
  rotation: IDENTITY,
  size: [2, 2, 2],
});

const ZONES = [zone('zone-1'), zone('zone-2', false), zone('zone-3')];
const VOLUMES = [
  volume('volume-1', 'zone-1', [0, 0, 0]),
  volume('volume-2', 'zone-2', [10, 0, 0]),
  volume('volume-3', 'zone-3', [20, 0, 0]),
];

const grid = () =>
  new WorkspaceGrid({ worldMin: [-32, -32, -32], worldMax: [32, 32, 32], voxelSize: 1, chunkSizeXZ: 16 });

function group(over: Partial<ConstraintGroup> = {}): ConstraintGroup {
  return { ...defaultConstraintGroup('cg-1'), ...over };
}

function scene(over: Partial<Scene> = {}): Scene {
  return {
    geometry: [],
    cameras: [],
    probes: [],
    sections: [],
    clipSectionId: null,
    zones: ZONES,
    volumes: VOLUMES,
    useZones: true,
    constraintGroups: [group({ zoneIds: ['zone-1', 'zone-3'] })],
    constraints: [],
    ...over,
  };
}

// --- The filter (§3.1.2, §3.3) ----------------------------------------------

test('markedFilterForZones names exactly the listed zones’ volumes', () => {
  const f = markedFilterForZones(VOLUMES, ['zone-1', 'zone-3']);
  assert.equal(f.regions.length, 2);
  assert.deepEqual(f.maskRegions, [0, 1]);
  // Exact OBBs, half-sized — the same thing `buildAggregateSpec` builds, because
  // `setSampling`'s conservative AABBs are not what says what is *counted* (§3.3).
  assert.deepEqual(f.regions[0].center, [0, 0, 0]);
  assert.deepEqual(f.regions[0].halfSize, [1, 1, 1]);
  assert.deepEqual(f.regions[1].center, [20, 0, 0]);
});

test('a listed zone counts even while globally disabled (§3.1.2)', () => {
  // `zone-2` is `enabled: false`, so the display descriptor leaves it out of the
  // marked set entirely. A group that lists it gets it anyway — the group states
  // its own target, and a display toggle does not get to redefine it.
  const display = buildAggregateSpec({
    grid: grid(),
    zones: ZONES,
    volumes: VOLUMES,
    sections: [],
    probes: [],
    samplingActive: true,
  });
  const displayMarked = display.index.markedFilter.maskRegions.map(
    (i) => display.index.markedFilter.regions[i].center[0],
  );
  assert.deepEqual(displayMarked, [0, 20], 'the disabled zone should be absent from the display filter');

  const targeted = markedFilterForZones(VOLUMES, ['zone-2']);
  assert.equal(targeted.regions.length, 1);
  assert.deepEqual(targeted.regions[0].center, [10, 0, 0]);
});

test('an empty or dead list reads as "no filter", the full-volume fallback', () => {
  assert.deepEqual(markedFilterForZones(VOLUMES, []), { regions: [], maskRegions: [] });
  assert.deepEqual(markedFilterForZones(VOLUMES, ['zone-404']), { regions: [], maskRegions: [] });
});

test('the display descriptor’s handed-over filter *is* markedFilterForZones (§3.3)', () => {
  // Not "agrees with" — **is**. Two constructions that agree today are two
  // constructions that can disagree tomorrow, which is the drift §3.3 exists to
  // rule out, so `buildAggregateSpec` delegates rather than assembling its own.
  const display = buildAggregateSpec({
    grid: grid(),
    zones: ZONES,
    volumes: VOLUMES,
    sections: [],
    probes: [],
    samplingActive: true,
  });
  const enabledIds = ZONES.filter((z) => z.enabled).map((z) => z.id);
  assert.deepEqual(display.index.markedFilter, markedFilterForZones(VOLUMES, enabledIds));

  // Sampling off is "no filter", and the same call says so.
  const unzoned = buildAggregateSpec({
    grid: grid(),
    zones: ZONES,
    volumes: VOLUMES,
    sections: [],
    probes: [],
    samplingActive: false,
  });
  assert.deepEqual(unzoned.index.markedFilter, markedFilterForZones(VOLUMES, []));
});

test('volumesOfZones selects by zone, and nothing for an empty list', () => {
  assert.deepEqual(volumesOfZones(VOLUMES, ['zone-1', 'zone-3']).map((v) => v.id), ['volume-1', 'volume-3']);
  assert.deepEqual(volumesOfZones(VOLUMES, []), []);
  assert.deepEqual(volumesOfZones(VOLUMES, ['zone-404']), []);
});

// --- Lifecycle (§7) ----------------------------------------------------------

const doc = (over: Partial<Scene> = {}): SceneDocState => ({
  ...initSceneState(scene(over)),
  hasRunOnce: true,
});

test('deleting a listed zone prunes it from every group (§7)', () => {
  const next = sceneReducer(doc(), { type: 'deleteEntity', kind: 'zone', id: 'zone-1' });
  assert.deepEqual(next.constraintGroups[0].zoneIds, ['zone-3']);
});

test('deleting an unlisted zone changes no group — so a targeted pool survives it', () => {
  const before = doc();
  const next = sceneReducer(before, { type: 'deleteEntity', kind: 'zone', id: 'zone-2' });
  assert.deepEqual(next.constraintGroups[0].zoneIds, ['zone-1', 'zone-3']);
  // Identity-stable, not merely equal: the memoized derivations that read the
  // groups must not re-run because an unrelated zone went away.
  assert.equal(next.constraintGroups, before.constraintGroups);
});

test('regenerating zones clears every group’s list (§7)', () => {
  // Generation re-numbers from `zone-1`, so the ids survive and name *different*
  // boxes. Pruning by liveness would never fire and the group would silently
  // retarget — so the references are treated as destroyed, which is what they are.
  const next = sceneReducer(doc(), {
    type: 'generated',
    zones: [zone('zone-1'), zone('zone-2')],
    volumes: [volume('volume-1', 'zone-1', [99, 0, 0])],
  });
  assert.deepEqual(next.constraintGroups[0].zoneIds, []);
  assert.equal(next.zones.length, 2);
});

test('duplicating a group copies the target verbatim, into a fresh array (§7)', () => {
  const groups = [group({ zoneIds: ['zone-1'], restrictMounts: true })];
  const copy = duplicateConstraintGroup(groups, [], 'cg-1')!;
  assert.deepEqual(copy.group.zoneIds, ['zone-1']);
  assert.equal(copy.group.restrictMounts, true);
  assert.notEqual(copy.group.zoneIds, groups[0].zoneIds);
});

// --- Persistence (§9) --------------------------------------------------------

function fileWith(groupJson: Record<string, unknown>) {
  return {
    formatVersion: 3,
    geometry: [],
    cameras: [],
    probes: [],
    sections: [],
    zones: [{ id: 'zone-1', name: 'Dock' }],
    volumes: [{ id: 'volume-1', zoneId: 'zone-1', position: [0, 0, 0], rotation: IDENTITY, size: [2, 2, 2] }],
    useZones: true,
    constraintGroups: [
      {
        id: 'cg-1',
        name: 'Dock',
        fov: 60,
        far: 30,
        poolSize: 200,
        maxCount: 10,
        trials: 1000,
        epsilon: 1,
        seed: 1,
        ...groupJson,
      },
    ],
    constraints: [],
  };
}

test('the three keys are optional at formatVersion 3, and default to the old behaviour', () => {
  // A v3 file written before the feature: no bump, still reads, and the defaults
  // reproduce exactly what it used to do.
  const parsed = parseSceneFile(fileWith({}));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const g = parsed.scene.constraintGroups[0];
  assert.deepEqual(g.zoneIds, []);
  assert.equal(g.restrictScoring, true);
  assert.equal(g.restrictMounts, false);
});

test('a dangling zoneId is dropped, not rejected (§9)', () => {
  // The same treatment `parseVolumes` gives an orphan volume: a scene that
  // legitimately lost a zone through editing must still reload.
  const parsed = parseSceneFile(fileWith({ zoneIds: ['zone-1', 'zone-404', 'zone-1'] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.scene.constraintGroups[0].zoneIds, ['zone-1']);
});

test('a malformed zoneIds or flag is an error, not a silent default', () => {
  assert.equal(parseSceneFile(fileWith({ zoneIds: 'zone-1' })).ok, false);
  assert.equal(parseSceneFile(fileWith({ restrictMounts: 'yes' })).ok, false);
  assert.equal(parseSceneFile(fileWith({ restrictScoring: 1 })).ok, false);
});

test('the target round-trips through serialize . parse', () => {
  const doc0 = fileWith({ zoneIds: ['zone-1'], restrictScoring: false, restrictMounts: true });
  const parsed = parseSceneFile(doc0);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const out = serializeScene(parsed.scene).constraintGroups[0] as unknown as ConstraintGroup;
  assert.deepEqual(out.zoneIds, ['zone-1']);
  assert.equal(out.restrictScoring, false);
  assert.equal(out.restrictMounts, true);
});


// --- What App renders through (§3.1.2, §5, §10) ------------------------------

/** The app's own marked set — deliberately unlike any target, so a mix-up shows. */
const APP: AppMarkedSet = {
  filter: markedFilterForZones(VOLUMES, ['zone-1']),
  total: 1_000,
  revision: 'app-rev',
};

const SCENE = {
  zones: ZONES,
  volumes: VOLUMES,
  validVoxels: (id: string) => ({ 'zone-1': 100, 'zone-2': 20, 'zone-3': 3 })[id] ?? 0,
};

test('an empty list resolves to the app’s own marked set, untouched (§3.1.2)', () => {
  // The pre-feature behaviour exactly: a scene not using the feature must be
  // bit-identical, which is what makes both flags safe to default.
  const t = resolveGroupTarget(group({ zoneIds: [] }), SCENE, APP);
  assert.equal(t.filter, APP.filter);
  assert.equal(t.total, APP.total);
  assert.equal(t.markedRevision, APP.revision);
  assert.deepEqual(t.zoneNames, []);
  assert.deepEqual(t.mountVolumes, []);
  assert.equal(t.mountRevision, '');

  // Both flags are inert with no list — not "on but empty".
  const flagged = resolveGroupTarget(
    group({ zoneIds: [], restrictScoring: true, restrictMounts: true }),
    SCENE,
    APP,
  );
  assert.deepEqual(flagged, t);
});

test('the filter and the denominator always come from the same resolution (§3.1.2)', () => {
  // The failure this pairing exists to prevent: the listed zones' score over the
  // enabled zones' denominator, a percentage of the wrong thing that nothing on
  // screen would look wrong about.
  const t = resolveGroupTarget(group({ zoneIds: ['zone-2', 'zone-3'] }), SCENE, APP);
  assert.deepEqual(t.filter, markedFilterForZones(VOLUMES, ['zone-2', 'zone-3']));
  assert.equal(t.total, 23, 'the listed zones’ own validVoxels, disabled ones included');
  assert.deepEqual(t.zoneNames.length, 2, 'the axis names what the denominator is');
  assert.notEqual(t.markedRevision, APP.revision, 'a targeted pool turns on its own zones');
});

test('restrictScoring off keeps the app’s numbers while restrictMounts still binds', () => {
  // "Mount inside the bay, but score against the marked set" is a sentence a user
  // can mean, so the two flags are honoured separately.
  const t = resolveGroupTarget(
    group({ zoneIds: ['zone-3'], restrictScoring: false, restrictMounts: true }),
    SCENE,
    APP,
  );
  assert.equal(t.filter, APP.filter);
  assert.equal(t.total, APP.total);
  assert.equal(t.markedRevision, APP.revision);
  assert.deepEqual(t.zoneNames, [], 'no target set, so nothing to disclose on the axis');
  assert.deepEqual(t.mountVolumes.map((v) => v.id), ['volume-3']);
  assert.notEqual(t.mountRevision, '', 'the mount filter still moves the fingerprint');
});

test('a dead id resolves as no target rather than as an empty one (§3.1.2)', () => {
  const t = resolveGroupTarget(group({ zoneIds: ['zone-404'] }), SCENE, APP);
  assert.equal(t.total, APP.total, 'never a denominator of zero');
  assert.equal(t.filter, APP.filter);
});

// --- The gizmo dimming and its text cue (§5, §4.1.1) -------------------------

const con = (id: string, position: Vec3): CameraConstraint => ({
  id,
  groupId: 'cg-1',
  name: '',
  enabled: true,
  distance: 0,
  kind: 'point',
  position,
});

test('constraintOverlaps names only zero-overlap constraints, and only under a filter', () => {
  // `zone-3`'s volume is a 2 m cube at [20,0,0]; `inside` sits in it, `outside`
  // is 20 m away with `distance: 0`, so no draw of its can ever land in the zone.
  const inside = con('con-in', [20, 0, 0]);
  const outside = con('con-out', [0, 0, 0]);
  const cs = [inside, outside];
  const g = group({ zoneIds: ['zone-3'], restrictMounts: true });

  const overlaps = constraintOverlaps(g, cs, VOLUMES);
  assert.deepEqual(
    overlaps.map((o) => [o.constraintId, o.fraction > 0]),
    [['con-in', true], ['con-out', false]],
  );
  assert.deepEqual([...unmountableIds(overlaps)], ['con-out']);

  // No mount filter, nothing to say — and the shared empty set, so the view does
  // not churn on a fresh object every render.
  assert.deepEqual(constraintOverlaps(group({ zoneIds: ['zone-3'] }), cs, VOLUMES), []);
  assert.equal(unmountableIds(constraintOverlaps(null, cs, VOLUMES)), NO_UNMOUNTABLE);

  // `restrictMounts` with an empty list is inert here too — a caller that tested
  // the flag alone would paint every constraint of an untargeted group as dead.
  assert.deepEqual(constraintOverlaps(group({ restrictMounts: true }), cs, VOLUMES), []);
});

test('a group only judges its own constraints, and only the enabled ones', () => {
  const g = group({ zoneIds: ['zone-3'], restrictMounts: true });
  const cs = [
    { ...con('mine', [0, 0, 0]) },
    { ...con('disabled', [0, 0, 0]), enabled: false },
    { ...con('theirs', [0, 0, 0]), groupId: 'cg-2' },
  ];
  assert.deepEqual(constraintOverlaps(g, cs, VOLUMES).map((o) => o.constraintId), ['mine']);
});

// --- §10's regenerate row ----------------------------------------------------

test('the regenerate notice counts only the groups that held a target (§7, §10)', () => {
  assert.equal(regeneratedTargetsNotice([group({ zoneIds: [] })]), null);
  assert.match(
    regeneratedTargetsNotice([group({ zoneIds: ['zone-1'] }), group({ zoneIds: [] })])!,
    /Zones were regenerated; 1 constraint group\(s\) lost their target zones\./,
  );
  assert.match(
    regeneratedTargetsNotice([group({ zoneIds: ['zone-1'] }), group({ zoneIds: ['zone-3'] })])!,
    /2 constraint group\(s\)/,
  );
});
