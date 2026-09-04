import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_FILE_FORMAT_VERSION,
  isSafeAssetPath,
  parseSceneFile,
  resolveSectionFootprints,
  serializeScene,
  type SceneFileJSON,
} from '../src/scene/sceneFile.ts';

function validDoc(): SceneFileJSON {
  return {
    formatVersion: 3,
    geometry: [
      {
        kind: 'room',
        halfX: 10,
        halfZ: 10,
        height: 6,
        thickness: 0.3,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      {
        kind: 'box',
        min: [-7, 0, -7],
        max: [-4, 2.5, -4],
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      {
        kind: 'gltf',
        src: 'assets/shelf.glb',
        position: [2, 0, 3],
        rotation: [0, 0.707, 0, 0.707],
        scale: [1, 1, 1],
      },
    ],
    cameras: [
      // Bound to con-1 (`camera_placement.md` §6.3) — provenance plus the clamp,
      // and the reference the reader checks once the constraints are parsed.
      {
        id: 'cam-1',
        position: [-6, 5.4, -9.6],
        rotation: [0, 0, 0, 1],
        fov: 60,
        aspect: 1.7778,
        near: 0.1,
        far: 30,
        constraintId: 'con-1',
      },
    ],
    probes: [{ id: 'probe-1', position: [0, 1, 0] }],
    sections: [
      {
        id: 'section-1',
        orientation: 'horizontal',
        min: 0,
        max: 2,
        minA: -10,
        maxA: 10,
        minB: -10,
        maxB: 10,
        aggregation: 'mean',
        enabled: true,
        clipRange: 3,
      },
    ],
    clipSectionId: 'section-1',
    zones: [{ id: 'zone-1', name: 'West wing', enabled: true }],
    volumes: [
      { id: 'volume-1', zoneId: 'zone-1', position: [3, 1.5, -2], rotation: [0, 0.259, 0, 0.966], size: [4, 3, 6] },
    ],
    useZones: true,
    constraintGroups: [
      {
        id: 'cg-1',
        name: 'Dock',
        enabled: true,
        fov: 60,
        far: 30,
        namePrefix: 'Dock',
        poolSize: 200,
        maxCount: 10,
        trials: 1000,
        epsilon: 1,
        seed: 1,
      },
    ],
    constraints: [
      {
        id: 'con-1',
        groupId: 'cg-1',
        name: 'Gantry rail',
        enabled: true,
        kind: 'polyline',
        distance: 0.4,
        points: [
          [-9, 5.4, -9],
          [-9, 5.4, 9],
          [9, 5.4, 9],
        ],
      },
      {
        id: 'con-2',
        groupId: 'cg-1',
        name: 'North wall',
        enabled: true,
        kind: 'plane',
        distance: 0.3,
        position: [0, 4, -9.6],
        rotation: [0, 0, 0, 1],
        size: [18, 3],
      },
    ],
  };
}

// --- camera placement (`camera_placement.md` §9) -----------------------------

test('constraint groups and constraints round-trip, strategy included (§9)', () => {
  const parsed = parseSceneFile(validDoc());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const [group] = parsed.scene.constraintGroups;
  // The pool size and the whole strategy persist, which is the point of a seeded analysis: a
  // file that records the output without its inputs cannot be re-run (§9).
  assert.equal(group.poolSize, 200);
  assert.equal(group.trials, 1000);
  assert.equal(group.seed, 1);
  assert.equal(group.far, 30);
  assert.equal(parsed.scene.constraints.length, 2);
  assert.equal(parsed.scene.cameras[0].constraintId, 'con-1');
});

test('parseSceneFile rejects a constraint whose groupId references no group (§14.8)', () => {
  const doc = validDoc();
  doc.constraints = [{ ...doc.constraints[0], groupId: 'cg-999' }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a camera bound to a constraint that does not exist (§14.8)', () => {
  // A dangling binding would read as an unclamped camera the user believes is
  // on a rail — silently, since nothing else about it looks wrong (§6.3).
  const doc = validDoc();
  doc.cameras = [{ ...doc.cameras[0], constraintId: 'con-999' }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a malformed constraint or strategy (§9)', () => {
  const bad = (mutate: (doc: SceneFileJSON) => void) => {
    const doc = validDoc();
    mutate(doc);
    return parseSceneFile(doc).ok;
  };
  assert.equal(bad((d) => { d.constraints[0] = { ...d.constraints[0], kind: 'blob' as never }; }), false);
  assert.equal(bad((d) => { d.constraints[0] = { ...d.constraints[0], distance: -1 }; }), false);
  assert.equal(bad((d) => { d.constraints[0] = { ...d.constraints[0], kind: 'polyline', points: [[0, 0, 0]] } as never; }), false);
  assert.equal(bad((d) => { d.constraints[1] = { ...d.constraints[1], kind: 'plane', size: [0, 3] } as never; }), false);
  assert.equal(bad((d) => { d.constraintGroups[0] = { ...d.constraintGroups[0], fov: 200 }; }), false);
  assert.equal(bad((d) => { d.constraintGroups[0] = { ...d.constraintGroups[0], far: 0 }; }), false);
  assert.equal(bad((d) => { d.constraintGroups[0] = { ...d.constraintGroups[0], poolSize: 0 }; }), false);
  assert.equal(bad((d) => { d.constraintGroups[0] = { ...d.constraintGroups[0], seed: 1.5 }; }), false);
  assert.equal(bad((d) => { d.constraintGroups[0] = { ...d.constraintGroups[0], id: 'cg-1', name: 'dup' }; }), true);
});

test("a group's legacy aspect/near are read past, not validated or kept (§9)", () => {
  // Both were persisted before they became placement-wide constants
  // (`camera_placement.md` §3.1.1). A file written by the older build must still
  // load — including with values the old reader would have rejected — and the
  // group it produces must carry neither key back out.
  const doc = validDoc();
  doc.constraintGroups[0] = { ...doc.constraintGroups[0], aspect: 0, near: 40 } as never;
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const group = result.scene.constraintGroups[0];
  assert.equal('aspect' in group, false);
  assert.equal('near' in group, false);
  assert.equal(group.far, 30);
  const written = serializeScene(result.scene).constraintGroups[0] as Record<string, unknown>;
  assert.equal('aspect' in written, false);
  assert.equal('near' in written, false);
});

test('duplicate constraint ids are rejected (§14.8)', () => {
  const doc = validDoc();
  doc.constraints = [doc.constraints[0], { ...doc.constraints[1], id: 'con-1' }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile accepts a well-formed document (spec §14.3 sketch)', () => {
  const result = parseSceneFile(validDoc());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.geometry.length, 3);
  assert.equal(result.scene.cameras.length, 1);
  assert.equal(result.scene.probes.length, 1);
  assert.equal(result.scene.sections.length, 1);
  assert.equal(result.scene.zones.length, 1);
  assert.equal(result.scene.volumes.length, 1);
  assert.equal(result.scene.useZones, true);
});

test('serializeScene . parseSceneFile round-trips', () => {
  const doc = validDoc();
  const parsed = parseSceneFile(doc);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const reserialized = serializeScene(parsed.scene);
  assert.deepEqual(reserialized, doc);
});

test('array order is the hierarchy order and round-trips verbatim (spec §5.5.1, §14.3)', () => {
  const doc = validDoc();
  doc.cameras = [
    { ...doc.cameras[0], id: 'cam-1' },
    { ...doc.cameras[0], id: 'cam-2' },
    { ...doc.cameras[0], id: 'cam-3' },
  ];
  // A zone-interleaved volumes array — what appending on create produces (§14.3).
  doc.zones = [
    { id: 'zone-1', name: 'West wing', enabled: true },
    { id: 'zone-2', name: 'East wing', enabled: true },
  ];
  doc.volumes = [
    { ...doc.volumes[0], id: 'volume-1', zoneId: 'zone-1' },
    { ...doc.volumes[0], id: 'volume-2', zoneId: 'zone-2' },
    { ...doc.volumes[0], id: 'volume-3', zoneId: 'zone-1' },
  ];

  const parsed = parseSceneFile(doc);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // Read preserves order — including the interleaving.
  assert.deepEqual(parsed.scene.cameras.map((c) => c.id), ['cam-1', 'cam-2', 'cam-3']);
  assert.deepEqual(parsed.scene.volumes.map((v) => v.id), ['volume-1', 'volume-2', 'volume-3']);

  // A reorder (as the reducer performs it) survives a write/read cycle, so no
  // separate order field is needed.
  const reordered = {
    ...parsed.scene,
    cameras: [parsed.scene.cameras[2], parsed.scene.cameras[0], parsed.scene.cameras[1]],
  };
  const reread = parseSceneFile(serializeScene(reordered));
  assert.equal(reread.ok, true);
  if (!reread.ok) return;
  assert.deepEqual(reread.scene.cameras.map((c) => c.id), ['cam-3', 'cam-1', 'cam-2']);
  assert.deepEqual(reread.scene.volumes.map((v) => v.id), ['volume-1', 'volume-2', 'volume-3']);
});

test('parseSceneFile leaves a missing footprint as NaN; resolveSectionFootprints defaults it to full extent (spec §14.3)', () => {
  const doc = validDoc();
  // A file written before finite footprints: no minA/maxA/minB/maxB.
  delete (doc.sections[0] as Record<string, unknown>).minA;
  delete (doc.sections[0] as Record<string, unknown>).maxA;
  delete (doc.sections[0] as Record<string, unknown>).minB;
  delete (doc.sections[0] as Record<string, unknown>).maxB;
  const parsed = parseSceneFile(doc);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const before = parsed.scene.sections[0];
  assert.equal(Number.isNaN(before.minA), true);
  assert.equal(Number.isNaN(before.maxB), true);
  // Resolved against the workspace AABB → full extent on both in-plane axes
  // (horizontal spans X×Z).
  const [resolved] = resolveSectionFootprints(parsed.scene.sections, [-10, -3, -8], [10, 5, 8]);
  assert.equal(resolved.minA, -10);
  assert.equal(resolved.maxA, 10);
  assert.equal(resolved.minB, -8);
  assert.equal(resolved.maxB, 8);
});

test('resolveSectionFootprints leaves a fully-specified footprint untouched (spec §14.3)', () => {
  const parsed = parseSceneFile(validDoc());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const [resolved] = resolveSectionFootprints(parsed.scene.sections, [-10, -3, -8], [10, 5, 8]);
  // validDoc's section carries an explicit ±10 footprint — kept, not overwritten.
  assert.equal(resolved.minA, -10);
  assert.equal(resolved.maxA, 10);
  assert.equal(resolved.minB, -10);
  assert.equal(resolved.maxB, 10);
});

test('parseSceneFile rejects non-object JSON', () => {
  assert.equal(parseSceneFile([1, 2, 3]).ok, false);
  assert.equal(parseSceneFile('hello').ok, false);
  assert.equal(parseSceneFile(null).ok, false);
});

test('parseSceneFile rejects an unknown/newer formatVersion (spec §14.8)', () => {
  const result = parseSceneFile({ ...validDoc(), formatVersion: 4 });
  assert.equal(result.ok, false);
  assert.equal(parseSceneFile({ ...validDoc(), formatVersion: 0 }).ok, false);
});

test('parseSceneFile reads a v2 document with no constraint groups (§14.8)', () => {
  // v2 predates camera placement, so both arrays read empty
  // (`camera_placement.md` §9) — the same back-compat rule v1 got for zones.
  const doc = validDoc();
  const v2: Record<string, unknown> = {
    ...doc,
    formatVersion: 2,
    cameras: doc.cameras.map(({ constraintId: _drop, ...rest }) => rest),
  };
  delete v2.constraintGroups;
  delete v2.constraints;
  const result = parseSceneFile(v2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.scene.constraintGroups, []);
  assert.deepEqual(result.scene.constraints, []);
});

test('parseSceneFile reads a v1 document with empty zones/volumes, useZones false (§14.8)', () => {
  const doc = validDoc();
  const v1: Record<string, unknown> = { ...doc, formatVersion: 1 };
  delete v1.zones;
  delete v1.volumes;
  delete v1.useZones;
  const result = parseSceneFile(v1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.scene.zones, []);
  assert.deepEqual(result.scene.volumes, []);
  assert.equal(result.scene.useZones, false);
});

test('serializeScene always writes the current formatVersion (§14.3)', () => {
  // A v1 file read and written back comes out at the current version: the writer
  // has one output format, so an old file is upgraded rather than preserved.
  const doc = validDoc();
  const parsed = parseSceneFile({ ...doc, formatVersion: 1, zones: undefined, volumes: undefined, useZones: undefined });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(serializeScene(parsed.scene).formatVersion, SCENE_FILE_FORMAT_VERSION);
  assert.equal(SCENE_FILE_FORMAT_VERSION, 3);
});

test('parseSceneFile rejects a volume whose zoneId references no zone (§14.8)', () => {
  const doc = validDoc();
  doc.volumes = [{ ...doc.volumes[0], zoneId: 'zone-999' }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a volume with a non-positive size component (§14.8)', () => {
  const doc = validDoc();
  doc.volumes = [{ ...doc.volumes[0], size: [4, 0, 6] }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects duplicate zone / volume ids (§14.8)', () => {
  const dupZone = validDoc();
  dupZone.zones = [...dupZone.zones, { id: 'zone-1', name: 'East wing', enabled: true }];
  assert.equal(parseSceneFile(dupZone).ok, false);

  const dupVol = validDoc();
  dupVol.volumes = [...dupVol.volumes, { ...dupVol.volumes[0] }];
  assert.equal(parseSceneFile(dupVol).ok, false);
});

test('parseSceneFile falls back a blank/missing zone name to the default Zone N (§6.2)', () => {
  const doc = validDoc();
  doc.zones = [{ id: 'zone-1', name: '   ' } as never, { id: 'zone-2' } as never];
  doc.volumes = [{ ...doc.volumes[0], zoneId: 'zone-1' }];
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.zones[0].name, 'Zone 1');
  assert.equal(result.scene.zones[1].name, 'Zone 2');
});

test('parseSceneFile reads camera/probe/section names, trimming them; blank/missing → "" (spec §5.6, §14.3)', () => {
  const doc = validDoc();
  doc.cameras[0].name = '  Front door  ';
  doc.sections[0].name = 'Ground floor';
  // probe-1 keeps no `name` key (validDoc leaves it absent).
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.cameras[0].name, 'Front door'); // trimmed on read
  assert.equal(result.scene.sections[0].name, 'Ground floor');
  assert.equal(result.scene.probes[0].name, ''); // missing → blank (displays as Probe N)
});

test('serializeScene omits blank names and writes named entities trimmed (spec §5.6, §14.3)', () => {
  const parsed = parseSceneFile(validDoc());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // Name one camera; leave probe/section blank.
  parsed.scene.cameras[0].name = '  Front door  ';
  const out = serializeScene(parsed.scene);
  assert.equal(out.cameras[0].name, 'Front door'); // trimmed, written
  assert.equal('name' in out.probes[0], false); // blank → omitted
  assert.equal('name' in out.sections[0], false); // blank → omitted
});

test('zone.enabled defaults to true when absent and round-trips when set (§7.3)', () => {
  const doc = validDoc();
  doc.zones = [{ id: 'zone-1', name: 'A' } as never, { id: 'zone-2', name: 'B', enabled: false }];
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.zones[0].enabled, true); // absent -> default true
  assert.equal(result.scene.zones[1].enabled, false);
});

test('camera.enabled defaults to true when absent and round-trips when set (§5.4, §14.3)', () => {
  const doc = validDoc();
  doc.cameras = [
    { id: 'cam-1', position: [0, 1, 0], rotation: [0, 0, 0, 1], fov: 60 }, // no enabled key
    { id: 'cam-2', position: [1, 1, 0], rotation: [0, 0, 0, 1], fov: 60, enabled: false } as never,
  ];
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.cameras[0].enabled, true); // absent → default true
  assert.equal(result.scene.cameras[1].enabled, false);
});

test('serializeScene omits camera.enabled when true and writes it only when false (§14.3 omit-on-write)', () => {
  const parsed = parseSceneFile({
    ...validDoc(),
    cameras: [
      { id: 'cam-1', position: [0, 1, 0], rotation: [0, 0, 0, 1], fov: 60 },
      { id: 'cam-2', position: [1, 1, 0], rotation: [0, 0, 0, 1], fov: 60, enabled: false },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const out = serializeScene(parsed.scene);
  assert.equal('enabled' in out.cameras[0], false); // enabled (default) → omitted
  assert.equal(out.cameras[1].enabled, false); // disabled → written
});

test('parseSceneFile rejects a non-boolean camera enabled (§14.8)', () => {
  const doc = validDoc();
  doc.cameras = [{ id: 'cam-1', position: [0, 1, 0], rotation: [0, 0, 0, 1], fov: 60, enabled: 'yes' } as never];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile reads a legacy section "visible" key as enabled (§14.3 back-compat)', () => {
  const doc = validDoc();
  doc.sections = [{ id: 'section-1', orientation: 'horizontal', min: 0, max: 2, aggregation: 'mean', visible: false } as never];
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.sections[0].enabled, false);
});

test('parseSceneFile defaults absent section clipRange and clipSectionId (§13.9 back-compat)', () => {
  const doc = validDoc();
  doc.sections = [{ id: 'section-1', orientation: 'horizontal', min: 0, max: 2, aggregation: 'mean', enabled: true } as never];
  delete (doc as { clipSectionId?: unknown }).clipSectionId;
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.sections[0].clipRange, 2);
  assert.equal(result.scene.clipSectionId, null);
});

test('parseSceneFile round-trips clipRange and clipSectionId (§13.9)', () => {
  const doc = validDoc();
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.sections[0].clipRange, 3);
  assert.equal(result.scene.clipSectionId, 'section-1');
});

test('parseSceneFile coerces a clipSectionId that names no section to null (§13.9)', () => {
  const doc = validDoc();
  doc.clipSectionId = 'does-not-exist';
  const result = parseSceneFile(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scene.clipSectionId, null);
});

test('parseSceneFile rejects an unknown geometry kind (spec §14.8)', () => {
  const doc = validDoc();
  doc.geometry = [{ ...doc.geometry[1], kind: 'cylinder' } as never];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a duplicate id within cameras (spec §14.8)', () => {
  const doc = validDoc();
  doc.cameras = [...doc.cameras, { ...doc.cameras[0] }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a duplicate id within probes (spec §14.8)', () => {
  const doc = validDoc();
  doc.probes = [...doc.probes, { ...doc.probes[0] }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile rejects a duplicate id within sections (spec §14.8)', () => {
  const doc = validDoc();
  doc.sections = [...doc.sections, { ...doc.sections[0] }];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('parseSceneFile allows the same id reused across different categories', () => {
  const doc = validDoc();
  doc.probes = [{ id: 'cam-1', position: [0, 1, 0] }];
  assert.equal(parseSceneFile(doc).ok, true);
});

test('parseSceneFile rejects an unsafe gltf src (spec §14.2, §14.8)', () => {
  for (const src of ['/etc/passwd', '../outside.glb', 'assets/../../escape.glb', 'https://example.com/a.glb', 'file:///a.glb', 'C:\\a.glb']) {
    const doc = validDoc();
    doc.geometry = [{ ...doc.geometry[2], src } as never];
    assert.equal(parseSceneFile(doc).ok, false, `expected "${src}" to be rejected`);
  }
});

test('parseSceneFile rejects a geometry object missing position/rotation/scale', () => {
  const doc = validDoc();
  const { position: _position, ...rest } = doc.geometry[1] as Record<string, unknown>;
  doc.geometry = [rest as never];
  assert.equal(parseSceneFile(doc).ok, false);
});

test('isSafeAssetPath accepts plain relative paths', () => {
  assert.equal(isSafeAssetPath('assets/shelf.glb'), true);
  assert.equal(isSafeAssetPath('assets/sub/dir/shelf.glb'), true);
});

test('isSafeAssetPath rejects absolute paths, URLs, and traversal', () => {
  assert.equal(isSafeAssetPath('/assets/shelf.glb'), false);
  assert.equal(isSafeAssetPath('../shelf.glb'), false);
  assert.equal(isSafeAssetPath('assets/../shelf.glb'), false);
  assert.equal(isSafeAssetPath('http://evil.example/shelf.glb'), false);
  assert.equal(isSafeAssetPath('data:model/gltf-binary;base64,AAAA'), false);
  assert.equal(isSafeAssetPath('C:\\shelf.glb'), false);
  assert.equal(isSafeAssetPath(''), false);
});

test('camera.aimLocked is absent-means-false, round-trips, and is omitted when false (aim_optimization.md §9)', () => {
  const doc = validDoc();
  doc.cameras = [
    { id: 'cam-1', position: [0, 1, 0], rotation: [0, 0, 0, 1], fov: 60 }, // no aimLocked key
    { id: 'cam-2', position: [1, 1, 0], rotation: [0, 0, 0, 1], fov: 60, aimLocked: true } as never,
  ];
  const parsed = parseSceneFile(doc);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.scene.cameras[0].aimLocked, undefined);
  assert.equal(parsed.scene.cameras[1].aimLocked, true);

  // Only the locked one carries the key on write, so a default scene file is
  // unchanged by the feature existing — which is why §9 needs no version bump.
  const out = serializeScene(parsed.scene);
  assert.equal('aimLocked' in out.cameras[0], false);
  assert.equal(out.cameras[1].aimLocked, true);

  const reread = parseSceneFile(out);
  assert.equal(reread.ok, true);
  if (!reread.ok) return;
  assert.equal(reread.scene.cameras[1].aimLocked, true);
});

test('camera.aimLocked must be a boolean (aim_optimization.md §9)', () => {
  const doc = validDoc();
  doc.cameras = [
    { id: 'cam-1', position: [0, 1, 0], rotation: [0, 0, 0, 1], fov: 60, aimLocked: 'yes' } as never,
  ];
  const parsed = parseSceneFile(doc);
  assert.equal(parsed.ok, false);
});
