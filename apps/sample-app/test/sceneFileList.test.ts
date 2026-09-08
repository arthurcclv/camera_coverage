import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSceneFileRow,
  moveListSelection,
  nextListSelection,
  planSceneFileList,
  type SceneFileEntry,
} from '../src/scene/sceneFileList.ts';
import { SCENE_FILE_PARSE_CAP } from '../src/scene/saveTarget.ts';

/** The smallest document `parseSceneFile` accepts (spec §14.3). */
function sceneDoc(cameras = 2, probes = 1): string {
  return JSON.stringify({
    formatVersion: 3,
    geometry: [],
    cameras: Array.from({ length: cameras }, (_, i) => ({
      id: `cam-${i}`,
      position: [0, 2, 0],
      rotation: [0, 0, 0, 1],
      fov: 60,
      aspect: 1.7778,
      near: 0.1,
      far: 30,
    })),
    probes: Array.from({ length: probes }, (_, i) => ({ id: `probe-${i}`, position: [0, 1, 0] })),
    sections: [],
    clipSectionId: null,
    zones: [],
    volumes: [],
    useZones: false,
    constraintGroups: [],
    constraints: [],
  });
}

// --- What gets listed, and in what order (spec §14.4) ---

test('only root `*.json` is listed, dotfiles excluded (spec §14.2, §14.4)', () => {
  const planned = planSceneFileList(['scene.json', 'notes.txt', 'site.glb', '.hidden.json']);
  assert.deepEqual(
    planned.map((p) => p.name),
    ['scene.json'],
  );
});

test('the list is case-insensitive alphabetical, so variants do not reshuffle (spec §14.4)', () => {
  // Scanned by eye: a folder's files must sit in the same place every opening.
  const planned = planSceneFileList(['Zulu.json', 'alpha.json', 'Bravo.json', 'scene.json']);
  assert.deepEqual(
    planned.map((p) => p.name),
    ['alpha.json', 'Bravo.json', 'scene.json', 'Zulu.json'],
  );
});

test(`only the first ${SCENE_FILE_PARSE_CAP} files are read; the rest validate on selection (spec §14.4)`, () => {
  const names = Array.from({ length: SCENE_FILE_PARSE_CAP + 3 }, (_, i) => `s${String(i).padStart(4, '0')}.json`);
  const planned = planSceneFileList(names);
  assert.equal(planned.length, names.length);
  assert.equal(planned.filter((p) => p.parse).length, SCENE_FILE_PARSE_CAP);
  // The cap applies to the *ordered* list, so which files get read is stable too.
  assert.equal(planned[SCENE_FILE_PARSE_CAP - 1].parse, true);
  assert.equal(planned[SCENE_FILE_PARSE_CAP].parse, false);
});

// --- What each row says (spec §14.4, §14.7) ---

test('a valid scene file summarizes its cameras and probes (spec §14.4)', () => {
  assert.deepEqual(describeSceneFileRow(sceneDoc(96, 12)), { summary: '96 cams · 12 probes', error: null });
});

test('an unreadable file lists with a reason rather than vanishing (spec §14.8)', () => {
  assert.deepEqual(describeSceneFileRow(null), { summary: null, error: 'could not be read' });
});

test('a `*.json` that is not JSON at all lists its reason (spec §14.8)', () => {
  assert.deepEqual(describeSceneFileRow('{ not json'), { summary: null, error: 'not valid JSON' });
});

test("a stray `package.json` is visibly excluded, not mysteriously absent (spec §14.4)", () => {
  const row = describeSceneFileRow(JSON.stringify({ name: 'my-app', version: '1.0.0' }));
  assert.equal(row.summary, null);
  assert.ok(row.error != null && row.error.length > 0, 'the schema error is the row is its reason');
});

// --- Which row the selection sits on (spec §14.7) ---

const entry = (name: string, error: string | null = null): SceneFileEntry => ({ name, summary: null, error });

test('the target file opens selected when it is loadable in this folder (spec §14.7)', () => {
  const entries = [entry('a.json'), entry('scene.json'), entry('z.json')];
  assert.equal(nextListSelection(entries, 'scene.json'), 'scene.json');
});

test('a folder that is not the target’s opens on its first loadable row (spec §14.7)', () => {
  // No preferred file — the commit key still needs a subject.
  const entries = [entry('broken.json', 'not valid JSON'), entry('a.json'), entry('z.json')];
  assert.equal(nextListSelection(entries, null), 'a.json');
  // Same when the preferred name is absent, or present but unselectable.
  assert.equal(nextListSelection(entries, 'scene.json'), 'a.json');
  assert.equal(nextListSelection(entries, 'broken.json'), 'a.json');
});

test('nothing is selected when nothing in the folder can be loaded (spec §14.8)', () => {
  assert.equal(nextListSelection([entry('broken.json', 'not valid JSON')], 'broken.json'), null);
  assert.equal(nextListSelection([], 'scene.json'), null);
});

test('arrow keys walk the loadable rows and clamp at both ends (spec §14.7)', () => {
  const loadable = ['a.json', 'b.json', 'c.json'];
  assert.equal(moveListSelection(loadable, 'a.json', 1), 'b.json');
  assert.equal(moveListSelection(loadable, 'b.json', -1), 'a.json');
  // Clamped, not wrapped: holding a key cannot cycle past the file you aimed for.
  assert.equal(moveListSelection(loadable, 'c.json', 1), 'c.json');
  assert.equal(moveListSelection(loadable, 'a.json', -1), 'a.json');
});

test('arrowing with nothing selected lands on the first loadable row (spec §14.7)', () => {
  assert.equal(moveListSelection(['a.json', 'b.json'], null, 1), 'a.json');
  // An unselectable row is not in the walk, so a selection outside it starts over.
  assert.equal(moveListSelection(['a.json', 'b.json'], 'broken.json', -1), 'a.json');
  assert.equal(moveListSelection([], null, 1), null);
});
