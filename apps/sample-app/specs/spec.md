# Sample App — Camera Coverage SDK Demo

A browser demo of [`@linkervision/camera-coverage-sdk`](../../../packages/camera-coverage-sdk/).
It loads an enclosed room with box obstacles and 10 cameras, lets the user adjust
each camera's position / rotation / FOV, runs the coverage calculation on demand,
and visualizes the result as a color-coded voxel overlay in the scene.

---

## 1. Goals & scope

- Demonstrate the SDK end-to-end: `init` → `loadScene` → `setSampling` →
  `setCameras` → `compute`, with results streamed and visualized.
- Keep the scene small enough that the **CPU reference compute backend** stays
  responsive, while still exercising the **WebGPU compute** path where available
  (distinct from the WebGPU *render* backend, §2.3).
- Be a readable reference for SDK consumers, not a polished product.
- Let the user drop **probes** — points in the scene — and read back which enabled
  cameras can see each point, reusing the computed coverage masks (§12).

Non-goals: saving/loading scenes, importing external meshes, multi-scene support,
authentication, mobile layout.

---

## 2. Tech stack & project wiring

| Concern | Decision |
|---|---|
| Bundler / dev server | **Vite** + TypeScript |
| UI | **React** — control panels, buttons, stats readouts |
| 3D rendering | **Three.js `WebGPURenderer`** (`three/webgpu`) with **TSL** node materials and automatic WebGL2 fallback (§2.3). Driven imperatively inside a `useEffect`/ref (no react-three-fiber) |
| SDK dependency | Referenced **by name** (`@linkervision/camera-coverage-sdk`) via npm workspaces |

### 2.1 Monorepo

Add a root `package.json` at the repo root:

```jsonc
{
  "name": "camera-coverage-monorepo",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
```

`apps/sample-app/package.json` declares `"@linkervision/camera-coverage-sdk": "*"`.
A single `npm install` at the root symlinks the package into `node_modules`; Vite
imports it by name through the package `exports` map. The SDK's internal specifiers
use explicit `.ts` extensions — Vite/esbuild resolve these without extra config.

### 2.2 Layout

```
apps/sample-app/
  specs/spec.md            ← this document
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  src/
    main.tsx               React entry
    App.tsx                layout, engine lifecycle, state orchestration
    worker.ts              SDK worker host entry
    engine/
      useEngine.ts         WorkerClient lifecycle + init/loadScene/compute wrappers
    scene/
      buildRoom.ts         room + boxes → { positions, indices } + Three.js meshes
      viewport.ts          WebGPURenderer (async init) + orbit/transform controls, render loop; four view cameras (perspective + top/front/right ortho) + bottom-left orientation-axis triad (§2.4)
      cameraGizmos.ts      per-camera frustum gizmos
      probeGizmos.ts       per-probe markers + selected-probe sightlines (§12.4)
      probeVisibility.ts   retained ChunkResults + world-point → camera-mask lookup (§12.2)
      volumetric.ts        voxel volumetric renderer (§2.3, volumetric_rendering.md)
      coverageOverlay.ts   maps ChunkResult coverage → volumetric voxels (§9)
      sectionHeatmap.ts    retained ChunkResults → per-section column aggregate + heatmap texture + stats (§13)
      sectionGizmos.ts     per-section heatmap plane + faint bound outlines + transform target (§13.5, §13.8)
      sceneTree.ts         scene hierarchy node model + derivation (camera + probe + section + zone/volume) (§5.5)
      samplingVolumes.ts   zone/volume model + OBB math + BVH seeding + marked filter + per-zone aggregation (sampling_volumes.md)
      samplingVolumeGizmos.ts  per-volume wireframe boxes + transform target (sampling_volumes.md §5)
    cameras/
      defaults.ts          10 default camera configs
      math.ts              Euler <-> quaternion helpers
    ui/
      CameraPanel.tsx      selected-camera editors
      ProbePanel.tsx       selected-probe position + per-camera visibility readout (§12.3)
      SectionPanel.tsx     selected-section orientation + range + aggregation editor (§13.6)
      VolumePanel.tsx      selected-volume position/rotation/size + zone reassign (sampling_volumes.md §6.1)
      ZonePanel.tsx        selected-zone name + member count + per-zone stats (sampling_volumes.md §6.2)
      SceneHierarchy.tsx   scene hierarchy tree (Cameras/Probes/Sections groups + Zones umbrella, enable/visibility toggle, add "+" menu, duplicate/delete context menu) (§5.5)
      OverlayControls.tsx  overlay mode + intensity scale + resolution slider
      ViewportLayerMenu.tsx  top-right eye-button dropdown: Coverage/Sections/Cameras/Zones visibility checkboxes (§2.4)
      ViewSelector.tsx     top-middle View dropdown: Perspective/Top/Front/Right camera selection (§2.4)
      SectionHeatmapControls.tsx  global section colormap + legend (§13.6)
      SamplingVolumeControls.tsx  zone tool: useZones toggle, generate, levels, marked readout (sampling_volumes.md §6.3)
      StatsPanel.tsx       coverage summary readout
      SectionStatsPanel.tsx  selected-section coverage stats (§13.7)
      RunBar.tsx           Run button + auto-run toggle + stale/backend indicators
```

The app is a **three-column** flex layout (desktop only, §1):

- **Left panel** — the scene inspector: a **"Scene"** panel with **Load**/**Save**
  scene-file actions (`SceneFileControls`, §14.7) at the top, then the
  `SceneHierarchy` tree, then the selected entity's editor
  (`CameraPanel`/`ProbePanel`/`SectionPanel`/`VolumePanel`/`ZonePanel`) below it. The
  hierarchy grows to fill the column and scrolls internally; the detail panel
  sits below (and shows a placeholder when nothing is selected). A **draggable
  divider** between the two resizes the split: dragging sets the detail panel's
  height and the hierarchy takes the remainder, with the detail panel scrolling
  internally when its content exceeds that height. The detail panel is the sole
  scroll region for the object editor — its inner lists (e.g. the probe's
  per-camera visibility list) do not scroll independently, so the object editor
  never shows a nested second scrollbar. Both sides keep a minimum height. Until
  first dragged the detail panel uses its natural height; once dragged, the
  chosen split is remembered across reloads (localStorage).
- **Center** — the 3D viewport with its overlaid toolbars and top-middle **View
  selector** (§2.4); a passive **orientation-axis triad** at its **bottom-left**;
  and, at the **bottom-right**, the floating **section-heatmap legend**
  (`SectionHeatmapControls`), shown only when the section layer is visible and at
  least one section exists (§13.6).
- **Right sidebar** — the run/results controls: `RunBar`, `OverlayControls`,
  `SamplingVolumeControls` (the zone tool, above the stats since it governs the
  coverage denominator), `StatsPanel`, and (when a section is selected)
  `SectionStatsPanel` (§13.7). The section-heatmap legend is **not** here — it floats
  over the viewport (see Center, §13.6).

Both side columns share the same fixed width and are not collapsible; only the
left column's internal hierarchy/detail split is adjustable (via the divider above).

Scroll containers (the side columns, the hierarchy tree, the detail panel) use a
thin custom-styled scrollbar and reserve a **stable gutter** (`scrollbar-gutter:
stable`) so their content does not reflow when the scrollbar appears or disappears.

### 2.3 Render backend

The viewport renders with Three.js's **`WebGPURenderer`** (`three/webgpu`), chosen for
throughput on the volumetric overlay's heavy additive overdraw (§9;
[`volumetric_rendering.md`](./volumetric_rendering.md)).

- It **prefers WebGPU** and **automatically falls back to its WebGL2 backend** when
  `navigator.gpu` is unavailable, so the demo always renders through one code path.
- The overlay's custom shader is authored in **TSL** node materials, which compile to
  **WGSL** on the WebGPU backend and **GLSL** on the WebGL2 backend — one shader, both
  backends.
- `WebGPURenderer` initializes **asynchronously** (`await renderer.init()` before the
  first frame); viewport setup accounts for this.

### 2.4 Viewport toolbar

Overlays sit over the 3D viewport itself (independent of the side panels): a
**top-left** transform toolbar, a **top-middle** View selector, and a
**top-right** layer-visibility dropdown. The viewport also carries a passive
**orientation-axis indicator** at its bottom-left and the floating
section-heatmap legend at its bottom-right (§13.6):

- **Top-left** — transform controls for the selected entity (§5.2):
  - Transform **mode** toggle: **Move** / **Rotate** / **Scale** icon buttons,
    switching `TransformControls`'s mode. Each shows its name as a tooltip on hover
    and is highlighted ("active") when its mode is current. **Scale** is a
    volume-only mode (`sampling_volumes.md` §5) — enabled only while a sampling
    volume is selected (cameras keep Move/Rotate; probes and sections are
    Move-only); on any other selection it falls back to Move.
  - Transform **space** toggle: a single icon button that flips the gizmo
    between **Local** and **Global** space (`TransformControls.setSpace`,
    mapping Local→`'local'` and Global→`'world'`). In Local space the gizmo
    aligns to the camera's own axes; in Global it aligns to the world axes.
    The icon reflects the current space (a box/cube glyph for Local, a globe
    glyph for Global) and the tooltip names the current space and the action
    (e.g. "Local space — click for global"). Defaults to **Local**. Always
    enabled, independent of selection, and shared by both Move and Rotate.
- **Top-middle** — a **View selector** dropdown that chooses which camera the
  viewport renders through. The button shows the current view's name and a
  chevron and opens a menu (same interaction model as the layer dropdown below —
  it closes on an outside click, **Escape**, or re-clicking the button) listing
  the four views with a checkmark on the active one. Labeled **View** (not
  "Camera", which is reserved for the coverage cameras of §5 and the **Cameras**
  layer toggle below):
  - **Perspective** — the default `PerspectiveCamera` (a 3/4 orbit view) with
    full orbit + pan + zoom. Selected on load.
  - **Top / Front / Right** — three **orthographic** cameras (true parallel
    projection) fixed to the world axes: **Top** looks down −Y (screen-up −Z),
    **Front** looks along −Z from +Z (up +Y), **Right** looks along −X from +X
    (up +Y). In an orthographic view orbit/rotation is **locked** — the view
    stays a true axis-aligned elevation — and only **pan** (drag) and **zoom**
    (wheel, dollying the ortho frustum) are available.

  Each view is a persistent camera with its **own remembered framing**: the
  first time a view is selected its frustum/position is auto-fit to the scene
  bounds and centered; afterward it keeps whatever pan/zoom the user left it at,
  so returning to a view restores its last framing (the auto-fit does not re-run,
  and is not re-applied when scene geometry later changes). Selection and the
  transform gizmos (§5.2) stay fully **enabled in every view** — switching
  re-points the orbit controls, `TransformControls`, and the picking raycaster
  at the active camera — so the orthographic views can be used for precise
  axis-aligned placement. The selected view is **transient viewport state**, like
  the layer toggles: it is **not** written to the scene file (§14) and resets to
  Perspective on every load.
- **Top-right** — a single **eye icon button** that opens a **layer-visibility
  dropdown**: a checklist of the viewport-only layers that can clutter or obscure
  the scene. Each row is a checkbox (checked = layer visible) beside the layer's
  glyph and name. Toggling a checkbox flips that layer immediately and leaves the
  menu **open**, so several layers can be changed in one pass; the menu closes on
  an outside click, **Escape**, or re-clicking the eye button. All rows are always
  present and clickable regardless of scene contents — toggling a layer that is
  currently empty is simply a no-op. The rows are:
  - **Coverage** — shows/hides the coverage volumetric overlay (the `visible`
    option, §9.2). This is the only control for overlay visibility — the
    sidebar has no separate checkbox for it.
  - **Sections** — a **master** show/hide-all for the section heatmap layer (§13):
    off hides every section's heatmap; on shows each **enabled** section per its own
    per-section enabled checkbox (§13.6), parallel to how **Cameras** relates
    to per-camera state. Defaults to visible.
  - **Cameras** — shows/hides the whole camera layer (§5.3) at once: every
    camera body plus the selected camera's frustum wireframe.
    Independent of per-camera enable/disable (§5.4): a camera stays
    enabled/selectable from the camera list while the layer is hidden — it's
    just not drawn or clickable in the viewport. Defaults to visible.
  - **Zones** — shows/hides all sampling-volume gizmos (`sampling_volumes.md` §5)
    at once. Purely visual and independent of the `useZones` compute setting
    (`sampling_volumes.md` §6.3) and per-zone enabled state: hiding the gizmos
    does not change the coverage result or the overlay's zone filtering.
    Defaults to visible.

The eye button renders as an icon button in a top-right toolbar strip and is
highlighted ("active") while the dropdown is open.

A passive **orientation gizmo** is pinned to the viewport's **bottom-left** and
continuously reflects the active camera's orientation. It is the Three.js
`ViewHelper` — labeled **X / Y / Z** axis balls (filled colored balls with a
letter on the positive axes, hollow colored rings on the negative axes) over the
scene. It is **read-only**: view changes happen only through the top-middle View
selector, so the helper's click-to-snap is intentionally left unwired.

**Two independent "WebGPU"s.** This render backend is distinct from the SDK's WebGPU
**compute** backend (§3.2): the renderer draws on the main thread, the compute backend
runs the coverage calculation in the worker. They are selected and reported (§10)
separately, and each may independently be WebGPU or its fallback.

---

## 3. Compute execution model

### 3.1 Web Worker

Compute runs off the main thread so the viewport stays interactive and progress
state can animate.

- `src/worker.ts`:

  ```ts
  import { installHost, messageTransport } from '@linkervision/camera-coverage-sdk';
  installHost(messageTransport(self as any));
  ```

- Main thread:

  ```ts
  const engine = WorkerClient.fromWorker(
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  );
  ```

`compute({ onChunkDone })` streams each `ChunkResult` back to the main thread,
where the overlay is (re)built.

### 3.2 Backend selection

1. Try `engine.init({ ...workspace, backend: 'auto' })`.
2. On any failure (e.g. `WEBGPU_UNAVAILABLE`), re-`init` with `backend: 'cpu'`.
3. Display the resolved backend from the returned `GpuCapabilities.backend`
   ("WebGPU" / "CPU") in the UI.

> Note: the SDK README flags the WebGPU path as written-to-spec but not
> runtime-validated; the CPU path is the tested reference. The fallback guarantees
> the demo always runs.

---

## 4. Scene

### 4.1 Geometry

An enclosed rectangular room, **open top**, plus freestanding box obstacles:

- Room interior ≈ **20 (X) × 20 (Z) × 6 (Y, height)** meters. Y is up (glTF Y-up).
- Floor + 4 walls (no ceiling, so the orbit camera can see in). Walls have
  non-zero thickness (built as boxes) so they read as solid geometry.
- **4–6 box obstacles** of varying size/position on the floor, tall enough to
  create occlusion shadows.

Geometry is the `geometry` list of the unified `Scene` (§14.1) — an ordered set of
objects (`room`/`box` primitives and `gltf` references). The **default** scene's
geometry is produced in code by `buildRoom.ts` (the room shell + box obstacles above);
imported scenes may add GLB-referenced meshes (§14).

All geometry objects are reduced to a single indexed triangle mesh
(`positions: Float32Array`, `indices: Uint32Array`, world space, meters — §14.6) used
for **both**:

- rendering in Three.js (primitives as room + box meshes, GLBs with their own
  materials; all surfaces double-sided — §14.6), and
- `engine.loadScene({ positions, indices })`.

### 4.2 Workspace

`WorkspaceConfig` passed to `init`:

- `worldMin` / `worldMax` — the room's AABB (with a small margin).
- `voxelSize` — see §6.
- `chunkSizeXZ` — `10` (default).

---

## 5. Cameras

- **10 cameras**, `MAX_CAMERAS` is 128 so well within range.
- Default placement: CCTV-style around the room perimeter, mounted high near the
  wall tops, angled inward and downward. Defined in `cameras/defaults.ts`.
- Per-camera config maps to `CameraConfig`:
  `{ id, position, rotation (quat xyzw), fov (vertical°), aspect (16/9), near (0.1), far (~30) }`.
- A camera also carries an **editable display name** (§5.6). The app models a camera
  as its own entity — a `Camera` = `CameraConfig` **plus** a `name` — and **converts
  to the SDK's plain `CameraConfig`** (dropping `name`) only at the `setCameras()`
  boundary (§8), the one place the engine type is required. So the name rides **on
  the camera object**, exactly like a probe's or section's; the scene-file `cameras`
  need not match the SDK type (§14.3).

### 5.1 Rotation representation

- The **quaternion is the source of truth** stored per camera.
- The panel exposes **Euler yaw / pitch / roll** sliders, converted to/from the
  quaternion (`cameras/math.ts`). The TransformControls gizmo writes the
  quaternion directly; the Euler sliders are re-derived for display.

### 5.2 Editing interaction

- **Select** a camera by clicking its frustum gizmo in the viewport or its camera
  node in the scene hierarchy (§5.5). Selection is **unified** across cameras, probes,
  sections, zones, and volumes (§5.5, §12.4, §13.8; `sampling_volumes.md` §4.1, §5): the
  viewport pick returns the nearest hit across cameras, probes, and **volumes**; sections
  and zones are selected from the hierarchy only (they have no pickable viewport body).
  Selecting any one entity deselects the others, so only one editor and at most one
  `TransformControls` gizmo is ever active.
- **Deselect** by clicking empty space in the viewport (a click that hits no gizmo
  body — camera, probe, *or* volume — clears the current selection, detaching the
  TransformControls gizmo). Only a genuine click deselects: a click that concludes a
  camera-orbit or TransformControls drag (pointer moved past a small threshold between
  press and release) is ignored and leaves the selection unchanged.
- **Panel sliders** edit the selected camera: position X/Y/Z, yaw/pitch/roll, FOV,
  and **Range (far)** — the detection range / far frustum plane (`CameraConfig.far`),
  slider range 0.5–100 m, step 0.1. Editing it resizes the frustum gizmo (§5.3) live
  and invalidates the displayed coverage result (§5.4).
- **Name field** — a text input at the top of the panel edits the camera's display
  name (§5.6). Unlike the sliders, editing the name is a pure display change: it
  never resizes a gizmo and never invalidates coverage.
- **TransformControls** gizmo (translate + rotate modes, in Local or Global space
  per the §2.4 space toggle) on the selected camera in the viewport, kept in
  two-way sync with the panel.

### 5.3 Frustum gizmos

Every camera renders as a clickable body (its selection target and TransformControls
attach point, §5.2), colored to signal its state. **Only the selected camera also
renders a frustum wireframe** reflecting its `fov`/`aspect`/`far`, so that camera's
aim and coverage volume are visible; the frustum is highlighted and follows selection
alone — it is drawn whenever the camera is selected, including a selected *disabled*
camera (§5.4). A non-selected camera shows only its body, never a frustum, regardless
of enabled or flagged (`CAMERA_INSIDE_GEOMETRY`) state. A disabled camera's body is
dimmed (§5.4). A viewport-level toggle can hide/show the whole camera layer at once
(§2.4).

### 5.4 Enable / disable

- Each **camera node** in the scene hierarchy (§5.5) has a **checkbox toggle** to
  enable/disable that camera, independent of selection. Toggling doesn't change the
  current selection.
- Disabled cameras stay in the scene (dimmed body) and keep
  their position/rotation/FOV editable, but are **excluded from `setCameras()`**
  passed to the engine, so they don't participate in `compute()` — no coverage
  rate is reported for them and they can't be flagged as `CAMERA_INSIDE_GEOMETRY`.
- Toggling a camera marks the result stale, same as any other camera edit (§8.1).
- The overlay's coverage-fraction denominator (`involvedCameraCount`, §9.1) tracks
  the **enabled** camera count, not the total.
- The enabled/disabled state is an **`enabled: boolean`** flag stored **on the
  camera entity** (like a section's, §13.1, or a zone's, `sampling_volumes.md` §6.2) —
  not a side set — so it **round-trips in the scene file** (§14.3). `defaultScene()`
  cameras are all enabled.

### 5.5 Scene hierarchy view

The scene entities are presented as a **scene hierarchy** — a generic tree that
holds cameras (§5) and probes (§12), and is structured to hold further entity types
(e.g. lights, meshes) in the future.

- **Node model.** An app-level `SceneNode` discriminated union (`scene/sceneTree.ts`):
  `{ kind: 'group' }`, `{ kind: 'camera' }`, `{ kind: 'probe' }`, `{ kind: 'section' }`,
  and — for the region-of-interest tool — `{ kind: 'zone' }` (**both selectable and
  expandable**) and `{ kind: 'volume' }` (a selectable leaf). Nodes carry hierarchy and
  identity only; entity payload stays in the canonical arrays — cameras in
  `CameraConfig[]` (§5), probes in `Probe[]` (§12.1), sections in `Section[]` (§13.1),
  zones in `Zone[]`, volumes in `SamplingVolume[]` (`sampling_volumes.md` §2) — which a
  node references by id. The tree is **derived** via
  `buildSceneTree(cameras, probes, sections, zones, volumes)` — no separate mutable node
  state.
- **Structure.** Auto-derived collapsible groups at the root, one per entity type:
  a **"Cameras"** group over the camera nodes, (when any probes exist) a **"Probes"**
  group over the probe nodes, (when any sections exist) a **"Sections"** group, and
  (when any **zone** exists — including an empty one) a passive **"Zones"** umbrella
  over **selectable+expandable zone nodes**, each holding its volume children
  (`sampling_volumes.md` §4.1) — the first
  user-created sub-groups (all other groups are auto-derived by type). No reordering,
  reparenting beyond this one level (future).
- **Rows.** A generic `TreeRow` renders indentation, the expand caret, label,
  selection highlight, and click routing; kind-specific content is dispatched on
  `node.kind`. Camera rows keep the existing checkbox toggle (§5.4), coverage dot,
  coverage-rate badge, and `inside geometry` badge. Probe rows show the probe label
  plus a small **"seen by K" badge** — the count of enabled cameras that see the probe
  (`popcount` of its mask, §12.2), mirroring the camera coverage-rate badge; full
  detail lives in the probe panel (§12.3). The badge is omitted when there is no usable
  mask (no run yet, or no coverage data at the point — §12.3). Section rows keep an
  **enabled checkbox** ("Enable/Disable section", §13.6) and show a small badge with the section's
  **orientation** and its **aggregated coverage** (e.g. `H · mean 47%`), mirroring the
  camera coverage-rate badge; the coverage part is omitted when there is no usable run.
  A group header shows a caret, label, and passive child count.
- **Labels.** A row's label is the entity's **resolved display name** — cameras
  (§5.6), probes (§12.1), sections (§13.1), and zones (`sampling_volumes.md` §6.2)
  each via their **on-entity `name`** — falling back to the default `Camera N` /
  `Probe N` / `Section N` / `Zone N` when blank. **Volume** rows are the one
  exception: they keep showing the raw id (`volume-N`); volume names are out of scope
  (§15).
- **Selection.** The app holds a single **unified selection** — a camera, probe,
  section, zone, *or* volume (`{ kind: 'camera' | 'probe' | 'section' | 'zone' |
  'volume'; id } | null`) — so selecting one deselects the others and only one
  `TransformControls` gizmo is ever attached. Clicking a camera, probe, section, or
  volume node selects that entity (drives the §5.2 panel and gizmo). Clicking a **zone**
  node selects it (drives its panel); its own caret handles expand/collapse. A zone's
  row **enabled checkbox** (independent per zone, decoupled from selection) controls
  whether it contributes to the visualized marked set (`sampling_volumes.md` §7.3).
  Clicking a group header (incl. the "Zones" umbrella) only expands/collapses it and
  does not change the selection.
- **Adding entities.** The "Hierarchy" panel header **"+" menu** creates — **Camera**,
  **Probe**, **Section**, **Zone**, or **Volume**. Cameras/probes/sections spawn at the
  **workspace center** with the next free id and auto-select. A **Zone** creates an empty
  zone (`zone-N`); a **Volume** adds a 1 m cube at the center into the target zone
  (creating "Zone 1" first if none exist) (`sampling_volumes.md` §4.1). Creating a camera
  or a volume marks the result stale (§8.1); creating a probe, section, or empty zone
  does not.
- **Row context menu.** **Right-clicking** a camera, probe, section, zone, or volume row
  opens a context menu with two actions, **Duplicate** (top) and **Delete** (bottom).
  Group headers have no context menu.
- **Deleting entities.** The context-menu **Delete** action removes the row's entity.
  Deleting a **zone** removes it **and all its volumes**. Deleting the selected
  entity clears the selection; deleting a camera, a volume, or a non-empty zone marks the
  result stale (§8.1); deleting a probe, section, or empty zone does not.
- **Duplicating entities.** The context-menu **Duplicate** action creates a **deep copy**
  of the row's entity with the **next free id** (same id prefix) and **auto-selects** the
  copy. The copy carries **every property verbatim** — including `name` (copied exactly;
  a blank name stays blank and its label auto-derives from the new id, §5.6) and the full
  **position/rotation/size**, so the copy initially **coincides with the original** (it is
  then repositioned via its gizmo). Per-kind rules:
  - **Camera** — the copy **inherits the original's enabled/disabled state** (§5.4): a
    disabled camera duplicates to a disabled one.
  - **Section** — the copy is created **not clipping**, even when the original is the
    active clip section; clipping is a single-valued scene-level selection (§13.9), not a
    section property, so it never transfers.
  - **Zone** — duplicates the zone **and fresh copies of all its volumes** (each with a
    new volume id, referencing the new zone); the copied zone keeps the original's
    `enabled` flag.
  - **Volume** — the copy is added to the **same zone** as the original (not the selected
    zone).

  Duplicating a camera, a volume, or a **non-empty** zone marks the result stale (§8.1);
  duplicating a probe, a section, or an **empty** zone does not (mirrors the add/delete
  stale rules above).
- **Expand/collapse** state is ephemeral UI state (default expanded), not persisted
  (§15).
- **Accessibility.** Rendered with `role=tree`/`treeitem`/`group` and
  `aria-expanded`/`aria-selected`; interaction is mouse-driven (no keyboard tree
  navigation yet).

### 5.6 Camera name

Each camera has an **editable display name** — the camera analog of the zone name
(`sampling_volumes.md` §6.2). The `CameraPanel` (§5.2) shows a **Name** text input at
its top, prefilled with the camera's current name, writing back on change (live, no
confirm step). The name is stored **on the app `Camera` entity** (a `CameraConfig`
extended with `name`, §14.1), exactly like a probe's (§12.1) or section's (§13.1)
name; the SDK never sees it — the app drops `name` when it converts to `CameraConfig`
at the `setCameras()` boundary (§8). Rules:

- The camera's **stable identity is `id`** (`cam-N`); the name is a pure display
  label. Renaming never changes `id` or anything the engine sees.
- The value is **trimmed**; an all-whitespace / empty / absent name **falls back to
  the default `Camera N`** (derived from the id) rather than showing a blank label.
  The stored `name` may be blank (unnamed cameras seed blank); the default is derived
  by the label helper, not baked in.
- **No uniqueness requirement** — two cameras may share a name (ids stay distinct).
- Deleting the camera drops its name with it — the name is a field of the camera, so
  there is no orphan to prune (unlike a side map).
- Renaming updates the label **everywhere live** — the hierarchy camera row (§5.5),
  the panel header, and every per-camera reference in the stats (§10, §13.7,
  `sampling_volumes.md` §6.2) — and is **persisted** to `scene.json` (§14.3).
- Renaming is **not** a coverage input: it **never marks the result stale** and
  never triggers a recompute (§8.1), like a zone/section label change.

---

## 6. Resolution control

- `voxelSize` default **0.5 m**; slider range **0.1 – 1.0 m**.
- `voxelSize` is fixed at `init()`, so changing it triggers a full re-run of
  `init` → `loadScene` → `setSampling` (scene mesh is cached and reused).
- The slider is **debounced**; the UI shows an estimated voxel count for the
  chosen size and warns near the low end.
- On the CPU backend a fine grid may be slow or rejected with `SCENE_TOO_LARGE`;
  this is caught and surfaced as a message rather than left to hang.

---

## 7. Sampling

- **Default (no zones):** the full volume,
  `setSampling({ regions: [{ type: 'full' }] })`. Coverage is evaluated over every
  valid (free-space `EMPTY_SPACE`) voxel in the room; voxels inside walls/boxes are
  invalid and excluded by the SDK.
- **Zone-driven (region of interest):** when the user enables zones and at least
  one **sampling volume** exists, the run derives the SDK regions from the world
  AABB of every volume — `setSampling({ regions: volumes.map(v => ({ type: 'box',
  … })) })` — narrowing the sampled set below the full volume. This is the
  region-of-interest tool: user-editable oriented boxes grouped into **zones**,
  seeded from the scene BVH, each zone reporting its own coverage results.

> **Companion spec.** The full behavior of sampling volumes & zones — the model,
> BVH seeding, per-zone aggregation, the enabled-zones marked set, and hierarchy/panel
> integration — lives in [`sampling_volumes.md`](./sampling_volumes.md), which is
> the source of truth for that feature. The edits it made to this document (this
> section among them) keep the two consistent (its §12 table). When zones are
> disabled or no volume exists, sampling falls back to the full volume above, so
> scenes that don't use the tool are unchanged.

---

## 8. Running the calculation

- A **Run coverage** button triggers `compute()` on demand.
- An **Auto-run** checkbox next to the button, **on by default**, triggers
  `compute()` automatically whenever the result is stale (§8.1) instead of
  requiring a manual click.
- `compute({ mode: 1, onChunkDone })`:
  - streams `ChunkResult`s; the overlay is rebuilt from accumulated chunks.
  - a progress/spinner state animates while the worker runs.
- On completion the returned `CoverageSummary` populates the stats panel.

### 8.1 Stale result handling

When a result is displayed and the user then edits a camera, FOV, or the
resolution slider:

- the overlay is **dimmed** and a **"Recompute"** badge appears,
- with Auto-run off, no automatic recompute — the user presses Run again;
- with Auto-run on (the default), a recompute is triggered automatically. It's
  **throttled to at most 10 runs/sec** (a fixed 100 ms poll checks staleness
  and fires the next run only once the previous one has finished), so rapid
  edits — e.g. dragging a camera gizmo — don't queue up overlapping computes.
  Auto-run does **not** retry after a run ends in error (§11); the user must
  press Run again to retry, same as the off case.

Camera edits require only `setCameras(...)` + `compute(...)` (no re-init).
Resolution edits require the full re-init pipeline (§6).

**Sampling (zone/volume) edits** feed `setSampling`, so a **sampling-dirty** flag
is set whenever the volume set, a volume transform, its `zoneId`, a non-empty
zone's deletion, or the `useZones` toggle changes. A run applies
`setSampling(regionsFromVolumes())` when the flag is set (or after a re-init reset
it), then `setCameras` + `compute`, then recomputes per-zone summaries — no re-init
needed (only a `voxelSize` change requires that). **Enabling/disabling a zone** or
**renaming a zone** never marks stale — they re-filter/relabel client-side
(`sampling_volumes.md` §7.2, §7.3, §8).

---

## 9. Coverage visualization

The coverage field is drawn with the **voxel volumetric renderer** — a
visualization-agnostic primitive that takes, per voxel, a `{center, size, intensity,
color}` and draws it as additive volumetric fog. Its technical design (shader,
chord-length math, compositing, tests) lives in
[`volumetric_rendering.md`](./volumetric_rendering.md). **This section owns the
visualization**: which voxels are fed to the renderer and how coverage data maps to
each voxel's `intensity` and `color`. Domain terms are defined in §16. A separate,
flat per-slab coverage visualization — the **section heatmap** — is described in §13.

Voxels are extracted from streamed `ChunkResult`s using
`accessor(result).forEachLeaf((min, size, mask, valid) => …)` and fed into the
renderer incrementally as chunks arrive. Each valid leaf becomes one voxel at world
position `min` with edge `size`; `intensity` and `color` depend on the active mode.

When zones are active, the overlay is filtered to the **enabled-zones marked set**
(`sampling_volumes.md` §7.3): a valid voxel is drawn only if its center falls in the
union of the enabled zones' volumes; voxels outside it read as unmarked and draw
nothing. Enabling/disabling a zone re-filters the retained leaves client-side, with
no recompute.

The overlay is assigned an explicit **render order** (`scene/renderOrder.ts`) that
places it **after** the section heatmap planes (§13.5) and **before** the
sampling-volume fills (`sampling_volumes.md` §5). Because the overlay uses
`depthWrite:false`/`depthTest:true`, depth-testing against the section plane's depth
gives correct per-viewpoint occlusion (§13.5).

### 9.1 Visualization modes

A **mode selector** switches between two mappings from coverage data to the
renderer's per-voxel inputs:

- **Coverage** — the default. **Every valid voxel** is fed. `color` = the
  user-selected **overlay color** (§9.2); `intensity` = the voxel's **coverage
  fraction** (`popcount(mask) / involvedCameraCount`, 0..1, §16). Well-covered
  regions glow bright/solid; weakly covered regions are faint; blind spots
  (fraction 0) contribute nothing and are invisible. This shows **where coverage
  is**.
- **Blind spots** — **only blind-spot voxels** (`mask == 0`, valid) are fed.
  `color` = the same user-selected **overlay color**; `intensity` = 1 (a fixed full
  value, since coverage fraction is 0 here and would otherwise render nothing).
  Uncovered space glows against the scene. This shows **where coverage is absent** —
  the complement of the coverage mode.

Both modes draw with the same **overlay color** (§9.2); the color is a purely
aesthetic global, independent of mode. What each mode encodes is *which* voxels are
shown and how coverage maps to `intensity`, not hue.

The two modes are mutually exclusive; the coverage-fraction denominator
(`involvedCameraCount`) tracks the **enabled** camera count (§5.4).

### 9.2 Controls

`OverlayControls.tsx`, deliberately minimal. Visibility on/off lives only in the
viewport's top-right toolbar (§2.4), not here:

- **Mode** — Coverage / Blind spots.
- **Overlay color** — a hue slider over the full spectrum (0..360°) that sets the fog
  color used by **both** modes. The color is `hsl(hue, 100%, 50%)` — full-saturation,
  so the slider sweeps a clean rainbow; it defaults to **red** (`hue = 0`). Rendered
  with a rainbow-gradient track. Sits immediately **before** Intensity scale.
- **Intensity scale** — the renderer's global brightness multiplier
  (`intensityScale`).

The overlay color is a single user-picked hue shared by both modes (the mode fixes
*which* voxels and the `intensity` mapping, not the hue). The old flat overlay's
"blind spots only" / "hide well-covered" toggles are subsumed by the mode selector;
blind-spot counts also remain available numerically in the stats panel (§10).

---

## 10. Stats panel

From `CoverageSummary`:

- `overallRate` — fraction of valid voxels seen by ≥ 1 camera.
- `perCamera[]` — per-camera `coverageRate`, listed alongside each camera by its
  **display name** (§5.6). Disabled cameras (§5.4) aren't sent to the engine, so they
  have no entry here.
- `validVoxels`, `elapsedMs`.
- **Blind-spot count** — number of valid voxels no enabled camera sees (§16),
  derived as `round(validVoxels × (1 − overallRate))`. Surfaced here numerically so
  the count is available regardless of the active visualization mode (§9.1).
- Active **compute** backend (WebGPU / CPU, §3.2) and **render** backend
  (WebGPU / WebGL2, §2.3), plus current `voxelSize` / voxel count.

When zones are active, these numbers reflect the **enabled-zones union** rather than
the full volume (`sampling_volumes.md` §7.4): `overallRate`, `perCamera`,
`validVoxels`, and the blind-spot count come from the client-side aggregation over
the union of the enabled zones, keeping the SDK summary's elapsed time. Per-zone
numbers are also shown on each zone row and in the `ZonePanel`. With zones off, the
panel is exactly as above (the SDK summary).

---

## 11. Error handling

| Case | Handling |
|---|---|
| `WEBGPU_UNAVAILABLE` on `auto` init (compute) | fall back to CPU (§3.2) |
| WebGPU renderer unavailable | automatic WebGL2 fallback in `WebGPURenderer` (§2.3); no error surfaced |
| `SCENE_TOO_LARGE` (fine voxel on CPU) | catch, show message, keep previous valid state |
| `CAMERA_INSIDE_GEOMETRY` | surface which camera; keep it flagged in the list (disabled cameras are excluded, so never flagged) |
| `TOO_MANY_CAMERAS` | not reachable (10 ≤ 128), but guarded |
| Worker/device errors | reported in a status area; engine re-init offered |

---

## 12. Probes

A **probe** is a user-placed **point** in the scene used to inspect coverage at an
exact location: when a probe is selected, the app reports which enabled cameras can
see that point. Probes are pure **observers** — they are not cameras, never
participate in `compute()`, and never change the coverage field.

### 12.1 Model & state

- A probe is `{ id, position: Vec3, name: string }`. The `name` is an **editable
  display label** stored **on the entity** (like the zone, `sampling_volumes.md`
  §6.2), with the same semantics as the camera name (§5.6): trimmed, blank/absent
  falls back to the default `Probe N`, no uniqueness, never a coverage input, and it
  round-trips in the scene file (§14.3). Probes live in a canonical `probes: Probe[]`
  array in `App.tsx`, parallel to `cameras` (§5). A probe node in the hierarchy
  (§5.5) references its probe by id; the tree carries identity only, like camera
  nodes.
- Probes are **not auto-persisted** across reloads (§15), but they **are** included in
  scene-file export/import (§14).

### 12.2 Visibility query (reuse of computed masks)

A probe's visibility is read from the **most recent completed `compute()` run's
per-voxel camera masks** — not a fresh ray cast (the SDK exposes no arbitrary-point
query; the grid masks already encode line-of-sight + frustum + range per voxel, §7).
The probe's world position is mapped to the voxel that contains it and that voxel's
mask is read:

- world → global voxel `floor((p − worldMin) / voxelSize)` → `(chunkId, i, j, k)`
  via a `WorkspaceGrid` built from the same workspace config used at `init` (§4.2);
- `accessor(chunkResult).getMask/getMaskWord(i, j, k)` gives the camera bitmask, and
  `isValid(i, j, k)` gives voxel validity.

To make this lookup possible the app **retains the streamed `ChunkResult`s** (keyed
by `chunkId`) for the current run, reset at the start of each `compute()`. This is in
parallel with the overlay (§9), which consumes the same stream but keeps only
per-voxel *counts* and drops invalid voxels, so its data can't answer "which cameras,
at this point." The retained SVO is the compact resident form; no extra spatial index
is built, and lookup uses the SDK accessor's own `O(depth)` descent.

- **Bit order.** Bit *n* of a mask is the camera at index *n* in the
  **enabled-camera list passed to `setCameras()` for that run**. The app snapshots
  that ordered id list alongside the retained chunks, so masks decode to the correct
  camera ids even if the live enabled set has since changed. All mask words are
  decoded (correct up to `MAX_CAMERAS` = 128), not just word 0.
- **Resolution.** Because the mask is quantized to the voxel grid, probe visibility
  has voxel-size resolution (§6).

### 12.3 Probe panel (left panel)

When a probe is selected (§5.2), the left panel shows, in place of the camera panel:

- header `Probe — <name>` (§12.1);
- a **Name** text input editing the probe's display name — live, and never marks the
  result stale (§12.1, §5.6);
- **position X / Y / Z** sliders (a point has no orientation — no rotation or FOV);
- a **visibility readout** against the enabled cameras of the retained run:
  - a summary line **"Seen by K of N cameras"** (N = that run's enabled-camera count),
  - one row per enabled camera marked **visible (✓)** or **not visible (–)**, decoded
    from the mask; clicking a camera row selects that camera (§5.2).

Deletion is not offered from this panel — a probe is deleted from the hierarchy
context menu (§5.5).

**States without usable data** — never rendered as "0 of N":

- no `compute()` has completed yet → *"Run coverage to see visibility."*;
- the probe's voxel is invalid or outside the sampled region (`isValid` false, point
  outside the workspace, or no retained chunk covers it) → *"No coverage data at this
  point."*.

**Stale hint.** The masks describe the enabled-camera set of the retained run. When
the live scene has diverged from that run (results stale, §8.1 — a camera moved, was
toggled, added, or deleted since), the panel shows a **stale hint** above the readout
(e.g. "⚠ Coverage out of date — recompute"), because the reported visibility no
longer matches the current scene. With Auto-run on (the default) this reconciles
within one throttled run.

### 12.4 Viewport representation

- Each probe renders as a distinct **marker** — its own color, visually separate from
  camera bodies — via a `ProbeGizmoSet` (`scene/probeGizmos.ts`), pickable like camera
  gizmo bodies. Viewport click-selection (§5.2) returns the **nearest hit across
  cameras and probes**.
- Selecting a probe attaches `TransformControls` in **translate mode only**; the
  rotate mode/toggle (§2.4) is disabled/ignored while a probe is selected (a point has
  no orientation). Dragging the marker edits the probe position, kept in two-way sync
  with the panel sliders.
- Moving a probe **re-reads the existing masks** as it crosses voxel boundaries and
  updates the panel and sightlines live; it does **not** mark results stale or trigger
  recompute (a probe is not part of the coverage input, §12.5).
- **Sightlines.** While a probe is selected, a **green line segment** is drawn from
  the probe to each camera that **sees** it (visible cameras only), rebuilt when the
  probe moves or the masks change. Only the selected probe draws sightlines.

### 12.5 Recompute coupling

- Adding, moving, or deleting a **probe** never marks coverage stale and never
  triggers `compute()`.
- Adding or deleting a **camera** (§5.5) changes the coverage input and marks the
  result stale like any camera edit (§8.1); Auto-run recomputes.

---

## 13. Sections (2D coverage heatmap)

A **section** is a user-placed, axis-aligned **slab** of the workspace whose coverage
is aggregated along one axis and drawn as a **2D heatmap** on a plane inside the
viewport. Like probes (§12), sections are pure **observers**: they read the most
recent completed `compute()` run's per-voxel data and never participate in `compute()`
or change the coverage field. Unlike the volumetric overlay (§9) — one scene-wide 3D
fog — a section is a flat, per-cell heatmap of a chosen slice, and several can coexist.

### 13.1 Model & state

- A section is
  `{ id, orientation: 'horizontal' | 'vertical-x' | 'vertical-z', min: number, max: number, aggregation: 'mean' | 'max' | 'min' | 'blind', enabled: boolean, clipRange: number, name: string }`.
  The `name` is an **editable display label** stored on the entity (like the zone,
  `sampling_volumes.md` §6.2), with the same semantics as the camera name (§5.6):
  trimmed, blank/absent falls back to the default `Section N`, no uniqueness, never a
  coverage input, and it round-trips in the scene file (§14.3).
  `clipRange` (a world-metre width, default `2`) is the section's clip band width
  (§13.9); *which* section clips — if any — is the single scene-level `clipSectionId`
  (§14.1), not a per-section flag. Both are saved in the scene file (§14); everything but
  the global colormap is per-section.
  `min`/`max` are the slab bounds in world meters **along the collapse axis** (the
  section normal), `min ≤ max`. Sections live in a canonical `sections: Section[]`
  array in `App.tsx`, parallel to `cameras` (§5) and `probes` (§12.1). A section node in
  the hierarchy (§5.5) references its section by id; the tree carries identity only.
- The **collapse axis** and the two **in-plane axes** follow the orientation:
  - `horizontal` — collapse **Y**, heatmap spans **X×Z** (a floor plan).
  - `vertical-x` — collapse **X**, heatmap spans **Z×Y**.
  - `vertical-z` — collapse **Z**, heatmap spans **X×Y**.
- Sections are **not auto-persisted** across reloads (§15), but they **are** included in
  scene-file export/import (§14). The global colormap and its legend (§13.5) are
  shared by all sections; everything else in the record above is per-section.

### 13.2 Orientation & range (the slab)

- **Orientation** — a three-way selector (Horizontal / Vertical X / Vertical Z),
  choosing the collapse axis per §13.1.
- **Range** — a single **thickness** slider, **0.1–5 m**. Changing it keeps the slab's
  **center** (`(min + max) / 2`) fixed and grows/shrinks `[min, max]` symmetrically around
  it — the slab's *position* is only ever changed by the viewport drag (§13.8), never by
  this control. A new section defaults to the collapse axis's full workspace-AABB extent,
  **capped to 5 m** and centered on that axis (so on an axis whose extent already fits
  within 5 m, the default is the true full extent; otherwise it's a 5 m slab centered on
  the axis). The slab is `[min, max]` along the normal.
- The heatmap draws on a single **plane at the range midpoint** `(min + max) / 2`,
  perpendicular to the collapse axis. Two faint, **non-interactive outline planes** at
  `min` and `max` mark the slab's extent so the aggregated volume is visible.

### 13.3 Aggregation & cell mapping

The slab is divided into **cells** — one per **voxel column**: the run of voxels along
the collapse axis at a fixed in-plane grid position `(a, b)`, clipped to `[min, max]`.
The heatmap texture holds one texel per cell, so its resolution tracks `voxelSize` (§6)
and reuses the workspace grid's in-plane dimensions.

- **Cell classification (black / transparent / colored).** The zone filter is applied
  **first**. When zones are active, a voxel **outside the enabled-zones union**
  (`sampling_volumes.md` §7.3) is **skipped** — not aggregated and it does **not** classify
  the cell. (It cannot: with zones active the SDK samples only the enabled volumes'
  neighborhood, so an out-of-zone voxel is *unsampled*, hence indistinguishable from an
  obstacle via validity alone.) Each cell is then classified by scanning its **in-zone**
  voxels (all of them, when zones are off), distinguishing two kinds of invalidity that the
  app can tell apart: a voxel is **valid** when it is a sampled free-space voxel with data
  (a retained chunk, `isValid` true); **no-data** when its column position maps to no
  retained chunk (outside the sampled region / no data); and an **obstacle** when it is a
  grid voxel the SDK marked invalid (wall, box, enclosed interior — `isValid` false). The
  rules, in precedence order — **valid data wins**:
  - **Colored.** If the column holds **≥ 1** in-zone **valid** voxel, the cell is colored —
    it aggregates those valid voxels and **ignores** any obstacle or no-data voxels sharing
    the column. As long as there is real coverage data anywhere in the column, it is shown.
  - **Transparent (no data).** Otherwise (no valid voxel), if **any** in-zone voxel is
    no-data, **or** the column has **no in-zone voxel at all** (its `(a, b)` lies entirely
    outside the enabled zones), the cell is **transparent** — it renders nothing and reveals
    the scene behind the plane. Transparent cells are **not part of the section's region of
    interest** and are **excluded from the cell total** (§13.7), exactly like out-of-zone
    skips.
  - **Black (obstacle).** Otherwise the column has no valid and no no-data voxel: it is
    **entirely obstacle** (fully solid), and the cell is **black** — a solid silhouette of
    the geometry that fully fills the slab at that `(a, b)`.

  Because valid data wins, obstacle silhouettes shrink to only the **fully-solid** columns,
  and a column that mixes valid voxels with no-data (e.g. a **horizontal** slab taller than a
  shorter sampling volume, poking out the top/bottom) stays **colored** on the strength of its
  valid voxels rather than blacking or vanishing. Only columns with *no* coverage data at all
  disappear (transparent) or, if wholly inside geometry, read black. Enabling/disabling a zone
  re-filters client-side, no recompute.
- **Cell value.** For a colored cell, each **aggregated** voxel (valid, and in-zone when
  zones are active) contributes its **coverage fraction**
  (`popcount(mask) / involvedCameraCount`, 0..1, §16); the cell value is the
  per-section **aggregation** over those voxels:
  - `mean` — average coverage fraction (the section analog of the §9.1 Coverage mode).
  - `max` — best-covered voxel in the column.
  - `min` — worst-covered voxel in the column.
  - `blind` — **blind-spot fraction**: the share of the column's voxels that are blind
    (`mask == 0`).
- **Bit order / enabled set.** Masks decode exactly as for probes (§12.2): bit *n* is
  the *n*-th camera in the **enabled-camera list `setCameras()` received for the
  retained run**, snapshotted alongside the chunks; `involvedCameraCount` is that run's
  enabled count. All mask words are read (up to `MAX_CAMERAS` = 128).

### 13.4 Data source & recompute coupling

- Sections read the **retained `ChunkResult`s of the most recent completed run** — the
  same per-voxel masks that back probes (§12.2), consumed as a third stream consumer
  alongside the overlay (§9) and probe store. No fresh ray cast and no extra spatial
  index; lookup uses the SDK accessor's own descent over the retained SVO.
- Changing a section's orientation, range, aggregation, its enabled state, or the global
  colormap **re-aggregates client-side instantly** and **never** triggers `compute()`.
  Adding, moving, resizing, or deleting a section never marks coverage stale (§8.1) —
  like probes (§12.5), sections are not part of the coverage input.
- Because the heatmap reflects a past run, when the live scene diverges from it
  (results stale, §8.1) the heatmap is **dimmed** and the Section stats panel shows a
  **stale hint** (§13.7), mirroring the overlay's stale dimming and the probe panel's
  stale hint (§12.3). With Auto-run on (the default) this reconciles within one run.

### 13.5 Rendering & colormap

- Each enabled section draws its heatmap on the midpoint plane (§13.2),
  **double-sided**, with **nearest** texture filtering so cells read as crisp blocks
  rather than a smoothed gradient.
- **Colormap.** Colored cells map their value through a single **global perceptual
  colormap — Turbo** (0 → dark blue, 1 → red). Turbo's blue low end stays visually
  distinct from the **black** obstacle cells, which matters because a valid-but-blind
  column reads as value 0. **Obstacle** cells (§13.3) are **pure black**; **no-data /
  empty** cells (§13.3) are **fully transparent** (alpha 0), revealing the scene behind
  the plane. The heatmap material discards fully-transparent texels via a small
  `alphaTest` (~0.01) so they write no color and no depth — they never occlude the
  coverage overlay (§9) or another section behind them — while stale-dimmed colored cells
  (whose alpha is the reduced overall opacity, §13.4) survive the test. The heatmap plane
  also carries an explicit **render order** (`scene/renderOrder.ts`) so it draws **before**
  the coverage overlay (§9) and the sampling-volume fills (`sampling_volumes.md` §5). Since
  it writes depth while those layers use `depthWrite:false`/`depthTest:true`, occlusion
  between the plane and the fog/fills is resolved by the **depth buffer per viewpoint** —
  fog/fill in front of the slab glows over it, behind it is hidden — rather than by
  Three.js's viewpoint-dependent transparency sorting. The `blind`
  aggregation is drawn through the same colormap (0 → no blind voxels, 1 → all blind); its
  meaning is labeled in the controls and Section stats so the shared legend stays
  unambiguous.
- **Legend scale.** The colorbar gradient is fixed, but its numeric labels are read in
  the units the selected section's aggregation encodes — a **camera count** (`0`..`N`)
  for `mean`/`max`/`min`, a **percentage** for `blind`, or the plain coverage
  **fraction** as a fallback — per §13.6. Value → color is still the same linear
  Turbo mapping over `0..1`; only the *labels* change.

### 13.6 Controls & enablement

- **Per-section editor** — when a section is selected (§5.2), the left detail panel
  shows a **`SectionPanel`** in place of the camera/probe panel: header
  `Section — <name>` (§13.1), a **Name** text input (editing the section's display
  name — live, never marks the result stale, §13.1, §5.6), the orientation selector,
  the thickness slider (§13.2), the aggregation selector, a **Clip toggle button**,
  and a **reveal-range slider** (§13.9).
  The button is **highlighted** while this section is the one clipping (§14.1
  `clipSectionId`); the reveal-range slider is **always shown** (it has no visible effect
  unless this section is the clipping one).
- **Global controls** — the section-heatmap **legend / colorbar**
  (`SectionHeatmapControls`) holds the shared **colormap** (a fixed Turbo gradient).
  It is a **floating overlay pinned to the bottom-right of the viewport** (§2.2) — a
  third viewport overlay alongside the two top toolbars (§2.4), an **opaque card with
  a drop shadow** so it reads over the 3D scene. To stay compact over the scene it
  shows **only** the adaptive caption, the colorbar, and its numeric ticks — **no
  block title and no "Colormap: Turbo" label** (the colormap is fixed, so it needs no
  on-screen name). It is shown **only when the section layer is visible *and* at least
  one section exists** (the master **Section** toggle, §2.4, is on **and** `sections`
  is non-empty); otherwise it is hidden, so it never floats over an empty scene. Its
  visibility is purely presentational and never affects `compute()` or the heatmaps
  themselves. The colorbar's **numeric scale and caption adapt to the
  currently-selected section's aggregation** so the numbers read in the units the
  heatmap actually encodes (§13.5):
  - `mean` / `max` / `min` — the scale is a **camera count**, `0` to `N`, where `N`
    is the enabled-camera count of the **retained run** the selected section's
    heatmap reflects (the coverage-fraction denominator, §13.3; the same count the
    per-camera stats decode against). Because coverage fraction maps **linearly** to
    color, a count `k` sits at colorbar position `k / N`. Labels are **whole camera
    counts** at an **adaptive step** (a "nice" step — 1, 2, 5, 10, 20, 25, 50, … —
    chosen to yield ~5–9 roughly evenly-spaced ticks), always including `0` and `N`.
    Caption: **"Cameras seeing voxel"**.
  - `blind` — the scale is the **blind-voxel share** as a **percentage**, `0%` to
    `100%` (ticks `0/50/100` only); camera counts are meaningless here (§13.5).
    Caption: **"Blind-voxel share"**.
  - **No section selected, or no `compute()` completed yet** (so `N` is unknown) —
    the scale falls back to the plain **coverage fraction** `0`..`1`
    (ticks `0/0.25/0.5/0.75/1`). Caption: **"Coverage fraction"**.
  The colorbar itself (the Turbo gradient) never changes — only its tick labels and
  caption do; the recompute/enable rules of §13.4 are unaffected (relabeling is
  instant and never triggers `compute()`).
- **Enabled.** Each section's hierarchy row has an **enabled checkbox**
  ("Enable/Disable section") toggling that one heatmap on/off (the section analog of
  the camera enable checkbox, §5.4, and the unified `onToggleEnabled` handler, but
  purely visual — sections never compute); a disabled section dims in the tree. The
  viewport top-right toolbar's **Section** toggle (§2.4) is a **master show/hide-all**
  for the whole layer, parallel to Gizmos: master off hides every heatmap; master on
  shows each **enabled** section.

### 13.7 Section stats (right sidebar)

A **"Section stats"** block (`SectionStatsPanel`) in the right sidebar reports coverage
numbers for the **currently-selected section** — the section analog of the coverage
Stats panel (§10). Numbers are computed over the **colored cells** (obstacle and
transparent columns excluded) so they match what the heatmap shows, on the underlying
**coverage fraction** independent of the active display aggregation (§13.3):

- **Context** — orientation and range (`min`–`max` m).
- **Cells** — total / colored / obstacle (black). **Total is the region of interest** —
  colored plus obstacle cells; **transparent no-data/empty cells (§13.3) are excluded**,
  mirroring how out-of-zone voxels are skipped. A section whose slab lies entirely in
  no-data space therefore reports plain zeros (total 0), not a "no run" placeholder.
- **Section coverage** — mean coverage fraction over the colored cells (analog of
  `overallRate`, §10).
- **Blind cells** — count and % of colored cells whose whole column is blind (analog of
  the blind-spot count, §10).
- **Min / Max** — the lowest and highest colored-cell coverage.
- **Per camera** — for each camera enabled in the retained run, the fraction of the
  section's colored cells it sees in **≥ 1** voxel of the column (analog of the
  per-camera `coverageRate`, §10), decoded from the snapshotted enabled-camera list
  and labeled by the camera's **display name** (§5.6).

**States without usable data** — never shown as "0": no section selected → a
placeholder; a section selected but no `compute()` completed → *"Run coverage to see
section stats."*; retained run diverged from the live scene → the numbers plus a
**stale hint** (§13.4).

### 13.8 Viewport interaction & selection

- A section is **selected from its hierarchy row** (§5.5); the **heatmap plane is not a
  pick target**, so clicking it passes through to the cameras/probes (or empty space)
  behind it and the viewport pick (§5.2) is unchanged.
- Selecting a section attaches **`TransformControls` in translate mode only, constrained
  to the collapse axis**: dragging slides the whole slab along its normal, moving `min`
  and `max` together (fixed thickness) — the same "keep thickness, move center" relationship
  the thickness slider (§13.2) mirrors in the other direction (keep center, change
  thickness). Rotate mode and the space toggle (§2.4) are ignored while a section is
  selected (a slab has no orientation to rotate, and translation is axis-locked).
  **Thickness** is changed only via the thickness slider (§13.2), not in the viewport;
  **position** is changed only via the viewport drag, not the panel.

### 13.9 Clip (geometry cross-section)

Exactly **one section at a time** can hide all **scene geometry** (floor, walls, boxes,
glTF — §14.6) outside a band along its **normal (collapse axis)**, giving a CAD-style
cross-section into the scene at the heatmap plane. Which section that is — if any — is the
scene-level **`clipSectionId`** (§14.1); it is **independent of selection**. The band is
**`clipRange` metres wide, centred on the cut plane** `(min + max) / 2` (§13.2):
`[mid − clipRange/2, mid + clipRange/2]`. Because it is centred on the plane, it
**follows the slab** as the section is dragged (§13.8).

- **Scope — geometry only.** The scene geometry group is a **`ClippingGroup`** (the
  WebGPU renderer's clipping path; `Material.clippingPlanes` is not honoured there), and
  the clip sets its two world clipping planes (at the band bounds, intersecting), which
  clip every descendant mesh — floor, walls, boxes, glTF. The coverage overlay (§9),
  cameras, probes, and the section's own heatmap and outline planes (§13.5) live outside
  that group and are **never** clipped.
- **Single, button-driven.** A **Clip toggle button** in the section's `SectionPanel`
  (§13.6) sets `clipSectionId`: clicking it on a section that is **not** the clipping one
  makes it the sole clip (any other section's clip turns off); clicking it on the section
  that **is** clipping turns clipping off entirely (`clipSectionId = null`). Selection is
  irrelevant, as are the master Section toggle (§2.4) and `section.enabled` (§13.6).
  Deleting the clipping section clears the clip. At most one section ever clips.
- **Range control.** A **clip toggle** and a **reveal-range slider** live in
  `SectionPanel` (§13.6); the slider is **always shown**. Its bounds are **`0.1 m` → the
  workspace-AABB extent along the current normal** (dynamic per orientation); at the max
  the band spans the whole scene, so nothing is hidden. Changing orientation re-centres
  the band on the new normal and **clamps** `clipRange` to that axis's extent.
- **No recompute.** Toggling or resizing the clip is purely presentational — it never
  marks coverage stale (§8.1) and never triggers `compute()` (§13.4), like everything
  else about sections.

---

## 14. Scene file (import / export)

The scene can be saved to and loaded from a **scene folder** on disk — a portable
representation of the geometry, cameras, probes, and sections. This uses the
**File System Access API** (`showDirectoryPicker`), so import/export is available
only in Chromium-based browsers; where the API is absent the controls are hidden
(§14.7). View/render preferences (backend, overlay hue, transform space, intensity
scale, panel split) are **not** part of the scene file — they remain app-local.

### 14.1 Unified `Scene` model

- All scene entities live in a single in-memory `Scene`:
  `{ geometry: GeometryObject[], cameras: Camera[], probes: Probe[],
  sections: Section[], clipSectionId: string | null, zones: Zone[],
  volumes: SamplingVolume[], useZones: boolean }`. A **`Camera`** is the app camera
  entity — `CameraConfig` extended with a `name` (§5.6) and an **`enabled`** flag
  (§5.4); the app **filters to enabled cameras and converts each to a plain
  `CameraConfig`** (dropping `name`/`enabled`) at the `setCameras()` boundary (§8), the
  only place the SDK type is required — so probe/section/zone **and camera** names all
  live on their own entities (no side map). `clipSectionId` is the section currently
  clipping the scene (§13.9), or `null`.
  `defaultScene()` seeds `zones`/`volumes` **empty**, `useZones` **false**, and
  `clipSectionId` **null** (`sampling_volumes.md` §9); the default cameras
  (`cameras/defaults.ts`) carry **blank** names, so they display as `Camera N`.
- The startup scene is **constructed in code** as a `Scene` from today's defaults
  (`buildRoom.ts` geometry + `cameras/defaults.ts`); no folder is opened at boot (the
  File System Access API requires a user gesture). `defaultScene()` is the single
  source of the boot state.
- Import **fully replaces** the current `Scene` (§14.4); it never merges.

### 14.2 Folder layout & asset resolution

```
<scene folder>/
  scene.json          # the serialized Scene (§14.3)
  assets/
    shelf.glb         # GLB/GLTF files referenced by scene.json
    ...
```

- A `gltf` geometry object's `src` is a path **relative to the folder root**
  (e.g. `assets/shelf.glb`), resolved through the picked directory handle.
- Referencing anything outside the folder (absolute paths, URLs, `..` segments) is
  invalid and rejected on import (§14.8).

### 14.3 `scene.json` format

- **`formatVersion`** — integer, currently `2` (bumped from 1 for zones/volumes).
  The reader **accepts 1 and 2**; a v1 file reads with empty `zones`/`volumes` and
  `useZones` false. A version **> 2** is rejected (§14.8).
- **Coordinates / units** — world space, meters, right-handed **Y-up**: the same frame
  as the SDK and glTF. Rotations are **quaternions `[x, y, z, w]`** throughout (matching
  `CameraConfig.rotation`, §5.1).
- **`geometry`** — an ordered list of objects, each a discriminated union on `kind`,
  all carrying a transform (`position [x,y,z]`, `rotation [x,y,z,w]`, `scale [x,y,z]`):
  - `room` — parametric shell (`halfX`, `halfZ`, `height`, `thickness`): floor + 4 walls,
    open top (§4.1).
  - `box` — axis-aligned obstacle (`min`, `max`) in the object's local frame.
  - `gltf` — a `src` reference (§14.2) to a GLB/GLTF asset.
- **`cameras`** / **`probes`** / **`sections`** — the serialized cameras, `Probe[]`,
  and `Section[]` (§5, §12.1, §13.1). A **camera** object is the app `Camera` shape —
  the `CameraConfig` fields **plus** an optional `name` **and an optional `enabled`** —
  **not** the bare SDK type; the reader builds the app `Camera`, and the app converts
  to `CameraConfig` only at `setCameras()` (§14.1). A camera's **`enabled`** flag
  (§5.4) is **optional on read**, defaulting to `true` when absent, and — since
  cameras are enabled by default — **omitted on write when `true`** (only
  `enabled: false` is written). A section's per-entity flag is **`enabled`** (renamed from
  the legacy `visible`, which the reader still accepts for back-compat, §14.8). A
  section's **`clipRange`** (§13.9) is **optional on read**, defaulting to `2`
  (clamped to the collapse-axis extent) when absent.
- **`name`** on each **camera**, **probe**, and **section** is the user-edited
  display label (§5.6, §12.1, §13.1), **optional on read** — a blank/missing name
  reads as the default `Camera N` / `Probe N` / `Section N`, never an error — and, to
  keep files tidy, is **omitted on write when blank** (an unnamed entity has no `name`
  key and reads back as its default). Adding `name` is back-compatible, so there is
  **no format-version bump** (still `2`), exactly like `clipRange`/`clipSectionId`/the
  camera `enabled` flag.
- **`clipSectionId`** — which section clips (§13.9), a scene-level `string | null`.
  **Optional on read**, defaulting to `null`; an id that names no loaded section is
  coerced to `null`. Older files (and files with no clip) load unclipped — **no
  format-version bump**.
- **`zones`** / **`volumes`** / **`useZones`** — the region-of-interest state
  (`sampling_volumes.md` §9). Each zone is `{ id, name, enabled }` (the user-edited
  `name` round-trips; blank/missing reads as the default `Zone N`; `enabled` defaults
  to `true` when absent); each volume is `{ id, zoneId, position, rotation, size }`.
  `useZones` is a persisted analysis setting (default `false` when absent).
  Generation levels are **not** persisted (tool state).
- **Ids** are unique within each category; duplicates are rejected (§14.8).

Sketch:

```json
{
  "formatVersion": 2,
  "useZones": false,
  "geometry": [
    { "kind": "room", "halfX": 10, "halfZ": 10, "height": 6, "thickness": 0.3,
      "position": [0,0,0], "rotation": [0,0,0,1], "scale": [1,1,1] },
    { "kind": "box", "min": [-7,0,-7], "max": [-4,2.5,-4],
      "position": [0,0,0], "rotation": [0,0,0,1], "scale": [1,1,1] },
    { "kind": "gltf", "src": "assets/shelf.glb",
      "position": [2,0,3], "rotation": [0,0.707,0,0.707], "scale": [1,1,1] }
  ],
  "cameras": [
    { "id": "cam-1", "position": [-6,5.4,-9.6], "rotation": [0,0,0,1],
      "fov": 60, "aspect": 1.7778, "near": 0.1, "far": 30, "name": "Front door" },
    { "id": "cam-2", "position": [6,5.4,-9.6], "rotation": [0,0,0,1],
      "fov": 60, "enabled": false, "name": "Loading bay (off)" }
  ],
  "probes": [ { "id": "probe-1", "position": [0,1,0], "name": "Aisle 3" } ],
  "sections": [
    { "id": "section-1", "orientation": "horizontal", "min": 0, "max": 2,
      "aggregation": "mean", "enabled": true, "name": "Ground floor" }
  ],
  "zones": [ { "id": "zone-1", "name": "West wing", "enabled": true } ],
  "volumes": [
    { "id": "volume-1", "zoneId": "zone-1",
      "position": [3,1.5,-2], "rotation": [0,0.259,0,0.966], "size": [4,3,6] }
  ]
}
```

### 14.4 Import

1. User picks a folder (`showDirectoryPicker`).
2. Read and parse `scene.json`, then **validate all-or-nothing** — schema,
   `formatVersion`, id uniqueness (per category), object `kind`s, asset-path safety
   (§14.2), and — for sampling — every `volume.zoneId` referencing an existing zone
   and `size` components > 0 (`sampling_volumes.md` §9). Import replaces
   `zones`/`volumes`/`useZones` too (each zone's `enabled` flag comes from the file).
3. Load **every** referenced GLB/GLTF via `GLTFLoader` (from `three/examples`, no new
   npm dependency). Any missing-file or parse failure aborts the import.
4. Only if all of the above succeed: build the merged collision mesh (§14.6),
   **cancel any in-flight compute**, replace the `Scene`, clear the coverage overlay
   and the retained per-run probe/section data (they read "no-data", §12.3/§13.4, until
   the next run), and **require an explicit Run** (§8) — import never auto-computes.
5. On **any** failure the current scene is left **completely untouched** and a single
   clear error is surfaced (§14.8). There is never a half-loaded scene — silently
   dropping an occluder would understate coverage.

### 14.5 Export

- Serializes the current `Scene` to `scene.json` and writes it back into the chosen
  folder **in place** through the directory handle (a true round-trip).
- Export writes **only `scene.json`** — GLB/GLTF bytes are *referenced*, expected to
  already exist under `assets/`. A `gltf` object whose `src` is absent from the folder
  is a **dangling reference** until the file is placed there (and will fail a later
  import, §14.8). Bundling/embedding assets is out of scope (§14.9).

### 14.6 Geometry rendering & collision

- **Rendering** — `room`/`box` primitives render as today (§4.1); `gltf` objects render
  with their own materials from the loaded glTF scene graph, positioned by the object
  transform. **All** renderable geometry — primitives and glTF meshes alike — is forced
  **double-sided** (`side = THREE.DoubleSide`), overriding whatever `side` a glTF file's
  materials authored, so back-faces never cull (e.g. viewing a room from inside, or a
  section cutaway exposing an interior face). This applies only to `side`; every other
  material property from the glTF is preserved.
- **Collision** — **every** geometry object contributes to occlusion. Each object is
  reduced to world-space triangles: primitives generated as before; GLB meshes traversed,
  each mesh's geometry transformed by (node world-matrix × object transform) and
  de-indexed into world-space positions/indices. Non-mesh glTF nodes (embedded lights /
  cameras) are ignored. All triangles are merged into the single indexed `SceneMesh`
  passed to `engine.loadScene` (§4.1).
- **Workspace** — the AABB passed to `init` (§4.2) is derived from the merged geometry's
  bounds (with the existing margin), so imported geometry extending beyond the default
  room is still covered.

### 14.7 UI controls

- **Load** (import) and **Save** (export) actions in a **"Scene"** panel at the
  top of the left panel (§2.2), above the scene hierarchy.
- Where the File System Access API is unavailable, the panel shows an
  explanatory hint instead of the actions — there is no scene-file control in
  that case (no in-app "reset to default"; reloading the page restores the
  boot state, §14.1).

### 14.8 Error handling

| Case | Handling |
|---|---|
| User cancels the folder picker | no-op, scene unchanged |
| `scene.json` missing / not JSON / schema-invalid | abort, keep current scene, show error |
| Newer `formatVersion` (> 2) | abort, keep current scene, show error (v1 and v2 are accepted) |
| Duplicate id within a category (incl. zones, volumes) | abort, keep current scene, show error |
| Unknown geometry `kind` | abort, keep current scene, show error |
| `volume.zoneId` referencing no zone, or non-positive `size` | abort, keep current scene, show error |
| Unsafe `src` (absolute / URL / `..` / outside folder) | abort, keep current scene, show error |
| Referenced GLB missing or fails to parse | abort, keep current scene, show error |
| Export write denied / fails | keep in-memory scene, show error |

### 14.9 Out of scope for this feature

- In-app geometry **authoring** — no add / move / scale / delete of geometry via gizmos
  or panels, and geometry is not selectable/editable like cameras/probes/sections. The
  geometry list is authored by editing `scene.json` or via export (§14.5).
- Embedding or bundling assets (data-URI, zip) — assets stay file references (§14.5).
- Non-Chromium browsers (no File System Access API).
- Additional primitive kinds (cylinder, sphere, …) — use GLB for arbitrary shapes.

---

## 15. Out of scope / future

- Mode 2 (coverage-count thresholding), per-camera coverage isolation view.
- Height-band sampling regions as a live control. (Box/oriented-box sampling
  regions grouped into zones **shipped** as sampling volumes & zones —
  [`sampling_volumes.md`](./sampling_volumes.md); its §13 lists that feature's own
  out-of-scope items — subtractive volumes, an OBB SDK region, multi-zone
  membership, simultaneous multi-zone overlays, per-zone colors.)
- In-app scene *editing* — adding/removing/transforming geometry through the UI. The
  scene file (§14) can carry imported geometry (including GLB meshes), but authoring it
  in-app is out of scope.
- Auto-persisting layouts across reloads (localStorage / autosave); explicit
  scene-file import/export is §14.
- Scene-hierarchy: further entity types (lights, meshes), user-created groups,
  reordering/reparenting, keyboard navigation.
- Probes: richer per-camera detail (distance / angle), sub-voxel visibility (a true
  per-point ray cast instead of reusing the voxel mask), and sightlines for
  non-selected probes.
- Sections: per-section colormaps, non-axis-aligned (oblique) sections, selecting a
  section by clicking its heatmap plane, draggable slab bound handles (editing thickness
  in the viewport), sub-voxel/continuous sampling instead of the voxel-column
  aggregate, and persisting section layouts.

---

## 16. Terminology

Canonical domain language for the app. The rendering primitive that draws the
visualization is described in
[`volumetric_rendering.md`](./volumetric_rendering.md); it is deliberately
coverage-agnostic and defines only its own generic terms (voxel intensity, color).

- **Coverage** — whether, and by how many cameras, a given voxel of free space can
  be seen. The SDK produces, per valid voxel, a **camera bitmask** (which of the
  enabled cameras see it) plus a **valid** flag. Coverage is the app's fundamental
  quantity.
- **Coverage fraction** — for one voxel, `popcount(mask) / involvedCameraCount`: the
  share of the enabled ("involved") cameras that can see it. Ranges 0 (blind spot)
  to 1 (seen by every enabled camera). Normalized, not a raw count. In the Coverage
  visualization mode (§9.1) it maps to the renderer's per-voxel intensity.
- **Blind spot** — a valid free-space voxel that no enabled camera sees (coverage
  fraction 0). Invisible in the Coverage mode; surfaced by the dedicated Blind spots
  mode (§9.1) and numerically in the stats panel (§10).
- **Section** — a user-placed, axis-aligned slab of the workspace whose coverage is
  aggregated along one axis into a 2D heatmap (§13). A pure observer, like a probe.
- **Collapse axis** — a section's normal: the axis along which its voxels are
  aggregated. The heatmap spans the other two (in-plane) axes (§13.1).
- **Column** — the run of voxels along the collapse axis at one in-plane grid position,
  clipped to the slab range; the unit aggregated into one heatmap **cell** (§13.3).
- **Cell** — one texel of a section heatmap, the aggregate of one column. A **colored
  cell** is a fully-valid column; a **black (invalid) cell** is a column containing any
  invalid voxel (§13.3).
- **Blind cell** — a colored cell whose entire column is blind (every voxel `mask ==
  0`); counted in Section stats (§13.7).
- **Section coverage** — the mean coverage fraction over a section's colored cells; the
  section analog of overall coverage (§13.7).
- **Sampling volume** — a user-placed, editable **oriented box**. Unlike a
  probe/section observer, it is **coverage input**: it changes which voxels are
  counted. Belongs to exactly one zone (`sampling_volumes.md` §2, §10).
- **Zone** — a named unit of sampling volumes with its **own coverage results**,
  aggregated over the union of its volumes (`M(z)`). The primary region-of-interest
  unit; a first-class, selectable+expandable scene-hierarchy entity.
- **Marked set** — the valid voxels counted for a given aggregation: `M(z)` for a
  zone, the union of the enabled zones for the visualized set, or all valid voxels
  when zones are inactive.
- **Enabled zone** — a zone whose per-zone `enabled` flag is on, so it contributes
  to the visualized marked set (the union of enabled zones drives the overlay,
  sections, and the main stats panel). Toggled per zone from its hierarchy row
  checkbox, decoupled from selection; toggling is a client-side re-filter, not a
  recompute (`sampling_volumes.md` §7.3).
