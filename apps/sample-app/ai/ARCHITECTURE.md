# ARCHITECTURE.md — sample-app

How the demo is structured. For *why* see [DECISIONS.md](./DECISIONS.md); for the
behavioral contract see [`../specs/spec.md`](../specs/spec.md).

## Three layers

```
React UI layer  (App.tsx owns state; ui/* are presentational panels)
      │  canonical arrays pushed down via update()/setOptions() in effects
      ▼
Three.js scene layer  (scene/* imperative objects: gizmos, overlay, viewport)
      │
SDK engine layer  (engine/useEngine.ts → WorkerClient → worker.ts → CoverageEngine)
      run off-thread in a Web Worker
```

1. **React UI** — `App.tsx` owns *all* state and layout; `ui/*` components are
   presentational, driven by props and callbacks.
2. **Three.js scene** — `scene/*` classes run **imperatively** inside a
   ref-driven `useEffect`. React holds the canonical data and pushes it into these
   objects; there is no react-three-fiber.
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
  size, tracked via `initializedRoomRef`. It filters out disabled cameras,
  builds a `WorkspaceGrid`, resets probe-visibility, the section-heatmap store,
  and overlay, then `compute({ mode: 1, onChunkDone })` feeds each streamed
  chunk into **three** retained-data consumers: the coverage overlay, the
  probe-visibility store, and the section-heatmap store. Every stage after the
  initial `runGenerationRef` snapshot re-checks it before touching state or
  feeding a stream consumer, so a run superseded mid-flight by `applyScene`
  (import) can't land its results or contaminate the new scene's retained
  chunks — see DECISIONS.md.

## State management

All state lives in `App.tsx` `useState` — cameras, probes, sections,
`geometryObjects` (the scene-file source of truth, spec §14.1) + `room` (its
built `GeometryBuild`: collision mesh + renderable group + workspace bounds),
selection, `disabledIds`, `collapsedIds`, overlay options, `voxelSize`
(debounced 250 ms), summary, stale flag, `autoRun`, transform mode/space, gizmo
visibility, `sectionsVisible` (the viewport master toggle), probe queries,
`masksVersion`, `viewportReady`, scene-file `sceneError`/`sceneIOBusy`,
inspector split height. Per-section `SectionCellGrid`s are derived state
(`useMemo` over `sections` + `masksVersion`), not stored directly. Live values
are mirrored into `useRef`s so the imperative Three.js callbacks read current
state without re-subscribing. **Auto-run** is a 10 Hz `setInterval` that fires
`handleRun` when inputs are stale and the engine is idle and error-free (spec
§8.1 throttle).

`room` used to be a `useMemo(() => buildRoom(), [])` constant; it's now real
state so scene-file import (spec §14) can replace it. The Three.js setup
effect (viewport, gizmos, listeners) still runs exactly once — it no longer
depends on `room` — and a separate effect (deps `[room, viewportReady]`) owns
adding/removing `room.group` from the scene, so a geometry swap never tears
down or recreates the WebGPU renderer/orbit camera. `applyScene` (in
`App.tsx`) is the single place that replaces geometry + cameras + probes +
sections + all derived/retained-run state together; `handleImportScene` is a
thin wrapper around it and `scene/sceneIO.ts` (there is no in-app "reset to
default" — see DECISIONS.md).

## Module responsibilities

**Entry / orchestration**
- `main.tsx` — React entry; mounts `<App>` in StrictMode.
- `App.tsx` — layout, engine lifecycle, all state orchestration, imperative
  Three.js wiring.
- `worker.ts` — SDK worker host + warning side-channel.
- `engine/useEngine.ts` — `WorkerClient` lifecycle + init/load/setCameras/compute
  wrappers with CPU fallback.

**Scene (`scene/`, imperative Three.js + pure math)**
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
  §14.5), thin wrappers around `sceneFile.ts` + `sceneGeometryBuild.ts`.
- `viewport.ts` — async `WebGPURenderer` init, orbit + transform controls, lights,
  grid, render loop.
- `cameraGizmos.ts` — per-camera frustum wireframe + pickable "body" sphere;
  selection / flag / disable styling.
- `probeGizmos.ts` — per-probe octahedron markers + green sightlines to visible
  cameras.
- `probeVisibility.ts` — `Probe` type, retained-chunk store, world-point → voxel
  mask decode (pure `locateVoxel` / `chunkLocalForGlobalIndex`, the latter shared
  with the section column walker).
- `volumetric.ts` — instanced-cube TSL volumetric renderer + pure-TS
  slab/chord/composite reference.
- `coverageOverlay.ts` — maps `ChunkResult` leaves → volumetric voxels per mode;
  hue helper; exports `popcount32` (shared with `sectionHeatmap.ts`).
- `sectionHeatmap.ts` — `Section` model, retained-chunk store, cross-chunk column
  aggregation, Turbo-style colormap, texture-data + stats generation (§13), plus
  `sectionPlaneRotation`/`collapseAxisNormalSign` (the plane-orientation math
  `sectionGizmos.ts` renders with — kept here, not there, so it's unit-tested;
  see DECISIONS.md's "mirrored along its in-plane Z axis" entry for why that
  mattered). Pure data layer — no Three.js.
- `sectionGizmos.ts` — per-section heatmap plane (`DataTexture`) + min/max bound
  outlines + axis-constrained TransformControls target; consumes
  `sectionHeatmap.ts`'s output (including its rotation/sign math), owns no
  aggregation logic.
- `sceneTree.ts` — `SceneNode` union (camera/probe/section + zone/volume) +
  `buildSceneTree` / `flattenVisible`. Zone nodes are both selectable and
  expandable (their volume children); `flattenVisible` treats any node with a
  non-empty `childIds` as expandable, not just groups.
- `samplingVolumes.ts` — the region-of-interest core (`sampling_volumes.md`): the
  `Zone`/`SamplingVolume` types, OBB math (`inVolume`/`inZone`/`obbWorldAabb`),
  `buildSceneBvh` + `extractZonesAndVolumes` (BVH two-level seeding via the SDK's
  public `cleanMesh`/`buildBvh`), `makeMarkedFilter` (the enabled-zones union filter the overlay
  and sections apply), `regionsFromVolumes` (SDK `box` regions from OBB world
  AABBs), and `ZoneCoverageStore`/`computeZoneCoverage` (a 4th retained-chunk
  consumer that aggregates per-zone coverage client-side). Pure — no Three.js.
- `samplingVolumeGizmos.ts` — per-volume wireframe box (edges + faint fill) whose
  root object maps 1:1 to `{position, quaternion, scale}` so TransformControls
  (translate/rotate/scale) writes them straight back; pickable, dims the volumes of
  disabled zones.
- `viewportSelection.ts` — pure click-vs-drag + unified selection decision.
- `transformSpace.ts` — pure local/global ↔ Three.js space mapping + icon/tooltip.

**Cameras (`cameras/`)**
- `defaults.ts` — the 10 default CCTV camera configs.
- `math.ts` — Euler (YXZ, degrees) ↔ quaternion helpers.

**UI (`ui/`, presentational React)**
- `SceneFileControls.tsx` — the "Scene" panel (Load/Save, spec §14.7) atop the
  left panel, above the hierarchy; hidden entirely where the File System Access
  API is unavailable.
- `SceneHierarchy.tsx` — tree view, add menu, delete context menu, per-kind rows.
- `CameraPanel.tsx` — selected-camera position / Euler / FOV / range (far) sliders.
- `ProbePanel.tsx` — probe position sliders + visibility readout + stale hint.
- `SectionPanel.tsx` — orientation / thickness / aggregation editor for the
  selected section (thickness keeps the section's center fixed; position only
  changes via the viewport drag).
- `VolumePanel.tsx` — selected-volume position / Euler / size sliders + a zone
  reassignment dropdown.
- `ZonePanel.tsx` — selected-zone editable name + member count + per-zone coverage
  stats (whether the zone is enabled is controlled by the zone row's checkbox, not here).
- `OverlayControls.tsx` — resolution slider + overlay mode / color / intensity.
- `SectionHeatmapControls.tsx` — the shared Turbo legend/colorbar.
- `SamplingVolumeControls.tsx` — the zone tool block (useZones toggle, Generate,
  zone/box level sliders, marked-voxels readout), above StatsPanel.
- `StatsPanel.tsx` — coverage summary + compute/render backend readout (reflects
  the enabled-zones union when zones are active).
- `SectionStatsPanel.tsx` — selected-section coverage stats (colored-cell mean /
  blind / min / max / per-camera).
- `RunBar.tsx` — run button, auto-run, backend / stale / error indicators.
- `Slider.tsx` — reusable labeled range slider (optional gradient track).
- `leftPanelSplit.ts` — pure clamp + `localStorage` (de)serialization for the
  draggable divider.

## Selection model

A single unified selection: `Selection = { kind: 'camera' | 'probe' | 'section' |
'zone' | 'volume', id } | null` (`scene/viewportSelection.ts`). A viewport click
picks the nearest hit across cameras, probes, and **volumes** — sections and zones
have no pickable body, so they're selected from their hierarchy rows; drag-tail
clicks (> 5 px travel) are ignored. Exactly one `TransformControls` gizmo is
attached at a time; selecting a probe forces translate-only, selecting a section
forces translate-only **and** constrains the visible handle to its collapse axis,
selecting a **volume** enables the volume-only **scale** mode (translate/rotate/
scale), and selecting a **zone** attaches no gizmo (it's a container). Which zones
are **enabled** (contribute to the visualized marked set) is decoupled from
selection — driven by a per-zone **enabled checkbox** in the hierarchy row
(independent per zone, like cameras/sections), not by selecting a zone.
