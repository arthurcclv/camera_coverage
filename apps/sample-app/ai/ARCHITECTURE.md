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
  flaggedCameras, sceneStats, samplingStats }`.
- **`App.tsx` `handleRun`** re-inits only when voxel size changed, filters out
  disabled cameras, builds a `WorkspaceGrid`, resets probe-visibility, the
  section-heatmap store, and overlay, then `compute({ mode: 1, onChunkDone })`
  feeds each streamed chunk into **three** retained-data consumers: the coverage
  overlay, the probe-visibility store, and the section-heatmap store.

## State management

All state lives in `App.tsx` `useState` — cameras, probes, sections, selection,
`disabledIds`, `collapsedIds`, overlay options, `voxelSize` (debounced 250 ms),
summary, stale flag, `autoRun`, transform mode/space, gizmo visibility,
`sectionsVisible` (the viewport master toggle), probe queries, `masksVersion`,
inspector split height. Per-section `SectionCellGrid`s are derived state
(`useMemo` over `sections` + `masksVersion`), not stored directly. Live values
are mirrored into `useRef`s so the imperative Three.js callbacks read current
state without re-subscribing. **Auto-run** is a 10 Hz `setInterval` that fires
`handleRun` when inputs are stale and the engine is idle and error-free (spec
§8.1 throttle).

## Module responsibilities

**Entry / orchestration**
- `main.tsx` — React entry; mounts `<App>` in StrictMode.
- `App.tsx` — layout, engine lifecycle, all state orchestration, imperative
  Three.js wiring.
- `worker.ts` — SDK worker host + warning side-channel.
- `engine/useEngine.ts` — `WorkerClient` lifecycle + init/load/setCameras/compute
  wrappers with CPU fallback.

**Scene (`scene/`, imperative Three.js + pure math)**
- `buildRoom.ts` — room + box obstacles → one merged triangle mesh (for the SDK)
  plus Three.js meshes; workspace-AABB constants.
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
- `sceneTree.ts` — `SceneNode` union (camera/probe/section) + `buildSceneTree` /
  `flattenVisible`.
- `viewportSelection.ts` — pure click-vs-drag + unified selection decision.
- `transformSpace.ts` — pure local/global ↔ Three.js space mapping + icon/tooltip.

**Cameras (`cameras/`)**
- `defaults.ts` — the 10 default CCTV camera configs.
- `math.ts` — Euler (YXZ, degrees) ↔ quaternion helpers.

**UI (`ui/`, presentational React)**
- `SceneHierarchy.tsx` — tree view, add menu, delete context menu, per-kind rows.
- `CameraPanel.tsx` — selected-camera position / Euler / FOV sliders.
- `ProbePanel.tsx` — probe position sliders + visibility readout + stale hint.
- `SectionPanel.tsx` — orientation / thickness / aggregation editor for the
  selected section (thickness keeps the section's center fixed; position only
  changes via the viewport drag).
- `OverlayControls.tsx` — resolution slider + overlay mode / color / intensity.
- `SectionHeatmapControls.tsx` — the shared Turbo legend/colorbar.
- `StatsPanel.tsx` — coverage summary + compute/render backend readout.
- `SectionStatsPanel.tsx` — selected-section coverage stats (colored-cell mean /
  blind / min / max / per-camera).
- `RunBar.tsx` — run button, auto-run, backend / stale / error indicators.
- `Slider.tsx` — reusable labeled range slider (optional gradient track).
- `leftPanelSplit.ts` — pure clamp + `localStorage` (de)serialization for the
  draggable divider.

## Selection model

A single unified selection: `Selection = { kind: 'camera' | 'probe' | 'section',
id } | null` (`scene/viewportSelection.ts`). A viewport click picks the nearest
hit across cameras and probes only — a section's heatmap plane is never a pick
target (§13.8), so it's selected from its hierarchy row; drag-tail clicks (> 5 px
travel) are ignored. Exactly one `TransformControls` gizmo is attached at a time;
selecting a probe forces translate-only, selecting a section forces
translate-only **and** constrains the visible handle to its collapse axis
(`showX`/`showY`/`showZ` on `TransformControls`, reset to all-true otherwise).
