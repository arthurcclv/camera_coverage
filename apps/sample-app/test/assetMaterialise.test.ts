/**
 * The save's materialise plan (`asset_import.md` §8.3–§8.6) — what would be
 * written, what would be replaced, and above all what must be **refused**.
 *
 * §8.5's folder replace is the only irreversible operation in this app, and its
 * path is derived from a picked file's basename, so its guardrails are asserted
 * here rather than reviewed (`ai/CONVENTIONS.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planMaterialisation,
  pendingPaths,
  rewriteSrc,
  type AssetDirEntry,
  type MaterialiseInput,
} from '../src/scene/assetMaterialise.ts';
import { addPending, noPendingAssets } from '../src/scene/pendingAssets.ts';

function input(over: Partial<MaterialiseInput> = {}): MaterialiseInput {
  return {
    pending: [{ src: 'assets/rack/rack.gltf', paths: ['assets/rack/rack.gltf'] }],
    deduped: new Map(),
    assetDir: [],
    sceneSrcs: ['assets/rack/rack.gltf'],
    ...over,
  };
}

/** The plan, asserted to have succeeded. */
function ok(plan: ReturnType<typeof planMaterialisation>) {
  assert.equal(plan.ok, true, plan.ok ? '' : plan.reason.key);
  return plan as Extract<typeof plan, { ok: true }>;
}

test('a fresh import writes its own folder and replaces nothing (§8.7)', () => {
  const plan = ok(planMaterialisation(input()));
  assert.deepEqual(plan.writes, [
    { src: 'assets/rack/rack.gltf', paths: ['assets/rack/rack.gltf'], folder: 'assets/rack', replaces: false },
  ]);
  assert.deepEqual([...plan.rewrites], []);
  assert.deepEqual(plan.replaced, []);
});

test('a multi-file model writes its dependencies at their own paths (§5.1, §8.7)', () => {
  const paths = ['assets/rack/rack.gltf', 'assets/rack/rack.bin', 'assets/rack/textures/wall.png'];
  const plan = ok(planMaterialisation(input({ pending: [{ src: paths[0], paths }] })));
  assert.deepEqual(plan.writes[0].paths, paths);
});

test('a file already in assets/ writes nothing and re-points its row (§8.3)', () => {
  const plan = ok(
    planMaterialisation(
      input({ deduped: new Map([['assets/rack/rack.gltf', 'assets/site/rack.gltf']]) }),
    ),
  );
  assert.deepEqual(plan.writes, []);
  assert.deepEqual([...plan.rewrites], [['assets/rack/rack.gltf', 'assets/site/rack.gltf']]);
});

test('a dedupe onto the very path the row already carries rewrites nothing', () => {
  const plan = ok(
    planMaterialisation(
      input({ deduped: new Map([['assets/rack/rack.gltf', 'assets/rack/rack.gltf']]) }),
    ),
  );
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.rewrites.size, 0);
});

test('a deduped asset cannot collide, because it is settled before collisions are (§8.3)', () => {
  // Order matters: dedupe first. A pending asset that turns out to be the file
  // already sitting in `assets/rack/` must not then be reported as replacing it.
  const plan = ok(
    planMaterialisation(
      input({
        deduped: new Map([['assets/rack/rack.gltf', 'assets/rack/rack.gltf']]),
        assetDir: [{ name: 'rack', kind: 'directory' }],
      }),
    ),
  );
  assert.deepEqual(plan.replaced, []);
  assert.deepEqual(plan.writes, []);
});

test('an existing folder of the same name is a replacement, named for the confirmation (§8.4)', () => {
  const plan = ok(planMaterialisation(input({ assetDir: [{ name: 'rack', kind: 'directory' }] })));
  assert.equal(plan.writes[0].replaces, true);
  assert.deepEqual(plan.replaced, ['assets/rack']);
});

test('an unrelated folder in assets/ is left alone', () => {
  const assetDir: AssetDirEntry[] = [
    { name: 'site', kind: 'directory' },
    { name: 'shelf.glb', kind: 'file' },
  ];
  const plan = ok(planMaterialisation(input({ assetDir })));
  assert.equal(plan.writes[0].replaces, false);
  assert.deepEqual(plan.replaced, []);
});

test('§8.6: a replacement another row still reads from is refused, not confirmed', () => {
  // The scene being saved has a second row on a file inside `assets/rack/`.
  // Emptying it would corrupt the very scene the user is saving, so no
  // confirmation dialog is offered — the save aborts, naming both.
  const plan = planMaterialisation(
    input({
      assetDir: [{ name: 'rack', kind: 'directory' }],
      sceneSrcs: ['assets/rack/rack.gltf', 'assets/rack/older.glb'],
    }),
  );
  assert.equal(plan.ok, false);
  // The refusal is a message as data (`spec.md` §18.4): it names both the folder
  // it refused to empty and the row that would have lost its file.
  assert.deepEqual(plan.ok ? null : plan.reason, {
    key: 'materialiseFolderInUse',
    params: { folder: 'assets/rack', src: 'assets/rack/older.glb' },
  });
});

test('§8.6: the row being written is not itself a reason to refuse', () => {
  // The pending asset's own `src` sits inside the folder by construction; only
  // a **surviving other** row traps it.
  const plan = ok(
    planMaterialisation(
      input({ assetDir: [{ name: 'rack', kind: 'directory' }], sceneSrcs: ['assets/rack/rack.gltf'] }),
    ),
  );
  assert.equal(plan.writes[0].replaces, true);
});

test('§8.6: a row inside a folder that is NOT being replaced is irrelevant', () => {
  const plan = ok(
    planMaterialisation(input({ sceneSrcs: ['assets/rack/rack.gltf', 'assets/site/old.glb'] })),
  );
  assert.equal(plan.writes[0].replaces, false);
});

test('§8.6: a plain file where the folder would go is refused, never removed', () => {
  const plan = planMaterialisation(input({ assetDir: [{ name: 'rack', kind: 'file' }] }));
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.ok ? null : plan.reason, {
    key: 'materialiseFolderIsFile',
    params: { folder: 'assets/rack' },
  });
});

test('§8.6: nothing but a single direct child of assets/ can ever be targeted', () => {
  // Every shape that is not `assets/<one segment>/<file>` is refused outright —
  // `assets/` itself, the folder root, a multi-segment path, and anything
  // outside `assets/`. This is the guard that keeps a hand-forced `src` in a
  // scene file from reaching a recursive removal.
  for (const src of [
    'assets/rack.gltf',
    'assets/site/model/rack.gltf',
    'models/rack/rack.gltf',
    'assets/../rack/rack.gltf',
    'rack.gltf',
  ]) {
    const plan = planMaterialisation(input({ pending: [{ src, paths: [src] }], sceneSrcs: [src] }));
    assert.equal(plan.ok, false, src);
    assert.equal(plan.ok ? null : plan.reason.key, 'materialiseNotImportPath', src);
  }
});

test('a refusal abandons the whole plan, so nothing partial is written (§8.6)', () => {
  const plan = planMaterialisation(
    input({
      pending: [
        { src: 'assets/good/good.glb', paths: ['assets/good/good.glb'] },
        { src: 'assets/bad/bad.glb', paths: ['assets/bad/bad.glb'] },
      ],
      assetDir: [{ name: 'bad', kind: 'file' }],
      sceneSrcs: ['assets/good/good.glb', 'assets/bad/bad.glb'],
    }),
  );
  assert.equal(plan.ok, false);
});

test('several imports plan together, each in its own folder', () => {
  const plan = ok(
    planMaterialisation(
      input({
        pending: [
          { src: 'assets/rack/rack.glb', paths: ['assets/rack/rack.glb'] },
          { src: 'assets/rack-2/rack.glb', paths: ['assets/rack-2/rack.glb'] },
        ],
        sceneSrcs: ['assets/rack/rack.glb', 'assets/rack-2/rack.glb'],
      }),
    ),
  );
  assert.deepEqual(plan.writes.map((w) => w.folder), ['assets/rack', 'assets/rack-2']);
});

test('pendingPaths lists the asset first, then its dependencies (§5.1)', () => {
  const pending = addPending(noPendingAssets(), 'assets/rack/rack.gltf', {
    file: new File([], 'rack.gltf'),
    handle: {} as FileSystemFileHandle,
    deps: new Map([
      ['assets/rack/rack.bin', new File([], 'rack.bin')],
      ['assets/rack/textures/wall.png', new File([], 'wall.png')],
    ]),
  });
  assert.deepEqual(pendingPaths(pending), [
    {
      src: 'assets/rack/rack.gltf',
      paths: ['assets/rack/rack.gltf', 'assets/rack/rack.bin', 'assets/rack/textures/wall.png'],
    },
  ]);
});

test('rewriteSrc is identity for anything the plan did not move', () => {
  const rewrites = new Map([['assets/rack/rack.gltf', 'assets/site/rack.gltf']]);
  assert.equal(rewriteSrc(rewrites, 'assets/rack/rack.gltf'), 'assets/site/rack.gltf');
  assert.equal(rewriteSrc(rewrites, 'assets/site.spz'), 'assets/site.spz');
});
