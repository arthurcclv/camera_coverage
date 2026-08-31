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
`saveTarget`/`lastSave` (§14.5 — session-only, never persisted), and inspector
split height. The merged per-chunk aggregation results and the
run-generation guard live on one `coverageRun` (`useMemo(() => new CoverageRun())`,
see `scene/coverageRun.ts`); the three derived reads (`sectionCellGrids`,
`zoneCoverage`, `probeQueries`) call its `sectionCells`/`zoneCoverage`/
`probeQueries`, keyed on `masksVersion`. What a run derives is one `aggregate`
`useMemo` (`scene/aggregateSpec.ts`) — descriptor plus read-back index — and an
effect re-requests it through `engine.reaggregate` whenever it changes, which is
what makes a zone move or a section drag cost no recompute (spec §3.3). All of that, plus two derived `useMemo`s
(`clipBand`, `sightlines`), is bundled into one immutable `sceneViewState`
(`useMemo`) and pushed to `SceneView.sync()` in a single effect — SceneView diffs
each field by reference, so an expensive op runs only on its own change. The only
`useRef`s left are the async run/handler path: `roomRef`, `initializedRoomRef`,
`bvhRef`, and **one `stateRef` mirroring the whole reducer state** so `handleRun`
reads the live document across awaits (it replaced the ~7 per-field mirrors and
`samplingDirtyRef`; the run-generation guard moved onto `coverageRun`). **Auto-run**
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
  — the placement ray's clip-band-aware nearest hit), `transformReadback.ts`
  (`floorVolumeSize`, `sectionBoundsFromCenters`), plus `types.ts`
  (`SceneViewState`, `TransformChange`). The gizmo/overlay/viewport modules below
  are its internal parts — App never touches them directly.
- `aggregateSpec.ts` — the app → SDK aggregation mapping (spec §3.3), in one
  place and in both directions: `buildAggregateSpec` turns zones/volumes/
  sections/probes into an `AggregateSpec` (volume → OBB region, zone → group,
  marked set → the enabled zones' group plus `maskRegions`, section → `columns`
  slab, overlay → `leafCounts`, probe → `probes`) and returns the
  `AggregateIndex` that reads the results back. Kept whole rather than split
  across the four consumers because a zone's group index and the group its
  numbers are read from drifting apart produces a plausible wrong number, never
  an error. Unit-tested in `test/aggregateSpec.test.ts`.
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
  a superseded build's GPU resources.
- `sceneFile.ts` — pure `scene.json` schema/validation/(de)serialization (spec
  §14.3, §14.8): `parseSceneFile` (schema, `formatVersion` — writes `2`, reads
  `1` and `2` with a v1 file getting empty zones/volumes, geometry `kind`s,
  asset-path safety, id uniqueness within each id-bearing category, and
  `volume.zoneId` referential integrity + `size > 0`) and `serializeScene`. No
  file I/O; this is the layer with real decision logic, so it's the one that's
  unit-tested.
- `sceneIO.ts` — the only impure scene-file I/O: `importSceneFromDirectory`/
  `exportSceneToDirectory` against a `FileSystemDirectoryHandle` (spec §14.4,
  §14.5), thin wrappers around `sceneFile.ts` + `sceneGeometryBuild.ts`. Also the
  save-time probes `sceneJsonExists` / `findExistingAssets` (what a picked
  destination would replace) and `ensureWritePermission` (read handle → readwrite
  on first save), and `copyAssets` — the Save As… asset copy, which streams each
  referenced GLB from the source folder to the same relative path in the
  destination (creating folders as needed) and throws `AssetCopyError` (carrying
  `src` + `reason`) on the first failure so the caller can abandon the save before
  writing `scene.json`. One private `fileHandleAt` walks a relative asset path for
  both import and copy.
- `saveTarget.ts` — pure save-target logic (spec §14.5, §14.7): `resolveSaveAction`
  (write silently vs. show a picker, and whether an overwrite needs confirming),
  `nextSaveTarget` (fold an import/save/failure/cancel outcome into the target),
  `planAssetCopy` (the deduped referenced-`src` list a Save As… must copy), and
  the status/prompt/error strings. Generic over the handle type — only `.name` is
  read — so `test/saveTarget.test.ts` needs no File System Access API. App.tsx
  holds the handle and does the awaits; every decision lives here.
- `viewport.ts` — async `WebGPURenderer` init, orbit + transform controls, lights,
  grid, render loop, and the five view cameras of the View selector. The
  **Selected** view (spec §2.4.1) is driven through `setCameraViewSource` and
  publishes its frame-guide rect back out via the `onCameraGuide` option, so the
  outline App draws and the FOV the renderer used come from one `fitCameraView`
  call and cannot disagree.
- `viewCameras.ts` — the pure geometry behind the View selector: `ViewId` (five
  views) and `OrthoViewId` (the three elevations — `Exclude<ViewId,'perspective'>`
  is *not* that set, since the `camera` view is perspective too), the labels,
  `isOrthographic`/`orbitEnabled`/`navigationEnabled`, `fitOrtho` for the ortho
  auto-fit, and `fitCameraView` for the Selected view's rendered FOV + guide rect.
- `gizmoSet.ts` — the shared spine the four per-entity gizmo sets extend.
  `GizmoSet<E>` owns the keyed `entries` map, the group, the create/update/sweep
  `reconcile` loop, `getAttachTarget`, and `dispose`; subclasses supply
  `createEntry`/`disposeEntry`/`attachTargetOf` and their own `update` signature.
  `PickableGizmoSet<E>` adds the nearest-hit `pickHit` for the viewport-pickable
  three (sections are hierarchy-selected only, spec §13.8). `GizmoPicker` /
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
- `volumetric.ts` — instanced-cube TSL volumetric renderer + pure-TS
  slab/chord/composite reference. Exposes `setRenderOrder` (draw order forwarded to
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
  selected from the hierarchy row, never the viewport (spec §13.8).
- `sceneTree.ts` — `SceneNode` union (camera/probe/section + zone/volume) +
  `buildSceneTree` / `flattenVisible`. Zone nodes are both selectable and
  expandable (their volume children); `flattenVisible` treats any node with a
  non-empty `childIds` as expandable, not just groups.
- `reorder.ts` — pure drag-reorder logic (spec §5.5.1). Two halves: `siblingRows` /
  `insertionTargetAt` turn a pointer Y plus measured row extents into "insert before
  this sibling" (or null → illegal drop), and `moveBefore` / `moveVolumeBefore` do
  the array splice the reducer applies. `moveVolumeBefore` is the subtle one — the
  global `volumes` array interleaves zones, so it permutes a zone's volumes among
  the slots they already occupy and leaves every other element identical. Both
  splices return the *input array reference* on a no-op, which is how the reducer
  stays a cheap identity for illegal drops. No DOM here; the pointer plumbing lives
  in `SceneHierarchy.tsx`.
- `entityDuplication.ts` — pure "Duplicate" context-menu logic (spec §5.5):
  `nextFreeId` (shared with `App.tsx`'s add handlers) plus `duplicateCamera`/
  `Probe`/`Section`/`Volume`/`Zone`, each returning a deep verbatim copy with a
  fresh id. Zone duplication also clones the zone's child volumes; app-level side
  effects (selection, camera disabled-state inheritance, stale-marking) stay in
  `App.tsx`.
- `samplingVolumes.ts` — the region-of-interest core (`sampling_volumes.md`): the
  `Zone`/`SamplingVolume` types, OBB math (`inVolume`/`inZone`/`obbWorldAabb`),
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
  (translate/rotate/scale) writes them straight back; pickable, dims the volumes of
  disabled zones. Extends `PickableGizmoSet`.
- `viewportSelection.ts` — pure click-vs-drag + unified selection decision.
- `transformSpace.ts` — pure local/global ↔ Three.js space mapping + icon/tooltip.
- `placement.ts` — pure "Place on surface" tool logic (spec §2.4.2): the
  `PLACEABLE_KINDS` list (the one place the supported kinds are named), the
  `canPlace` narrowing predicate over it, and the button tooltip.

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

**UI (`ui/`, presentational React)**
- `SceneFileControls.tsx` — the "Scene" panel (Load / Save / Save As… plus the
  save-target status line, spec §14.7) atop the left panel, above the hierarchy;
  hidden entirely where the File System Access API is unavailable. Presentational
  only — the status string comes from `scene/saveTarget.ts`.
- `SceneHierarchy.tsx` — tree view, add menu, duplicate/delete context menu, per-kind
  rows, and `useDragReorder` — the pointer plumbing for drag-to-reorder (§5.5.1):
  the 4px threshold, window move/up listeners attached on pointerdown, Escape-cancel,
  the rAF edge-auto-scroll loop, and swallowing the click that would otherwise select
  after a drop. Every geometric decision is delegated to `scene/reorder.ts`.
- `CameraPanel.tsx` — selected-camera editor: Position + Rotation as grouped
  numeric text fields (`Vec3Field`, §5.2.1); FOV / range (far) stay sliders.
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
  of viewport-only layer toggles (Coverage / Sections / Cameras / Zones). Owns its
  own popover open/close (outside-click + Escape) and layer glyphs; App wires each
  checkbox to the backing visibility state. "Zones" drives the sampling-volume
  gizmos' `group.visible` — purely visual, independent of `useZones`.
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
  round the committed value.
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

## Selection model

A single unified selection: `Selection = { kind: 'camera' | 'probe' | 'section' |
'zone' | 'volume', id } | null` (`scene/viewportSelection.ts`). A viewport click
picks the nearest hit across cameras, probes, and **volumes** (`SceneView`
raycasts each set in its three-set pickable registry, arbitration by the pure
`scene/sceneView/pick.ts` `nearestHit`, then the click-vs-drag decision
`selectionAfterClick`) — sections and zones have no pickable body, so they're
selected from their hierarchy rows; drag-tail clicks (> 5 px travel) are ignored.
`SceneView` emits the resolved selection to App via `onSelect`. Exactly one
`TransformControls` gizmo is attached at a time (a four-set attach registry keyed
by selection kind maps the selection to the set that owns its target); selecting a
probe forces translate-only, selecting a section forces translate-only **and**
constrains the visible handle to its collapse axis, selecting a **volume** enables
the volume-only **scale** mode (translate/rotate/scale), and selecting a **zone**
attaches no gizmo (it's a container, absent from the attach registry). Which zones
are **enabled** (contribute to the visualized marked set) is decoupled from
selection — driven by a per-zone **enabled checkbox** in the hierarchy row
(independent per zone, like cameras/sections), not by selecting a zone.

The selection also gates the **Place on surface** tool (spec §2.4.2): the kinds
that carry a `position` — camera and probe — are named once in
`scene/placement.ts`'s `PLACEABLE_KINDS`, and `canPlace` narrows `Selection` to
them, so App's placement handler switches exhaustively and widening the list is a
compile error until every consumer handles the new kind. While the tool is armed
(`SceneViewState.placing`) the gizmo detaches and a viewport click is consumed for
placement instead of selection: it raycasts only `room.group`, resolves through
`surfaceHit`, and comes back to App as an `onPlace(point)` that App applies with
the ordinary `changeCamera`/`changeProbe` action — so the tool inherits each kind's
existing stale semantics rather than restating them.
