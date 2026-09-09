# ARCHITECTURE.md — sample-app

How the demo is structured. For *why* see [DECISIONS.md](./DECISIONS.md); for the
behavioral contract see [`../specs/spec.md`](../specs/spec.md).

## Three layers

```
React UI layer  (App.tsx owns state; ui/* are presentational panels)
      │  one immutable snapshot pushed down via SceneView.sync() in one effect
      ▼
SceneView  (scene/sceneView/ — the imperative Three.js bridge: viewport,
      │     gizmos, overlay, pick, listeners, behind sync/onSelect/onTransform)
      ▼
SDK engine layer  (engine/useEngine.ts → WorkerClient → worker.ts → CoverageEngine)
      run off-thread in a Web Worker
```

The viewport is **one canvas, one `WebGLRenderer`, one scene** (`spec.md` §2.3,
`gaussian_splats.md` §4):

```
.viewport
  canvas.viewport-main   WebGLRenderer (WebGL2)
      ├─ geometry group (ClippingGroup → per-material clippingPlanes)
      ├─ gizmo sets, grid, light rig, coverage fog
      └─ splat group  ← SparkRenderer, one SplatMesh per row, the clip SplatEdit
```

Everything shares one depth buffer, so a capture is occluded by the walls in front
of it like any other scene content. WebGL2 is not a fallback here — it is the
render backend, fixed by Spark's `WebGLRenderer` requirement and confirmed by
measurement against WebGPU (see DECISIONS.md). **WebGPU is still used, for
compute**: the SDK holds its own device in the worker and shares nothing with the
renderer. `SplatLayer` (`scene/splatLayer.ts`) is a part of the viewport, like the
gizmo sets: App reaches it only through the `SceneViewState` snapshot.

1. **React UI** — `App.tsx` owns *all* state and layout; `ui/*` components are
   presentational, driven by props and callbacks.
2. **SceneView** (`scene/sceneView/`) — owns everything Three.js behind one small
   interface (`sync` · `onSelect` · `onTransform` · `beginCoverageRun`/
   `addCoverageCounts` · `dispose`). React holds the canonical data and pushes one
   snapshot per change through `sync()`, which diffs each field by reference and
   drives the `scene/*` imperative objects (gizmos, overlay, viewport); selection
   and transform edits come back as resolved events. There is no
   react-three-fiber. The individual `scene/*` gizmo/overlay/viewport modules are
   SceneView's internal parts, not App's.
3. **SDK engine** — runs inside a Web Worker, reached through a thin hook.

## Talking to the SDK

- **`worker.ts`** hosts the engine:
  `installHost(messageTransport(self), { engineOptions: { onWarning } })`. Because
  `VisibilityEngine` has no warning channel, it forwards `CAMERA_INSIDE_GEOMETRY`
  as a side-channel `{ kind: 'warning' }` postMessage.
- **`engine/useEngine.ts`** creates the worker, wraps it with
  `WorkerClient.fromWorker(worker)`, and exposes
  `{ state, initAndLoad, setCameras, compute }`. `initAndLoad` tries
  `backend: 'auto'`, falls back to `backend: 'cpu'`, then `loadScene` (cloning
  buffers, since they're transferred) and `setSampling({ regions: [{ type:
  'full' }] })`. It listens for the `warning` message to populate
  `flaggedCameras`. `EngineState = { status, backend, errorMessage,
  flaggedCameras, sceneStats, samplingStats, fullValidVoxels }` —
  `fullValidVoxels` snapshots the full-volume valid count at init/re-init (the
  "% of full" denominator, `sampling_volumes.md` §6.3/§7.4); the box-restricted
  `setSampling` of an active run updates `samplingStats` but not it.
- **`App.tsx` `ensureLoaded`** owns the engine's load. It is the single entry to
  `initAndLoad`, called from a `[room]` effect (mount, and every import/reset) *and*
  from `handleRun`. `engineLoadAction` in `useEngine.ts` — a pure helper, tested in
  `test/engineLoad.test.ts` — decides between `satisfied` / `join` / `start` from the
  `(epoch, room, voxelSize)` triple the engine holds, the one in flight, and the one
  requested, which is what keeps the load single-flight when a run fires in the same
  tick as the scene-load effect. **`epoch`** is `useEngine`'s worker-instance counter
  (bumped whenever it creates a worker, which also resets `EngineState`): a load is a
  fact about one worker, so StrictMode's dev remount must neither join the terminated
  worker's unsettled `init` nor inherit its "loaded" state. **The engine loads on scene load, not on the first
  run** (spec §8): a pool build drives `compute()` without passing the Run gate, so
  its readiness check has to be satisfiable before any run has happened. Loading is
  not computing — coverage still waits for a Run or an auto-run tick. A `voxelSize`
  change stays lazy (spec §6): it is re-initialized by the next run, since it gates
  nothing and re-voxelizing is the session's costliest call.
- **`App.tsx` `handleRun`** re-inits when voxel size changed **or** `room` (the
  built geometry) was replaced since the last init — a scene-file import (spec
  §14.4) always forces a fresh `loadScene`/workspace even at the same voxel
  size, tracked via `initializedRoomRef`. It passes **every** camera (disabled ones
  carry `enabled: false` rather than being filtered out — spec §5.4, see
  DECISIONS.md), builds a `WorkspaceGrid`, and calls
  `compute({ mode: 1, incremental: true, onRunStart, onChunkDone })`.
  `onRunStart` decides the consumers' lifecycle: on a **full** run it resets the
  three stores via `coverageRun.reset(grid, ids)` (probe-visibility,
  section-heatmap, and zone-coverage); on an **incremental** run it resets nothing,
  because each store is keyed by `chunkId` and an arriving chunk replaces just that
  entry (SDK spec §13.1). Either way it opens the overlay's run inline with
  `SceneView.beginCoverageRun(grid.voxelSize, { incremental })`, which both binds
  the run's one resolution and clears the retained chunks when the run is full. Each streamed chunk then
  feeds `coverageRun.addChunk()` (the three stores) and the overlay
  (`SceneView.addCoverageChunk()`) — **four** retained-data consumers, three
  behind the coordinator and the overlay inline (SceneView owns it). After the last
  chunk App flushes the overlay once (`SceneView.flushCoverage()`); the overlay's
  rebuild is whole-scene, so running it per chunk would cost more than an incremental
  run saves. Every stage
  after the initial `coverageRun.generation` snapshot re-checks it with
  `coverageRun.isCurrent(gen)` before touching state or feeding a consumer, so a
  run superseded mid-flight by `applyScene` (import — which calls
  `coverageRun.clear()`, wiping the stores and bumping the generation) can't land
  its results or contaminate the new scene's retained chunks — see DECISIONS.md.

## State management

State is split in two. The **editable scene document** — cameras, probes,
sections, `clipSectionId`, zones, volumes, `useZones`, plus `selection`,
`collapsedIds`, and the `stale`/`hasRunOnce`/`samplingDirty` machine — lives in a
single pure reducer, `scene/sceneReducer.ts`, reached via `useReducer` in
`App.tsx` and destructured for reading. Every CRUD/rename/toggle/duplicate
handler, viewport selection, and transform drag is a thin `dispatch(...)`; the
rules for which edit marks the result stale (and which also dirties the sampled
region set) live in that one tested transition, not in effects (spec §8.1). See
DECISIONS.md.

Everything else stays in `App.tsx` `useState`: `geometryObjects` (the scene-file
source of truth, spec §14.1) + `room` (its built `GeometryBuild`), overlay
options, `voxelSize` (debounced 250 ms), summary, `autoRun`, transform
mode/space, gizmo visibility, `sectionsVisible` (viewport master toggle), probe
queries, `masksVersion`, `viewportReady`, scene-file `sceneError`/`sceneIOBusy`/
`saveTarget`/`lastSave` (§14.5 — session-only, never persisted) plus the two dialog
states `loadDialogFolder`/`saveAsDialog` and `unsavedWarning` (§14.7), and inspector
split height. `saveTarget` is the **pair** `{ folder, name }` (§14.5), and the scene as
last loaded or saved is held serialized in a `sceneBaselineRef` — the dirty check
compares snapshots when a dialog opens rather than tracking edits, so a drag that ends
where it started is not a change and editing costs nothing (§14.4). The merged per-chunk aggregation results and the
run-generation guard live on one `coverageRun` (`useMemo(() => new CoverageRun())`,
see `scene/coverageRun.ts`); the three derived reads (`sectionCellGrids`,
`zoneCoverage`, `probeQueries`) call its `sectionCells`/`zoneCoverage`/
`probeQueries`, keyed on `masksVersion`. What a run derives is one `aggregate`
`useMemo` (`scene/aggregateSpec.ts`) — descriptor plus read-back index — and an
effect re-requests it through `engine.reaggregate` whenever it changes, which is
what makes a zone move or a section drag cost no recompute (spec §3.3). All of that, plus two derived `useMemo`s
(`clipBand`, `sightlines`), is bundled into one immutable `sceneViewState`
(`useMemo`) and pushed to `SceneView.sync()` in a single effect — SceneView diffs
each field by reference, so an expensive op runs only on its own change. The
`useRef`s fall into three groups. The **async run/handler path**: `roomRef`,
`initializedRoomRef`, `initializedVoxelSizeRef`, `engineLoadRef` (the in-flight
load, keyed by what it loads), `bvhRef`, and **one `stateRef` mirroring the whole
reducer state** so `handleRun` reads the live document across awaits (it replaced
the ~7 per-field mirrors and `samplingDirtyRef`; the run-generation guard moved
onto `coverageRun`). **DOM handles** for the gestures and panels (`containerRef`,
`leftPanelRef`, `detailPanelRef`, `dividerDragRef`, `viewRef`). And the largest
group, added with the aim optimizer and camera placement: **getter mirrors** —
`camerasRef`, `constraintsRef`, `markedFilterRef`, `engineReadyRef`,
`samplingPendingRef` and their peers — each mirroring one value so the session
hooks can read it live through a thunk without re-creating their callbacks on
every edit (see `usePlacement`'s `UsePlacementArgs`). That group is why the ref
count is now ~28 rather than the six above; it is a second mirroring mechanism
living beside `stateRef`, and consolidating the two onto `stateRef` is the
obvious next simplification if the argument list grows again. **Auto-run**
is a 10 Hz
`setInterval` that fires `handleRun` when inputs are stale and the engine is idle
and error-free (spec §8.1 throttle).

`room` used to be a `useMemo(() => buildRoom(), [])` constant; it's now real
state so scene-file import (spec §14) can replace it. The `SceneView.create()`
effect runs exactly once (it depends only on the stable `applyTransformChange`);
the `room.group` swap and the clip planes are snapshot fields, so `sync()`
adds/removes the geometry group on a `room` change without tearing down or
recreating the WebGPU renderer/orbit camera. `applyScene` (in
`App.tsx`) is the single place that replaces the whole scene at once — the
App-owned geometry build + `coverageRun.clear()` as side effects, and the
document in one `sceneReplaced` dispatch; `handleImportScene` is a
thin wrapper around it and `scene/sceneIO.ts` (there is no in-app "reset to
default" — see DECISIONS.md).

## Module responsibilities

**Entry / orchestration**
- `main.tsx` — React entry; mounts `<App>` in StrictMode.
- `App.tsx` — layout, engine lifecycle, run orchestration, and building the
  `sceneViewState` snapshot it pushes to `SceneView`. The editable scene document
  is a `useReducer(sceneReducer)`; App dispatches actions rather than holding that
  state directly, and does no direct Three.js wiring (that lives in
  `scene/sceneView/`).
- `worker.ts` — SDK worker host + warning side-channel.
- `engine/useEngine.ts` — `WorkerClient` lifecycle + init/load/setCameras/compute
  wrappers with CPU fallback.

**Scene (`scene/`, imperative Three.js + pure math)**
- `sceneView/` — the imperative Three.js bridge (spec §2–§13). `sceneView.ts` is
  the `SceneView` class: it constructs and owns the viewport + all gizmo sets +
  the overlay, wires the pick raycaster and the pointer/`objectChange` listeners,
  and presents `create` · `sync(SceneViewState)` · `onSelect` · `onTransform` ·
  `onPlace` · `beginCoverageRun`/`addCoverageCounts`/`clearCoverage` · `dispose`. `sync` diffs each
  snapshot field by reference and fans it out to the objects below; drags come back
  as resolved `onTransform` events, clicks as resolved `onSelect`, and an armed
  "Place on surface" hit as an `onPlace` world point. The decision logic it owns
  is pure and unit-tested: `pick.ts` (`nearestHit`), `surfaceHit.ts` (`surfaceHit`
  — the placement ray's clip-band-aware nearest hit, plus that hit's world-space
  geometric face normal), `hoverPlane.ts` (`planeHit`/`planeFromHit`/`seedPlane` —
  the polyline draw mode's rubber band, resolved against a plane rather than the
  scene mesh so a pointer move costs no raycast), `transformReadback.ts`
  (`floorVolumeSize`, `sectionBoundsFromCenters`), plus `types.ts`
  (`SceneViewState`, `TransformChange`). The gizmo/overlay/viewport modules below
  are its internal parts — App never touches them directly.
- `splats.ts` — the `SplatObject` entity and every **pure decision** around it
  (`gaussian_splats.md` §2, §5.4, §6.2, §7): `splatLabel` (the one entity kind
  whose blank-name fallback is its *filename*, not an ordinal), the accepted
  capture extensions, `defaultSplat`, `identityRegistration` (fresh tuples per
  call — `Vec3`/`Quat` are mutable, so a shared constant would alias every splat
  in the scene), `splatBadge` (the row's load-state text), `splatDecodeFailure`
  (which failure a capture that would not decode reports — a hand-referenced
  PCSOGS `meta.json` names its `.sog` zip instead of badging bare), the
  `FLIP_Z_ROTATION` preset, and `clipBandToSdfBox` — the section clip's world
  band as an SDF box, a pure function of the band and the workspace AABB alone
  with **no capture registration in it**. The `Registration` type
  (position/rotation/uniform scale) is here too, and `SplatObject` extends it, so
  the three fields that always travel together have one name without changing the
  serialized shape. Tested in `test/splats.test.ts`.
- `splatAssets.ts` — the **Add 3DGS** dialog's list decisions (§3.2):
  `planSplatAssetList` (filter to the accepted extensions, list a PCSOGS
  `meta.json` *with its reason* rather than dropping it, case-insensitive stable
  order), `firstSelectableAsset`, `formatByteSize`. The same pure/impure split
  `sceneFileList.ts` has from `sceneIO.ts`. Tested in `test/splatAssets.test.ts`.
- `splatLayer.ts` — the impure half (§4): the splat `Group` inside the viewport
  scene, the `SparkRenderer` (constructed once, on the first load), the
  streamed load path, the **per-`src` decode cache** refcounted by referencing
  rows, and the clip's single global `SplatEdit` — which it re-applies when a
  decode lands, since Spark's `SplatEdit` class only arrives with the first load
  and a scene *opened* with a section already clipping would otherwise draw its
  captures uncut. Its `releaseAll()` is public because "the scene was replaced"
  is not visible from here: two scene files in one folder share an asset loader,
  so App's import path calls it (`SceneView.releaseSplats`). Each row gets an **anchor**
  `Object3D` carrying its registration with the `SplatMesh` at identity beneath
  it, which is what makes a still-loading or hidden capture a stable
  `TransformControls` target and lets one decode serve several rows at different
  transforms. Deliberately thin and **untested** — Spark cannot run under
  `node --test`, so every judgement lives in the two modules above and this is
  verified by running the app (§11).
- `aggregateSpec.ts` — the app → SDK aggregation mapping (spec §3.3), in one
  place and in both directions: `buildAggregateSpec` turns zones/volumes/
  sections/probes into an `AggregateSpec` (volume → OBB region, zone → group,
  marked set → the enabled zones' group plus `maskRegions`, section → `columns`
  slab, overlay → `leafCounts`, probe → `probes`) and returns the
  `AggregateIndex` that reads the results back. Kept whole rather than split
  across the four consumers because a zone's group index and the group its
  numbers are read from drifting apart produces a plausible wrong number, never
  an error. Unit-tested in `test/aggregateSpec.test.ts`. It also exports
  `markedFilterForZones(volumes, zoneIds)` — the same `MarkedFilter` over a
  **chosen** set of zones, which is how a constraint group's target zones reach a
  build step (`camera_placement.md` §3.1.2). One construction of a filter, not
  two, so a targeted build and the display run cannot disagree about "counted".
- `coverageRun.ts` — the merged store of a run's `AggregateResult`s plus the
  §14.4 generation guard. Merges on **read**, not on arrival: an incremental run
  re-sends a few chunks and each must *replace* its predecessor, which a running
  total could not distinguish from an addition.
- `geometryModel.ts` — the `GeometryObject` union (`room`/`box`/`gltf`, spec
  §14.1, §14.3) + pure triangle-mesh math shared by the default room and
  imported geometry: `boxTris`/`roomTris`/`mergeTris`, `transformTriMesh`
  (bakes a `position`/`rotation`/`scale` into world-space vertices),
  `computeAabb`/`computeWorkspaceBounds`.
- `buildRoom.ts` — `defaultGeometry()`: the default scene's `GeometryObject[]`
  (a room + 5 box obstacles, identity transforms) from the room constants
  (`ROOM_HALF_X`/`ROOM_HALF_Z`/`ROOM_HEIGHT`/`WALL_THICKNESS`, still consumed
  directly by `cameras/defaults.ts` for camera placement).
- `sceneModel.ts` — the unified `Scene` type (`geometry + cameras + probes +
  sections + zones + volumes + useZones`, spec §14.1) + `defaultScene()`, the
  single source of the boot state (zones/volumes empty, `useZones` false).
- `sceneReducer.ts` — the pure scene-document reducer (`sceneReducer` +
  `initSceneState`): the `Scene` fields minus geometry, plus `selection`,
  `collapsedIds`, and the `stale`/`hasRunOnce`/`samplingDirty` flags. A
  fine-grained typed `SceneAction` union drives every CRUD/rename/toggle/
  duplicate/transform/selection edit; it allocates ids (`nextFreeId`) and calls
  the `entityDuplication` helpers, and is the one place the stale-marking rules
  (spec §8.1) live. Pure — App does the impure work around each dispatch.
  Unit-tested in `test/sceneReducer.test.ts`.
- `sceneGeometryBuild.ts` — reduces a `GeometryObject[]` to one `GeometryBuild`
  (merged collision `SceneMesh` + renderable `THREE.Group` + workspace bounds,
  spec §14.6). `buildStaticGeometrySync` handles `room`/`box` only (the
  synchronous fast path used for the default scene); `buildSceneGeometry` adds
  `gltf` objects via `GLTFLoader`, transforming each mesh by (object transform ×
  node world-matrix) into the same merged mesh. `disposeGeometryBuild` releases
  a superseded build's GPU resources, and `swapGeometry` is the **only** caller
  that matters: it detaches the outgoing group, disposes it, then attaches the
  incoming one, in that order. `SceneView.sync` calls it on a room swap; App
  deliberately does **not** dispose in `applyScene`, because `useEffect` runs
  after paint and freeing a build still parented to the scene leaves the
  animation loop drawing released resources for a frame.
- `sceneFile.ts` — pure scene-file schema/validation/(de)serialization (spec
  §14.3, §14.8): `parseSceneFile` (schema, `formatVersion` — writes `3`, reads
  `1`–`3` with a v1 file getting empty zones/volumes, geometry `kind`s,
  asset-path safety, id uniqueness within each id-bearing category, and
  `volume.zoneId` referential integrity + `size > 0`) and `serializeScene`. No
  file I/O; this is the layer with real decision logic, so it's the one that's
  unit-tested.
- `sceneIO.ts` — the only impure scene-file I/O: `importSceneFile`/
  `exportSceneFile` (spec §14.4, §14.5), thin wrappers around `sceneFile.ts`,
  `sceneFileList.ts` + `sceneGeometryBuild.ts`. A scene file is addressed by the
  **save target**, the `{ folder, name }` pair — a folder holds any number of
  scene files (§14.2), so nothing here knows a default name, and the pair travels
  as the one value `saveTarget.ts` already names. Also `listSceneFiles` (the Load
  dialog's rows: reads what `planSceneFileList` says to read, with **no GLB
  loaded**, and shapes each row through `describeSceneFileRow`), `fileNamesIn`
  (the Save-as dialog's collision set, probed once per folder rather than per
  keystroke), `findExistingAssets` (which assets a destination would replace),
  `ensureWritePermission` (read handle → readwrite, from the click's activation),
  and `copyAssets` — the cross-folder Save As… asset copy, which
  streams each referenced GLB from the source folder to the same relative path in
  the destination (creating folders as needed) and throws `AssetCopyError`
  (carrying `src` + `reason`) on the first failure so the caller can abandon the
  save before writing the scene file. One private `fileHandleAt` walks a relative
  asset path for both import and copy; one private `readTextAt` turns a failed
  read into `null` for the list. **No decisions live here** — every judgement is
  in one of the three pure modules, which is what keeps the untested surface this
  small.
- `sceneFileList.ts` — pure Load-list logic (spec §14.4, §14.7):
  `planSceneFileList` (which of a folder's names are listed, the stable
  case-insensitive order, and which fall past `SCENE_FILE_PARSE_CAP` and so list
  name-only), `describeSceneFileRow` (a row's `96 cams · 12 probes` or the reason
  it cannot load — `null` text means unreadable), `nextListSelection` (which row
  a freshly-listed folder opens on) and `moveListSelection` (ArrowUp/ArrowDown
  across the loadable rows, clamped). Owns the `SceneFileEntry` row type.
  `sceneIO.listSceneFiles` supplies the bytes and nothing else, so the whole list
  is unit-tested with plain strings (`test/sceneFileList.test.ts`).
- `saveTarget.ts` — pure save-target logic (spec §14.5, §14.7). The target is the
  pair `{ folder, name }`: `resolveSaveAction` (write silently vs. open the
  Save-as dialog), `nextSaveTarget` (fold an import/save/failure/cancel outcome
  into it), `normalizeSceneFileName` + `isSceneFileName` (the naming rules and the
  `*.json` listing predicate), `summarizeSceneFile` (a list row's
  `96 cams · 12 probes`), `planAssetCopy` (the deduped referenced-`src` list a
  cross-folder Save As… must copy), `resolveWriteAction` + `describeOverwriteConfirm`
  (whether a commit replaces a file and so must be confirmed, §14.5, and what the
  confirmation says), and the status/warning/error strings. The
  dirty check is not a function here — it is one `!==` on the `sceneSnapshot`
  strings App.tsx stores at each load and save (§14.4). Generic over the handle type — only `.name` is
  read — so `test/saveTarget.test.ts` needs no File System Access API. App.tsx
  holds the handles and does the awaits; every decision lives here.
- `viewport.ts` — `WebGLRenderer` construction (synchronous), orbit + transform
  controls, the light rig (from `sceneLighting.ts`), grid, render loop, and the five view
  cameras of the View selector. The
  **Selected** view (spec §2.4.1) is driven through `setCameraViewSource` and
  publishes its frame-guide rect back out via the `onCameraGuide` option, so the
  outline App draws and the FOV the renderer used come from one `fitCameraView`
  call and cannot disagree.
- `sceneLighting.ts` — `createSceneLights()`: the viewport's fixed four-light rig
  (hemisphere + key/fill directionals + ambient, spec §2.3.1). A pure factory
  returning a `SceneLights` record keyed by role — not an array, so neither the
  caller nor the tests depend on add order — and holding no scene reference, so
  the rig's intensities and directions are assertable in `node --test` without a
  live renderer (which needs a real GPU context). Unit-tested in
  `test/sceneLighting.test.ts`, which pins the §2.3.1 table exactly and then the
  property it exists for (no direction unlit).
- `viewCameras.ts` — the pure geometry behind the View selector: `ViewId` (five
  views) and `OrthoViewId` (the three elevations — `Exclude<ViewId,'perspective'>`
  is *not* that set, since the `camera` view is perspective too), the labels,
  `isOrthographic`/`orbitEnabled`/`navigationEnabled`, `fitOrtho` for the ortho
  auto-fit, and `fitCameraView` for the Selected view's rendered FOV + guide rect.
- `entityVisibility.ts` — the two *derived* sets behind spec §2.4.3's hiding rule:
  `drawableGroupIds` (the enabled groups plus the one placement mode is open on) and
  `visibleZoneIds` (the enabled zones union every drawable group's target `zoneIds`).
  Neither is a property of a single entity — a constraint's visibility depends on its
  group, a volume's on whichever groups target its zone — which is why they live here
  rather than in a gizmo set. Pure; App feeds both into `SceneViewState`.
- `gizmoSet.ts` — the shared spine the five per-entity gizmo sets extend.
  `GizmoSet<E>` owns the keyed `entries` map, the group, the create/update/sweep
  `reconcile` loop, `getAttachTarget`, and `dispose`; subclasses supply
  `createEntry`/`disposeEntry`/`attachTargetOf` and their own `update` signature.
  `pickHit` also enforces **hidden is unpickable** (spec §2.4.3) by walking the
  ancestor chain — Three's raycaster does not skip invisible objects — which covers
  a disabled entity and a switched-off layer with one rule, so SceneView carries no
  per-layer pick guard of its own.
  `PickableGizmoSet<E>` adds the nearest-hit `pickHit` for the viewport-pickable
  four (sections are hierarchy-selected only, spec §13.8), plus a `pickRecursive`
  flag: three of them have a single-mesh body, while a camera constraint's is
  several meshes, so that set opts in rather than every set paying for it.
  `GizmoPicker` /
  `GizmoAttachable` are the minimal interfaces `SceneView` holds the sets behind
  in its pick and attach registries. See DECISIONS.md's GizmoSet entry.
- `cameraGizmos.ts` — per-camera frustum wireframe + pickable "body" sphere;
  selection / flag / disable styling. Extends `PickableGizmoSet`.
- `probeGizmos.ts` — per-probe octahedron markers + green sightlines to visible
  cameras. Extends `PickableGizmoSet` (overrides `dispose` to also clear the
  non-entry sightline overlay).
- `runCameras.ts` — the bridge between a camera's **mask-bit index** (its position
  in the full list passed to `setCameras()`, disabled cameras included since spec
  §5.4) and its position among the cameras that *count*. Resolved once per run in
  `CoverageRun.reset()` and shared by every readout derived from it, so no readout
  re-derives it — or forgets to. Pure, no deps.
- `probeVisibility.ts` — the `Probe` model (`defaultProbeName`/`probeLabel`) and
  the `ProbeVisibilityResult` shape App renders. No store and no mask decode:
  probes are an SDK aggregation primitive now (`spec.probes`, SDK spec §19.2), so
  the answer arrives already resolved and `CoverageRun.probeQueries` reads it.
  Pure, no deps.
- `volumetric.ts` — instanced-cube GLSL volumetric renderer + pure-TS
  slab/chord/composite reference, which stays the tested truth the shader mirrors. Exposes `setRenderOrder` (draw order forwarded to
  the mesh, re-applied across buffer reallocation); the primitive stays agnostic to
  *which* order — that comes from `renderOrder.ts`.
- `renderOrder.ts` — single source of truth for the draw order of the scene's
  transparent layers (section heatmap plane → coverage fog → volume fill). The plane
  is the only depth writer, so it draws first and the depth test resolves the rest
  per viewpoint (spec §9, §13.5). See DECISIONS.md's transparent-layer draw-order entry.
- `coverageOverlay.ts` — maps an `AggregateResult`'s `leafCounts` → volumetric
  voxels per mode. The per-voxel camera *count* is reduced in the SDK now (§19.2),
  so this module counts nothing itself — it retains the merged leaf list **keyed
  by `chunkId`** so a re-sent chunk replaces rather than duplicates (spec §9), and
  defers the whole-overlay rebuild to an explicit flush at the end of a run;
  client-side re-filters (mode, hue/intensity) still rebuild immediately. Also the
  hue helper (`hueToRgb`, `coverageFraction`) and `droppedLeaves`, the count the
  last rebuild could not draw within the renderer's instance cap.
- `sectionHeatmap.ts` — `Section` model, retained-chunk store, cross-chunk column
  aggregation, texture-data + stats generation, the section-legend visibility
  predicate (`sectionLegendVisible`, §13.6/§13.9), plus
  `sectionPlaneRotation`/`collapseAxisNormalSign` (the plane-orientation math
  `sectionGizmos.ts` renders with — kept here, not there, so it's unit-tested;
  see DECISIONS.md's "mirrored along its in-plane Z axis" entry for why that
  mattered). Imports `turboColormap` from `heatmapLegend.ts` for the texture. Pure
  data layer — no Three.js.
- `heatmapLegend.ts` — the **generic** colorbar/legend layer: the shared Turbo
  colormap (`turboColormap`/`turboCssGradient`) and three pure legend-scale builders,
  each returning a `LegendScale` (`{caption, ticks, gradient}`): `sectionLegendScale`
  (section mode: camera-count / blind-share, Turbo), `coverageLegendScale` (Turbo plain
  fraction — the `N=0` defensive fallback), and `overlayLegendScale(hue, mode)` (the
  coverage overlay's **hue-intensity ramp** / solid blind-spots swatch, §9.1/§9.2). Plus
  `chooseHeatmapLegend(clipSection, clipGrid, overlay)` — the pure selector that returns
  the right `LegendScale` **or `null`** (§13.6): the section legend keyed to the
  **clipping** section once a run is retained, else the overlay legend, else hidden. The
  gradient rides on `LegendScale` so the component stays dumb. Imports only *types* from
  `sectionHeatmap.ts` / `coverageOverlay.ts`, so runtime deps stay one-way. Pure — no
  React, no Three.js.
- `sectionGizmos.ts` — per-section heatmap plane (`DataTexture`) + min/max bound
  outlines + axis-constrained TransformControls target; consumes
  `sectionHeatmap.ts`'s output (including its rotation/sign math), owns no
  aggregation logic. Extends the plain (non-pickable) `GizmoSet` — sections are
  selected from the hierarchy row, never the viewport (spec §13.8). The only set
  whose pooled entry holds **measured** data, so it is the only one that must
  write the absence of it: a null cell grid resets the texture to the 1×1
  transparent no-data plane (§13.4) rather than leaving what was there.
- `sceneTree.ts` — `SceneNode` union (camera/probe/section + zone/volume +
  constraintGroup/constraint + splat) + `buildSceneTree` / `flattenVisible`, the
  `nodeIdFor*` / `*IdForNode` namespaced id pair per kind, and
  `nodeIdForSelection` — the selection → highlighted-row mapping, an exhaustive
  `Record` over `Selection['kind']` (it replaced a ternary chain ending in `: null`,
  which left the two constraint kinds with no node and so no highlight). Zone nodes
  are both selectable and expandable (their volume children); `flattenVisible`
  treats any node with a non-empty `childIds` as expandable, not just groups.
  Two more row decisions live here rather than in the component: `nodeSelection`
  (row → what clicking it selects, and what its context menu addresses) and
  `nodeEnabled` (row → whether it dims, through an `EnabledLookup` the hierarchy
  builds from the arrays and maps it already has). Both are exhaustive `Record`s
  over the kind union; `nodeEnabled` replaced a six-deep ternary chain ending in
  a bare `: true`, which every kind added after `splat` would have inherited.
- `reorder.ts` — pure drag-reorder logic (spec §5.5.1). Two halves: `siblingRows` /
  `insertionTargetAt` turn a pointer Y plus measured row extents into "insert before
  this sibling" (or null → illegal drop), and `moveBefore` / `moveVolumeBefore` do
  the array splice the reducer applies. The subtle one is
  `moveWithinParentBefore` — the flat `volumes` array interleaves zones (and
  `constraints` interleaves groups), so it permutes one parent's children among the
  slots they already occupy and leaves every other element identical.
  `moveVolumeBefore` (parent `zoneId`) and `moveConstraintBefore` (parent `groupId`)
  are one-line wrappers over it rather than two copies of that reasoning. Every
  splice returns the *input array reference* on a no-op, which is how the reducer
  stays a cheap identity for illegal drops. No DOM here; the pointer plumbing lives
  in `SceneHierarchy.tsx`.
- `entityDuplication.ts` — pure "Duplicate" context-menu logic (spec §5.5):
  `nextFreeId` (shared with `App.tsx`'s add handlers) plus `duplicateCamera`/
  `Probe`/`Section`/`Volume`/`Zone`, each returning a deep verbatim copy with a
  fresh id. Zone duplication also clones the zone's child volumes; app-level side
  effects (selection, camera disabled-state inheritance, stale-marking) stay in
  `App.tsx`.
- `quatMath.ts` — `applyQuat`/`applyQuatConj` over plain `Vec3`/`Quat` tuples, shared by
  `samplingVolumes.ts`'s box-local frame and `placement/region.ts`'s plane-local one. It
  exists because the pair shipped twice, byte-identical, from two different specs. Not
  Three.js, so the pure modules and their tests reach it without a renderer.
- `samplingVolumes.ts` — the region-of-interest core (`sampling_volumes.md`): the
  `Zone`/`SamplingVolume` types, OBB math (`inVolume`/`inZone`/`obbWorldAabb`, over
  `quatMath.ts`),
  `buildSceneBvh` + `extractZonesAndVolumes` (BVH two-level seeding via the SDK's
  public `cleanMesh`/`buildBvh`), `regionsFromVolumes` (SDK `box` regions from OBB
  world AABBs), and `summaryFromAccum` (a `ZoneSummary` from one SDK `RegionAccum`).
  The enabled-zones union filter and per-zone coverage are no longer computed
  here: both are descriptor primitives now — a group and `maskRegions` — built in
  `aggregateSpec.ts` and reduced in the SDK. Pure — no Three.js.
- `statsDisplay.ts` — the one place the *displayed* coverage numbers are chosen
  (spec §10, §5.5, `sampling_volumes.md` §7.4): `displayCoverageSummary` picks the
  enabled-zones union when zones are active and the SDK summary otherwise, and
  `hierarchyPerCamera` narrows it for the hierarchy badges (dropping them on an
  empty marked set, where every rate finalizes to 0). Both the StatsPanel and the
  hierarchy read it, so the two can't report different rates for one camera. Pure.
- `samplingVolumeGizmos.ts` — per-volume wireframe box (edges + faint fill) whose
  root object maps 1:1 to `{position, quaternion, scale}` so TransformControls
  (translate/rotate/scale) writes them straight back; pickable, and hides the
  volumes of zones outside the visible set (spec §2.4.3) unless selected. Extends
  `PickableGizmoSet`.
- `constraintGizmos.ts` — per-constraint handles plus the **exact** dilation: a plane's
  is the core slab *and* four edge cylinders *and* four corner spheres, because the
  bounding box would claim corners the region does not contain and a bare slab would deny
  the rim it does — a gizmo that disagrees with `inRegion` teaches the wrong shape. The
  meshes are rebuilt only on a **shape-signature** change; every other update is a
  transform write. **Fills are marked, not inferred:** `fillMaterial()` sets
  `userData.fill`, and the styling pass gives every marked material the one `fillOpacity`
  ramp. It used to infer translucency from being parented under the dilation group, which
  forced a plane's rectangle — a fill that is not a dilation — fully opaque
  (`test/constraintGizmos.test.ts`). Also holds `PlacementOverlay` (the pool scatter and the draft
  polyline with its clicked vertices), since both are the placement tool's picture and share
  its layer toggle. Both dot sets are one `ScreenDots` (instanced `Sprite`, screen-space
  size); the draft draws at `RenderOrder.draftOverlay` with `depthTest: false`, since its
  vertices are coplanar with the surface they were clicked on.
- `polylineDraw.ts` — the armed draw mode's pure state and the vertex-editing rules:
  append, backspace, cursor, the commit rule (one vertex commits as a *point* constraint —
  that is what the user drew), `drawClickAction` (whether one viewport click appends or
  commits — a double-click contributes no vertex of its own, `draftAfterDoubleClick`
  taking back the one its first click appended), and the committed
  polyline's rules: `effectiveVertex` (a polyline always has one vertex selected, defaulting
  to its last — one clamp that also covers a delete), `insertMidpoint` (the panel's `+`,
  null on the last vertex), and `extendEnd`/`extendInsertAt` (vertex 1 prepends, any other
  appends), plus `segmentPairs`, which turns the draft's vertices into the explicit endpoint
  pairs its `LineSegments` draws (solid: two dashed constructions rendered nothing under
  this app's WebGPU backend, see `CONVENTIONS.md`). A repeating variant of `placement.ts`'s
  tool, reusing every rule of spec §2.4.2. Tested in `test/polylineDraw.test.ts`.
- `viewportSelection.ts` — pure click-vs-drag + unified selection decision, plus
  `vertexAfterClick`, the same decision one level down for a polyline's vertex
  sub-selection.
- `transformSpace.ts` — pure local/global ↔ Three.js space mapping + icon/tooltip.
- `placement.ts` — pure "Place on surface" tool logic (spec §2.4.2): the
  `PLACEABLE_KINDS` list (the one place the supported kinds are named),
  `placeTarget` resolving a selection **plus a polyline vertex sub-selection** to
  one `PlaceTarget`, `canPlace` over it, and the button tooltip.

**Cameras (`cameras/`)**
- `camera.ts` — the `SceneCamera` entity (`CameraConfig` + editable `name`), its
  `defaultCameraName`/`cameraLabel` helpers, and `toCameraConfig` (drops `name` at the
  SDK `setCameras()` boundary). See [DECISIONS.md](DECISIONS.md) for why names are
  on-entity + converted rather than a side map.
- `defaults.ts` — the 10 default CCTV cameras (blank names → display as `Camera N`).
- `math.ts` — Euler (YXZ, degrees) ↔ quaternion helpers.
- `aim.ts` — pure aim-drag math for the **Selected** view (spec §2.4.1, §5.2):
  `aimDelta` maps a pointer delta over the frame guide to a new orientation
  (mouselook — the aim follows the pointer — at a FOV-derived deg/px), plus
  `horizontalFov` and the ±89° `clampPitch` shared with the rotation fields. Lives here rather than in `scene/` because it is
  camera *pose* math composing `math.ts`, not view-framing geometry; the gesture
  plumbing that calls it is in `scene/sceneView/`.

**Aim optimization (`optimize/`, `aim_optimization.md`)**

A layered stack whose lower half is pure, so the decisions can be tested without a
GPU. Read it bottom-up:

- `weights.ts` — the `u32` weight tables the SDK's projection primitive sums:
  `1/(n+1)^α` in 16384ths, and a blind-voxel indicator. **Changing the objective is a
  change to this file and nothing else** — which is what made fixing a 1.7-point coverage
  shortfall a one-constant edit (`REDUNDANCY_EXPONENT`, see DECISIONS.md).
- `comparison.ts` — the measured per-zone before/after. Pure: two `ZoneCoverage`
  snapshots in, a sorted diff out. Separate from the optimizer because it reports what
  *happened*, not what was proposed — both its columns come from real runs.
- `cubeRig.ts` — the six 90° capture cameras that tile the sphere around one mount
  point. Ordinary `CameraConfig`s, computed by the ordinary Pass 2, which is why the
  panorama agrees with the engine rather than reimplementing it.
- `panorama.ts` — merges a capture's six `ProjectionAccum`s into a weighted angular
  image, and builds the mip pyramid whose nodes carry their cells' corner directions.
- `search.ts` — a frustum as five half-spaces through the origin, the pyramid walk,
  and the exhaustive 1° scan under the blind gate. No engine, no React.
- `greedy.ts` — the round loop, parameterized on `capture`/`apply`. Ordering, rounds,
  the gate, the gain threshold, ΔΦ: all pure.
- `session.ts` — the SDK-shaped half: slot management, the two camera masks, and the
  capture descriptor. The capture carries the **marked filter handed over from
  `scene/aggregateSpec.ts`**, not one of its own: `setSampling` bounds what is *computed*
  with conservative AABBs, and only the descriptor's exact OBBs say what is *counted*.
- `useAimOptimizer.ts` — **the only module here that calls the engine.** Owns session
  state, cancel/apply, and the rule that the scene is not written until Apply.

The invariant that spans layers: a session appends six cameras to the list the engine
holds but **never** to the scene, so `chunkSizeFor` reserves their slots
unconditionally (opening a session must not re-init), the display descriptor carries a
`cameras` mask that hides them, and auto-run is suspended for the duration.

**Camera placement (`placement/`, `camera_placement.md`)**

The same layering, and the same reason for it: the lower half is pure, so the search can
be tested without a GPU. What differs is *where* the expensive step sits — the aim
optimizer captures once per camera and then searches orientations for free, while
placement builds once per **mount point** and then searches layouts for free (see
DECISIONS.md). Read it bottom-up:

- `region.ts` — the entities and their geometry. A constraint's region is the Minkowski
  sum of its primitive with a ball, so membership is a **distance** (`dist ≤ distance`)
  rather than a box test — which is why a polyline gets round joints and caps and a plane
  a rounded rim for free. Also owns `primitiveMeasure` (the pool-split weight),
  `projectIntoRegion` (the drag clamp), the entity defaults, and the
  `constraintProblem`/`groupProblem` validators the **scene-file reader and the panels
  share**, so an imported constraint and a hand-edited one are rejected identically. A
  group also carries its **target zones** — `zoneIds` plus `restrictScoring` /
  `restrictMounts` (`camera_placement.md` §3.1.2).
- `halton.ts` — the deterministic low-discrepancy sequence the pool is drawn from, its
  ball map, and the per-constraint offsets. Five dimensions per position **always**, so
  the index→position mapping is independent of kind and tolerance; that is what makes the
  draw prefix-stable across an edit, and prefix-stability is what makes extending a pool
  cost only the new build steps.
- `leafSet.ts` — the cached reachable set as the SDK's merged cubes, plus the
  `VoxelBitset` a trial rasterizes into. `add()` returns the **marginal** contribution,
  which is what makes a prefix curve exact.
- `assign.ts` — the Apply plan: a minimum-total-distance assignment (Hungarian) between
  the group's bound cameras and the chosen positions, resolved into moves / creates /
  disables. Pure. Nothing it emits removes scene data — the surplus is switched off where
  it stands — but it is still the module that decides which of a site's cameras move
  where, so its optimality is pinned against brute force rather than against a
  hand-computed answer.
- `analyze.ts` — the greedy pass, the trial loop, the prefix curve, and the knee. No
  engine, no React. The PRNG is counter-based on `(seed, trialIndex)`, so trial *t* is the
  same layout however the run was chunked — a cancelled-and-resumed analysis is identical
  to an uninterrupted one. Named for the button, and the button named for the act: it
  searches layouts and measures nothing, which is why the axis it feeds says *reachable*.
  The **greedy pass** reads no PRNG at all: it picks by largest gain against the union so
  far, breaking ties by distance to the nearest camera already picked, and it is lazy —
  gains only fall as the union grows, so a stale gain is still an upper bound and a step
  re-evaluates only candidates that could still win. Both halves offer their prefixes to
  one two-key comparison (`score`, then `separation`), so a count holds the better layout
  and not the later one.
- `pool.ts` — the SDK-shaped half: the measure-weighted split, the draw plan, the build-step
  camera list and descriptor, the rejection budget, the fingerprint, and the blockers. Its
  build-step descriptor carries the marked filter **handed over from
  `scene/aggregateSpec.ts`**, for the identical reason `optimize/session.ts` does. It also
  owns the **mount filter** (`camera_placement.md` §4.1.1): `overlapFraction` estimates a
  constraint's overlap with the group's target zones by *running the constraint's own draw*
  — the estimator is the sampler, so `distance` is honoured for free and the number is
  directly the acceptance rate — and `drawBasis` turns that into the effective measures the
  split uses, dropping a zero-overlap constraint rather than keeping it at weight 0. A
  `DrawBasis` (constraints + weights + mount volumes) is what `poolSplit` / `planDraws` /
  `truncatedShares` / `replacementDraw` all take, because those three are only ever correct
  together. `GroupTarget` is the one value a group's zones resolve to (filter, denominator,
  mount volumes, names, fingerprint parts) and `resolveGroupTarget` is the pure function
  that produces it from the group, the scene and the app's own marked set — so a filter from
  the listed zones can never be paired with a denominator from the enabled ones. The rest of
  §3.1.2's rendering decisions live here for the same reason (App has no test):
  `constraintOverlaps` / `unmountableIds` (which gizmos dim), `overlapSummary` (the line
  both cards show), and `regeneratedTargetsNotice` (§10's status line).
- `curvePlot.ts` — the score-vs-count plot's geometry: the value range and its headroom,
  the count→x and score→y maps the polyline is drawn with, and `countAtFraction`, the
  inverse a click uses. Pure, and separate from the panel because the drawing and the
  click handler have to agree — when they disagree the plot renders perfectly and simply
  selects the wrong count, which is invisible until someone counts the dots.
- `mode.ts` — the placement **mode**'s panel decisions, all pure. The lifecycle is a
  reducer: open, requestClose, keepOpen, confirmClose, applied, groupGone → the next state
  plus at most one `closeSession` effect, carrying two rules worth testing without React —
  a running build step is not closeable (Cancel stops it), and a built pool asks before it
  is dropped, minutes of GPU against a keystroke. Beside it, `buildAction`/`buildLabel` turn
  (pool, fingerprint, size) into **Build / Extend to N / Truncate to N / Rebuild**, and
  `analysisStamp` is the comparison that marks a result stale. `usePlacement.ts` owns the
  session; this owns when it closes and what the buttons say.
- `usePlacement.ts` — **the only module here that calls the engine.** Owns the session,
  the pool, the analysis loop's batching, Apply/Discard, and Reposition. It is also where
  the three Build cases become build steps: an extension carries the pool forward and plans
  only the new draws, a truncation carries a prefix and plans none, a rebuild starts over.
  Carrying forward needs two numbers per constraint, not one — `kept` counts against the
  share while `nextSeq` has already moved past whatever was rejected.

Two invariants span the layers. The pool's **fingerprint** covers the geometry, the voxel
size, the marked set, and the group's range — and deliberately *not* the cameras, because
a reachable set cannot depend on them; that is what makes place → aim → measure →
re-search cheap. And the six capture slots are the **same six** the aim optimizer uses, so
the two sessions are mutually exclusive rather than each reserving its own.

**UI (`ui/`, presentational React)**
- `SceneFileControls.tsx` — the "Scene" panel (Load… / Save / Save As… plus the
  save-target status line, spec §14.7) atop the left panel, above the hierarchy;
  hidden entirely where the File System Access API is unavailable. Presentational
  only — the status string comes from `scene/saveTarget.ts`. Its error banner is
  for failures with **no dialog open**; a dialog's own errors render inside it.
- `Modal.tsx` — the app's only blocking surface (`VISUAL_DESIGN.md`): dimmed
  backdrop, centred `.panel` card, title + scrolling body + pinned footer, Escape
  to cancel, focus moved in on open and restored on close. Holds a module-level
  **open-modal stack** so Escape closes the topmost card only — both modals listen
  on `window` in the capture phase and `stopPropagation` does not stop a sibling
  listener, so without it one Escape would cancel a stacked confirmation *and* the
  dialog beneath it. `stacked` suppresses the second dim (spec §14.7). Plus what
  the dialogs share of the folder line: `FolderLine` (the granted-folder row and
  its **Change…** button), `usePickedFolder` (the folder being browsed and the
  re-pick that replaces *only* it) and `FOLDER_UNAVAILABLE`, the one message a
  folder that cannot be enumerated or probed gets (§14.8).
- `ConfirmOverwriteDialog.tsx` — the **Overwrite scene file?** gate (spec §14.5):
  the confirmation in front of every write that would replace an existing file,
  from a plain Save or a Save-as commit alike. Body lines come from
  `describeOverwriteConfirm`; the only `stacked` modal in the app. Its
  **Overwrite** click is the activation the lazy `requestPermission` runs from, so
  App commits straight to `writeScene` from it.
- `LoadSceneDialog.tsx` — the **Load scene** dialog (spec §14.4): lists the
  granted folder's scene files via `listSceneFiles`, with summaries, invalid rows
  greyed with their reason, arrow-key/Enter/double-click navigation, and the
  unsaved-changes warning that turns **Load** into **Load anyway**. The **current**
  badge is gated on `isTargetFolder` as well as the name, since two granted
  folders can each hold a `scene.json` and only one is what Save writes to
  (§14.7). Owns only the folder being browsed and its listing; the all-or-nothing
  import is the caller's, so a failure leaves the dialog open over an untouched
  scene.
- `SaveSceneAsDialog.tsx` — the **Save scene as** dialog (spec §14.5): an editor
  for `{ folder, name }` that writes nothing until its own commit. Name validated
  through `normalizeSceneFileName` as typed; the replace warning is inline and
  recomputed per folder, turning **Save** into **Replace**, so no modal
  confirmation ever stacks on it.
- `SceneHierarchy.tsx` — tree view, add menu, duplicate/delete context menu, per-kind
  rows, and `useDragReorder` — the pointer plumbing for drag-to-reorder (§5.5.1):
  the 4px threshold, window move/up listeners attached on pointerdown, Escape-cancel,
  the rAF edge-auto-scroll loop, and swallowing the click that would otherwise select
  after a drop. Every geometric decision is delegated to `scene/reorder.ts`.
- `CameraPanel.tsx` — selected-camera editor: Position + Rotation as grouped
  numeric text fields (`Vec3Field`, §5.2.1); FOV / range (far) stay sliders; the
  aim-lock checkbox (`aim_optimization.md` §4.5), which never marks stale.
- `OptimizePanel.tsx` — the aim optimizer's two entry points, the yaw × pitch score
  heatmap, the per-camera proposal, and the whole-scene summary. Rendered in the **right
  sidebar** below `SamplingVolumeControls`, not in the left inspector: it is a tool (one
  entry point has no selection at all, the other only *reads* one), and a 2:1 heatmap
  above the camera editor's numeric fields would push them out of view.
- `CandidatePositionsPanel.tsx` / `StrategyPanel.tsx` / `NewCameraDefaultsPanel.tsx` — the
  placement **mode**'s left column, three cards: the two *draw* inputs `Size` and `Seed` +
  **Build**; the two strategy fields + **Analyze**; and the camera template (`Name prefix`,
  `FOV`, `Range`) with no button at all. The split is by *when a field is read*, not by
  topic. A draw input decides which positions get built, so it is spent on the GPU and
  resolves into Build's own label; a strategy field re-runs for free over the pool in hand;
  and the knee tolerance is read *after* the trials, so it is in the review column instead.
  Separate files because each of the first two cards owns one button's feedback — its
  progress line, its readout, its blocker, its Cancel — and the file boundary is what keeps
  that beside the button instead of drifting into a shared status area. Build and Analyze
  stay separate because their costs differ by three orders of magnitude.
  `NewCameraDefaultsPanel` is **last** in the column, under both buttons: its three fields
  are set once per group and then left alone, so putting the settled card first would push
  Build and Analyze down the column for the whole of every session. Having no button of its
  own is what lets it sit below two that do. `Range` is also a build-step input, and its cost
  is stated where it is paid — Build's label two cards up flips to **Rebuild**.
- `PlacementReviewPanel.tsx` — the mode's right column: the group's name,
  the reachable-vs-count curve with its knee and pool-ceiling asymptote, the **count** and
  **knee-tolerance** sliders, the layout's numbers, and **Apply**/**Close** pinned below the
  scroll region so the exit cannot scroll out of view. The tolerance is here, not in
  `StrategyPanel`, because it reads the *finished* curve: `epsilon` enters the trial loop
  nowhere, so the knee is derived per render and a tolerance edit costs a scan (see
  DECISIONS.md). The mode targets one group, fixed at open, so there is no group selector —
  that dropdown was a second selection model beside the hierarchy's, and it only existed
  because a sidebar panel had no other way to know which group the user meant. Its axis says
  **reachable**, never coverage (see DECISIONS.md).
- `ConstraintGroupPanel.tsx` — selected group: name, constraint count, the **target zone**
  list, and **Place cameras**, the mode's only entry point, disabled with its reason when
  the group cannot be searched. The camera **template** is *not* here — it is the mode's
  third card, because it is an input to a placement run rather than a description of the
  group, and out here it cost this panel a heading and a second thought. The **strategy** is
  persisted on the group and shown only in the mode for the same reason. The **target
  zones** are the one placement input that stays, because they are a *reference to other
  entities* rather than a number: they give the group its identity, they must outlive zone
  deletion and regeneration, and through `restrictMounts` they change what every constraint
  in the group geometrically means (see DECISIONS.md). With `restrictMounts` on it also
  carries the §4.1.1 overlap percentages in words — the text cue beside the dimmed gizmos,
  since dimming alone cannot separate "no draw can land here" from "disabled".
- `ConstraintPanel.tsx` — selected constraint: kind, group, tolerance, geometry, and for a
  polyline **only the selected vertex** — its coordinates plus Insert / Delete / Extend
  (`PolylineVertex`, in the same file). The panel half of the draw mode; a rail's dozens of
  vertices as a list would bury the one the user is holding in the viewport.
- `ProbePanel.tsx` — probe position (grouped text field) + visibility readout + stale hint.
- `SectionPanel.tsx` — orientation / thickness / aggregation editor for the
  selected section (thickness keeps the section's center fixed; position only
  changes via the viewport drag).
- `VolumePanel.tsx` — selected-volume Position / Rotation / Size as grouped numeric
  text fields (`Vec3Field`, §5.2.1) + a zone reassignment dropdown.
- `ZonePanel.tsx` — selected-zone editable name + member count + per-zone coverage
  stats (whether the zone is enabled is controlled by the zone row's checkbox, not here).
- `OverlayControls.tsx` — resolution slider + overlay mode / color / intensity.
- `ViewportLayerMenu.tsx` — the top-right eye-button dropdown (§2.4): a checklist
  of viewport-only layer toggles (Coverage / Sections / Cameras / Zones / Constraints).
  Owns its own popover open/close (outside-click + Escape) and layer glyphs; App wires
  each checkbox to the backing visibility state. "Zones" drives the sampling-volume
  gizmos' `group.visible` — purely visual, independent of `useZones`. "Constraints" drives
  the constraint gizmos **and** the placement pool scatter together, since both are the
  placement tool's picture.
- `HeatmapLegend.tsx` — the **presentational** legend/colorbar: it renders whatever
  `LegendScale` it is handed (caption + `scale.gradient` + ticks), owning no mode
  logic. Rendered as a **floating `.viewport-legend` overlay at the viewport
  bottom-right** (not in the sidebar). App drives it as a **dual-purpose** widget:
  - **section legend** when `sectionLegendVisible(sectionsVisible, sections,
    clipSectionId)` — layer visible *and* `clipSectionId` references an existing,
    **enabled** clipping section (§13.6, §13.9), i.e. that section's heatmap is drawn;
    scale is `sectionLegendScale(...)` (or `coverageLegendScale()` when nothing is
    selected);
  - else the **coverage-overlay legend** when the overlay is visible
    (`overlayOptions.visible`, §9) — scale is `overlayLegendScale(hue, mode)`;
  - hidden when neither applies.
- `SamplingVolumeControls.tsx` — the zone tool block (useZones toggle, Generate,
  zone/box level sliders, marked-voxels readout), above StatsPanel.
- `StatsPanel.tsx` — coverage summary + compute/render backend readout (reflects
  the enabled-zones union when zones are active).
- `SectionStatsPanel.tsx` — selected-section coverage stats (colored-cell mean /
  blind / min / max / per-camera).
- `RunBar.tsx` — run button, auto-run, backend / stale / error indicators.
- `Slider.tsx` — reusable labeled range slider (optional gradient track); its value
  readout is an editable `NumberInput` (§5.2.1). `integer` sliders (octree levels)
  round the committed value. An optional `title` spells out a label whose unit is
  jargon (`Knee (pp)`), riding on both the hover text and the field's `aria-label`.
- `NumberInput.tsx` — the shared numeric text input behind both field kinds (§5.2.1):
  commits on blur/Enter, reverts on Escape, and holds the raw string while focused so a
  gizmo drag / Euler round-trip / slider drag can't stomp the caret. A `seed` prop picks
  the focus seed — `'display'` (rounded, vector fields) vs `'full'` (slider fields).
- `Vec3Field.tsx` — grouped numeric vector editor (§5.2.1): a group label + three
  labeled `NumberInput`s (seed `'display'`).
- `numberField.ts` — pure parse → clamp → revert + focus-seed helpers behind the fields
  (`commitNumberField` / `resolveFieldCommit` / `seedFieldValue`); the single test seam
  for field behavior (`test/numberField.test.ts`).
- `leftPanelSplit.ts` — pure clamp + `localStorage` (de)serialization for the
  draggable divider.
- `menuPopover.ts` — placement for the hierarchy's popovers (spec §5.5): the pure
  `'right' | 'left'` choice (`popoverSide`) plus `MENU_WIDTH_PX`. The "+" menu and its
  Constraint submenu both open **outward** and are both `position: fixed`, placed by
  `SceneHierarchy`'s `placeOutward` from the anchor's measured rect — absolute
  positioning is what `.left-panel`'s `overflow: hidden` clips. The width is fixed (not
  content-driven) so the two line up as one assembly and the side can be resolved
  before the popover renders; `MENU_WIDTH_PX` mirrors `index.css`, and
  `test/menuPopover.test.ts` reads the stylesheet and fails if they drift. The side is
  measured rather than constant because the left panel is resizable.
- `entityMenu.ts` — the hierarchy context menu's per-kind routing: `DeletableKind`,
  the `EntityMenuHandlers` bundle `SceneHierarchyProps` extends, and
  `deleteHandlers` / `duplicateHandlers`, which return
  `Record<DeletableKind, (id) => void>`. The record is load-bearing, not stylistic —
  it replaced two if/else chains whose trailing `else` assumed `volume`, so the
  constraint kinds added later were routed to `onDeleteVolume`/`onDuplicateVolume`
  and did nothing at all. Tested in `test/entityMenu.test.ts`.

## Selection model

A single unified selection: `Selection = { kind: 'camera' | 'probe' | 'section' |
'zone' | 'volume' | 'constraintGroup' | 'constraint' | 'splat', id } | null`
(`scene/viewportSelection.ts`). Every kind highlights its hierarchy row, via
`sceneTree.ts`'s `nodeIdForSelection`. A viewport click
picks the nearest hit across cameras, probes, and **volumes** (`SceneView`
raycasts each set in its three-set pickable registry, arbitration by the pure
`scene/sceneView/pick.ts` `nearestHit`, then the click-vs-drag decision
`selectionAfterClick`) — sections and zones have no pickable body, so they're
selected from their hierarchy rows — as are **splats**, whose body is on the other
canvas and deliberately unreachable (`pointer-events: none` plus absence from the
picked scene): a capture contributes no triangles, so a camera "placed" on a
captured wall would be reported as seeing through the surface it sits on
(`gaussian_splats.md` §1.1, §6.5). Drag-tail clicks (> 5 px travel) are ignored.
`SceneView` emits the resolved selection to App via `onSelect`. Exactly one
`TransformControls` gizmo is attached at a time (a four-set attach registry keyed
by selection kind maps the selection to the set that owns its target); selecting a
probe forces translate-only, selecting a section forces translate-only **and**
constrains the visible handle to its collapse axis, selecting a **volume** enables
the volume-only **scale** mode (translate/rotate/scale), and selecting a **zone**
attaches no gizmo (it's a container, absent from the attach registry), and
selecting a **splat** attaches the gizmo to its anchor in the *splat* scene —
Move/Rotate only, since a per-axis scale drag would shear the capture's
Gaussians, and its scale is one uniform number in `SplatPanel` instead. A
disabled splat is the one exception to "selection wins" (spec §2.4.3): it stays
hidden while selected, though its gizmo still attaches, because re-drawing a
capture the user just hid by clicking its row would read as a broken checkbox. Which zones
are **enabled** (contribute to the visualized marked set) is decoupled from
selection — driven by a per-zone **enabled checkbox** in the hierarchy row
(independent per zone, like cameras/sections), not by selecting a zone.

The selection also gates the **Place on surface** tool (spec §2.4.2): the kinds
that carry a placeable point — camera, probe, and a polyline constraint's
**selected vertex** (`camera_placement.md` §6.2) — are named once in
`scene/placement.ts`'s `PLACEABLE_KINDS`, and `placeTarget` resolves the selection
(plus the vertex sub-selection, since a polyline has no `position` of its own) to
one `PlaceTarget`, so App's placement handler switches exhaustively and widening
the union is a compile error until every consumer handles the new target. While
the tool is armed (`SceneViewState.placing`) the gizmo detaches and a viewport
click is consumed for placement instead of selection: it raycasts only
`room.group`, resolves through `surfaceHit`, and comes back to App as an
`onPlace(point)` that App applies with the ordinary
`changeCamera`/`changeProbe`/`moveConstraintVertex` action — so the tool inherits
each target's existing clamp and stale semantics rather than restating them.

The **polyline draw mode** (`camera_placement.md` §6.2) is the same tool repeating,
and splits the two gestures apart on cost. A *click* is exactly the above — a
`room.group` raycast through `surfaceHit`. A *hover*, which fires on every pointer
move, is not: it intersects the ray with a single **hover plane** (`hoverPlane.ts`)
and touches no geometry, because three's `Mesh.raycast` is `O(triangles)` with no
BVH and an imported site glTF makes that the frame's dominant cost. `SceneView`
holds the plane, re-seeding it from the surface each committed click landed on, so
the band runs along the wall or floor being drawn; `SceneViewState.drawAnchor`
seeds it when **Extend** arms, which needs a band before it has a click. A fresh
draft starts with no plane, and needs none — there is no rubber band until a first
vertex exists.
