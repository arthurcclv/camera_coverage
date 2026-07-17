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
      viewport.ts          WebGPURenderer (async init) + orbit/transform controls, render loop
      cameraGizmos.ts      per-camera frustum gizmos
      probeGizmos.ts       per-probe markers + selected-probe sightlines (§12.4)
      probeVisibility.ts   retained ChunkResults + world-point → camera-mask lookup (§12.2)
      volumetric.ts        voxel volumetric renderer (§2.3, volumetric_rendering.md)
      coverageOverlay.ts   maps ChunkResult coverage → volumetric voxels (§9)
      sceneTree.ts         scene hierarchy node model + derivation (camera + probe) (§5.5)
    cameras/
      defaults.ts          10 default camera configs
      math.ts              Euler <-> quaternion helpers
    ui/
      CameraPanel.tsx      selected-camera editors
      ProbePanel.tsx       selected-probe position + per-camera visibility readout (§12.3)
      SceneHierarchy.tsx   scene hierarchy tree (Cameras/Probes groups, enable toggle, add "+" menu, delete context menu) (§5.5)
      OverlayControls.tsx  overlay visibility + mode + intensity scale + resolution slider
      StatsPanel.tsx       coverage summary readout
      RunBar.tsx           Run button + auto-run toggle + stale/backend indicators
```

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

Two toolbars overlay the 3D viewport itself (independent of the sidebar panels):

- **Top-left** — transform controls for the selected camera (§5.2):
  - Transform **mode** toggle: **Move** / **Rotate** icon buttons, switching
    `TransformControls`'s mode. Each shows its name as a tooltip on hover and
    is highlighted ("active") when its mode is current.
  - Transform **space** toggle: a single icon button that flips the gizmo
    between **Local** and **Global** space (`TransformControls.setSpace`,
    mapping Local→`'local'` and Global→`'world'`). In Local space the gizmo
    aligns to the camera's own axes; in Global it aligns to the world axes.
    The icon reflects the current space (a box/cube glyph for Local, a globe
    glyph for Global) and the tooltip names the current space and the action
    (e.g. "Local space — click for global"). Defaults to **Local**. Always
    enabled, independent of selection, and shared by both Move and Rotate.
- **Top-right** — icon-button visibility toggles for the two viewport-only layers
  that can clutter or obscure the scene:
  - **Overlay** — shows/hides the coverage volumetric overlay (the `visible`
    option, §9.2). This is the only control for overlay visibility — the
    sidebar has no separate checkbox for it.
  - **Gizmos** — shows/hides all camera frustum gizmos (§5.3) at once.
    Independent of per-camera enable/disable (§5.4): a camera stays
    enabled/selectable from the camera list while its gizmo is hidden — it's
    just not drawn or clickable in the viewport. Defaults to visible.

Both render as icon buttons (eye-style glyphs) in a top-right toolbar strip,
highlighted ("active") when the corresponding layer is currently visible.

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

A single indexed triangle mesh (`positions: Float32Array`, `indices: Uint32Array`,
world space, meters) is produced by `buildRoom.ts` and used for **both**:

- rendering in Three.js (as the room + box meshes), and
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

### 5.1 Rotation representation

- The **quaternion is the source of truth** stored per camera.
- The panel exposes **Euler yaw / pitch / roll** sliders, converted to/from the
  quaternion (`cameras/math.ts`). The TransformControls gizmo writes the
  quaternion directly; the Euler sliders are re-derived for display.

### 5.2 Editing interaction

- **Select** a camera by clicking its frustum gizmo in the viewport or its camera
  node in the scene hierarchy (§5.5). Selection is unified across cameras and probes
  (§5.5, §12.4): the viewport pick returns the nearest hit across both, and selecting
  a camera deselects any probe and vice-versa.
- **Deselect** by clicking empty space in the viewport (a click that hits no gizmo
  body — camera *or* probe — clears the current selection, detaching the
  TransformControls gizmo). Only a genuine click deselects: a click that concludes a
  camera-orbit or TransformControls drag (pointer moved past a small threshold between
  press and release) is ignored and leaves the selection unchanged.
- **Panel sliders** edit the selected camera: position X/Y/Z, yaw/pitch/roll, FOV.
- **TransformControls** gizmo (translate + rotate modes, in Local or Global space
  per the §2.4 space toggle) on the selected camera in the viewport, kept in
  two-way sync with the panel.

### 5.3 Frustum gizmos

Each camera renders as a frustum wireframe reflecting its `fov`/`aspect`/`far`, so
aim and coverage volume are visible. The selected camera's gizmo is highlighted.
A disabled camera's gizmo is dimmed and its frustum wireframe hidden (§5.4). A
viewport-level toggle can hide/show all gizmos at once (§2.4).

### 5.4 Enable / disable

- Each **camera node** in the scene hierarchy (§5.5) has a **checkbox toggle** to
  enable/disable that camera, independent of selection. Toggling doesn't change the
  current selection.
- Disabled cameras stay in the scene (dimmed gizmo, no frustum wireframe) and keep
  their position/rotation/FOV editable, but are **excluded from `setCameras()`**
  passed to the engine, so they don't participate in `compute()` — no coverage
  rate is reported for them and they can't be flagged as `CAMERA_INSIDE_GEOMETRY`.
- Toggling a camera marks the result stale, same as any other camera edit (§8.1).
- The overlay's coverage-fraction denominator (`involvedCameraCount`, §9.1) tracks
  the **enabled** camera count, not the total.

### 5.5 Scene hierarchy view

The scene entities are presented as a **scene hierarchy** — a generic tree that
holds cameras (§5) and probes (§12), and is structured to hold further entity types
(e.g. lights, meshes) in the future.

- **Node model.** An app-level `SceneNode` discriminated union (`scene/sceneTree.ts`):
  `{ kind: 'group' }`, `{ kind: 'camera' }`, and `{ kind: 'probe' }`. Nodes carry
  hierarchy and identity only; entity payload stays in the canonical arrays — cameras
  in `CameraConfig[]` (§5), probes in `Probe[]` (§12.1) — which a node references by
  id. The tree is **derived** from those arrays via `buildSceneTree(cameras, probes)`
  — no separate mutable node state.
- **Structure.** Auto-derived collapsible groups at the root, one per entity type:
  a **"Cameras"** group over the camera nodes, and (when any probes exist) a
  **"Probes"** group over the probe nodes. Groups are derived by entity type, not
  user-created; further entity types appear as sibling groups. No reordering,
  reparenting, or user-created groups (future).
- **Rows.** A generic `TreeRow` renders indentation, the expand caret, label,
  selection highlight, and click routing; kind-specific content is dispatched on
  `node.kind`. Camera rows keep the existing checkbox toggle (§5.4), coverage dot,
  coverage-rate badge, and `inside geometry` badge. Probe rows show the probe label
  plus a small **"seen by K" badge** — the count of enabled cameras that see the probe
  (`popcount` of its mask, §12.2), mirroring the camera coverage-rate badge; full
  detail lives in the probe panel (§12.3). The badge is omitted when there is no usable
  mask (no run yet, or no coverage data at the point — §12.3). A group header shows a
  caret, label, and passive child count.
- **Selection.** The app holds a single **unified selection** — a camera *or* a probe
  (`{ kind: 'camera' | 'probe'; id } | null`) — so selecting one deselects the other
  and only one `TransformControls` gizmo is ever attached. Clicking a camera or probe
  node selects that entity (drives the §5.2 panel and gizmo). Clicking a group header
  only expands/collapses it and does not change the current selection.
- **Adding entities.** The "Scene" panel header carries a **"+" icon button** at its
  top-right that opens a small menu of entity types to create — **Camera** and
  **Probe**. Creating an entity spawns it at the **workspace center** with the next
  free id (`cam-N` / `probe-N`) and **auto-selects** it (its gizmo and panel are
  immediately ready). Creating a camera marks the result stale (§8.1, §12.5); creating
  a probe does not.
- **Deleting entities.** **Right-clicking** a camera or probe row opens a context menu
  whose action (for now) is **Delete**, which removes that entity. Deleting the
  currently-selected entity clears the selection; deleting a camera marks the result
  stale (§8.1). Group headers have no context menu.
- **Expand/collapse** state is ephemeral UI state (default expanded), not persisted
  (§13).
- **Accessibility.** Rendered with `role=tree`/`treeitem`/`group` and
  `aria-expanded`/`aria-selected`; interaction is mouse-driven (no keyboard tree
  navigation yet).

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

- Fixed to full volume: `setSampling({ regions: [{ type: 'full' }] })`.
- Coverage is evaluated over every valid (free-space `EMPTY_SPACE`) voxel in the
  room. Voxels inside walls/boxes are invalid and excluded by the SDK.

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

---

## 9. Coverage visualization

The coverage field is drawn with the **voxel volumetric renderer** — a
visualization-agnostic primitive that takes, per voxel, a `{center, size, intensity,
color}` and draws it as additive volumetric fog. Its technical design (shader,
chord-length math, compositing, tests) lives in
[`volumetric_rendering.md`](./volumetric_rendering.md). **This section owns the
visualization**: which voxels are fed to the renderer and how coverage data maps to
each voxel's `intensity` and `color`. Domain terms are defined in §14.

Voxels are extracted from streamed `ChunkResult`s using
`accessor(result).forEachLeaf((min, size, mask, valid) => …)` and fed into the
renderer incrementally as chunks arrive. Each valid leaf becomes one voxel at world
position `min` with edge `size`; `intensity` and `color` depend on the active mode.

### 9.1 Visualization modes

A **mode selector** switches between two mappings from coverage data to the
renderer's per-voxel inputs:

- **Coverage** — the default. **Every valid voxel** is fed. `color` = the
  user-selected **overlay color** (§9.2); `intensity` = the voxel's **coverage
  fraction** (`popcount(mask) / involvedCameraCount`, 0..1, §14). Well-covered
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
- `perCamera[]` — per-camera `coverageRate`, listed alongside each camera.
  Disabled cameras (§5.4) aren't sent to the engine, so they have no entry here.
- `validVoxels`, `elapsedMs`.
- **Blind-spot count** — number of valid voxels no enabled camera sees (§14),
  derived as `round(validVoxels × (1 − overallRate))`. Surfaced here numerically so
  the count is available regardless of the active visualization mode (§9.1).
- Active **compute** backend (WebGPU / CPU, §3.2) and **render** backend
  (WebGPU / WebGL2, §2.3), plus current `voxelSize` / voxel count.

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

- A probe is `{ id, position: Vec3 }`. Probes live in a canonical `probes: Probe[]`
  array in `App.tsx`, parallel to `cameras` (§5). A probe node in the hierarchy
  (§5.5) references its probe by id; the tree carries identity only, like camera
  nodes.
- Probes are **not persisted** (§13).

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

### 12.3 Probe panel (right sidebar)

When a probe is selected (§5.2), the right panel shows, in place of the camera panel:

- header `Probe — <id>`;
- **position X / Y / Z** sliders (a point has no orientation — no rotation or FOV);
- a **visibility readout** against the enabled cameras of the retained run:
  - a summary line **"Seen by K of N cameras"** (N = that run's enabled-camera count),
  - one row per enabled camera marked **visible (✓)** or **not visible (–)**, decoded
    from the mask; clicking a camera row selects that camera (§5.2);
- a **Delete** action (also available from the hierarchy context menu, §5.5).

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

## 13. Out of scope / future

- Mode 2 (coverage-count thresholding), per-camera coverage isolation view.
- Height-band / box sampling regions as a live control.
- Scene editing (adding/removing boxes), mesh import.
- Persisting camera / probe layouts.
- Scene-hierarchy: further entity types (lights, meshes), user-created groups,
  reordering/reparenting, keyboard navigation.
- Probes: richer per-camera detail (distance / angle), sub-voxel visibility (a true
  per-point ray cast instead of reusing the voxel mask), and sightlines for
  non-selected probes.

---

## 14. Terminology

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
