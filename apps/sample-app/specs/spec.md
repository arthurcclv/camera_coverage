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
| 3D rendering | **Three.js `WebGLRenderer`** (WebGL2) with GLSL `ShaderMaterial`s (§2.3); Spark draws 3DGS captures into the same renderer. Driven imperatively inside a `useEffect`/ref (no react-three-fiber) |
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
  specs/navigation.md      Perspective-view camera navigation: wheel/middle/pan/orbit (§2.4)
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
      viewport.ts          WebGLRenderer + orbit/transform controls, render loop; four view cameras (perspective + top/front/right ortho) + bottom-left orientation-axis triad (§2.4)
      navigation.ts        pure Perspective-view navigation math: ground-plane reference distance, wheel/middle step, pan rate, wheel-notch normalisation (navigation.md)
      cameraGizmos.ts      per-camera frustum gizmos
      probeGizmos.ts       per-probe markers + selected-probe sightlines (§12.4)
      probeVisibility.ts   retained ChunkResults + world-point → camera-mask lookup (§12.2)
      volumetric.ts        voxel volumetric renderer, and its own fog scene (§2.3, volumetric_rendering.md)
      fogCompositor.ts     the fog's two-target pass: scene->target, fog max-blended into a second target sharing its depth, composited to the canvas (volumetric_rendering.md §4)
      sceneLighting.ts     the viewport's fixed four-light rig (§2.3.1)
      coverageOverlay.ts   maps ChunkResult coverage → volumetric voxels (§9)
      sectionHeatmap.ts    retained ChunkResults → per-section column aggregate + heatmap texture + stats (§13)
      heatmapLegend.ts     Turbo colormap + hue ramp + legend-scale builders (section camera-count/blind + coverage-fraction + coverage-overlay hue modes) (§13.5, §13.6, §9)
      sectionGizmos.ts     per-section heatmap plane + faint bound outlines + transform target (§13.5, §13.8)
      sceneTree.ts         scene hierarchy node model + derivation (camera + probe + section + zone/volume + constraint group/constraint) (§5.5)
      reorder.ts           hierarchy drag-reorder: pointer hit-test → insertion target + array splice (§5.5.1)
      samplingVolumes.ts   zone/volume model + OBB math + BVH seeding + marked filter + per-zone aggregation (sampling_volumes.md)
      samplingVolumeGizmos.ts  per-volume wireframe boxes + transform target (sampling_volumes.md §5)
      constraintGizmos.ts  per-constraint primitive handles + translucent dilation (camera_placement.md §6.1)
      polylineDraw.ts      the armed polyline draw mode, over §2.4.2's hit test (camera_placement.md §6.2)
      splats.ts            SplatObject model + label + ids + clip-band → SDF box mapping (gaussian_splats.md §2, §5.4)
      splatAssets.ts       which assets/ files the Add 3DGS dialog lists, and in what order (gaussian_splats.md §3.2)
      splatLayer.ts        the splat group in the main scene: SparkRenderer, stream load, decode cache, SplatEdit lifecycle (gaussian_splats.md §4)
    cameras/
      defaults.ts          10 default camera configs
      math.ts              Euler <-> quaternion helpers
    optimize/
      weights.ts           u32 weight tables + harmonic numbers (aim_optimization.md §2.2, §1.2)
      cubeRig.ts           the six 90° capture cameras for a mount point (aim_optimization.md §2.1)
      panorama.ts          ProjectionAccums → weighted angular image + mip pyramid (aim_optimization.md §3.2)
      search.ts            frustum half-spaces, pyramid walk, exhaustive yaw×pitch scan (aim_optimization.md §4.3)
      greedy.ts            the sequential-greedy round loop, engine-free (aim_optimization.md §4.1)
      session.ts           capture slots, camera masks, capture descriptor (aim_optimization.md §3.1)
      useAimOptimizer.ts   session state + the only engine calls (aim_optimization.md §5, §6)
    placement/
      region.ts            constraint membership, measure, nearest point, projection (camera_placement.md §3.2)
      halton.ts            the low-discrepancy sequence + ball map + per-constraint offsets (camera_placement.md §4.1)
      pool.ts              pool split, draw, build-step descriptor, rejection (camera_placement.md §4.1–§4.3)
      leafSet.ts           LeafCubes: build from AggregateResult, rasterize into a bitset (camera_placement.md §2.1)
      analyze.ts           trial loop, prefix curve, knee — engine-free (camera_placement.md §4.4, §4.5)
      usePlacement.ts      session state + the only engine calls (camera_placement.md §3.4, §5)
      mode.ts              the placement mode's lifecycle as a pure reducer + the template line + the Build/Extend/Truncate/Rebuild decision (camera_placement.md §5, §5.1, §3.3.1)
    ui/
      CameraPanel.tsx      selected-camera editors
      ProbePanel.tsx       selected-probe position + per-camera visibility readout (§12.3)
      SectionPanel.tsx     selected-section orientation + range + aggregation editor (§13.6)
      VolumePanel.tsx      selected-volume position/rotation/size + zone reassign (sampling_volumes.md §6.1)
      ZonePanel.tsx        selected-zone name + member count + per-zone stats (sampling_volumes.md §6.2)
      ConstraintGroupPanel.tsx  selected-group name + the Camera placement section: camera template + `Place cameras` (camera_placement.md §5)
      ConstraintPanel.tsx  selected-constraint kind + distance + geometry + vertex list (camera_placement.md §6)
      SplatPanel.tsx       selected-splat name + source + position/rotation/uniform scale + Flip 180° Z (gaussian_splats.md §7)
      AddSplatDialog.tsx   the Add 3DGS dialog: the capture files found in assets/ (gaussian_splats.md §3.2)
      SceneHierarchy.tsx   scene hierarchy tree (Cameras/Probes/Sections/Splats groups + Zones and Constraints umbrellas, enable/visibility toggle, add "+" menu with its nested Constraint submenu and its 3D Gaussian Splat… dialog entry, duplicate/delete context menu, drag-to-reorder within a group) (§5.5, §5.5.1)
      OverlayControls.tsx  overlay mode + intensity scale + resolution slider
      ViewportLayerMenu.tsx  top-right eye-button dropdown: Coverage/Sections/Cameras/Zones/Constraints/Splats/Geometry visibility checkboxes (§2.4)
      ViewSelector.tsx     top-middle View dropdown: Perspective/Top/Front/Right camera selection (§2.4)
      HeatmapLegend.tsx    legend renderer (caption + gradient + ticks); caller picks section (Turbo) vs coverage-overlay (hue) scale (§13.6, §9)
      SamplingVolumeControls.tsx  zone tool: useZones toggle, generate, levels, marked readout (sampling_volumes.md §6.3)
      StatsPanel.tsx       coverage summary readout
      SectionStatsPanel.tsx  selected-section coverage stats (§13.7)
      RunBar.tsx           Run button + auto-run toggle + stale/backend indicators
      OptimizePanel.tsx    aim optimizer: entry points, score heatmap, proposal, summary (aim_optimization.md §5, §6)
      CandidatePositionsPanel.tsx  placement mode, left card 1: pool size + Build + its progress/readout/blocker (camera_placement.md §5.1)
      StrategyPanel.tsx    placement mode, left card 2: max cams / trials / knee / seed + Analyze (camera_placement.md §5.1)
      PlacementReviewPanel.tsx  placement mode, right column: curve, slider, stats, pinned Apply/Close (camera_placement.md §5.2, §5.3)
```

The app is a **three-column** flex layout (desktop only, §1):

- **Left panel** — the scene inspector: a **"Scene"** panel with **Load**/**Save**
  scene-file actions (`SceneFileControls`, §14.7) at the top, then the
  `SceneHierarchy` tree, then the selected entity's editor
  (`CameraPanel`/`ProbePanel`/`SectionPanel`/`VolumePanel`/`ZonePanel`/
  `ConstraintGroupPanel`/`ConstraintPanel`/`SplatPanel`) below it. The
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
  and, at the **bottom-right**, the floating **heatmap legend** (rendered by
  `HeatmapLegend`) — the **section-heatmap legend** when the section layer is visible
  and an enabled section is clipping, otherwise the **coverage-overlay legend** when
  the coverage overlay is visible; hidden when neither applies (§13.6, §13.9, §9).
- **Right sidebar** — the run/results controls: `RunBar`, `OverlayControls`,
  `SamplingVolumeControls` (the zone tool, above the stats since it governs the
  coverage denominator), `OptimizePanel` (the aim optimizer,
  [`aim_optimization.md`](./aim_optimization.md) §5 — a tool rather than a selection
  editor, so it sits here and not in the left column, below the zone tool because it
  optimizes over whatever sampled set that tool defines), `StatsPanel`,
  and (when a section is selected) `SectionStatsPanel` (§13.7). The heatmap legend is **not** here —
  it floats over the viewport (see Center, §13.6). The camera placement tool is **not** in
  this column: it is a mode, not a panel (see **Placement mode** below).

Both side columns share the same fixed width and are not collapsible; only the
left column's internal hierarchy/detail split is adjustable (via the divider above).

**Placement mode.** One flow **replaces both side columns' contents** rather than sitting
in one of them: [`camera_placement.md`](./camera_placement.md) §5's camera placement, opened
by **Place cameras** in the selected constraint group's panel. While it is open the columns
keep their widths and the viewport keeps the middle, but the left holds the tool's two input
cards (`CandidatePositionsPanel`, `StrategyPanel`) and the right its review
(`PlacementReviewPanel`, with Apply and Close pinned below its scroll region). The
hierarchy, the selection inspector, the run bar, the overlay and zone tools and the stats
panel are all unmounted; the placement session lives and dies with the mode. The viewport
keeps its View selector and layer menu and loses its transform toolbar (§2.4); nothing in
the scene is selectable. Apply or Close restores the columns and the prior selection. It is
the only mode of its kind, and what earns it one is not screen space but exclusion: the tool
needs a target that cannot drift, an exit that cannot be navigated away from, and geometry
that cannot be edited under a live build.

Scroll containers (the side columns, the hierarchy tree, the detail panel) use a
thin custom-styled scrollbar and reserve a **stable gutter** (`scrollbar-gutter:
stable`) so their content does not reflow when the scrollbar appears or disappears.

### 2.3 Render backend

The app uses **two GPU backends, for two different jobs**, and they share nothing —
no device, no adapter, no canvas, no thread:

| Job | Backend | Thread |
| --- | --- | --- |
| Coverage analysis — visibility rays, Passes 1–3, mask aggregation | **WebGPU compute** | Web Worker (§3.1) |
| The viewport — geometry, gizmos, coverage fog, splat captures | **WebGL2** | main |

**Compute is WebGPU.** The SDK acquires its own `GPUAdapter`/`GPUDevice` through
`navigator.gpu` inside the worker, and falls back to the CPU reference when WebGPU is
unavailable (§3.2). It never touches the viewport's renderer. Only the *compute*
backend is surfaced in the UI — the `RunBar` badge (§3.2) — because it is the only
one of the two that is still a choice.

**The viewport renders with Three.js's classic `WebGLRenderer`** (the `three` build,
not `three/webgpu`), on **one** canvas.

- The viewport's custom shaders are authored as **GLSL** `ShaderMaterial`s
  (`volumetric_rendering.md` §2). WebGL2 is the only render target, so there is one
  shader language and no cross-backend compilation step.
- `WebGLRenderer` constructs **synchronously** — there is no `await renderer.init()`,
  so `createViewport` is synchronous and App does not stage viewport creation behind
  a promise.
- **The splat captures draw into this same renderer and this same scene**
  (`gaussian_splats.md` §4). Spark, the splat renderer, requires a `WebGLRenderer`:
  `SparkRendererOptions.renderer` is typed to it, it draws with GLSL
  `RawShaderMaterial`, and it reaches into `renderer.properties`, `renderer.state`,
  `renderer.initTexture` and `renderer.xr`. Sharing the renderer is what lets geometry
  and captures **share one depth buffer**, so a capture is occluded by the walls in
  front of it and occludes what stands behind it, like any other scene content.
- **Why not `WebGPURenderer`.** It was the previous choice, taken for raster
  throughput on the coverage overlay's overdraw (§9). It cannot host Spark on
  either of its backends — including its WebGL2 backend, which exposes a
  `WebGPURenderer` API surface, not the `WebGLRenderer` internals Spark reaches for —
  so keeping it meant a second canvas, a second renderer, and **no shared depth**,
  which put every capture behind every mesh. The throughput premise was then measured
  and did not hold at site scale: on the reference site with the overlay on, WebGL2
  ran a steady 17.1–17.4 ms median frame with a 25 ms p95, against WebGPU's
  10.2–19.6 ms median with a p95 blowing out to 101 ms. WebGPU has the higher ceiling;
  WebGL2 has the frame times a user orbiting to judge coverage actually feels. See
  `ai/DECISIONS.md`.
- **A capture appears a few frames after it loads.** Spark's sort runs in a worker, so
  a `SplatMesh` emits no geometry for its first several frames even after its own
  `initialized` promise resolves (`gaussian_splats.md` §4.4). Nothing may treat
  "loaded" as "on screen", and `SparkRenderer`'s own mesh draws one triangle per frame
  regardless of content, so draw-call counts say nothing about whether a capture is
  visible.

### 2.3.1 Scene lighting

The viewport lights the scene with **four fixed lights** — no shadow maps, no
environment map, and no user controls. The goal is legibility rather than realism:
**every surface must be readable from every viewing angle**, since the user orbits
freely to judge coverage and a face that renders black cannot be judged at all.

| Light | Color | Intensity | Position |
| --- | --- | --- | --- |
| `HemisphereLight` | sky `#ffffff` / ground `#6a6f7a` | 1.1 | — |
| `DirectionalLight` (key) | `#ffffff` | 1.4 | `(15, 25, 10)` |
| `DirectionalLight` (fill) | `#ffffff` | 0.5 | `(-15, 8, -10)` |
| `AmbientLight` | `#ffffff` | 0.5 | — |

- The **key** light establishes form; the **fill** light sits roughly opposite it
  and lower, so surfaces facing away from the key are shaded rather than black —
  and the geometry keeps its shape, which a bare ambient lift would flatten.
- The hemisphere **ground** color is a mid grey, deliberately *not* the near-black
  `#30323a` of the UI panel palette: it is bounce light, not chrome, and a dark
  ground color is what makes downward-facing faces read as unlit holes.
- `AmbientLight` sets the floor brightness no surface falls below.
- Loaded glTF materials are used **as authored** — only `side` is overridden
  (§14.6). Consequently a material authored as **fully metallic**
  (`metalness: 1.0`) still renders black under this rig, because a metal surface
  shows only reflections and there is no environment map for it to reflect. That
  is a known limitation of the asset, not a lighting bug; the fix is to author
  non-unit metalness.

The rig lives in `scene/sceneLighting.ts` rather than inline in `viewport.ts`, so
its invariants are testable without a live renderer (which needs a real GPU
adapter).

### 2.4 Viewport toolbar

Overlays sit over the 3D viewport itself (independent of the side panels): a
**top-left** transform toolbar, a **top-middle** View selector, and a
**top-right** layer-visibility dropdown. In the **placement mode** (§2.2) the transform
toolbar is hidden — nothing there is selectable — while the View selector and the layer
menu stay, because the mode's own picture (the pool scatter, the constraint gizmos) is what
the layer menu governs (`camera_placement.md` §5.1). The viewport also carries a passive
**orientation-axis indicator** at its bottom-left and the floating
heatmap legend at its bottom-right (§13.6):

- **Top-left** — tools for the selected entity (§5.2), laid out as **two groups**
  separated by a wider gap than the buttons within a group carry: the **transform**
  group (mode + space) and the **placement** group (**Place on surface**, **Draw
  polyline**). The gap
  is the grouping — there is no divider rule.
  - Transform **mode** toggle: **Move** / **Rotate** / **Scale** icon buttons,
    switching `TransformControls`'s mode. Each shows its name as a tooltip on hover
    and is highlighted ("active") when its mode is current. **Scale** is a
    volume-only mode (`sampling_volumes.md` §5) — enabled only while a sampling
    volume is selected (cameras and **splats** keep Move/Rotate; probes and sections
    are Move-only); on any other selection it falls back to Move. A **splat**'s scale
    is deliberately **not** on the gizmo: it is a single uniform number edited in its
    panel, because the per-axis scale gizmo would shear the capture's Gaussians
    (`gaussian_splats.md` §2.1, §7).
  - Transform **space** toggle: a single icon button that flips the gizmo
    between **Local** and **Global** space (`TransformControls.setSpace`,
    mapping Local→`'local'` and Global→`'world'`). In Local space the gizmo
    aligns to the camera's own axes; in Global it aligns to the world axes.
    The icon reflects the current space (a box/cube glyph for Local, a globe
    glyph for Global) and the tooltip names the current space and the action
    (e.g. "Local space — click for global"). Defaults to **Local**. Always
    enabled, independent of selection, and shared by both Move and Rotate.
  - **Place on surface** — a one-shot placement tool: arm it, then click the scene
    geometry to set the selected entity's position to the point clicked. Its own
    group, separated from the transform buttons above. Enabled **only** for the
    selections that carry a placeable point — a **camera**, a **probe**, or a
    polyline constraint's **selected vertex** (`camera_placement.md` §6.2) — and
    disabled for a section, a zone, a sampling volume, a point or plane
    constraint, a splat, or an empty selection. Highlighted ("active") while armed.
    Specified in §2.4.2.
- **Top-middle** — a **View selector** dropdown that chooses which camera the
  viewport renders through. The button shows the current view's name and a
  chevron and opens a menu (same interaction model as the layer dropdown below —
  it closes on an outside click, **Escape**, or re-clicking the button) listing
  the five views with a checkmark on the active one. Labeled **View**; the word
  "Camera" stays reserved for the coverage cameras of §5 and the **Cameras**
  layer toggle below, which is why the fifth row is named **Selected** — dropping
  the word entirely rather than competing with it:
  - **Perspective** — the default `PerspectiveCamera` (a 3/4 orbit view) with
    full orbit + pan + forward/backward travel. Selected on load. Its navigation
    is specified in [`navigation.md`](./navigation.md): the wheel translates the
    camera along the cursor ray rather than dollying toward a fixed pivot, so it
    is **unbounded** in both directions, and pan is measured against the ground
    plane rather than against a pivot the camera converges on.
  - **Top / Front / Right** — three **orthographic** cameras (true parallel
    projection) fixed to the world axes: **Top** looks down −Y (screen-up −Z),
    **Front** looks along −Z from +Z (up +Y), **Right** looks along −X from +X
    (up +Y). In an orthographic view orbit/rotation is **locked** — the view
    stays a true axis-aligned elevation — and only **pan** (drag) and **zoom**
    (wheel, dollying the ortho frustum) are available. `navigation.md` does
    **not** apply to these views (`navigation.md` §7): under parallel projection
    translating the camera along its own axis changes nothing on screen, and
    ortho pan is already 1:1 at every zoom level.
  - **Selected** — a perspective view rendered from the **currently selected
    camera** (§5), so the viewport shows what that camera sees. Both this row and
    the selector button read the static label "Selected" — never the camera's own
    name. Detailed in §2.4.1.

  Each of those **first four** views is a persistent camera with its **own
  remembered framing**: the first time a view is selected its frustum/position is
  auto-fit to the scene bounds and centered; afterward it keeps whatever framing
  the user left it at — for the Perspective view that framing is the **camera
  pose alone**, since its orbit pivot is per-gesture scratch
  (`navigation.md` §3) —
  so returning to a view restores its last framing (the auto-fit does not re-run,
  and is not re-applied when scene geometry later changes). Selection and the
  transform gizmos (§5.2) stay fully **enabled in those four views** — switching
  re-points the orbit controls, `TransformControls`, and the picking raycaster
  at the active camera — so the orthographic views can be used for precise
  axis-aligned placement. The **Selected** view is the exception on both
  counts: it has no remembered framing, no transform gizmo, and inert viewport
  clicks (§2.4.1). Whichever view is **active** is **transient viewport state**, like
  the layer toggles: it is **not** written to the scene file (§14) and resets to
  Perspective on every load.
- **Immediately right of the View selector** — a **Reset view** button: an
  icon-only button that **re-frames the active view** on the scene bounds as they
  are *now*, discarding whatever framing the user has navigated to.
  - **Perspective** keeps its current viewing **direction** and is moved back
    along it until the scene's bounding **sphere** fills the padded frustum.
    Direction is preserved rather than reset to the startup 3/4 elevation so the
    button reads as "frame the scene", not "undo my orientation". The sphere
    rather than the bounding **box** so that the same reset lands the camera the
    same distance away from every viewing angle — a box's projected extent
    depends on the angle it is viewed from, so fitting it would make the button's
    result depend on where the user happened to be looking. It costs a little
    extra margin on a long, thin workspace.
  - **Top / Front / Right** re-run the same auto-fit they got on first activation.
    This is therefore also the only way to re-fit a view **after scene geometry
    changes**, which the one-time auto-fit deliberately does not do by itself.
  - **Selected** has no framing of its own (§2.4.1), so the button is **disabled**
    in that view — dimmed, inert, and carrying a tooltip with the reason, exactly
    as the selector's own Selected row is when no camera is selected.

  For the Perspective view this is the **only** way back from a camera that has
  been flown far from the scene, since nothing limits how far it may travel
  ([`navigation.md`](./navigation.md) §5). Re-framing is **transient viewport
  state** like the active view itself: it writes nothing to the scene file (§14).

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
    just not drawn or clickable in the viewport. The layer toggle and the
    per-camera flag hide independently; §2.4.3 covers the flag. Defaults to
    visible.
  - **Camera names** — shows/hides the per-camera name labels (§5.3) without
    hiding the cameras themselves. **Subordinate to Cameras**: with the camera
    layer hidden there is no body to sit beside, so the labels are hidden too
    whatever this row says. It is the escape from the wall of text a site with
    ~100 cameras draws when zoomed out — the labels keep a constant pixel size by
    design, so distance never thins them. Defaults to visible.
  - **Zones** — shows/hides all sampling-volume gizmos (`sampling_volumes.md` §5)
    at once. Purely visual and independent of the `useZones` compute setting
    (`sampling_volumes.md` §6.3) and per-zone enabled state: hiding the gizmos
    does not change the coverage result or the overlay's zone filtering. The
    layer toggle and the per-zone flag hide independently; §2.4.3 covers the
    flag. Defaults to visible.
  - **Constraints** — shows/hides all camera-constraint gizmos and the placement
    tool's pool scatter (`camera_placement.md` §6.1, §5.2) at once. Purely visual:
    constraints are not analysis inputs (`camera_placement.md` §1.1), so hiding them
    cannot change any number. The layer toggle and the per-constraint/per-group
    flag hide independently; §2.4.3 covers the flag. Defaults to visible.
  - **Splats** — a **master** show/hide-all for the 3D Gaussian Splat layer
    (`gaussian_splats.md` §5.2): off hides every capture; on shows each per its own
    row checkbox, parallel to how **Cameras** relates to per-camera state. Purely
    visual — splats are not analysis inputs (`gaussian_splats.md` §1.1) — and
    implemented as the splat group's visibility, so hiding the layer costs nothing.
    Defaults to visible.
  - **Geometry** — shows/hides the **rendered** scene geometry (floor, walls, boxes,
    glTF — §14.6) at once. It hides **drawing only**: the merged collision
    `SceneMesh`, the workspace AABB, and every coverage result are untouched, so it
    never marks the result stale. This is the row that makes a splat capture
    visible — splats draw behind opaque, double-sided geometry (§2.3), so hiding the
    model is how the real site is seen behind the same cameras and the same overlay
    (`gaussian_splats.md` §5.3). Defaults to visible.

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

### 2.4.1 Selected view

The **Selected** view (§2.4) renders the viewport through the camera
currently selected in the scene (§5), so the viewport answers "what does this
camera see?" — the question the coverage overlay and the frustum wireframe can
only answer indirectly. It is a live view *of a scene entity* rather than a free
editor camera, and that difference drives everything below.

**Binding to the selection.** The view always renders through the **current**
selection, so selecting a different camera in the hierarchy (§5.5) cuts the
viewport to that camera's eye immediately — clicking down the camera list walks
the rig one view at a time. Consequently:

- The menu row is **disabled** (dimmed, non-clickable, tooltip "Select a camera
  to use this view") whenever the selection is not a camera.
- It is enabled for **any** selected camera, including a **disabled** one (§5.4):
  a disabled camera still has a pose and FOV, and previewing what it *would* see
  is how one decides whether to enable it — the same reasoning by which §5.3
  draws the frustum for a selected disabled camera. Nothing in the view marks the
  disabled case specially; the coverage overlay simply shows no contribution from
  that camera, because it took no part in the run.
- If the selection stops being a camera while the view is active — a probe,
  section, zone, volume, or splat is selected, or the selection is cleared — the
  viewport **reverts to Perspective**. An active Selected view therefore
  always implies a selected camera; there is no empty state to render.
- **Splat captures render in this view too** (`gaussian_splats.md` §4.3): the splat
  layer draws the same camera object the WebGPU renderer does, so with the geometry
  layer hidden (§2.4) this view shows what the camera sees **of the real site** — the
  closest the app gets to the question `apps/splat-camera-export` answers, live and
  while aiming.
- The view has **no remembered framing** and is never auto-fit: its framing is
  derived wholly from the selected camera, so there is nothing to remember. Like
  the other views it is transient state, never written to the scene file (§14).

**Framing and the frame guide.** The rendered frustum is **derived from**, not
copied from, the camera. A camera's `aspect` (16/9 by default) rarely matches the
viewport's, so rendering at the camera's exact FOV would either crop its image or
fill the viewport with scene the camera cannot see. Instead the rendered vertical
FOV is **expanded so the camera's true image fits inside the viewport with a
constant padding on all sides**, at any window shape, and a **frame guide** marks
the true image bounds:

- The guide is a **1px outline in the selected-camera yellow** (`#ffd23f`, the
  §5.3 selection color) — that camera's frustum seen head-on. Geometry **inside**
  the guide is what the camera sees; geometry outside it is not.
- There is **no dimming** of the region outside the guide. The padding band
  renders at full brightness as legible context, showing what a small pan or a
  wider FOV would gain.
- The guide rectangle is produced by the **same pure fit function** that yields
  the rendered FOV — one computation feeding both — so the outline and the render
  can never disagree. It is recomputed when the viewport resizes or the camera's
  FOV/aspect changes.
- **Clip planes** are the viewport's own generous perspective near/far, **not**
  the camera's `near`/`far`. The camera's `far` is its detection range, and
  clipping the scene there would leave the view unreadable in a large scene; the
  coverage overlay (§9) already conveys range.

**Navigation is replaced by aiming.** Orbit, pan, and zoom are **all disabled**
in this view: the viewport *is* the camera's image, and any orbit or zoom would
show coverage the camera does not actually have. A **left-drag instead aims the
selected camera**, writing its rotation — the gesture is specified in §5.2.

**Gizmos.** The selected camera's own **body and frustum wireframe are hidden**
while the viewport renders through it (§5.3), as is its `TransformControls` gizmo:
all three are degenerate at the eye point (the frustum's edges project exactly
onto the image borders, and the gizmo's handles surround the viewer). Everything
else keeps drawing — the **other** cameras' bodies (so their placement within
this camera's field of view is visible), probes, sections, sampling volumes, the
coverage overlay, the grid, and the bottom-left orientation gizmo, which mirrors
this camera's orientation as it does any other view's.

A wall-mounted camera looks across the workspace at a grazing angle, so the
coverage overlay (§9) can read as a dense wall of fog here rather than the
translucent haze the Perspective view's steeper elevation gives. This is
**accepted**: dense fog along a ray genuinely means a lot of covered volume in
that direction, and the **Coverage** row of the layer dropdown (§2.4) is the
one-click escape hatch.

The **top-left transform toolbar** (§2.4) stays **enabled** in this view even
though no `TransformControls` gizmo is drawn; the mode and space it sets simply
take effect on returning to another view. **Place on surface** (§2.4.2) is the one
top-left tool that is not merely deferred here: it is live in this view, and is the
sole exception to the inert-click rule above.

### 2.4.2 Place on surface

A one-shot placement tool in the top-left toolbar's second group (§2.4): **arm it,
then click the scene geometry, and the selected entity's position becomes the point
clicked**. It exists because positioning by gizmo drag or by typing coordinates
both make "put this camera on *that* wall" an indirect exercise — the geometry
already knows where its surfaces are, so a click can name one directly.

**Supported kinds.** Only the selection kinds that carry a `position` are
placeable: a **camera** (§5), a **probe** (§12), and a **polyline constraint's
selected vertex** (`camera_placement.md` §6.2). A section is a set of bounds
rather than a point (§13.1), a zone has no transform at all, and a sampling
volume's `position` is its box *centre* — placing it on a surface would bury half
the box below that surface — so all three leave the button **disabled**. A
**splat** carries a `position` but is disabled too, for a different reason: its
registration is a whole-capture frame, not a point to drop on a wall
(`gaussian_splats.md` §7). The
supported set is a single named list in the code, not a condition spelled out at
each use site, and widening it is a deliberate edit that every consumer must be
updated for.

**The vertex is the one target that is not an entity.** It is a *sub-selection* on
a selected constraint (`camera_placement.md` §6.1), so the tool is enabled by the
pair — a `constraint` selection whose constraint is a polyline, plus a selected
vertex — and its click writes that vertex rather than the constraint's own
`position`, which a polyline does not have. It is here rather than in a gesture of
its own because a vertex *is* a point on a wall or a rail: "put it on that
surface" is the same question the tool already answers, and answering it twice in
two ways would be the odd choice.

**Arming.** Clicking the button arms the tool; it is **one-shot**, disarming as
soon as a placement succeeds. While armed:

- The `TransformControls` gizmo is **detached**, so the whole viewport is
  placement surface with no dead zone around the selected entity and no ambiguity
  about whether a drag near it moves it or aims the ray. It re-attaches on disarm.
- The pointer shows a **crosshair** over the viewport, and the button is
  highlighted ("active").
- Viewport clicks **do not select or deselect** — the §5.2 pick and the
  deselect-on-miss rule are both suspended for the duration.
- **Orbit, pan, and zoom keep working**, so the surface to click can be brought
  into view. The §5.2 click-vs-drag threshold still applies: a click that concludes
  a drag past the threshold places nothing.

Besides a successful placement, the tool disarms on **re-clicking the button**, on
**any change to the selection** (including its being cleared, or the entity being
deleted — otherwise the next click would move an entity the user is no longer
looking at), and on **Escape**. Escape pressed while a numeric text field (§5.2.1)
holds focus reverts that field only and leaves the tool armed, since Escape is
already that field's revert key.

**A repeating variant exists.** The **polyline draw mode** (`camera_placement.md` §6.2)
reuses every rule in this section — the gizmo detach, the crosshair, the suspended pick and
deselect, the surviving orbit/pan/zoom, the click-vs-drag threshold, and the hit test
below — and differs only in that it **appends** rather than assigns, is **not** one-shot
(Enter or double-click commits — the double-click contributing no vertex of its own
— Backspace removes the last vertex), and needs no selection. **It has no button in this
toolbar**: it is armed from the hierarchy's "+ ▸ Constraint ▸ Polyline" (§5.5), which is
where every other constraint is created, so the crosshair is its only armed signal here. **Extend** (`camera_placement.md` §6.2) is the same variant bound to a
committed polyline: every click is a committed edit there, so nothing about it
commits or cancels.

**The hit test.** The armed click casts a ray through the active camera and tests
it against the **scene geometry only** (§4.1, §14.6). Gizmos — camera bodies, probe
markers, volume boxes, section planes — and the coverage overlay are **transparent
to the ray**, so a camera body standing in front of a wall never blocks placement
on that wall. Geometry is rendered double-sided (§14.6), so a wall's far face is a
valid target: the tool places on whichever surface is actually visible from the
current viewpoint.

**A splat capture is never a target**, even a visible one filling the click. It is
on another canvas and not in the picked scene at all (§2.3), and the reason is not
merely mechanical: a splat contributes no triangles to the collision mesh, so a
camera mounted on a captured wall would be reported by every subsequent run as
seeing straight through the surface it sits on (`gaussian_splats.md` §1.1). A click
that lands only on a capture is a miss.

When a section is **clipping** the geometry (§13.9), intersections lying outside
the clip band are **discarded** and the nearest surviving intersection wins. The
rule is that only what can be *seen* can be clicked; without it the ray would land
on surfaces the clip has hidden and the resulting position would appear to come
from nowhere.

**A miss is a no-op.** A click that hits no eligible surface — empty space, or only
clipped-away geometry — places nothing, leaves the selection untouched, and leaves
the tool **armed**, so the user can simply click again. A mis-aim is not a command.

**The result.** The position written is the **raw intersection point**, with no
offset along the surface normal, and **only** the position: rotation is never
touched, so a camera placed on a wall keeps the orientation it had and is aimed
afterwards by the Rotate gizmo, the §5.2 aim drag, or the panel fields. Two
consequences are **accepted deliberately** rather than corrected:

- A position lying exactly on a surface can, through floating-point error, resolve
  to the geometry's interior, self-occluding the camera's rays and yielding little
  or no coverage for it; the analogous probe lands in an obstacle voxel and reads
  as invalid (§12.2). The fix in both cases is a small manual nudge in the panel.
- The app has **no undo**, so a stray armed click must be recovered from by
  retyping the position. One-shot arming is what keeps that window narrow.

The edit is applied through the **same path as any other position edit** of that
entity, so the established recompute coupling holds unchanged: placing a camera
marks the coverage result **stale** (§5.4, §8.1); placing a probe does **not**
(§12.5).

**Availability across views.** The tool works in **all five views** (§2.4),
including **Selected** (§2.4.1). It is safe there precisely because placement never
changes the selection, so it cannot eject the view back to Perspective — the reason
clicks are otherwise inert in that view.

An active Selected view always implies a selected **camera** (§2.4.1), so the only
entity placeable from it is **the camera being rendered through**: clicking a
surface mounts that camera onto the spot, and the view immediately jumps to the new
vantage point, since the viewport *is* that camera's image. Aiming first and then
clicking the wall the camera already faces is the most direct way to mount a camera
where it can see a particular area. A probe can never be placed from this view —
selecting one reverts the viewport to Perspective before the tool could fire.

While the tool is armed in the Selected view a drag still aims the camera (§5.2),
and the click-vs-drag threshold — which that view otherwise has no use for —
applies again so that an aim drag places nothing.

Whether the tool is armed is **transient viewport state**, like the transform mode
and the layer toggles: never written to the scene file (§14), and never armed on
load.

---

### 2.4.3 Disabled entities

`enabled: false` — on a camera (§5.4), a section (§13.1), a zone
(`sampling_volumes.md` §6.2), a constraint / constraint group
(`camera_placement.md` §3.1), or a splat (`gaussian_splats.md` §5.1) — means the
entity **draws nothing in the viewport**.
Before this rule each kind chose its own answer: sections vanished, cameras and
zones and constraints dimmed. A large layout disables in **bulk** — Apply parks its
surplus cameras with this very flag (`camera_placement.md` §9.4) — and a dimmed body
is still a body: at ninety-odd cameras the dim ramp is clutter that reads as a
rendering fault rather than as an off switch. One rule, six kinds.

**Selection wins.** While an entity is the current selection it draws anyway, at a
**selected-disabled** tier between selected and gone. Selection is now the only
moment a disabled entity is on screen, so it is the moment that must carry the cue;
finding it indistinguishable from an enabled one would leave re-enabling to
guesswork. It is also what keeps a disabled entity editable without a round trip
through its checkbox: its hierarchy row (§5.5) selects it, it appears,
`TransformControls` attaches to something visible, and it goes again on deselect.

| entity | enabled | selected | selected-disabled | disabled |
|---|---|---|---|---|
| camera body | opacity 1 | 1, scale ×1.4 | 0.3 | hidden |
| camera frustum | not drawn | drawn | drawn | hidden |
| section | heatmap + outlines | same | outlines only, opacity 0.35 | hidden |
| zone volume edges | 0.85 | 1 | 0.4 | hidden |
| zone volume fill | 0.10 | 0.18 | 0.06 | hidden |
| constraint fill | 0.10 | 0.16 | 0.06 | hidden |
| constraint handles + lines | 1 | 1 | 0.35 | hidden |

A selected disabled **section** draws its box outlines and *not* its heatmap: the
outline is what a drag needs to see, while the heatmap is measured data the section
is excluded from reporting. This also settles a standing defect — a disabled section
was invisible yet still had `TransformControls` attached (§13.8), so it could be
dragged blind. The constraint's selected-disabled fill (0.06) is deliberately the
same value a selected but **mount-excluded** constraint takes
(`camera_placement.md` §4.1.1): both mean *selected, and contributing nothing*, and
separate values would be a distinction with no decision behind it.

**A splat is the one exception to "selection wins."** A disabled **splat**
(`gaussian_splats.md` §5.1) stays hidden **even while selected**. The exception above
exists so a gizmo's own wireframe is visible to the drag that needs it; a splat is
not a gizmo but a photoreal capture filling the viewport, and re-drawing one the user
has just explicitly hidden — because they clicked its row — would read as the
checkbox not working rather than as a courtesy. There is no selected-disabled tier
for it, and no partial opacity: the checkbox is honoured literally. Its
`TransformControls` gizmo **still attaches**, so a hidden capture can be moved and
re-ticked to check the result, which is the editability the rule was protecting.

**A disabled group hides its constraints.** A group's `enabled: false` skips the
whole group in the search (`camera_placement.md` §3.1), so every constraint under it
is inert whatever its own checkbox says — and hides, whatever its own checkbox says.
The unticked parent row sits directly above the ticked child in the hierarchy, so
the tree still explains the viewport. The group **placement mode is open on** counts
as selected for this rule (`camera_placement.md` §5.1): its constraints draw at the
selected-disabled tier, so Build never scatters candidate dots over rails that
aren't there.

**A group's target zones stay drawn.** A non-empty `zoneIds` overrides each zone's
own `enabled` (`camera_placement.md` §3.1.2), so a globally-disabled zone a group
targets is still the region the pool is built into. The set the volume gizmos
consult is therefore not the enabled zones but the **visible zones** — the enabled
zones **union** every *drawable* group's target `zoneIds`, drawable being the same
set as above (enabled, plus the group placement mode is open on). The zone row stays
unticked while its box draws; that mismatch is the point, and it is the same
override the group panel already reports.

**Hidden is unpickable.** Three.js raycasts invisible objects, so hiding a gizmo
does not stop a click from selecting it. The rule is enforced once, in the shared
`pickHit` of the pickable gizmo sets (§5.2): an entry whose pick target is invisible
— by its own flag or any ancestor's — is skipped. This **subsumes** the per-layer
case the **Cameras** toggle needed (§2.4), which no longer needs its own guard.

**No new state.** No "hide disabled" toggle, no layer-menu row, no `scene.json`
field, no viewport badge counting what is hidden. The hierarchy (§5.5) is the
authoritative list, and it already shows every disabled entity as a dimmed row with
an unticked box.

---

## 3. Compute execution model

### 3.1 Web Worker

Compute runs off the main thread so the viewport stays interactive and progress
state can animate.

- `src/worker.ts`:

  ```ts
  import { installHost, messageTransport } from '@linkervision/camera-coverage-sdk';
  installHost(messageTransport(self as any), { retainChunks: true });
  ```

- Main thread:

  ```ts
  const engine = WorkerClient.fromWorker(
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  );
  ```

**The main thread never receives a `ChunkResult`.** `retainChunks` keeps every run's
per-voxel masks in the worker (SDK spec §16.1) and the app asks for the *derived*
quantities instead, through the aggregation descriptor of §3.3. `onChunkDone` is not
used at all.

### 3.2 Backend selection

1. Try `engine.init({ ...workspace, solidDetection: false, backend: 'auto' })`.
2. On any failure (e.g. `WEBGPU_UNAVAILABLE`), re-`init` with `backend: 'cpu'`
   (same `solidDetection: false`).
3. Display the resolved backend from the returned `GpuCapabilities.backend`
   ("WebGPU" / "CPU") in the UI.

> **`solidDetection` is always off in the demo (§4.2).** The default room is
> open-top, but imported scenes (§14) may be watertight closed rooms whose whole
> interior the flood fill would misclassify as `SOLID_GEOMETRY` — flagging every
> in-room camera `CAMERA_INSIDE_GEOMETRY` and zeroing coverage. Disabling solid
> detection sidesteps this; visibility is unaffected (it always comes from BVH ray
> casting, never occupancy).

> Note: the SDK README flags the WebGPU path as written-to-spec but not
> runtime-validated; the CPU path is the tested reference. The fallback guarantees
> the demo always runs.

### 3.3 Aggregated derivation

Everything this app shows is a small reduction of the coverage masks: per-zone counts,
per-column section cells, a per-voxel camera count for the overlay, a mask lookup per
probe. The app declares those four as one SDK **aggregation descriptor** (SDK spec §19.1)
and receives the reductions; it never scans a voxel itself, on either backend.

| App concept | SDK primitive | Result |
|---|---|---|
| Sampling volume (`sampling_volumes.md` §2.1) | `regions[]` — one OBB per volume, in a stable order | per-volume counts |
| Zone (`sampling_volumes.md` §2.2) | a **group** its volumes declare | per-zone counts, each voxel once |
| Marked set (`sampling_volumes.md` §7.3) | the group the **enabled** zones' volumes also declare, plus `maskRegions` on the slabs and on `leafCounts` | union counts + the client-side filter |
| Section (§13) | one `columns` slab, `axis` from its orientation, `range` from its footprint | per-cell aggregation (§13.3) |
| Coverage overlay (§9) | `leafCounts` | one byte per voxel: the camera count |
| Probe (§12) | `probes[]` | the mask at that point |

A zone owns many volumes and they may overlap, so a zone's total is **not** the sum of
its volumes'; that is what an SDK group is for (SDK spec §19.2). Zone *i* declares group
*i*, and every enabled zone's volumes additionally declare the union group — one
descriptor, both answers, each voxel counted once in each.

**Two entry points, one descriptor.**

- A **run** passes `aggregate` to `compute()`; the reduction happens inside the chunk
  pipeline while the masks are resident, so it costs no extra transfer (SDK spec §19.4).
- A **descriptor edit** — moving a zone or volume, dragging a section, toggling a zone,
  moving a probe — calls `aggregateRetained(spec)`, which re-reduces the masks
  the worker still holds. **No recompute, no ray cast**: none of those edits can change
  a mask bit, and paying a run for them would be paying for the one thing that cannot
  have changed.

Both are `async`, so the panels they feed hold their previous value for a frame rather
than blocking the main thread on the way to a new one. **They are also mutually exclusive.**
A run reuses the descriptor its retained results were produced under, not the newest one:
an incremental run (§8) re-sends only a few chunks, and accumulators laid out by two
different descriptors cannot be merged. So a run never starts while a re-aggregation is in
flight, a re-aggregation never starts while a run is, and a descriptor edit that lands
mid-run is reconciled as soon as that run ends — by re-reducing **every** retained chunk at
once, never by mixing. That is the point: the work that
used to run between a `ChunkResult` arriving and the UI updating is what made a run
visibly stall the viewport even when the engine's own `elapsedMs` was small.

**Camera constraints are absent from the descriptor.** A constraint group and its
constraints (`camera_placement.md` §1.1) generate cameras and nothing else: they do not
appear as regions, do not restrict the marked set, and cannot change a single reduction.
The placement tool's own build steps use a **separate** descriptor of their own
(`camera_placement.md` §3.3), built from the marked filter this one produces.

**Descriptor caps.** The SDK allows 64 regions, 32 groups, 32 slabs, 256 probes (SDK
spec §19.6). The app therefore supports 64 sampling volumes, 31 zones (group 31 is the
marked-set union), 32 sections, and 256 probes.

Over-cap entities are **dropped from the descriptor, never clamped into a neighbour's
slot**, and every drop is surfaced as a warning (§11) naming the entity kind and the cap.
Clamping is the one option ruled out: a section that silently aggregated *another*
section's column is exactly the plausible wrong number this whole descriptor exists to
avoid. Failing the build outright is ruled out too — a 33rd section the user can delete
should not take down the zone panel, the overlay, and the probes with it. So the
descriptor stays valid, the index omits what was dropped, and every read of a dropped
entity is `null`, which the panels already render as "no data".

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

- `worldMin` / `worldMax` — the room's AABB (with a small margin). Derived from the
  merged **geometry** alone (§14.6): a **splat** capture contributes **no bounds**,
  however far it extends, because it is not measured (`gaussian_splats.md` §1.1).
  Widening the analysis volume to enclose a backdrop would add voxels nothing can
  cover and dilute every reported rate.
- `voxelSize` — see §6.
- `chunkSizeXZ` — **derived per scene** via the SDK's `suggestChunkSizeXZ` (SDK spec §3),
  not pinned. On this app's default room that reproduces the 10 m the worked examples
  assume; on a large imported site it grows so a chunk stays near the 2M-voxel target
  instead of partitioning the site into thousands of tiny ones.
- `solidDetection` — **hard-coded `false`**. The SDK's flood-fill SOLID detection
  assumes closed objects float in open free space reachable from the workspace
  boundary; a watertight room inverts that (its free space is *enclosed*), so the
  whole interior — cameras included — would be marked `SOLID_GEOMETRY`. Turning it
  off keeps enclosed interiors `EMPTY_SPACE` (valid, but any voxel truly buried in
  a solid still reads as fully blocked via ray casting). See §3.2.

---

## 5. Cameras

- **10 cameras**, `MAX_CAMERAS` is 128 so well within range.
- Default placement: CCTV-style around the room perimeter, mounted high near the
  wall tops, angled inward and downward. Defined in `cameras/defaults.ts`.
- Per-camera config maps to `CameraConfig`:
  `{ id, position, rotation (quat xyzw), fov (vertical°), aspect (16/9), near (0.1), far (~30) }`.
- A camera also carries an **editable display name** (§5.6), an **`aimLocked`
  flag** (`aim_optimization.md` §4.5, default false, excluding it from the aim
  optimizer), and an optional **`constraintId`** (`camera_placement.md` §6.3) naming the
  camera constraint it is bound to — provenance for a placed camera, and a clamp that
  keeps its position inside that constraint's region. The app models a camera as its own
  entity — a `Camera` =
  `CameraConfig` **plus** those app-only fields — and **converts to the SDK's plain
  `CameraConfig`** (dropping them) only at the `setCameras()` boundary (§8), the one
  place the engine type is required. So they ride **on the camera object**, exactly
  like a probe's or section's; the scene-file `cameras` need not match the SDK type
  (§14.3).

### 5.1 Rotation representation

- The **quaternion is the source of truth** stored per camera.
- The panel exposes **Euler yaw / pitch / roll** as numeric text fields (§5.2,
  §5.2.1), converted to/from the quaternion (`cameras/math.ts`). The rotation row
  is **axis-labeled X / Y / Z** — X = rotation about X (**pitch**), Y = about Y
  (**yaw**), Z = about Z (**roll**), matching the `YXZ` Euler order in
  `cameras/math.ts` — not the words yaw/pitch/roll. The TransformControls gizmo
  writes the quaternion directly; the Euler fields are re-derived for display,
  except a field is not re-derived while it is focused (§5.2.1).

### 5.2 Editing interaction

- **Select** a camera by clicking its frustum gizmo in the viewport or its camera
  node in the scene hierarchy (§5.5). Selection is **unified** across cameras, probes,
  sections, zones, volumes, constraint groups/constraints, and **splats** (§5.5, §12.4,
  §13.8; `sampling_volumes.md` §4.1, §5; `gaussian_splats.md` §6.1): the
  viewport pick returns the nearest hit across cameras, probes, and **volumes**; sections,
  zones, constraint groups, and **splats** are selected from the hierarchy only (they
  have no pickable viewport body — a splat's is on another canvas entirely, §2.4.2).
  Selecting any one entity deselects the others, so only one editor and at most one
  `TransformControls` gizmo is ever active.
- **Deselect** by clicking empty space in the viewport (a click that hits no gizmo
  body — camera, probe, *or* volume — clears the current selection, detaching the
  TransformControls gizmo). Only a genuine click deselects: a click that concludes a
  camera-orbit or TransformControls drag (pointer moved past a small threshold between
  press and release) is ignored and leaves the selection unchanged. Both the pick and
  the deselect are **suspended** while the **Place on surface** tool is armed (§2.4.2),
  which consumes viewport clicks for placement instead.
- **Panel fields** edit the selected camera. **Position** (X/Y/Z) and **rotation**
  (X/Y/Z = pitch/yaw/roll, §5.1) are each a **grouped row of three numeric text
  fields** (§5.2.1). **FOV** and **Range (far)** — the detection range / far frustum
  plane (`CameraConfig.far`), range 0.5–100 m, step 0.1 — remain **sliders**, each with
  an **editable value field** in place of the old read-only readout (§5.2.1). Editing
  any of them resizes the frustum gizmo (§5.3) live where applicable and invalidates
  the displayed coverage result (§5.4, §8.1).
- **Name field** — a text input at the top of the panel edits the camera's display
  name (§5.6). Unlike the position/rotation fields, editing the name is a pure display
  change: it never resizes a gizmo and never invalidates coverage.
- **TransformControls** gizmo (translate + rotate modes, in Local or Global space
  per the §2.4 space toggle) on the selected camera in the viewport, kept in
  two-way sync with the panel.
- **Place on surface** (§2.4.2) — the third way to set position, alongside the
  panel fields and the gizmo: arm the toolbar tool, then click the scene geometry
  to move the camera to the point clicked. Position only, and available for a
  selected camera or probe (§12) only.
- **A bound camera's position is clamped to its constraint.** When the camera carries
  `constraintId` (§5, `camera_placement.md` §6.3), **every** write of its position —
  gizmo drag, a committed numeric field (§5.2.1), Place on surface, the placement tool's
  own Reposition, and the bind itself — is projected into that constraint's region before
  it is stored. Reshaping the constraint re-clamps it too, and because that **moves a
  camera** it marks the result stale, unlike every other constraint edit. So the gizmo slides along the rail and stops at its ends, and a coordinate
  typed off the wall snaps back to the wall. Rotation is never clamped. The camera panel
  names the binding and offers a dropdown to rebind or unbind.
- **Aiming from the camera's own view.** In the **Selected** view (§2.4.1)
  the viewport is the selected camera's image and there is no gizmo, so the
  viewport interactions above are replaced:
  - **A left-drag aims the camera.** The drag **steers the camera**, first-person
    mouselook style: dragging right turns the camera **right**, dragging down tilts
    it **down** — the aim follows the pointer, and the scene sweeps the opposite
    way. Degrees per pixel are derived from the camera's FOV and the rendered image
    size, so a drag spanning the image sweeps **exactly one field of view**: a
    narrow lens gives fine control and a wide lens coarse control, with no fixed
    sensitivity constant.
  - Only **yaw and pitch** are written. **Pitch is clamped to ±89°** and **roll is
    preserved exactly** — the same invariants the rotation fields enforce (§5.1,
    §5.2.1) — so the horizon stays level, as a mounted camera's does, and the
    panel can always represent what the drag produced.
  - The rotation is written **continuously during the drag**, through the same path
    as a `TransformControls` drag: the panel's rotation fields tick live (§5.2.1)
    and the result is marked stale (§8.1) exactly as any other camera rotation
    edit. A drag never writes position; the only way to change position from this
    view is the **Place on surface** tool (§2.4.2), which is live here — otherwise
    position stays with the panel fields and the gizmo in the other views.
  - **Viewport clicks change nothing** in this view: there is no picking, and —
    unlike the deselect rule above — a click on empty space does **not** deselect,
    which would otherwise eject the view back to Perspective (§2.4.1). Selection
    changes come from the scene hierarchy (§5.5). Because clicks are inert there
    is no click-vs-drag threshold to apply: any pointer movement aims. The single
    exception is while **Place on surface** is armed (§2.4.2): a click then places,
    so the click-vs-drag threshold applies again for the duration and an aim drag
    places nothing.

### 5.2.1 Numeric text-field editing

Two kinds of numeric text field appear in the panels, sharing one commit/revert core:

- **Grouped vector fields** — position, rotation, and volume size (`sampling_volumes.md`
  §6.1): one row per vector — a group label (Position / Rotation / Size) followed by
  three fields carrying dim axis letters **X / Y / Z**. A **splat**'s Scale is
  deliberately *not* one of these: it is a single uniform number in an ungrouped field,
  because a per-axis scale would shear the capture (`gaussian_splats.md` §7).
- **Slider value fields** — **every slider in the app** keeps its slider control but its
  formerly read-only value readout is an **editable numeric text field**: FOV and Range
  (§5.2), the resolution voxel size (§6), the section thickness / footprint / reveal-range
  sliders (§13.6), and the sampling zone-level / box-level sliders (`sampling_volumes.md`
  §6.1). The slider thumb and the field are two views of one value; typing commits the
  value the slider would otherwise set.

Shared behavior for every numeric text field:

- A **bound camera's** position fields commit through the projection of
  `camera_placement.md` §6.3, so the committed value may differ from the typed one; the
  field re-derives to what was stored, which is what makes the clamp visible rather than
  mysterious.
- **Commit on blur or Enter**; **Escape** reverts to the last committed value. While
  a field is **focused** it holds the raw typed string and is **not** overwritten by
  re-derived props, so a concurrent gizmo drag, an Euler→quat→Euler round-trip (§5.1),
  or a slider drag of the same value never stomps the caret. An **unfocused** field
  always shows the live value.
- **Invalid or empty** input (anything that is not a finite number) reverts to the
  last committed value on commit — the scene is never written a `NaN`.
- A committed edit marks the result stale (§8.1) **once per commit**, like any other
  camera/volume edit. Probe position is the exception — it never marks stale (§12.5), as
  is every field of a **splat** (`gaussian_splats.md` §1.1).
  Focusing and blurring a field **without a real change** — no edit, or a value that
  rounds/clamps back to the one already stored — is **not** a commit and marks nothing
  stale.

**Grouped vector fields** additionally:

- **Bounds — clamp meaningful, free the rest.** **Pitch ∈ [−89, 89]°** (avoids gimbal
  degeneracy, §5.1) and volume **size ≥ the per-axis floor** (`sampling_volumes.md` §5)
  are clamped; **position, yaw, and roll are unbounded** — any finite value is accepted
  (the former slider min/max on those were arbitrary UI extents and are dropped).
- On **focus**, seed the field with the **rounded display value** — **2 decimals** for
  every vector field (position, rotation, size). The no-op guard compares the raw string against that
  displayed value, so an untouched focus/blur carrying higher precision from a quat
  round-trip or gizmo drag does not spuriously commit.

**Slider value fields** additionally:

- are **always clamped to the slider's [min, max]** — a slider has no unbounded axis.
- commit the **exact typed value, clamped to range only** — never snapped to the
  slider's step — so text entry gives precision the slider drag cannot (e.g. FOV
  42.37, voxel 0.37). **Integer sliders are the exception**: a slider declared
  **integer** (zone level, box level — octree indices) **rounds** its committed value
  to the nearest whole number within range. Step-1 *continuous* sliders like FOV are
  **not** integer sliders and keep their typed decimals.
- on **focus**, seed the field with the **full stored value** rather than the rounded
  readout, trimmed to at most ~6 significant decimals with trailing zeros removed, so
  re-editing a value carrying extra precision — or float noise from a viewport drag —
  is lossless and clean. The no-op guard still holds via the value-equality check (a
  seeded full-precision string that parses back to the stored value commits nothing).
- **Unfocused display precision** is the slider's `digits`: **FOV to 2 decimals**, the
  whole-unit sliders (zone level, box level, overlay hue) to 0, the metric sliders to
  their existing precision.

The parse → clamp → revert decision **and** the focus-seed formatting are **pure
functions** independent of React (`ui/numberField.ts`), so they are unit-tested directly
(see testing notes); the field component and each panel are thin wrappers over them. The
two field kinds are one shared `NumberInput` component parameterized by a **seed mode**
(`display` vs `full`).

### 5.3 Frustum gizmos

Every camera renders as a clickable body (its selection target and TransformControls
attach point, §5.2), colored to signal its state. **Only the selected camera also
renders a frustum wireframe** reflecting its `fov`/`aspect`/`far`, so that camera's
aim and coverage volume are visible; the frustum is highlighted and follows selection
alone — it is drawn whenever the camera is selected, including a selected *disabled*
camera (§5.4). A non-selected camera shows only its body, never a frustum, regardless
of enabled or flagged (`CAMERA_INSIDE_GEOMETRY`) state. A disabled camera draws nothing unless it is the
selection, which dims its body to 0.3 and keeps its frustum (§2.4.3). A viewport-level toggle can hide/show the whole camera layer at once
(§2.4).

**Name label.** Beside each drawn body the camera's display name — the trimmed
`name`, or the `Camera N` fallback (§5.6's rule, shared via `cameraLabel()`) — is drawn
as a **2D label**: **white** 11 px/600 text carrying a **2 px black outline** and no
plate behind it, anchored **4 screen-pixels to the right of the body's own drawn edge**
and vertically centred on it. The gap is measured to the **first glyph**, not to the
texture that carries it: the margin that keeps the outline from being clipped is
transparent, so counting it as gap would make the number in this spec and the space on
the screen two different things — the offset applied is the gap *less* that margin. An
outline rather than a plate because at ~100 cameras the plates are the picture — a grid of opaque black rectangles hides the very coverage fog
and site capture they are annotating, while an outline costs only the glyphs' own area
and still separates the name from whatever it crosses. It is white rather than the
palette's `#e6e8eb` because the contrast now comes from the outline, not from a dark
ground: against the brightest thing a label can cross the pair reads as black-on-white,
and the lighter of the two texts is the one that survives it. The texture keeps a small
transparent margin around the glyphs so the outline is never clipped at its edge.
Measured from the **edge**, not the centre: the body is world-sized, so how wide it
draws depends entirely on the framing, and a fixed gap from the centre would put the
label on top of a body a couple of metres from the eye — exactly the close-up the
Perspective view exists for. The label itself is **screen-space**: constant pixel size and a constant gap at every distance and in every
view, the three orthographic elevations included, so a name is as readable across a
1120 m site as across a room. A name wider than **140 px** is **ellipsised** — the full
text stays in the camera panel (§5.1), and a label that grew with its name would blanket
the viewport at site scale. The ellipsis alone is the floor: a name too long for even
one character to fit still draws its ellipsis, because a label that marks *there is a
name here* is worth more than a blank.

The label draws **exactly when the body draws**: same layer toggle, same
disabled-camera rule (§2.4.3), same rendering-through suppression below. One shared
predicate decides for both, so the two can never disagree. A second viewport toggle,
**Camera names** (§2.4), hides the labels without hiding the cameras. Labels are **not
clickable** — picking is unchanged (§5.2), so a label can never steal a click from the
body it names, and a name that overlaps a neighbouring camera costs nothing.

**The body's visibility decides the label's, and nothing else does.** A label is drawn
when the camera's **body** is unobstructed, and hidden when something in the scene
stands in front of that body — a wall, a box, a splat capture. When it is drawn it is
drawn **whole and on top**: over geometry, over the captures, and over the coverage
fog, whatever happens to lie in front of the label itself. The label is never
*partially* eaten by an edge it overlaps, which is the difference between a label and a
decal — a name clipped down its middle by a pillar three metres closer to the eye reads
as a rendering fault, and is unreadable besides.

That makes the occlusion test **one sample per label, not one per pixel**: the pass
runs after the fog composite where the canvas depth no longer describes the scene, so
the shader reads the scene's depth texture at the **body's** own screen position and
draws or drops the whole quad (`volumetric_rendering.md` §4.1). The tolerance clears the
body's own radius — the **larger** of the two body sizes, so a selected body is cleared
too — and what the depth buffer cannot resolve at that distance (sized, with its safety
factor, in `volumetric_rendering.md` §4.1), and nothing beyond those two: a camera whose
body is visible is never hidden by the body itself, and a camera hidden behind anything
thicker than the pair loses its label. Neither term scales with the **eye distance**, which
is the failure this pass exists to avoid: a tolerance that did would, at site scale,
leave metres of geometry unable to hide anything.

**A label's opacity never changes abruptly.** Occlusion is a binary fact about the
scene, but showing it as one makes labels strobe: the anchor's pixel drifts sub-pixel as
the view moves, the depth under it is unstable where the body is near-coplanar with a
surface or in front of a 3DGS capture, and a body crossing a wall's silhouette crosses
it within a frame or two. So the raw test drives a **damped opacity**, smoothed two
ways:

- **spatially** — the depth is sampled over a small ring around the body rather than at
  one texel, and each sample ramps across a depth **band** instead of switching at a
  threshold, which removes the jitter at a grazing edge;
- **temporally** — the result is eased toward, never jumped to, with a fixed time
  constant (~150 ms, so a transition completes in roughly a third of a second). The
  easing is **frame-rate independent**: it is a function of elapsed time, not of frames
  drawn, so the fade looks the same at 30 fps as at 120, and a long stall (a tab in the
  background) resumes with a bounded step rather than a jump.

A camera passing behind a wall therefore fades out over that time constant, and a new
label — a camera just added, or one whose anchor has come back into view — fades in over
it rather than appearing at full strength. A label near an edge settles at full opacity
or none, never at a permanent half.

The one instant change is **deliberate user action**: hiding the layer with the
**Camera names** or **Cameras** toggle (§2.4), disabling a camera, or entering the
Selected view takes effect at once. Those are not occlusion, and easing them would read
as lag in the control.

**Exception — rendering through the camera.** While the viewport renders *through*
the selected camera (the **Selected** view, §2.4.1), that camera draws
**neither its body nor its frustum**: both are degenerate at the eye point, the
frustum's edges projecting onto the image borders. Every **other** camera's body
still draws normally, so their placement within this camera's field of view stays
visible.

### 5.4 Enable / disable

- Each **camera node** in the scene hierarchy (§5.5) has a **checkbox toggle** to
  enable/disable that camera, independent of selection. Toggling doesn't change the
  current selection.
- Disabled cameras stay in the scene but **draw nothing in the viewport** unless
  they are the selection (§2.4.3), and keep their position/rotation/FOV editable. They **are** passed to `setCameras()`, carrying
  `enabled: false` (SDK spec §5.2), so they keep their camera index but contribute
  nothing to `compute()` — their coverage rate is 0 and they can't be flagged as
  `CAMERA_INSIDE_GEOMETRY`.
- The app deliberately does **not** filter its own camera list before
  `setCameras()`. Filtering would renumber every camera after the toggled one, which
  disqualifies the run from incremental recompute (SDK spec §13.1) and forces a full
  recompute on every checkbox click. Passing the flag instead keeps indices stable, so
  a toggle recomputes only that camera's frustum chunks.
- Because disabled cameras now occupy indices, anything that treats "the cameras the
  engine knows about" as "the cameras that count" must filter explicitly: the stats
  panel's `perCamera` list (§10), the probe panel's *seen by N of M* denominator
  (§12.3), and the section legend's camera-count scale (§13.6) all read the **enabled**
  count. `involvedCameraCount` (§9.1) already does.
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
  expandable**) and `{ kind: 'volume' }` (a selectable leaf), and — for the placement tool
  (`camera_placement.md` §7) — `{ kind: 'constraintGroup' }` (**both selectable and
  expandable**) and `{ kind: 'constraint' }` (a selectable leaf), and — for splat
  captures (`gaussian_splats.md` §2.2) — `{ kind: 'splat' }` (a selectable leaf).
  Nodes carry hierarchy and
  identity only; entity payload stays in the canonical arrays — cameras in
  `CameraConfig[]` (§5), probes in `Probe[]` (§12.1), sections in `Section[]` (§13.1),
  zones in `Zone[]`, volumes in `SamplingVolume[]` (`sampling_volumes.md` §2), constraint
  groups in `ConstraintGroup[]` and constraints in `CameraConstraint[]`
  (`camera_placement.md` §3.1), splats in `SplatObject[]` (`gaussian_splats.md` §2.1) —
  which a node references by id. The tree is **derived** via
  `buildSceneTree(cameras, probes, sections, zones, volumes, constraintGroups, constraints, splats)`
  — no separate mutable node state.
- **Structure.** Auto-derived collapsible groups at the root, one per entity type:
  a **"Cameras"** group over the camera nodes, (when any probes exist) a **"Probes"**
  group over the probe nodes, (when any sections exist) a **"Sections"** group, and
  (when any **zone** exists — including an empty one) a passive **"Zones"** umbrella
  over **selectable+expandable zone nodes**, each holding its volume children
  (`sampling_volumes.md` §4.1), and (when any **constraint group** exists — including an
  empty one) a passive **"Constraints"** umbrella over **selectable+expandable constraint-group
  nodes**, each holding its constraint children (`camera_placement.md` §7) — the
  user-created sub-groups (all other groups are auto-derived by type) — and (when any
  splat exists) a **"Splats"** group over the splat nodes (`gaussian_splats.md` §2.2),
  auto-derived by type like Cameras/Probes/Sections. The root order is
  **Cameras → Probes → Sections → Zones → Constraints → Splats**, fixed; Splats sits
  last because it is the only group that cannot change a number, and the order already
  runs from analysis inputs toward presentation. Rows are
  **reorderable by drag within their own group** (§5.5.1); **reparenting** by drag is not
  offered — a volume changes zone from its panel instead (`sampling_volumes.md` §6.1), and
  a constraint changes group from its panel (`camera_placement.md` §7).
- **Rows.** A generic `TreeRow` renders indentation, the expand caret, label,
  selection highlight, and click routing; kind-specific content is dispatched on
  `node.kind`. Camera rows keep the existing checkbox toggle (§5.4), coverage dot,
  coverage-rate badge, and `inside geometry` badge. The dot and badge read the
  **same per-camera rate the stats panel shows** (§10) — the enabled-zones union
  when zones are active, the SDK summary otherwise (`sampling_volumes.md` §7.4) —
  so a camera never reports two different numbers in the two places.
  Probe rows show the probe label plus a small
  **"seen by K" badge** — the count of enabled cameras that see the probe
  (`popcount` of its mask, §12.2), mirroring the camera coverage-rate badge; full
  detail lives in the probe panel (§12.3). The badge is omitted when there is no usable
  mask (no run yet, or no coverage data at the point — §12.3). Section rows keep an
  **enabled checkbox** ("Enable/Disable section", §13.6) and show a small badge with the section's
  **orientation** and its **aggregated coverage** (e.g. `H · mean 47%`), mirroring the
  camera coverage-rate badge; the coverage part is omitted when there is no usable run.
  **Constraint-group** rows carry an **enabled checkbox** (`camera_placement.md` §3.1) and
  a badge with the group's constraint count and, after a search, its selected camera count
  and reachable rate (e.g. `3 constraints · 8 cams · 94%`); the search part is omitted when
  no search has run. **Constraint** rows carry an **enabled checkbox** and a badge with the
  constraint's kind and primitive measure (e.g. `polyline · 60 m`).
  **Splat** rows carry an **enabled checkbox** (`gaussian_splats.md` §5.1) and a badge
  reflecting **load state** — `41%` while loading, `4.2M splats` once loaded,
  `⚠ missing from assets/` or `⚠ could not be decoded` on failure — and
  `⚠ SOG bundle — use its .sog zip` for the one failure whose remedy is a
  different file rather than a repair (`gaussian_splats.md` §6.2, §9). That state is **derived side state** held beside the
  scene, like the retained per-run probe/section data (§12.3, §13.4) — never part of
  the entity and never serialized. Nothing in the app blocks on a splat's load.
  A group header shows a caret, label, and passive child count.
- **Labels.** A row's label is the entity's **resolved display name** — cameras
  (§5.6), probes (§12.1), sections (§13.1), and zones (`sampling_volumes.md` §6.2)
  each via their **on-entity `name`** — falling back to the default `Camera N` /
  `Probe N` / `Section N` / `Zone N` when blank. **Volume** rows are the one
  exception: they keep showing the raw id (`volume-N`); volume names are out of scope
  (§16). Constraint groups and constraints resolve from their own **`name`**
  (`camera_placement.md` §3.1), falling back to `Group N` / `Constraint N`.
  **Splats** resolve from their own `name` too, but fall back to the **basename of
  their `src`** — `site.spz`, `yard-scan.ply` — not to `Splat N`
  (`gaussian_splats.md` §2.3). It is the one documented exception to the ordinal
  fallback, on the same ground §14.2 gives for scene files ("the filename is the
  scene's name"): a splat's identity *is* its file, an ordinal would leave two
  unnamed captures indistinguishable, and it makes a duplicated row read as a
  duplicate rather than as an unrelated second capture.
- **Selection.** The app holds a single **unified selection** — a camera, probe,
  section, zone, volume, constraint group, constraint, *or* splat
  (`{ kind: 'camera' | 'probe' | 'section' | 'zone' | 'volume' | 'constraintGroup' |
  'constraint' | 'splat'; id } | null`) — so selecting one deselects the others and
  only one `TransformControls` gizmo is ever attached. Clicking a camera, probe, section, or
  volume node selects that entity (drives the §5.2 panel and gizmo). Clicking a **zone**
  node selects it (drives its panel); its own caret handles expand/collapse. A zone's
  row **enabled checkbox** (independent per zone, decoupled from selection) controls
  whether it contributes to the visualized marked set (`sampling_volumes.md` §7.3).
  Clicking a **constraint group** or **constraint** node selects it the same way a zone or
  volume node does; a constraint's own **enabled checkbox** controls whether it contributes
  pool positions (`camera_placement.md` §4.1) and a group's controls whether the search
  considers it at all. A **constraint** is pickable in the viewport through its handles
  (`camera_placement.md` §6.1); a constraint **group** has no pickable body and is selected
  from the hierarchy only, like a zone. A selected polyline additionally carries a
  **vertex sub-selection**, which is not a node kind (`camera_placement.md` §6.1).
  Clicking a **splat** node selects it (drives the `SplatPanel`,
  `gaussian_splats.md` §7, and attaches
  the gizmo); a splat's own **enabled checkbox** controls only whether the viewport
  draws it (`gaussian_splats.md` §5.1). A splat is likewise selectable **from the
  hierarchy only** — it is on the other canvas and not in the picked scene, and
  §2.4.2 gives the reason a click must not reach it.
  Clicking a group header (incl. the "Zones", "Constraints" and "Splats" umbrellas)
  only expands/collapses it and does not change the selection.
- **Adding entities.** The "Hierarchy" panel header **"+" menu** creates — **Camera**,
  **Probe**, **Section**, **Zone**, **Volume**, **Constraint ▸**, or
  **3D Gaussian Splat…**.
  Cameras/probes/sections spawn at the **workspace center** with the next free id and
  auto-select. A **Zone** creates an empty zone (`zone-N`); a **Volume** adds a 1 m cube
  at the center into the target zone (creating "Zone 1" first if none exist)
  (`sampling_volumes.md` §4.1). Creating a camera or a volume marks the result stale
  (§8.1); creating a probe, section, or empty zone does not.

  **3D Gaussian Splat… is the one entry that opens a dialog**, and the one entry that
  is **not always enabled**. It creates nothing itself: it opens the **Add 3DGS**
  dialog (§14.7), which lists the capture files already sitting in the scene folder's
  `assets/` and adds a row referencing the chosen one, at an identity transform,
  auto-selected (`gaussian_splats.md` §3.2). It needs a folder to read, so with **no
  save target** — at boot, before any Load or Save (§14.1) — the entry is **disabled**
  with the hint *"Load or save a scene first."* The app never writes into `assets/`;
  the user puts the file there, which is what keeps §14.9's no-file-management rule
  intact and what lets one capture serve every scene file in the folder. **No splat
  action ever marks the result stale** — splats are not analysis inputs
  (`gaussian_splats.md` §1.1), the same rule constraints follow.

  **Constraint ▸ is a submenu, and adds nothing itself.** It holds **Group**, **Point**,
  **Polyline**, and **Plane** (`camera_placement.md` §7). Four constraint entries
  sitting flat among the scene-entity rows made the menu read as nine peers, when
  the constraint half is one feature's worth of choices; nesting them keeps the top
  level short and keeps "which kind of constraint" one level down, where the
  question actually belongs. A **Group** creates an empty group; a **Point** spawns at
  the workspace centre; a **Plane** a 4 × 4 m rectangle there; **Polyline** arms the draw
  mode (§2.4, `camera_placement.md` §6.2) instead of spawning geometry, since a polyline
  with no vertices is not a thing the user wants. The submenu opens on **hover or click**
  of its row and closes with the parent menu. Both popovers open **outward** — the "+"
  menu rightward from its button, the submenu rightward from its row — at one **fixed
  width**, so the two read as a single assembly rather than two panels each sized to its
  own longest label (`VISUAL_DESIGN.md` → Menu).

  **All four entries are always enabled.** Picking a type when no group exists creates
  "Group 1" first and adds the constraint to it — the same rule Volume follows for
  "Zone 1", and already what the reducer does; only the old menu's `when a group exists`
  gate hid it. **No constraint or group action ever marks the result stale** —
  constraints are not analysis inputs (`camera_placement.md` §1.1), and adding one "for
  symmetry" with zones would force a needless recompute.
- **Row context menu.** **Right-clicking** a camera, probe, section, zone, volume,
  constraint-group, constraint, or splat row opens a context menu with two actions,
  **Duplicate** (top) and **Delete** (bottom).
- **Group-header context menu.** Right-clicking a **group header** opens that group's own
  menu, which is **per-group and may be empty**: **Cameras** offers one item, **Export
  camera info** (§15.1), and every other header — Probes, Sections, Zones, Constraints,
  Splats — offers none, so right-clicking one opens **nothing at all**, exactly as it did
  before group headers had menus. A group's items are declared in a single **exhaustive
  per-group record**, so the next group added must state its list, empty or not (§15.1) —
  the same compile-time guard the per-kind row records carry (`ui/entityMenu.ts`).
- **Deleting entities.** The context-menu **Delete** action removes the row's entity.
  Deleting a **zone** removes it **and all its volumes**. Deleting the selected
  entity clears the selection; deleting a camera, a volume, or a non-empty zone marks the
  result stale (§8.1); deleting a probe, section, empty zone, constraint, or constraint
  group does not. Deleting a **constraint group** removes it **and all its constraints**;
  deleting a constraint (directly or with its group) **unbinds** every camera that
  referenced it — the cameras and their positions stay (`camera_placement.md` §6.3).
  Deleting a **splat** disposes its mesh, cancels an in-flight load, and releases its
  decoded capture **only if it was the last row referencing that `src`**
  (`gaussian_splats.md` §3.3); it never marks the result stale.
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
  - **Constraint group** — duplicates the group **and fresh copies of all its
    constraints** (each with a new constraint id, referencing the new group), carrying the
    camera template, the pool size and the strategy verbatim (`camera_placement.md` §3.1). The
    duplicate holds **no pool and no search result**: those are derived from the scene
    (§3.3.1 there), not properties of the entity.
  - **Constraint** — the copy is added to the **same group** as the original, and no
    camera is bound to it (a binding is provenance for a specific camera, so it does not
    transfer).
  - **Splat** — the copy carries the same **`src`**, so it is labelled by the same
    filename (§5.6's exception above) and **shares the original's decoded capture**
    rather than re-reading and re-decoding the file (`gaussian_splats.md` §3.3).
    Duplicating to compare two registrations of one capture therefore costs a row, not
    a second copy in memory.

  Duplicating a camera, a volume, or a **non-empty** zone marks the result stale (§8.1);
  duplicating a probe, a section, an **empty** zone, a constraint, a constraint group,
  or a splat does not (mirrors the add/delete stale rules above).
- **Expand/collapse** state is ephemeral UI state (default expanded), not persisted
  (§16).
- **Accessibility.** Rendered with `role=tree`/`treeitem`/`group` and
  `aria-expanded`/`aria-selected`; interaction is mouse-driven (no keyboard tree
  navigation yet, and no keyboard equivalent for drag-reordering, §5.5.1).

### 5.5.1 Reordering rows (drag and drop)

A row is **dragged to reorder it within its own group**. Draggable kinds: **camera**,
**probe**, **section**, **zone**, **volume**, **constraint group**, **constraint**, and
**splat**. The
root group headers are **not** draggable — they are auto-derived by type and their order
(Cameras → Probes → Sections → Zones → Constraints → Splats) is fixed.

- **Order is array order.** The tree is derived from the canonical arrays (§5.5), so
  reordering a row **is** a reorder of that entity's array — `cameras`, `probes`,
  `sections`, `zones`, `volumes`, or `splats`. It therefore **round-trips in the scene file** with no
  new field and no format-version bump (§14.3). A **volume** is reordered **within the
  slots its own zone's volumes already occupy** in the (zone-interleaved) `volumes` array;
  no other element moves.
- **Within-group only.** A drop is legal only among the dragged row's **siblings**. There
  is **no reparenting** — dragging never changes a volume's `zoneId` (that is the volume
  panel's job, `sampling_volumes.md` §6.1). While the pointer is anywhere else, **no
  insertion line is shown** and releasing is a **no-op**.
- **A zone drags as a subtree.** Legal drop positions for a zone are **zone boundaries** —
  before another zone, or after that zone's last visible volume row — never between another
  zone's volumes. A zone's volumes **move with it**.
- **Grip and threshold.** The **whole row** initiates the drag, except its enabled checkbox
  and its expand caret. The drag arms only once the pointer moves **4 px**; a press below
  the threshold is an ordinary **click that selects** (§5.5). **Escape** cancels an
  in-flight drag and the row returns to its original position, mirroring the
  armed-placement cancel (§2.4.2).
- **Feedback.** The dragged row **dims in place**; a **2 px accent insertion line**, inset
  to the target row's indent depth, marks where the row will land. There is no floating
  ghost row, and the list does not reflow until the drop commits.
- **Auto-scroll.** While dragging, a pointer within **24 px** of the hierarchy's top or
  bottom edge scrolls the tree continuously (speed ramping with proximity), so a row can be
  moved beyond the visible pane (§2.2).
- **No side effects.** Reordering **never changes the selection** (the detail panel and the
  viewport gizmo stay put) and **never marks the result stale or sampling-dirty** (§8.1) —
  array order is presentation-only, like a rename (§5.6). It is **not undoable** (the app
  has no undo, §2.4.2); a stray drag is recovered by dragging back. For **splats** this
  is doubly true: Spark sorts every Gaussian globally by view depth across all captures,
  so splat row order does not even affect **draw** order (`gaussian_splats.md` §6.6).

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

- `voxelSize` default **0.5 m**; slider range **0.1 – 1.0 m** (value editable per §5.2.1).
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
  valid (free-space `EMPTY_SPACE`) voxel in the room; voxels *on* a wall/box surface
  (`MIXED_SPACE`) are invalid and excluded by the SDK. With `solidDetection` off
  (§4.2) the enclosed interiors of solids are not culled as `SOLID_GEOMETRY` — they
  count as valid but read as fully blocked (0 coverage) via ray casting.
- **Zone-driven (region of interest):** when the user enables zones and at least
  one **sampling volume** exists, the run derives the SDK regions from the world
  AABB of every volume — `setSampling({ regions: volumes.map(v => ({ type: 'box',
  … })) })` — narrowing the sampled set below the full volume. This is the
  region-of-interest tool: user-editable oriented boxes grouped into **zones**,
  seeded from the scene BVH, each zone reporting its own coverage results.

> **Companion spec.** The full behavior of sampling zones — the model,
> BVH seeding, per-zone aggregation, the enabled-zones marked set, and hierarchy/panel
> integration — lives in [`sampling_volumes.md`](./sampling_volumes.md), which is
> the source of truth for that feature. The edits it made to this document (this
> section among them) keep the two consistent (its §12 table). When zones are
> disabled or no volume exists, sampling falls back to the full volume above, so
> scenes that don't use the tool are unchanged.

---

## 8. Running the calculation

**The engine is initialized when a scene loads, not when a run starts.** As soon as the
app holds a collision mesh — at startup, and after every import or reset (§14.4) — it
runs `init` → `loadScene` → `setSampling({ regions: [{ type: 'full' }] })` against the
current workspace at the debounced `voxelSize`, and computes nothing. Coverage still
requires an explicit Run or an Auto-run tick: loading a scene is not measuring it.

This is not an optimization; it is what makes engine readiness a state the user can
reach. A pool build (`camera_placement.md` §4.2) drives `compute()` itself and so does
**not** pass the Run gate below — it carries its own readiness check instead. While init
happened only inside a run, that check was unsatisfiable before the first run: from
startup the placement tool sat disabled reading `Wait for the engine to finish loading
the scene.` about a load that would never begin until the user clicked Run coverage,
which the message gave them no reason to do.

The load is **idempotent and single-flight**. The scene-load effect and `handleRun` share
one "ensure loaded" path, keyed on the `(collision mesh, voxelSize)` pair the engine was
last loaded against: two overlapping `init` calls are impossible, and a run that finds
the engine already loaded for its pair skips straight to `setCameras` + `compute`.
Sampling needs no special case — an import already marks the region set dirty (§8.1), so
the first run after one re-applies its zones over the full-volume default this load
leaves behind.

A **`voxelSize` change is deliberately not eager**: it is re-initialized by the next run,
exactly as before (§6). Re-voxelizing the workspace is the most expensive operation in
the session, and spending it on every debounced slider settle would burn it on
resolutions the user is still scrubbing past — while unlike a scene load it gates nothing,
since the engine already holds a scene. The consequence is that between a resolution edit
and the next run the engine is loaded at the *previous* voxel size, and a `compute()` started
in that window samples at that size; this is pre-existing behavior and unchanged here.

- A **Run coverage** button triggers `compute()` on demand.
- An **Auto-run** checkbox next to the button, **on by default**, triggers
  `compute()` automatically whenever the result is stale (§8.1) instead of
  requiring a manual click.
- `compute({ mode: 1, incremental: true, onRunStart, aggregate, onAggregate })`:
  - streams one `AggregateResult` per chunk (§3.3); per-voxel masks stay in the worker.
  - a progress/spinner state animates while the worker runs.
- On completion the returned `CoverageSummary` populates the stats panel. It always
  describes the whole scene, incremental or not (SDK spec §13.1).

**Incremental runs.** The app always asks for `incremental: true` and lets the engine
decide (SDK spec §13.1); there is no user-facing switch. `onRunStart` fires once before
the first chunk and reports what kind of run this is. The app keeps one merged store of
per-chunk `AggregateResult`s (§3.3), and that store keys its lifecycle off the same flag:

- `incremental === false` — **reset** the store, then accumulate as before.
- `incremental === true` — **do not reset**. Results are keyed by `chunkId`, so an
  arriving one replaces that chunk's retained entry and every chunk the run skipped keeps
  the result it already had.

Resetting on an incremental run would blank most of the scene with no error, so the reset
is driven by `onRunStart` rather than inferred from app state. The **worker's** own
retention (§3.1) follows the identical rule, one level down — the SDK host applies it so
the app does not have to.

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

**Superseded runs are cancelled.** A resolution, geometry, or sampling change makes
whatever is currently computing describe a workspace the user has already moved off, and
those are the long runs — a full re-init at a fine voxel size, not a handful of dirty
chunks. The app aborts the in-flight `compute()` (`camera-coverage-sdk` §13.2) at the
moment of that edit, so the engine goes idle at the next chunk boundary and the ordinary
"not busy" gate starts the replacement run. Without this the user waits out a full run
whose result is discarded, and only then waits for the one they asked for. A scene
import cancels the same way (§14.4 step 4).

**Auto-run is suspended while an optimize session or a placement session is open**
(`aim_optimization.md` §3.1, `camera_placement.md` §3.4). Both features drive their own
`compute()` calls against a camera list carrying six extra capture slots, and letting the
staleness poller fire in parallel would interleave two runs over two different camera
lists. The session's own final run re-establishes the displayed numbers when it closes.
The two sessions **share those six slots and are mutually exclusive** — a scene of any size
therefore needs six spare slots, not six per feature.

A **camera** edit is deliberately not cancelled: its run is short, and its result is
still applied — one edit stale, reconciled by the next auto-run — so cancelling would
discard finished work to save nothing. Cancellation is surfaced nowhere in the UI: it is
not an error (§11), it does not stop Auto-run, and it leaves the previous run's overlay
and stats standing until the replacement lands.

Camera edits require only `setCameras(...)` + `compute(...)` (no re-init).
Resolution edits require the full re-init pipeline (§6).

A camera **pose** edit — the dominant case, since a gizmo drag emits one per frame and
auto-run fires up to 10×/sec — is eligible for incremental recompute, so a drag costs
only the chunks the camera's old and new frusta touch rather than the whole workspace.
Adding, deleting, or reordering a camera is not eligible and falls back to a full run
(SDK spec §13.1); reordering already never marks stale, so in practice only add and
delete pay it. Resolution and sampling edits discard the engine's baseline, so the run
that follows one is always full.

**Sampling (zone/volume) edits** feed `setSampling`, so a **sampling-dirty** flag
is set whenever the volume set, a volume transform, its `zoneId`, a non-empty
zone's deletion, or the `useZones` toggle changes. A run applies
`setSampling(regionsFromVolumes())` when the flag is set (or after a re-init reset
it), then `setCameras` + `compute`, then recomputes per-zone summaries — no re-init
needed (only a `voxelSize` change requires that). **Enabling/disabling a zone** or
**renaming a zone** never marks stale — a rename relabels, and a toggle changes only
which regions the marked-set group and the slab/leaf filters name, so it re-reduces the
retained masks through `aggregateRetained` (§3.3) rather than recomputing
(`sampling_volumes.md` §7.2, §7.3, §8). **Reordering** a hierarchy row (§5.5.1) likewise
never marks stale or sampling-dirty: it permutes an array whose order is display-only, and
results are keyed by entity id, not array position.

**No splat action ever marks stale.** Adding, deleting, duplicating, moving, scaling,
renaming, or toggling a **splat** (`gaussian_splats.md` §1.1) leaves both flags alone,
as does either of the **Splats**/**Geometry** layer toggles (§2.4). A splat contributes
no triangles to the collision mesh, no bounds to the workspace AABB (§4.2), and no
voxels to any marked set, so there is nothing for a recompute to produce differently —
the same rule, for the same reason, that constraints follow
(`camera_placement.md` §1.1). Hiding the geometry **layer** is likewise presentational:
the merged `SceneMesh` is untouched, so the standing result stays valid and displayed.

---

## 9. Coverage visualization

The coverage field is drawn with the **voxel volumetric renderer** — a
visualization-agnostic primitive that takes, per voxel, a `{center, size, intensity,
color}` and draws it as translucent volumetric fog: max-blended among its own
voxels into a separate target, then alpha-composited over the scene. Its technical design (shader,
chord-length math, compositing, tests) lives in
[`volumetric_rendering.md`](./volumetric_rendering.md). **This section owns the
visualization**: which voxels are fed to the renderer and how coverage data maps to
each voxel's `intensity` and `color`. Domain terms are defined in §17. A separate,
flat per-slab coverage visualization — the **section heatmap** — is described in §13.
The overlay's own **legend** — a hue-intensity ramp (coverage mode) or a solid swatch
(blind-spots mode), reflecting §9.1/§9.2 rather than the Turbo colormap — is the
coverage-overlay mode of the shared bottom-right legend widget (§13.6); it shows when
no section legend is up and the overlay is visible.

Voxels come from the run's `leafCounts` aggregation (§3.3): **merged uniform cubes** of
equal camera count, per chunk. Each leaf becomes one drawn instance at its cube's center
with that cube's edge length; `intensity` and `color` depend on the active mode. The
overlay retains the leaves per `chunkId` and rebuilds from them.

*Why counts and not masks.* The overlay needs `popcount(mask)` and nothing else — it
cannot answer "which cameras" and never has to (§12.2 does that). The popcount runs on
the GPU inside the chunk pipeline instead of per-leaf on the main thread.

*Why merged and not per voxel.* A renderer's cost is **per drawn instance**. On a
30 × 8 × 30 m room at 0.1 m with 8 cameras, 7.0M valid voxels collapse to 612k leaves —
11.5×, and the difference between 56 MiB of instance buffers and 642 MiB. A WebGPU
device's *default* `maxBufferSize` is 256 MiB and `InstancedMesh` spends 64 of the ~96
bytes per instance on its matrix alone, so the unmerged form does not merely run slowly
on a large site: it exceeds the buffer limit and the renderer's device is lost.

**The overlay is capped.** Past `MAX_INSTANCES` (2M) the renderer stops appending and
reports how many leaves it dropped, so a pathological scene yields a visibly incomplete
overlay rather than a lost device. `CoverageOverlay.droppedLeaves` is non-zero exactly
when what is on screen is not the whole answer.

The renderer is fed through its **bulk** path (`volumetric_rendering.md`), one typed
array per attribute, rather than an array of `{center, size, intensity, color}` objects.
At 0.1 m voxels a room is millions of voxels, and materializing an object with two nested
tuples for each of them cost more than the upload it was preparing.

The **marked-set filter** (`sampling_volumes.md` §7.3) is applied by the aggregation, not
by the overlay: `leafCounts.maskRegions` names the enabled zones' volumes, and a voxel
outside them arrives with its validity bit already clear. Toggling a zone therefore
re-requests `aggregateRetained` (§3.3) instead of re-walking retained leaves.

Extracted leaves are retained **keyed by `chunkId`**, not appended to one flat list, so
an arriving chunk **replaces** that chunk's leaves. This is what lets an incremental run
(§8) rewrite a few chunks while the rest of the overlay stands.

Mapping the retained leaves onto the renderer is a **whole-overlay rebuild** (it walks
every leaf, applies the marked-set filter and the active mode, and re-uploads). It is
therefore **deferred to the end of a run**, not run per arriving chunk: the app flushes
the overlay once, after the last chunk. Rebuilding per chunk makes a full run quadratic
in chunk count, and would make an incremental run pay a full-scene rebuild for each of
the handful of chunks it recomputed — cancelling the saving the incremental run bought.
A rebuild is still triggered directly, outside a run, by the client-side re-filters that
need one (mode switch, hue/intensity change, zone enable/disable).

The overlay derives each leaf's camera count from **`maskWords`** — every one of the
`CAM_WORDS` words (SDK spec §9.5) — not from the single-word `mask` argument. Reading
`mask` alone would silently drop cameras at index ≥ 32, rendering voxels seen only by
those cameras as blind. Because `maskWords` is accessor-owned scratch, the overlay
reduces it to a scalar camera count at traversal time and retains only that.

When zones are active, the overlay is filtered to the **enabled-zones marked set**
(`sampling_volumes.md` §7.3): a valid voxel is drawn only if its center falls in the
union of the enabled zones' volumes; voxels outside it read as unmarked and draw
nothing. Enabling/disabling a zone re-filters the retained leaves client-side, with
no recompute.

The overlay takes **no render order** and no part in the transparent-layer table
(`scene/renderOrder.ts`): it renders in its own pass, into its own target, and is
composited over the finished scene (`volumetric_rendering.md` §4). Occlusion is
decided by the depth that pass shares with the main one — a section heatmap plane
writes depth and so hides fog behind it, per viewpoint (§13.5), while a
sampling-volume fill does not and is therefore tinted *by* the fog
(`sampling_volumes.md` §5).

### 9.1 Visualization modes

A **mode selector** switches between two mappings from coverage data to the
renderer's per-voxel inputs:

- **Coverage** — the default. **Every valid voxel** is fed. `color` = the
  user-selected **overlay color** (§9.2); `intensity` = the voxel's **coverage
  fraction** (`popcount(maskWords) / involvedCameraCount`, 0..1, §17). Well-covered
  regions glow bright/solid; weakly covered regions are faint; blind spots
  (fraction 0) contribute nothing and are invisible. This shows **where coverage
  is**.
- **Blind spots** — **only blind-spot voxels** (every word of `maskWords` is 0, valid) are fed.
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
- **Intensity scale** — the renderer's global **opacity** multiplier
  (`intensityScale`): it scales every voxel's alpha, not its brightness
  (`volumetric_rendering.md` §3). A pixel shows the **strongest** voxel along the
  ray rather than a sum, so depth of field costs nothing and the knob holds its
  meaning on the demo room and a 1120 m site alike. The fog composites **over**
  whatever is behind it, geometry and 3DGS captures alike, so it is never washed out
  by a bright backdrop and this knob is about legibility, not visibility. Turning
  the overlay off
  entirely is the **Coverage** row of the layer menu (§2.4). Neither is adjusted
  automatically when a capture is visible: coupling one layer's appearance to another
  layer's state would override a setting the user chose (the same reasoning that keeps
  the **Geometry** row a manual toggle).

The overlay color is a single user-picked hue shared by both modes (the mode fixes
*which* voxels and the `intensity` mapping, not the hue). The old flat overlay's
"blind spots only" / "hide well-covered" toggles are subsumed by the mode selector;
blind-spot counts also remain available numerically in the stats panel (§10).

---

## 10. Stats panel

From `CoverageSummary`:

- `overallRate` — fraction of valid voxels seen by ≥ 1 camera.
- `perCamera[]` — per-camera `coverageRate`, listed alongside each camera by its
  **display name** (§5.6). Disabled cameras (§5.4) *are* sent to the engine and so do
  have an entry, always `0`; the panel **filters them out** rather than listing a row of
  zeroes for a camera the user switched off.
- `validVoxels`, `elapsedMs`.
- **Blind-spot count** — number of valid voxels no enabled camera sees (§17),
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
| No WebGL2 context | the viewport cannot be created; App surfaces the failure in its place (§2.3). Compute is unaffected — it has its own device in the worker |
| `SCENE_TOO_LARGE` (fine voxel on CPU) | catch, show message, keep previous valid state |
| `COMPUTE_CANCELED` (§8.1) | **not** surfaced: the app asked for the abort, so no banner, no error state, and Auto-run keeps going |
| `CAMERA_INSIDE_GEOMETRY` | surface which camera; keep it flagged in the list (the SDK never flags a camera carrying `enabled: false`, §5.4) |
| `TOO_MANY_CAMERAS` | not reachable (10 ≤ 128), but guarded |
| Descriptor cap exceeded (§3.3) | **warning**, not an error: the over-cap zones / volumes / sections / probes are dropped from the descriptor and named in the status area; the run and every other panel proceed |
| Placement tool cannot start (engine still loading, slots, a session already open, pending sampling, no enabled constraint) | the entry point is disabled with the reason (`camera_placement.md` §10). The engine-readiness check is the tool's own: a build step does not pass the Run gate of §8 |
| `CAMERA_INSIDE_GEOMETRY` for a **capture slot** during a session | **suppressed** for the session's duration; the pool position is rejected instead (`camera_placement.md` §4.2) |
| A pool build `compute()` rejects | build steps stop, the session closes, the partial pool is discarded, the SDK message goes to the status area (`camera_placement.md` §10) |
| Zones regenerated while a constraint group held target zones (§7) | **warning**, not an error: the lists are cleared and the status area names the groups — `Zones were regenerated; N constraint group(s) lost their target zones.` (`camera_placement.md` §3.1.2, §7) |
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
- Probes are **not auto-persisted** across reloads (§16), but they **are** included in
  scene-file export/import (§14).

### 12.2 Visibility query (reuse of computed masks)

A probe's visibility is read from the **most recent completed `compute()` run's
per-voxel camera masks** — not a fresh ray cast (the SDK exposes no arbitrary-point
query; the grid masks already encode line-of-sight + frustum + range per voxel, §7).
The probe's world position is mapped to the voxel that contains it and that voxel's
mask is read:

The lookup itself happens **in the worker**, as the `probes` primitive of the
aggregation descriptor (§3.3): the app sends the probe positions and receives, per chunk,
each probe's mask words and whether that chunk holds it (and whether the voxel was valid).
Exactly one chunk claims a given probe, so merging is a matter of taking the one that did.

This is why the app does not retain `ChunkResult`s on the main thread. Probes were the
only consumer that genuinely needed a *mask* rather than a count (§9 keeps counts and
cannot answer "which cameras, at this point"), and they need a handful of `O(1)` lookups
— which is precisely the shape the SDK resolves on the CPU next to the masks rather than
shipping megabytes so the main thread can index three points.

Moving a probe re-requests `aggregateRetained` (§3.3) rather than recomputing, which is
what makes §12.5's "never marks stale" true rather than merely tolerable.

- **Bit order.** Bit *n* of a mask is the camera at index *n* in the
  **camera list passed to `setCameras()` for that run**. The app snapshots that ordered
  id list alongside the retained aggregation, so masks decode to the correct camera ids
  even if the live camera set has since changed. All mask words are decoded (correct up to
  `MAX_CAMERAS` = 128), not just word 0.
- Since §5.4, that list includes **disabled** cameras (they hold their index, with a
  permanently-0 bit). The snapshot therefore records each camera's enabled state
  alongside its id: readouts phrased "of N cameras" (§12.3, §13.6) count the **enabled**
  entries, never the list length, and per-camera rows skip disabled entries.
- **Resolution.** Because the mask is quantized to the voxel grid, probe visibility
  has voxel-size resolution (§6).

### 12.3 Probe panel (left panel)

When a probe is selected (§5.2), the left panel shows, in place of the camera panel:

- header `Probe — <name>` (§12.1);
- a **Name** text input editing the probe's display name — live, and never marks the
  result stale (§12.1, §5.6);
- **position X / Y / Z** as a grouped row of numeric text fields (§5.2.1) — a point
  has no orientation, so there is no rotation or FOV. Editing position follows §5.2.1
  but, like dragging the marker or placing the probe with **Place on surface**
  (§2.4.2), **never marks the result stale** (§12.5);
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
  with the panel fields (§5.2.1).
- Moving a probe **re-reads the existing masks** as it crosses voxel boundaries and
  updates the panel and sightlines live; it does **not** mark results stale or trigger
  recompute (a probe is not part of the coverage input, §12.5). Position edits stay in
  two-way sync with the panel fields (§5.2.1).
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
  `{ id, orientation: 'horizontal' | 'vertical-x' | 'vertical-z', min: number, max: number, minA: number, maxA: number, minB: number, maxB: number, aggregation: 'mean' | 'max' | 'min' | 'blind', enabled: boolean, clipRange: number, name: string }`.
  The `name` is an **editable display label** stored on the entity (like the zone,
  `sampling_volumes.md` §6.2), with the same semantics as the camera name (§5.6):
  trimmed, blank/absent falls back to the default `Section N`, no uniqueness, never a
  coverage input, and it round-trips in the scene file (§14.3).
  `clipRange` (a world-metre width, default `2`) is the section's clip band width
  (§13.9); *which* section clips — if any — is the single scene-level `clipSectionId`
  (§14.1), not a per-section flag. Both are saved in the scene file (§14); everything but
  the global colormap is per-section.
  `min`/`max` are the slab **thickness** bounds in world meters **along the collapse axis**
  (the section normal), `min ≤ max`. `minA`/`maxA` and `minB`/`maxB` are the finite
  rectangular **footprint** bounds in world meters along the two **in-plane axes**
  (`axisA`, `axisB` per orientation, below), `minA ≤ maxA` and `minB ≤ maxB` — so a section
  is a bounded axis-aligned **box**, not a full-workspace slab. The footprint bounds are
  stored relative to the current orientation's in-plane axes and **reset on orientation
  change** (§13.2). Sections live in a canonical `sections: Section[]`
  array in `App.tsx`, parallel to `cameras` (§5) and `probes` (§12.1). A section node in
  the hierarchy (§5.5) references its section by id; the tree carries identity only.
- The **collapse axis** and the two **in-plane axes** follow the orientation:
  - `horizontal` — collapse **Y**, heatmap spans **X×Z** (a floor plan).
  - `vertical-x` — collapse **X**, heatmap spans **Z×Y**.
  - `vertical-z` — collapse **Z**, heatmap spans **X×Y**.
- Sections are **not auto-persisted** across reloads (§16), but they **are** included in
  scene-file export/import (§14). The global colormap and its legend (§13.5) are
  shared by all sections; everything else in the record above is per-section.

### 13.2 Orientation, thickness & footprint (the box)

A section is a finite, axis-aligned **box**: a slab of thickness `[min, max]` along the
collapse axis (the normal) with a bounded rectangular **footprint** `[minA, maxA] ×
[minB, maxB]` across the two in-plane axes (§13.1). Three sliders size it about a fixed
center; the viewport drag (§13.8) positions it — the two never overlap.

- **Orientation** — a three-way selector (Horizontal / Vertical X / Vertical Z),
  choosing the collapse axis per §13.1. Changing orientation **resets** both the thickness
  range and the in-plane footprint to their defaults for the new axes (below): the in-plane
  axes swap, so carried-over bounds would be meaningless.
- **Thickness** — a single slider, **0.1–30 m**, along the normal. Changing it keeps the
  slab's **center** (`(min + max) / 2`) fixed and grows/shrinks `[min, max]` symmetrically
  around it. A new section defaults to the collapse axis's full workspace-AABB extent,
  **capped to a 5 m default thickness** — independent of the slider's 30 m maximum — and
  centered on that axis (so on an axis whose extent already fits within 5 m, the default is
  the true full extent; otherwise it's a 5 m slab centered on the axis, which the slider
  can then widen up to 30 m).
- **Width & height** — two sliders sizing the footprint, one per in-plane axis (`axisA`,
  `axisB`). Each ranges **0.1 m → the workspace-AABB extent along that axis** and, like
  thickness, keeps the footprint's **center on that axis** fixed while growing/shrinking its
  bounds symmetrically. A new section defaults to the **full workspace-AABB extent** on both
  in-plane axes — so it initially spans the whole workspace in-plane, matching a section's
  appearance before finite footprints. The sliders are labeled by the world axis they size
  for the current orientation (§13.6).
- Sizing (thickness / width / height) only ever changes the box's **extent** about a fixed
  center; its **position** (center on all three axes) is changed only by the viewport drag
  (§13.8). The two controls are complementary — one holds center and moves an edge, the
  other holds size and moves the center.
- The heatmap draws on a single **plane at the thickness midpoint** `(min + max) / 2`,
  perpendicular to the collapse axis and **spanning the footprint** `[minA, maxA] × [minB,
  maxB]`. Two faint, **non-interactive outline planes** at `min` and `max` (same footprint)
  mark the slab's thickness so the aggregated volume is visible.

### 13.3 Aggregation & cell mapping

The box is divided into **cells** — one per **voxel column**: the run of voxels along
the collapse axis at a fixed in-plane grid position `(a, b)`, clipped to `[min, max]`.
Only columns whose in-plane position falls **within the footprint** `[minA, maxA] × [minB,
maxB]` (§13.2) are included, so the footprint selects a **grid-aligned sub-rectangle of
whole voxel columns**; the rendered plane and outlines (§13.2) span exactly those selected
columns, which means a footprint slider value snaps to the nearest column boundary. The
heatmap texture holds one texel per selected cell, so its resolution tracks `voxelSize`
(§6) and its in-plane dimensions are the **selected column counts** along `axisA`/`axisB`
(the full workspace grid when the footprint is at its default full extent).

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
  (`popcount(mask) / involvedCameraCount`, 0..1, §17); the cell value is the
  per-section **aggregation** over those voxels:
  - `mean` — average coverage fraction (the section analog of the §9.1 Coverage mode).
  - `max` — best-covered voxel in the column.
  - `min` — worst-covered voxel in the column.
  - `blind` — **blind-spot fraction**: the share of the column's voxels that are blind
    (`mask == 0`).
- **Bit order / enabled set.** Masks decode exactly as for probes (§12.2): bit *n* is
  the *n*-th camera in the **enabled-camera list `setCameras()` received for the
  retained run**, snapshotted alongside the aggregation; `involvedCameraCount` is that
  run's enabled count. All mask words are read (up to `MAX_CAMERAS` = 128).
- **The fractions are derived from integer counts, not accumulated as floats.** Every
  fraction above is `popcount / involvedCameraCount` over a denominator constant for the
  run, so the aggregation sums the integer popcount per cell and the app divides once
  (SDK spec §19.2). `mean` is `camCountSum / (validCount · involvedCameraCount)`, `max`
  and `min` are `camCountMax`/`camCountMin` over the same denominator, and `blind` is
  `blindCount / validCount`. This is not an approximation of a float reduction — it is
  exact, and it is what lets the same numbers come back bit-identical from the GPU.

### 13.4 Data source & recompute coupling

- Sections read the **`columns` aggregation of the most recent completed run** (§3.3):
  one slab per section, its `axis` from the section's orientation and its `range` from the
  footprint of §13.2, reduced next to the masks in the worker. No fresh ray cast, no
  extra spatial index, and no per-voxel data on the main thread.
- Each chunk contributes a partial accumulator for the cells its own voxels fall in, and
  the app sums them (SDK spec §19.2). Counts add, `seenWords` OR, `max`/`min` take the
  extremum — so a section spanning several chunks is the merge of their parts, and the
  answer does not depend on how the workspace happens to be partitioned.
- **No retained slab is no-data, and is drawn as such.** A section with no data at all —
  before the first run, or after the run was discarded with the scene that produced it
  (§14.4) — draws its **whole plane** as no-data: fully transparent (§13.3), over the raw
  footprint bounds rather than a grid-aligned extent there is no grid for. That plane is
  **written**, not assumed: the per-section render entry is pooled by section id, so a
  section id that survives an import would otherwise inherit the outgoing scene's cells
  and report a measurement of geometry that is gone.
- **No-data is derived, not reported.** A slab tells the app how many voxels it counted
  (`validCount`), how many were obstacles (`obstacleCount`), and how many the marked
  filter removed (`filteredCount`). A cell whose column is longer than those three
  together contains voxels no chunk covered — the "no data" case of §13.3. The SDK does
  not classify cells; §13.3's colored / transparent / black precedence stays the app's.
- Changing a section's orientation, range, its enabled state, or the marked filter
  **re-requests `aggregateRetained`** (§3.3) and **never** triggers `compute()`. Changing
  only the displayed `aggregation` or the colormap re-reads the cells already held and
  costs nothing at all.
  Adding, moving, resizing, or deleting a section never marks coverage stale (§8.1) —
  like probes (§12.5), sections are not part of the coverage input.
- Per-chunk merging gives the incremental behaviour the client-side cache used to buy
  by hand: an incremental run (§8) replaces only the chunks it recomputed, and a section
  whose cells no replaced chunk reaches keeps every contribution it already had. Chunks
  are partitioned on XZ only (`camera-coverage-sdk` §3), so this falls out of the
  partition rather than needing a footprint test.
- Because the heatmap reflects a past run, when the live scene diverges from it
  (results stale, §8.1) the heatmap is **dimmed** and the Section stats panel shows a
  **stale hint** (§13.7), mirroring the overlay's stale dimming and the probe panel's
  stale hint (§12.3). With Auto-run on (the default) this reconciles within one run.

### 13.5 Rendering & colormap

- Each enabled section draws its heatmap on the midpoint plane (§13.2) — a
  disabled one draws nothing but its outlines, and only while selected (§2.4.3) —
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
  the sampling-volume fills (`sampling_volumes.md` §5). Since it writes depth while the
  fill uses `depthWrite:false`/`depthTest:true`, occlusion between the plane and the fill
  is resolved by the **depth buffer per viewpoint** — a fill in front of the slab tints
  over it, behind it is hidden — rather than by Three.js's viewpoint-dependent
  transparency sorting. The plane's depth is also what the **coverage overlay** (§9)
  tests against in its own pass, so the same per-viewpoint rule governs the fog without
  the fog appearing in that table (`volumetric_rendering.md` §4). The `blind`
  aggregation is drawn through the same colormap (0 → no blind voxels, 1 → all blind); its
  meaning is labeled in the controls and Section stats so the shared legend stays
  unambiguous.
- **Legend scale.** The colorbar gradient is fixed, but its numeric labels are read in
  the units the **clipping section's** aggregation encodes — a **camera count** (`0`..`N`)
  for `mean`/`max`/`min`, or a **percentage** for `blind` — per §13.6. The legend
  requires a **retained run** and is hidden before one (nothing is drawn to describe).
  Value → color is still the same linear Turbo mapping over `0..1`; only the *labels* change.

### 13.6 Controls & enablement

- **Per-section editor** — when a section is selected (§5.2), the left detail panel
  shows a **`SectionPanel`** in place of the camera/probe panel: header
  `Section — <name>` (§13.1), a **Name** text input (editing the section's display
  name — live, never marks the result stale, §13.1, §5.6), the orientation selector,
  the thickness slider, **two footprint sliders (width & height)** (§13.2), the
  aggregation selector, a **Clip toggle button**, and a **reveal-range slider** (§13.9).
  Each of these sliders' value readouts is editable per §5.2.1.
  The width/height sliders are **labeled by the world axis they size for the current
  orientation** — horizontal: `Width (X)` / `Depth (Z)`; vertical-x: `Width (Z)` /
  `Height (Y)`; vertical-z: `Width (X)` / `Height (Y)` — so a horizontal footprint's two
  horizontal axes are never mislabeled "height".
  The button is **highlighted** while this section is the one clipping (§14.1
  `clipSectionId`); the reveal-range slider is **always shown** (it has no visible effect
  unless this section is the clipping one).
- **Global controls** — the floating bottom-right **legend / colorbar** (rendered by
  the generic `HeatmapLegend`, which draws whatever caption, gradient, and ticks it is
  handed). It is a **floating overlay pinned to the bottom-right of the viewport**
  (§2.2) — a third viewport overlay alongside the two top toolbars (§2.4), an **opaque
  card with a drop shadow** so it reads over the 3D scene. To stay compact it shows
  **only** the caption, the colorbar, and its numeric ticks — **no block title and no
  colormap name**. It is **purely presentational**: it never affects `compute()` or the
  heatmaps/overlay themselves. The widget shows **one of two legends** (or nothing), all
  built by the pure builders in `heatmapLegend.ts`:

  - **Section legend** — shown **when the section layer is visible, an enabled section
    is currently clipping the scene, *and* a run is retained** (the master **Section**
    toggle, §2.4, is on; `clipSectionId` (§13.9, §14.1) references an existing section
    whose **`enabled`** flag is set — which also guarantees `sections` is non-empty; and
    that section has a **retained cell grid**, §13.4). Both extra conditions tie the
    legend to a heatmap that is actually drawn: the clipping section's heatmap plane
    renders only when the master toggle is on **and** that section is enabled (§13.5),
    and before any `compute()` the plane draws nothing (every cell transparent). With no
    heatmap to describe the legend is **hidden** rather than showing a placeholder scale
    — so a disabled clip section, or a clip section with no retained run yet, shows no
    legend. The legend describes the **clipping section** — the one whose heatmap the
    clip reveals — **not** whatever entity is currently selected; selection never
    affects it. Its colorbar is the **fixed Turbo gradient** (§13.5); its **numeric
    scale and caption adapt to the clipping section's aggregation** (built by
    `sectionLegendScale`) so the numbers read in the units the heatmap encodes:
    - `mean` / `max` / `min` — the scale is a **camera count**, `0` to `N`, where `N`
      is the enabled-camera count of the **retained run** the clipping section's
      heatmap reflects (the coverage-fraction denominator, §13.3; the same count the
      per-camera stats decode against). Because coverage fraction maps **linearly** to
      color, a count `k` sits at colorbar position `k / N`. Labels are **whole camera
      counts** at an **adaptive step** (a "nice" step — 1, 2, 5, 10, 20, 25, 50, … —
      chosen to yield ~5–9 roughly evenly-spaced ticks), always including `0` and `N`.
      Caption: **"Cameras seeing voxel"**. (In the degenerate case of a run retained
      with **no enabled cameras** — `N = 0` — the scale falls back to the plain
      coverage fraction `0`..`1` via `coverageLegendScale` to avoid a `k / 0` scale.)
    - `blind` — the scale is the **blind-voxel share** as a **percentage**, `0%` to
      `100%` (ticks `0/50/100` only); camera counts are meaningless here (§13.5).
      Caption: **"Blind-voxel share"**.
    For the section legend the Turbo gradient never changes — only its tick labels and
    caption do.

  - **Coverage-overlay legend** — shown **when no enabled section is clipping (so the
    section legend does not apply) *and* the coverage overlay is visible**
    (`overlayOptions.visible`, §9). Instead of the
    Turbo colormap it reflects the overlay's **own appearance** (§9.1, §9.2), built by
    `overlayLegendScale(overlayHue, mode)`:
    - **Coverage** mode — a **transparent → full-hue intensity ramp** in the current
      overlay hue (intensity = coverage fraction, §9.1). Caption: **"Coverage
      fraction"**; ticks `0/0.25/0.5/0.75/1`.
    - **Blind spots** mode — a **solid full-hue swatch** (blind voxels draw at fixed
      full intensity, so there is no fraction scale, §9.1). Caption: **"Blind spots"**;
      no numeric ticks.

  The widget is hidden whenever it has **nothing to describe** — no enabled section
  clipping **and** the overlay hidden, or an enabled section clipping but **no run
  retained yet** — so it never floats over a scene with nothing to describe. Switching
  or relabeling between the two is instant and never triggers `compute()` (§13.4).
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

- **Context** — orientation, thickness range (`min`–`max` m), and footprint size
  (width × height m).
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

- A **disabled** section draws nothing (§2.4.3) — except while selected, when its box
  outlines draw at opacity 0.35 so the `TransformControls` drag below has a visible
  target. A disabled section used to be invisible *and* still attached, and so could be
  dragged blind.
- A section is **selected from its hierarchy row** (§5.5); the **heatmap plane is not a
  pick target**, so clicking it passes through to the cameras/probes (or empty space)
  behind it and the viewport pick (§5.2) is unchanged.
- Selecting a section attaches **`TransformControls` in translate mode, free on all three
  axes**: dragging slides the whole box, moving its **center** on each axis while holding
  thickness/width/height fixed — the complement of the sizing sliders (§13.2), which change
  extent about a fixed center. Moving `min`/`max` together along the normal repositions the
  cut plane; moving `minA`/`maxA` and `minB`/`maxB` together repositions the footprint
  in-plane. The box may be dragged **partly or wholly outside** the workspace; columns that
  leave the voxel grid simply read no-data (transparent, §13.3) and drop out of the stats
  (§13.7), exactly as an out-of-range slab does along the normal. Rotate mode and the space
  toggle (§2.4) are ignored while a section is selected (an axis-aligned box has no
  orientation to rotate). **Size** (thickness/width/height) is changed only via the panel
  sliders (§13.2), not in the viewport; **position** is changed only via the viewport drag,
  not the panel.

### 13.9 Clip (geometry cross-section)

Exactly **one section at a time** can hide all **scene geometry** (floor, walls, boxes,
glTF — §14.6) **and every splat capture** (`gaussian_splats.md` §5.4) outside a band
along its **normal (collapse axis)**, giving a CAD-style
cross-section into the scene at the heatmap plane. Which section that is — if any — is the
scene-level **`clipSectionId`** (§14.1); it is **independent of selection**. The band is
**`clipRange` metres wide, centred on the cut plane** `(min + max) / 2` (§13.2):
`[mid − clipRange/2, mid + clipRange/2]`. Because it is centred on the plane, it
**follows the slab** as the section is dragged (§13.8).

- **Scope — geometry and splats.** The clip sets two intersecting world clipping planes
  (at the band bounds) on the **materials of every mesh in the scene geometry group** —
  floor, walls, boxes, glTF — with `renderer.localClippingEnabled` on. The coverage
  overlay (§9), cameras, probes, and the section's own heatmap and outline planes
  (§13.5) carry no clipping planes and are **never** clipped. Rebuilding or swapping the
  geometry group (§14.4) **re-applies** the active band to the incoming materials —
  clipping is per-material state now, so nothing propagates to a new mesh on its own.
- **Splats clip by a different mechanism, to the same band.** A capture is Gaussians,
  not triangles: a clipping plane discards fragments of a rasterized surface, which is
  not what a splat is. So the band is applied as a **Spark SDF erase**: **one** inverted
  `SplatEdit` on the splat group (§2.3) — not one per capture — holding a `BOX` SDF at
  `opacity: 0`, which zeroes the alpha of every Gaussian outside the band. Spark evaluates an edit on **world-space**
  splat centres, and an edit parented outside any capture applies to **every** capture,
  so a single world-space box clips the whole layer. The edit is added when a clip
  becomes active and removed when it clears, so an unclipped scene does no per-frame
  work for it. Leaving captures unclipped was rejected: a cutaway exists to see inside,
  and the full capture standing behind the cut geometry would defeat it and read as a
  bug. The band → box mapping is a **pure, tested function** of the band and the
  workspace AABB alone — no capture's position, rotation or scale enters it
  (`gaussian_splats.md` §5.4).
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

The scene can be saved to and loaded from a **named scene file** inside a **scene
folder** on disk — a portable representation of the geometry, cameras, probes,
sections, and splat captures. One folder holds **any number** of scene files sharing its
one `assets/`, so
variants of the same site (a night-shift layout, a 96-camera build-out) sit side by side
without duplicating GLB or capture bytes. This uses the **File System Access API**
(`showDirectoryPicker`), so import/export is available only in Chromium-based browsers;
where the API is absent the controls are hidden (§14.7).

Only the **directory** picker is ever used. A `FileSystemFileHandle` from a native file
dialog grants access to that one file and the API exposes **no parent**, so a scene
picked that way could never resolve its sibling `assets/*.glb`. The folder is therefore
what grants access, and the file within it is chosen from an **in-app list** of that
folder's scene files (§14.4).

View/render preferences (backend, overlay hue, transform space, intensity scale, panel
split) are **not** part of the scene file — they remain app-local.

### 14.1 Unified `Scene` model

- All scene entities live in a single in-memory `Scene`:
  `{ geometry: GeometryObject[], cameras: Camera[], probes: Probe[],
  sections: Section[], clipSectionId: string | null, zones: Zone[],
  volumes: SamplingVolume[], useZones: boolean,
  constraintGroups: ConstraintGroup[], constraints: CameraConstraint[],
  splats: SplatObject[] }`. A
  **`Camera`** is the app camera
  entity — `CameraConfig` extended with a `name` (§5.6), an **`enabled`** flag
  (§5.4), `aimLocked`, and an optional **`constraintId`** (§5,
  `camera_placement.md` §6.3); the app **filters to enabled cameras and converts each to a
  plain `CameraConfig`** (dropping all four) at the `setCameras()` boundary (§8), the
  only place the SDK type is required — so probe/section/zone **and camera** names all
  live on their own entities (no side map). `clipSectionId` is the section currently
  clipping the scene (§13.9), or `null`.
  A **`SplatObject`** is one 3D Gaussian Splat capture — `{ id, name, src, enabled,
  position, rotation, scale }`, with a **uniform** `scale: number` (a non-uniform scale
  would shear the capture's Gaussians) — referencing a file under the scene folder's
  `assets/` (§14.2). It is a **separate array, deliberately not a fourth
  `GeometryObject` kind**: a capture contributes no triangles, so it would break §14.6's
  "every geometry object contributes to occlusion", and it is selectable and editable,
  which §14.9 rules out for geometry (`gaussian_splats.md` §2.1).
  `defaultScene()` seeds `zones`/`volumes` **empty**, `useZones` **false**,
  `constraintGroups`/`constraints` **empty** (`camera_placement.md` §9),
  `splats` **empty** (`gaussian_splats.md` §2.1), and
  `clipSectionId` **null** (`sampling_volumes.md` §9); the default cameras
  (`cameras/defaults.ts`) carry **blank** names, so they display as `Camera N`.
- The startup scene is **constructed in code** as a `Scene` from today's defaults
  (`buildRoom.ts` geometry + `cameras/defaults.ts`); no folder is opened at boot (the
  File System Access API requires a user gesture), and there is **no save target** —
  neither folder nor filename (§14.5). `defaultScene()` is the single source of the
  boot state.
- Import **fully replaces** the current `Scene` (§14.4); it never merges.

### 14.2 Folder layout & asset resolution

```
<scene folder>/
  scene.json          # a serialized Scene (§14.3)
  night-shift.json    # another, sharing the same assets/
  dense-96cam.json    # …and another
  assets/
    shelf.glb         # GLB/GLTF files referenced by the scene files
    site.spz          # 3DGS capture files, likewise (gaussian_splats.md §3.1)
    ...
```

- A **scene file** is any `*.json` at the **folder root** that parses as a valid scene
  (§14.3). `scene.json` is only the **default name** a first save proposes, never a
  requirement, and a folder may hold as many scene files as you like.
- Scene files are **flat** — only the folder root is searched, never subfolders. A
  scene one level down would sit one level from `assets/`, and reaching back up needs a
  `..` segment that this section's own path rule rejects.
- A `gltf` geometry object's `src` is a path **relative to the folder root**
  (e.g. `assets/shelf.glb`), resolved through the picked directory handle — so every
  scene file in a folder resolves assets identically, which is exactly what lets them
  share one `assets/`.
- A **splat**'s `src` follows the **same rule** (e.g. `assets/site.spz`), validated by
  the same `isSafeAssetPath` and copied by the same cross-folder Save As… (§14.5).
  Accepted extensions are the single-file capture formats — `.spz`, `.sog`, `.ply`,
  `.splat`, `.ksplat`; a bare PCSOGS bundle (a `meta.json` plus sibling `.webp`
  payloads) is **not** supported, since the `.sog` zip carries the same data in one
  file (`gaussian_splats.md` §3.1). Sharing one `assets/` matters more here than for
  GLB: a site capture can run to hundreds of megabytes, and every scene variant in the
  folder reads that one copy.
- Referencing anything outside the folder (absolute paths, URLs, `..` segments) is
  invalid and rejected on import (§14.8).
- **The filename is the scene's name.** A scene file carries no `name` field: a name
  inside the file would drift from the filename the moment either changed, and the file
  already has exactly one authoritative name — the one on disk.

### 14.3 Scene file format

- **Filename** — any portable name ending `.json` (§14.2, §14.5); nothing in the format
  depends on it, which is why **`formatVersion` stays `3`**. Naming scene files changes
  which file is read, not what is in it. (`scene.json` remains the conventional default
  name, and the name this spec uses in examples.)
- **`formatVersion`** — integer, currently `3` (bumped from 1 for zones/volumes, and
  from 2 for camera constraints). The reader **accepts 1, 2, and 3**: a v1 file reads with
  empty `zones`/`volumes` and `useZones` false, and a v1 or v2 file reads with empty
  `constraintGroups`/`constraints`. A version **> 3** is rejected (§14.8).
  **Splats did not bump it.** `splats` reads as `[]` when absent, so every existing file
  loads unchanged — the same additive precedent `name`, `clipRange`, the camera
  `enabled` flag and the section footprint bounds set below. A bump to `4` was rejected
  precisely because a version > 3 is rejected *outright*: a scene carrying a visual
  backdrop would become unopenable by an older build, when an older reader can simply
  ignore a key it does not know (`gaussian_splats.md` §8).
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
  the `CameraConfig` fields **plus** an optional `name`, an optional `enabled`, an
  optional `aimLocked` (`aim_optimization.md` §9, absent ⇒ `false`, omitted on write
  when false), **and an optional `constraintId`** (`camera_placement.md` §6.3, absent ⇒
  unbound, omitted on write when absent) — **not** the bare SDK type; the reader builds the app `Camera`, and the app converts
  to `CameraConfig` only at `setCameras()` (§14.1). A camera's **`enabled`** flag
  (§5.4) is **optional on read**, defaulting to `true` when absent, and — since
  cameras are enabled by default — **omitted on write when `true`** (only
  `enabled: false` is written). A section's per-entity flag is **`enabled`** (renamed from
  the legacy `visible`, which the reader still accepts for back-compat, §14.8). A
  section's **`clipRange`** (§13.9) is **optional on read**, defaulting to `2`
  (clamped to the collapse-axis extent) when absent. A section's in-plane footprint
  bounds **`minA`/`maxA`/`minB`/`maxB`** (§13.1) are also **optional on read**, each pair
  defaulting to the **full workspace-AABB extent** along its in-plane axis when absent — so
  files written before finite footprints load spanning the whole workspace in-plane,
  unchanged in appearance. Like `clipRange` and the camera `enabled` flag, adding them is
  back-compatible, so there is **no format-version bump** (they were added under `2`).
- **`name`** on each **camera**, **probe**, and **section** is the user-edited
  display label (§5.6, §12.1, §13.1), **optional on read** — a blank/missing name
  reads as the default `Camera N` / `Probe N` / `Section N`, never an error — and, to
  keep files tidy, is **omitted on write when blank** (an unnamed entity has no `name`
  key and reads back as its default). Adding `name` is back-compatible, so there is
  **no format-version bump** (added under `2`), exactly like `clipRange`/`clipSectionId`/the
  camera `enabled` flag.
- **Array order is significant.** The order of `cameras`, `probes`, `sections`, `zones`,
  `volumes`, `constraintGroups`, `constraints`, and `splats` is the **hierarchy display order**
  (§5.5), preserved verbatim on read and
  write. Drag-reordering (§5.5.1) rewrites these arrays in place; there is no separate
  order field and none is needed, so reordering is **not** a format change. A
  `volumes` array may **interleave zones** — volumes always append on create — and the
  reader/writer preserve that interleaving exactly; a zone's row order is the order of its
  own volumes within the array, ignoring the others.
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
- **`constraintGroups`** / **`constraints`** — the camera-placement state
  (`camera_placement.md` §9). A group is
  `{ id, name, enabled, fov, far, namePrefix, poolSize, maxCount, trials, epsilon, seed }`
  — the camera **template**, the **pool size** and the analysis **strategy** all persist, so a
  seeded search is reproducible from the file that records its output. A group carries no
  `aspect`/`near` of its own (`camera_placement.md` §3.1.1); both keys are read and ignored
  when an older file has them. It may also carry **`zoneIds`** (ids of `zones`, the group's
  **target zones**), **`restrictScoring`** and **`restrictMounts`**
  (`camera_placement.md` §3.1.2) — all three **optional on read**, defaulting to `[]` /
  `true` / `false`, and written always. They are **additive at `formatVersion` 3**, with no
  bump: a v3 file without them reads as an untargeted group, and a file with them opens in an
  older build as the same untargeted group. A `zoneIds` entry naming an unknown zone is
  **dropped**, as a `volume` with a dangling `zoneId` already is — a scene that legitimately
  lost a zone must still reload. A constraint is
  `{ id, groupId, name, enabled, kind, distance }` plus its per-kind geometry:
  `position` (point), `points` (polyline), or `position`/`rotation`/`size` (plane).
  The **pool, the search result, and the selected camera count are not persisted** —
  derived data invalidated by any scene change (`camera_placement.md` §3.3.1), the same
  line drawn for the zone tool's generation levels.
- **`splats`** — the 3D Gaussian Splat captures (`gaussian_splats.md` §8). Each is
  `{ id, src, enabled, position, rotation, scale }` plus **`name` when non-blank**, with
  `scale` a **single number** (uniform, `> 0`) rather than a `[x,y,z]` triple — the one
  transform in this format that is not a `Vec3` scale, because a non-uniform scale
  shears the capture's Gaussians. `enabled` is **optional on read** (default `true`) and
  — since splats are enabled by default — **omitted on write when `true`**, exactly like
  the camera flag. A blank/missing `name` reads back as the **capture's filename**, not
  as `Splat N` (§5.5). **Additive at `formatVersion` 3, no bump** (above). Load state —
  progress, splat count, or a load failure — is derived and **never persisted**.
- **Ids** are unique within each category; duplicates are rejected (§14.8).

Sketch:

```json
{
  "formatVersion": 3,
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
      "minA": -10, "maxA": 10, "minB": -10, "maxB": 10,
      "aggregation": "mean", "enabled": true, "name": "Ground floor" }
  ],
  "zones": [ { "id": "zone-1", "name": "West wing", "enabled": true } ],
  "volumes": [
    { "id": "volume-1", "zoneId": "zone-1",
      "position": [3,1.5,-2], "rotation": [0,0.259,0,0.966], "size": [4,3,6] }
  ],
  "constraintGroups": [
    { "id": "cg-1", "name": "Dock", "enabled": true,
      "fov": 60, "far": 30, "namePrefix": "Dock",
      "zoneIds": ["zone-1"], "restrictScoring": true, "restrictMounts": false,
      "poolSize": 200, "maxCount": 10, "trials": 1000, "epsilon": 1.0, "seed": 1 }
  ],
  "constraints": [
    { "id": "con-1", "groupId": "cg-1", "name": "Gantry rail", "enabled": true,
      "kind": "polyline", "distance": 0.4,
      "points": [[-9,5.4,-9],[-9,5.4,9],[9,5.4,9]] },
    { "id": "con-2", "groupId": "cg-1", "name": "North wall", "enabled": true,
      "kind": "plane", "distance": 0.3,
      "position": [0,4,-9.6], "rotation": [0,0,0,1], "size": [18,3] }
  ],
  "splats": [
    { "id": "splat-1", "src": "assets/site.spz",
      "position": [0,0,0], "rotation": [0,0,0,1], "scale": 1 },
    { "id": "splat-2", "name": "North dock", "src": "assets/dock.sog",
      "enabled": false,
      "position": [12,0,-40], "rotation": [0,0.707,0,0.707], "scale": 0.98 }
  ]
}
```

### 14.4 Import

**Load…** opens the **Load scene** dialog (§14.7), which settles a folder and then a
scene file within it:

1. The dialog opens on the current save target's folder when there is one, listing its
   scene files **immediately** — so switching between variants that share one `assets/`
   costs no OS dialog at all. **Change…** opens `showDirectoryPicker` (`mode: 'read'`);
   with no folder granted yet, Load… opens the picker first.
2. The app enumerates every `*.json` at the folder root and runs each through the same
   schema validation as step 4 — **parse only, no GLB is loaded** — so each row can name
   what its file holds (cameras / probes / sections). A `*.json` that is not a valid
   scene file is listed **greyed and unselectable, with its reason**, so a stray
   `package.json` is visibly excluded rather than mysteriously absent. Parsing is capped
   at **200** files; any beyond that list name-only and validate on selection.
3. If the current scene differs from the state serialized at its last load or save, the
   dialog warns that loading discards those changes and its commit button reads **Load
   anyway** (§14.7). The comparison is `serializeScene` output against that stored
   baseline, computed **when the dialog opens** — exact (a drag that ends where it
   started is not a change) and free while editing.
4. On commit the chosen file is read, parsed, and **validated all-or-nothing** — schema,
   `formatVersion`, id uniqueness (per category), object `kind`s, asset-path safety
   (§14.2), and — for sampling — every `volume.zoneId` referencing an existing zone
   and `size` components > 0 (`sampling_volumes.md` §9). Import replaces
   `zones`/`volumes`/`useZones` too (each zone's `enabled` flag comes from the file),
   and `splats` — each with a safe `src` (§14.2), a finite `scale > 0`, a 4-tuple
   `rotation`, and a boolean `enabled` when present (`gaussian_splats.md` §8).
5. Load **every** referenced GLB/GLTF via `GLTFLoader` (from `three/examples`, no new
   npm dependency). Any missing-file or parse failure aborts the import.

   **Splat captures are deliberately *not* part of this gate.** A missing or
   undecodable capture leaves the import successful and reports on the row instead
   (§14.8, `gaussian_splats.md` §9): the geometry is what coverage is measured against,
   so a broken GLB invalidates the scene, while a capture is a backdrop that cannot
   change a single number — refusing to open a 96-camera layout over it would be the
   wrong trade. Captures load **asynchronously and non-blockingly** after the import
   commits, so a hundreds-of-megabyte read never delays the scene appearing.
6. Only if all of the above succeed: build the merged collision mesh (§14.6),
   **cancel any in-flight compute** (`camera-coverage-sdk` §13.2 — an actual abort, not
   just a discarded result), replace the `Scene`, clear the coverage overlay
   and the retained per-run probe/section data (they read "no-data", §12.3/§13.4, until
   the next run), **dispose every loaded capture and the decode cache**
   (`gaussian_splats.md` §3.3 — driven from here, not inferred by the splat layer:
   two scene files in one folder share an asset loader, so the layer cannot see
   that the scene changed) and start the incoming scene's capture loads,
   **re-initialize the engine against the new collision mesh (§8) — a load,
   not a run**, and **require an explicit Run** (§8) — import never auto-computes.
7. A successful load sets the save target to `{ folder, filename }` (§14.5) and stores
   the loaded scene's serialization as the new dirty-check baseline.
8. On **any** failure the current scene is left **completely untouched**, the target is
   unchanged, and the error is surfaced **in the dialog, which stays open** (§14.8) so
   another file can be tried without re-navigating. There is never a half-loaded scene —
   silently dropping an occluder would understate coverage. Import **fully replaces**
   the current `Scene` on success and never merges (§14.1).

### 14.5 Export (Save / Save As…)

- Serializes the current `Scene` to a **named `*.json`** inside a scene folder, written
  **in place** through the directory handle (a true round-trip).
- The app tracks a **save target** — the pair `{ directory handle, filename }` the
  current scene is associated with. A successful **import** (§14.4) sets it to the
  imported folder and file; a successful **Save As…** retargets it; a **failed** import
  or write leaves it alone. The target is **session-only**: never persisted, and a page
  reload returns to the boot state with no target (§14.1) — a restored target beside
  the default room would turn one Save into silently overwriting a real scene.
- **Save** writes the target file with no *naming* dialog — a true round-trip back to
  the file the scene was *opened* from, rather than to whichever file happened to be
  saved to last. It is silent only when it **creates** the file; replacing one is
  confirmed first (**Overwrite confirmation** below). In practice a target names a file
  that exists — an import sets it, a Save As… creates it — so a routine re-save does
  carry one confirmation click. That is the deliberate trade: the write is destructive
  and irreversible, and nothing else in this app destroys a file on disk.
- **Save with no target behaves exactly as Save As…**: `showDirectoryPicker` first (it
  needs the click's user activation), then the naming dialog pre-filled `scene.json`.
  One code path, so a scene built from scratch gets named like any other — which is the
  case where a name is most wanted.
- **Save As…** opens the **Save scene as** dialog (§14.7) — an editor for the target
  pair `{ folder, filename }`. Nothing is written until its own commit.
  - **Name** is pre-filled from the current filename and **normalized** on commit:
    trimmed, with `.json` appended unless it already ends that way (case-insensitively)
    — so `notes.txt` becomes `notes.txt.json`. The extension is not as optional as it
    looks: the Load dialog lists `*.json` (§14.4), so a name saved under any other
    extension would write a file the app could never find again. **Rejected**: empty, a
    leading `.` (it hides the file and would make `.json` itself a legal name), and any
    of `/ \ : * ? " < > |` — scene folders travel between machines, so a name has to be
    portable, and a path separator would silently mean a subfolder, which §14.2 does not
    allow. Spaces and non-ASCII are fine; a site survey names its own scenes. A rejected
    name disables commit and states the rule. Where normalization would change what was
    typed, the dialog says what will be written (`Will be saved as night-shift.json`), so
    an appended `.json` is never a surprise.
  - **Change…** opens `showDirectoryPicker` (`mode: 'readwrite'`) and rewrites **only**
    the dialog's folder — the name carries over and stays editable, so the destination
    can be seen before the name is settled.
  - **Overwrite is reported inline**, recomputed against whichever folder is currently
    selected: whether it already holds a file of this name, how many of this scene's
    referenced assets it would replace, or both. When the save would replace anything,
    the commit button reads **Replace**. No modal confirmation stacks on the dialog.
    (The directory picker, unlike `showSaveFilePicker`, gives no overwrite warning of
    its own.)
  - On commit: **same folder** → write the scene file only; **different folder** → copy
    assets, then write (below). Either way the target becomes
    `{ chosen folder, normalized name }`.
- **Overwrite confirmation.** A write that would **replace an existing file** is confirmed
  first, in a small modal (§14.7) naming what it replaces. **One rule, both write paths**:
  a plain **Save** onto a target file that exists, and a **Save As…** commit onto a name
  the destination already holds, are the same destructive act and ask the same question.
  A Save As… onto a name that does **not** exist writes straight through — there is
  nothing to destroy, and asking would train the click away.
  - The question names `<folder>/<file>` and, for a cross-folder Save As…, how many of
    this scene's referenced assets that folder would also replace. Buttons: **Cancel**,
    **Overwrite**.
  - **Cancel is a no-op**: nothing written, target unchanged, and the surface underneath
    left exactly as it was — the **Save scene as** dialog stays open with the typed name
    intact, a plain Save leaves no dialog at all (§14.8).
  - Because the confirmation is what immediately precedes the write, **its own** click is
    the user activation the lazy `requestPermission` runs from (write permission, below).
  - The Save-as dialog keeps its inline replace warning **and** its **Replace** commit
    label. They answer a different question at a different time: the warning is what
    tells you a name collides *while you are still typing it*, and the label says where
    the button leads. The confirmation is the gate, not the notice.
- **Saving a variant is the same-folder case.** Save As… into the current folder under a
  new name writes one small JSON and copies nothing — which is the point of naming scene
  files: `night-shift.json` beside `scene.json`, both reading the same
  `assets/site.glb`.
- **Write permission** — import picks `mode: 'read'`; write access on that folder is
  requested **lazily on the first save** (`requestPermission({ mode: 'readwrite' })`,
  from the click's user activation), so viewing a scene never asks to edit files. **Every**
  write goes through that request — a plain **Save** and a **same-folder Save As…** alike,
  the latter being the commonest first write there is, since saving a variant beside the
  scene it was loaded from writes into the folder Load granted read-only. Once granted,
  the handle stays writable for the session and later saves are silent; a folder chosen
  through **Change…** is picked `readwrite` outright, so it is never re-asked (the grant
  is per-handle and survives editing the name before commit). A denied request keeps the
  scene *and* the target and reports in place (§14.8).
- **Picker anchoring** — every `showDirectoryPicker` call (Load's **Change…**, Save
  As…'s **Change…**, the no-target Save fallback) passes `startIn: <target folder>`
  when a target exists, plus a stable `id` so the app keeps its own
  remembered-directory bucket instead of following the last folder used anywhere in the
  origin.
- An in-place **Save** writes **only the scene file** — the GLB/GLTF and capture bytes
  are already
  in the folder, and are shared with every other scene file there. A `gltf` object whose
  `src` is absent from the folder is a **dangling reference** and will fail a later
  import (§14.8); it also aborts a cross-folder Save As…, which cannot copy a file that
  isn't there. A **splat** whose `src` is absent is the deliberate asymmetry: it is
  survivable on **import** (the row reports it, §14.8) but still **aborts a cross-folder
  Save As…**, because a copy cannot invent bytes and a destination that is supposed to
  hold a complete scene would silently not
  (`gaussian_splats.md` §9). Bundling/embedding asset bytes into the scene file stays
  out of scope (§14.9) — copies are ordinary files.
- **Assets follow a cross-folder Save As…** — a save into a folder that is *not* the
  target's copies every asset the scene references (§14.2) — every `gltf` `src` **and
  every splat `src`**, deduplicated across the two by `planAssetCopy(geometry, splats)`
  — from the target folder
  to the same relative path under the destination, creating intermediate folders as
  needed, so the new folder is a self-contained scene. A capture referenced by two
  splat rows (`gaussian_splats.md` §3.3) copies **once**. Only referenced `src` paths are
  copied, and each is copied once; unreferenced files under the source's `assets/` are
  left behind (a cross-folder Save As… therefore also prunes). Bytes are re-read from
  the target folder at save time — nothing is retained in memory after import (§14.4) —
  which is why the target doubles as the asset source. Selecting the target's own folder
  in **Change…** *is* the same-folder case (`isSameEntry`): no copy, whatever name is
  committed. A cross-folder destination states the count before the commit
  (`3 assets will be copied into this folder, so it holds a complete scene.`), since it
  is the save that does real work.
- **Order** — every asset copies **before** the scene file is written. Any copy failure
  (source file gone, read error, write/quota failure) aborts the save with an error
  naming the asset: no scene file is written and the target is unchanged (§14.8).
  Already-copied bytes are left in place — rolling them back could delete a file the
  copy legitimately overwrote. A destination with no scene file is visibly incomplete;
  one with a scene file that can't import is a trap.
- A successful save stores the serialization it wrote as the new dirty-check baseline
  (§14.4).

### 14.6 Geometry rendering & collision

- **Rendering** — `room`/`box` primitives render as today (§4.1); `gltf` objects render
  with their own materials from the loaded glTF scene graph, positioned by the object
  transform. **All** renderable geometry — primitives and glTF meshes alike — is forced
  **double-sided** (`side = THREE.DoubleSide`), overriding whatever `side` a glTF file's
  materials authored, so back-faces never cull (e.g. viewing a room from inside, or a
  section cutaway exposing an interior face). This applies only to `side`; every other
  material property from the glTF is preserved.
- **Build swap** — replacing the geometry on import (§14.4) **detaches** the outgoing
  build from the scene graph before **releasing** its GPU resources, and attaches the
  incoming one after. A load therefore never draws a frame against a freed build: no
  flash of the outgoing scene, no both-scenes-at-once, and no garbage where a clip band
  (§13.9) was active.
- **Collision** — **every** geometry object contributes to occlusion. Each object is
  reduced to world-space triangles: primitives generated as before; GLB meshes traversed,
  each mesh's geometry transformed by (node world-matrix × object transform) and
  de-indexed into world-space positions/indices. Non-mesh glTF nodes (embedded lights /
  cameras) are ignored. All triangles are merged into the single indexed `SceneMesh`
  passed to `engine.loadScene` (§4.1). This statement is **exact**, and is one of the
  two reasons a splat capture is not a `GeometryObject` (§14.1): a capture has no
  triangles to contribute, so it occludes nothing and is absent from the `SceneMesh`.
- **The Geometry layer toggle hides drawing only** (§2.4). Unticking it sets the render
  group invisible; the merged `SceneMesh`, the workspace AABB, and every standing
  coverage result are untouched, so the toggle never marks the result stale (§8.1). It
  exists because splats draw **behind** this group (§2.3) — hiding the model is how the
  real capture is seen with the same cameras and the same overlay
  (`gaussian_splats.md` §5.3).
- **Workspace** — the AABB passed to `init` (§4.2) is derived from the merged geometry's
  bounds (with the existing margin), so imported geometry extending beyond the default
  room is still covered. Splats contribute **no** bounds (§4.2).

### 14.7 UI controls

- **Load…** (import, §14.4), **Save**, and **Save As…** (export, §14.5) actions in a
  **"Scene"** panel at the top of the left panel (§2.2), above the scene hierarchy.
- Load…, Save As…, and **Add 3DGS** open **centred modal dialogs over a dimmed
  backdrop** — the app's
  only backdrop modals (`ai/VISUAL_DESIGN.md`). All three genuinely block: each settles
  a reference to a **file on disk** — which scene is loaded, which file Save writes, or
  which capture a splat row points at — and one of them can discard unsaved work. That
  shared question is why Add 3DGS is a modal card rather than a popover hanging off the
  "+" menu, despite being reached from a menu. **Escape**
  cancels, matching the existing dialog's key handling; the commit button is the primary
  action. **Keyboard and pointer**: in the Load list, **ArrowUp/ArrowDown** walk the
  **loadable** rows only — an unselectable row is listed to explain its absence, not to be
  stopped on — and **Enter** commits the selection, as **double-clicking** a loadable row
  does; in **Save scene as**, **Enter** in the Name field commits a valid name. Each is a
  shortcut for the footer's commit button and carries exactly its warnings, so nothing is
  ever loaded or replaced without the same label on screen.
  - **Load scene** — a folder line (`site-a/`, with **Change…**), then the folder's
    scene files, one row each with its summary (`96 cams · 12 probes`) and the target's
    current file marked **current**; invalid `*.json` rows greyed with their reason
    (§14.4). The mark is matched on the **folder as well as the name** (`isSameEntry`),
    since two folders granted in one session can each hold a `scene.json` and only one of
    them is what Save writes to — browsing away from the target's folder therefore marks
    nothing. The list opens with that current file selected, or with the first loadable
    row when the folder is not the target's, so the commit key always has a subject. A
    name too long for its row **ellipsizes with the full name on hover**, never at the
    cost of the `current` mark — the mark is what says where Save goes, so it stays
    visible whatever the name's length. The list scrolls inside the card. An unsaved-changes warning turns the commit button
    into **Load anyway**. Buttons: **Cancel**, **Load**.
  - **Save scene as** — the same folder line with **Change…**, a **Name** text field,
    and the inline overwrite / asset-clash warning beneath it (§14.5), which turns the
    commit button into **Replace**. An invalid name disables commit and states the rule.
    Buttons: **Cancel**, **Save**.
  - **Add 3DGS** — opened from the hierarchy's **"+" → 3D Gaussian Splat…** (§5.5), the
    only "+" entry that opens a dialog. It lists the capture files **already present in
    the scene folder's `assets/`** — root of `assets/` only, non-recursive, the same
    flatness rule §14.2 applies to scene files — filtered to the accepted extensions
    (§14.2) and sorted **case-insensitively and stably**, exactly as the Load list is,
    so a folder's contents do not reshuffle between openings. Each row shows the
    filename and its **byte size**; no file is read or decoded to build the list, only
    its metadata. A file this scene already references is **still listed and still
    selectable** — two rows on one capture is how two registrations are compared
    (`gaussian_splats.md` §3.3). It opens on the **first selectable row**, and its
    list takes the **same keyboard as the Load list** — Arrow keys over the
    selectable rows only, clamped at both ends, Enter or a double-click to commit —
    through the same shared `moveListSelection` (§14.7's list rule). Committing adds
    a splat row at an identity transform and auto-selects it. A folder with no `assets/`, or none holding an accepted file,
    says so and offers no commit. Buttons: **Cancel**, **Add**.
  - **Overwrite scene file?** — the confirmation of §14.5: a short card, no folder line
    and no fields, stating what would be replaced. Buttons: **Cancel**, **Overwrite**.
    It is the one dialog that may sit **over another** (the Save-as dialog it was
    committed from), and the only stacking this app allows. Stacked, it does not dim a
    second time — the backdrop beneath already dims the scene, and doubling it reads as a
    rendering fault rather than as depth. **Escape closes the topmost dialog only**, so
    cancelling the confirmation returns to the Save-as dialog with its name intact rather
    than discarding both.
- A status line under the actions names the target (§14.5). Idle it reads
  `<folder>/<file>` — composed for disambiguation, since two folders granted in one
  session can both hold a `scene.json`. Only each handle's leaf `name` is available
  through the API, never a real path, so the `/` is **display only**. With no target the
  line says so (`No file chosen — Save will ask where to write.`). After a successful
  save it briefly reads `Saved <file>` — the folder did not change — or
  `Saved to <folder>/<file> — N assets copied` when a cross-folder Save As… copied
  assets (§14.5): a silent write needs an acknowledgement, since no dialog closes to
  signal it.
- Errors raised by either dialog render **inside it**, leaving it open so the next file
  or folder can be tried without re-navigating (§14.8). The panel's error banner is for
  failures with **no dialog open** — a plain **Save** that cannot write.
- Where the File System Access API is unavailable, the panel shows an
  explanatory hint instead of the actions — there is no scene-file control in
  that case (no in-app "reset to default"; reloading the page restores the
  boot state, §14.1).

### 14.8 Error handling

| Case | Handling |
|---|---|
| User cancels a folder picker | no-op; the dialog stays open on its previous folder |
| User cancels the Load or Save-as dialog | no-op, nothing written, scene and target unchanged |
| User cancels the overwrite confirmation | no-op, nothing written, target unchanged; the surface beneath is untouched — the Save-as dialog stays open with its typed name, a plain Save leaves no dialog |
| Target file cannot be probed for the confirmation (permission, folder gone) | treated as "no file", so no confirmation is raised; the write that follows reports the real error |
| Target folder gone / renamed / unmounted, cannot be enumerated | error **in the dialog**, which stays open with **Change…** offered; scene and target unchanged |
| Folder holds no valid scene file | the dialog says so and offers **Change…**; nothing is loaded |
| A `*.json` in the folder is not a valid scene file | that row lists greyed and unselectable with its reason (§14.4); the rest of the list is unaffected |
| Chosen scene file unreadable / not JSON / schema-invalid | abort, keep current scene and target, error in the dialog |
| Newer `formatVersion` (> 3) | abort, keep current scene, show error (v1, v2 and v3 are accepted) |
| Duplicate id within a category (incl. zones, volumes, constraint groups, constraints) | abort, keep current scene, show error |
| Unknown geometry `kind` | abort, keep current scene, show error |
| `volume.zoneId` referencing no zone, or non-positive `size` | abort, keep current scene, show error |
| `constraint.groupId` referencing no group, or `camera.constraintId` referencing no constraint | abort, keep current scene, show error |
| Unknown constraint `kind`, negative/non-finite `distance`, a polyline with fewer than 2 points, or a non-positive plane `size` component | abort, keep current scene, show error |
| A group template, pool size or strategy out of range (`fov` outside (0,180), `far ≤ 0`, `poolSize`/`maxCount`/`trials < 1`, `epsilon < 0`, non-integer `seed`) | abort, keep current scene, show error (`camera_placement.md` §9) |
| Unsafe `src` (absolute / URL / `..` / outside folder) | abort, keep current scene, show error |
| Referenced GLB missing or fails to parse | abort, keep current scene and target, error in the dialog |
| Load would discard unsaved changes | inline warning; commit button reads **Load anyway** — pressing it loads, cancelling keeps the scene |
| Invalid filename in Save As… (empty, leading `.`, path separator or reserved character) | commit disabled, the rule stated inline, nothing written |
| Save-as name collides with an existing file, or would replace referenced assets | inline warning naming what is replaced; commit button reads **Replace**; pressing it overwrites |
| Export write fails | keep in-memory scene **and the target**, show error |
| Write permission denied on first save | keep in-memory scene and the target, show error |
| Target folder renamed / deleted / unmounted on save | keep in-memory scene and the target, show error (Save As… redirects) |
| Referenced asset missing from the source folder on a cross-folder Save As… | abort before writing the scene file, keep target, show error naming the asset (splat captures included — a copy cannot invent bytes) |
| Asset copy fails (read, write, or quota) | abort before writing the scene file, keep target, show error naming the asset |
| Unsafe splat `src` (absolute / URL / `..` / outside folder) | abort the import, keep current scene, show error (as for `gltf`) |
| Duplicate splat id, non-positive or non-finite `scale`, malformed `rotation`, non-boolean `enabled` | abort the import, keep current scene, show error |
| Referenced splat capture **missing** from `assets/` | **import succeeds**; the row badges `⚠ missing from assets/`; nothing is drawn; no coverage number changes (§14.4 step 5) |
| Referenced splat capture unreadable or **fails to decode** | **import succeeds**; the row badges `⚠ could not be decoded`; nothing is drawn; no coverage number changes |
| Referenced splat `src` is a PCSOGS `meta.json` — only reachable by hand-editing, since the Add dialog never offers one | **import succeeds**; the row badges `⚠ SOG bundle — use its .sog zip`, naming the remedy rather than the bare failure |
| No `assets/` folder, or it holds no accepted capture | the **Add 3DGS** dialog says so and offers no commit (§14.7) |
| No save target yet (boot) | the "+" menu's **3D Gaussian Splat…** entry is disabled: *"Load or save a scene first."* (§5.5) |
| No WebGL2 context | the viewport cannot be created and App surfaces the failure in its place; compute is unaffected, having its own device in the worker (§2.3) |
| Spark's dynamic import fails | the affected rows badge `⚠ could not be decoded`; nothing else is affected (§2.3) |

### 14.9 Out of scope for this feature

- In-app **`geometry`** authoring — no add / move / scale / delete of geometry via gizmos
  or panels, and geometry is not selectable/editable like cameras/probes/sections. The
  geometry list is authored by editing the scene file or via export (§14.5). This rule
  is scoped to the **`geometry` array**: a **splat** lives in its own `splats` array and
  *is* addable, selectable, and editable, which is one of the two reasons it is not a
  fourth `GeometryObject` kind (§14.1, `gaussian_splats.md` §2.1).
- Embedding or bundling assets (data-URI, zip) — assets stay file references (§14.5).
- **File management** — no renaming, duplicating or deleting scene files from within the
  app, and **nothing is ever written into `assets/`**: a splat capture is dropped in by
  the user and merely **referenced** (`gaussian_splats.md` §3.2), never copied or
  transcoded in-app. The Load and Add 3DGS dialogs list what is on disk; rearranging it
  is the OS's job. (Save As… under a new name is the supported way to fork a scene, and
  it is the one operation that does copy asset bytes, §14.5.)
- Non-Chromium browsers (no File System Access API).
- Additional primitive kinds (cylinder, sphere, …) — use GLB for arbitrary shapes.

---

## 15. Camera info export

A **one-way sidecar file**: every camera's position, orientation, and what its center ray
hits, written for an external tool to consume. It is **written, never read** — the app has
no importer for it, nothing in the app derives from it, and `scene.json` (§14) remains the
only round-tripping format. It is also the app's **first** feature to query the scene
geometry outside the coverage engine.

### 15.1 Trigger

- **Right-clicking the "Cameras" group header** in the scene hierarchy opens a menu whose
  single item is **Export camera info** (§5.5). Choosing it casts every camera's center ray
  (§15.3), builds the file (§15.2), and downloads it.
- **No ellipsis on the label.** Nothing opens: the file downloads. In this app "…" marks an
  item that opens a dialog (**Save As…**, **3D Gaussian Splat…**, §14.7), and this is not one.
- **Enabled except during its own run.** With **no cameras** the export still runs and writes
  `[]` — the Cameras header renders even when the group is empty (§5.5), and an empty array is
  the truthful answer to "what is the layout", not an error. The one thing that disables it is
  a **previous export still casting** (§15.3): the item greys out carrying
  `Still casting the camera rays…` as its `title`, so a second click cannot start a second
  cast over the same mesh. The blocker is a **string, not a flag**, matching the "+" menu's
  **3D Gaussian Splat…** gate (§14.7) — a disabled row explains itself rather than just
  failing to respond.
- **Which group headers have menus is a per-group record.** The routing is one exhaustive
  `Record<groupKind, item[]>` (§5.5) — Cameras declares this one item, every other group
  declares none, and an empty list opens no menu. This requires the hierarchy's `group`
  node to carry a **`groupKind`** discriminator: today it carries only its id
  (`'group:cameras'`), a plain string no exhaustive record can key on.

### 15.2 File format

**The shape is externally owned.** It is fixed by the consuming tool, and is not the app's to
tidy — in particular `info` is a **JSON document inside a JSON string**, deliberately, and
must not be "fixed" into a nested object.

```json
[
  { "name": "Camera 1", "info": "{\"pos\":[-3.4,1.8,12.25],\"rot\":[-30,0,0],\"hit\":[-3.4,0,4.116667]}" },
  { "name": "Front Gate", "info": "{\"pos\":[0,4,0],\"rot\":[-180,0,-180],\"hit\":null}" }
]
```

- The **outer document** is a JSON array, one object per camera with exactly the two keys
  `name` and `info`, pretty-printed with **2-space indent** (as §14.5 writes `scene.json`).
- **`name`** — the camera's hierarchy label: the trimmed `name`, or the default `Camera N`
  when it is blank (§5.6). Never empty. Deliberately **not made unique**: two cameras may
  carry the same label, and the file reproduces that rather than inventing suffixes, so a
  row reads exactly as the tree row it came from.
- **`info`** — a **string** holding a **compact** (no whitespace) JSON object with exactly
  three keys, in the order `pos`, `rot`, `hit`.
  - **`pos`** — the camera position `[x, y, z]` in **world space, meters, Y-up** (§14.3's frame).
  - **`rot`** — the orientation as **Euler angles `[x, y, z]` in degrees, rotation order `XYZ`**.
  - **`hit`** — the **hit point** of the camera's **center ray** (§15.3), `[x, y, z]` in the
    same frame, or **`null`** when the ray hits nothing. The key is **always present**.
- **`rot` is not the camera panel's convention, and the two must not be reconciled.** A camera
  stores a **quaternion** (§5.1); the camera panel edits it as **yaw/pitch/roll in degrees,
  order `YXZ`** (`cameras/math.ts`, the "aim, then tilt, then tilt-your-head" model). This
  export converts the same quaternion **independently**, to `[x, y, z]` degrees in order
  `XYZ`, so its three numbers **differ from the three the panel shows** for the same camera —
  a camera facing +X tilted 30° down reads `yaw -90 / pitch -30 / roll 0` in the panel and
  exports `[-90, -60, -90]`. Both are correct for their consumer — the panel's serves the UI,
  the export's is the external contract — and neither may be changed to match the other.
- **`rot` is one valid triple, not the prettiest one.** An `XYZ` decomposition is **not
  unique**: a level camera turned right around exports `[-180, 0, -180]`, where a human would
  write `[0, 180, 0]`. Both name the same rotation, and the export reports whatever the
  conversion yields rather than searching for the nicer branch — there is no canonical answer
  to search for. A consumer must **apply** the three angles in `XYZ` order, never compare them
  to a hand-written expectation.
- **Numbers are rounded to 6 decimals**, trailing zeros dropped (`2`, not `2.000000`).
  Micrometer precision is effectively lossless for anything downstream, and it suppresses the
  float noise a dragged gizmo or a quaternion→Euler conversion leaves behind
  (`-3.4000000000000004`, `29.999999999999996`) in a string a human has to read.
- **Filename** — `<scene>-cameras.json`, where `<scene>` is the save target's filename minus
  its `.json` (§14.5); the filename **is** the scene's name (§14.2), so the export is
  traceable to the layout it describes. With **no save target** — the boot scene (§14.1) —
  it is **`cameras.json`**. No timestamp: while iterating, a re-export should shadow the
  previous one, not accumulate copies.
- **Delivery is a browser download** (a blob URL and a synthetic `<a download>` click), not a
  File System Access write. It therefore needs **no folder permission** and works on the boot
  scene, where §14.5's save target does not yet exist, and it inherits none of §14.8's
  permission-lost / overwrite-confirm states. This is the app's **only** download path;
  every other write goes through §14.5.

### 15.3 The center ray

- **Every camera is exported, in hierarchy order** — the `cameras` array order (§5.5, §14.3).
  **Disabled cameras are included** (§5.4): disabled means "contributes no coverage", not
  "not mounted", and this file describes the layout. A camera flagged
  `CAMERA_INSIDE_GEOMETRY` (§11) is likewise exported, with whatever its ray hits.
- The ray starts at the camera **position** and runs along the camera's **forward direction** —
  the stored quaternion applied to `(0, 0, −1)` (§5.1's −Z convention). It is the frustum's
  center axis, so `hit` answers "what is this camera aimed at", independent of `fov` and
  `aspect`.
- It intersects the **merged scene geometry** — the room shell, box obstacles, and any GLB
  meshes of the `geometry` array (§14.6): the same surfaces the coverage engine occludes
  against, which is what makes `hit` the surface a camera's coverage stops at.
  **Splat captures are never hit** — a capture has no surface to intersect and no raycast
  index is built for one (`gaussian_splats.md` §6.5) — so a scene whose only visible content
  is a capture exports `hit: null` throughout. Gizmos, overlays, and section planes are never
  hit either.
- **Nearest hit wins**, and the ray is **unbounded**: it honors neither `near` nor `far`
  (§5.1). `far` is a detection range tuned for the *analysis*; letting it truncate the ray
  would report `null` for a camera plainly aimed at a wall 80 m away — which at the real
  sites, a workspace over a kilometer across with default `far`, is the common case, not the
  edge one.
- **A miss is `hit: null`.** Misses are real: a camera aimed up through the room's open top,
  or any camera in a scene with no geometry. `null` states "nothing there", which no sentinel
  point (`pos + forward × far`) can state without being mistaken for a surface.
- **Render state never affects the result.** Geometry hidden by the **Geometry** layer toggle
  (§2.4) and geometry cross-sectioned by a **section clip** (§13.9) are both **still hit**:
  hiding and clipping are viewing aids, while the layout is a fact about the site.
  Consequently two exports of one scene are **byte-identical** however the view is set up.
  This falls out of the implementation for free — Three.js clipping planes are a shader
  effect the raycaster ignores, and its raycaster does not skip invisible objects — but it is
  the **specified** behavior, not an accident to be tidied into WYSIWYG later.
- **The cast runs in a worker, over the merged collision `SceneMesh`** — not against the
  Three.js scene graph. A brute-force Möller–Trumbore pass per camera, no backface culling
  (geometry is double-sided, §14.6), nearest positive `t` wins. Measured on the real sites:
  **22 ms per camera** at 1.06 M triangles (`zxfx`) and **63–69 ms** at 3.83 M
  (`danjiang_bridge`) — so a 96-camera bridge layout is ~6 s of worker time, and the
  viewport stays live throughout.
- **Why not the viewport's raycaster.** Casting against the live scene graph was measured
  at **115–187 ms per camera** on the same geometry — *slower*, because each imported GLB is
  one submesh, so bounding-volume culling never fires and every ray scans every triangle
  anyway. On the main thread that is a **10–18 s freeze** at 96 cameras. It also cost the
  whole of this section its testability. The two agree to **1.4 × 10⁻¹⁴ m** on the real
  scenes, with identical hit/miss decisions, so nothing was traded for the move.
  (Two traps that path left behind, worth keeping written down: a shared raycaster pointed
  with `setFromCamera()` inherits the **viewport** camera's `near`/`far` and silently
  truncates export rays; and Three's raycaster ignores clipping planes and invisible
  objects, which is the behavior this section wants but only by accident.)
- **So the whole of this section is pure and unit-tested** (`cameras/centerRay.ts`): the
  forward vector, the intersection, nearest-wins, backfaces, the unbounded ray, and `null`.
  The forward vector is computed from the quaternion directly rather than through Three's
  `applyQuaternion`, so the worker bundle carries no Three.js; a test asserts the two agree.
  The file-shaping half (§15.2) is equally pure and separately tested.
- **The export does not block, and does not report progress.** One worker per export,
  created on the click and terminated on its reply; the mesh is **copied, not transferred**,
  since App and the engine keep using it. There is **no progress bar and no cancel** — the
  only feedback is the menu item disabling itself (§15.1) and the file arriving. A **worker
  failure writes nothing** and surfaces in the Scene panel's error banner (§14.7): a file of
  all-`null` hits would read as a scene with no geometry, which is a different fact. This
  covers the failures that **never reach the worker's error handler** — a worker that cannot
  be created at all, and a mesh that will not structured-clone — since those throw where the
  export was started; every one of them **re-enables the menu item**, so a failed export can
  be retried rather than disabling the feature for the session. One message serves all of
  them, with a fallback for the case the platform quotes no reason
  (`cameras/cameraInfo.ts`).
- The app already builds an SDK BVH over this same mesh for zone generation
  (`sampling_volumes.md` §3.1), and traversing it would make the cast effectively free.
  Deliberately **not** used here: brute force needs no cache-invalidation rule against a
  changing scene, and 6 s off the main thread is nobody's bottleneck. It is the upgrade path
  if this ever has to be interactive.

### 15.4 Out of scope for this feature

- **Reading the file back.** There is no importer and none is planned: `hit` is derived, never
  authored, and the layout already round-trips through §14.
- **Any other payload.** No CSV, no per-camera image, and no extra keys in the info string
  (`far`, `fov`, `enabled`, the hit distance, which surface was hit) — the three keys are the
  external contract (§15.2). Rendering *what a camera sees* is `apps/splat-camera-export`'s
  job, and it reads `scene.json`, not this file.
- **Exporting a subset** — selection-only or enabled-only.
- **Splats as ray targets** (`gaussian_splats.md` §13's "splats as occluders").
- **Context-menu items on the other group headers** — their records stay empty (§15.1).

---

## 16. Out of scope / future

- **Camera aim optimization shipped** — redundancy-weighted re-aiming of the existing
  cameras, [`aim_optimization.md`](./aim_optimization.md); its §13 lists that feature's
  own out-of-scope items (image-quality terms, joint rather than sequential-greedy
  optimization).
- **Camera placement shipped** — constraint-driven random search over mount positions,
  [`camera_placement.md`](./camera_placement.md); its §15 lists that feature's own
  out-of-scope items (aim-aware and redundancy-aware scoring, smarter search than
  independent trials, relocating existing cameras, cost terms, further constraint kinds).
- Mode 2 (coverage-count thresholding), per-camera coverage isolation view.
- Height-band sampling regions as a live control. (Box/oriented-box sampling
  regions grouped into zones **shipped** as sampling zones —
  [`sampling_volumes.md`](./sampling_volumes.md); its §13 lists that feature's own
  out-of-scope items — subtractive volumes, an OBB SDK region, multi-zone
  membership, simultaneous multi-zone overlays, per-zone colors.)
- **3D Gaussian Splat captures shipped** — real-site captures as hierarchy items with a
  visibility checkbox, [`gaussian_splats.md`](./gaussian_splats.md); its §13 lists that
  feature's own out-of-scope items (splats as occluders, depth interaction with
  geometry, viewport picking, in-app import/transcoding, PCSOGS bundles, streaming LOD,
  assisted registration).
- **Camera info export shipped** — the per-camera position / rotation / center-ray-hit
  sidecar on the Cameras group header, §15; its §15.4 lists that feature's own out-of-scope
  items (reading the file back, other payloads, subset exports, splats as ray targets).
- In-app scene *editing* — adding/removing/transforming **geometry** through the UI. The
  scene file (§14) can carry imported geometry (including GLB meshes), but authoring it
  in-app is out of scope. (Splat captures are a separate array and *are* authorable,
  §14.9.)
- Auto-persisting layouts across reloads (localStorage / autosave); explicit
  scene-file import/export is §14.
- Scene-hierarchy: further entity types (lights, meshes), user-created groups beyond
  zones, **reparenting by drag**, reordering the root type groups, and keyboard navigation
  / keyboard reordering. (Drag **reordering within a group** shipped, §5.5.1; **splats**
  shipped as the newest entity type, `gaussian_splats.md` §2.2.)
- Probes: richer per-camera detail (distance / angle), sub-voxel visibility (a true
  per-point ray cast instead of reusing the voxel mask), and sightlines for
  non-selected probes.
- Sections: per-section colormaps, non-axis-aligned (oblique) sections, selecting a
  section by clicking its heatmap plane, draggable slab bound handles (editing thickness
  in the viewport), sub-voxel/continuous sampling instead of the voxel-column
  aggregate, and persisting section layouts.

---

## 17. Terminology

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
  visualization mode (§9.1) it maps to the renderer's per-voxel intensity. The
  `popcount` is taken over **all** `CAM_WORDS` mask words (SDK spec §7.1), so it
  stays correct above 32 enabled cameras.
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
- **Reachable set** — the voxels a camera at a fixed mount point could see at *some*
  orientation: within `far`, unoccluded, ignoring the frustum. Independent of where the
  camera is aimed, which is what makes aim optimization cheap (`aim_optimization.md` §2).
- **Panorama** — the reachable set captured as a weighted angular image around one mount
  point, `6 × R × R` bins over six cube faces (`aim_optimization.md` §3.2).
- **Capture slot** — one of six session-only cameras that measure a mount point: a
  panorama for the aim optimizer, a reachable-set count for the placement tool. They occupy
  mask bits but are never scene entities, and the two features **share** them, so only one
  session can be open at a time (`aim_optimization.md` §3.1, `camera_placement.md` §3.4).
- **Φ (scene potential)** — `Σ_v G(n(v))` over the marked set, where `G` is the running
  sum of the optimizer's redundancy weight. A camera's optimization score is exactly its
  marginal contribution to Φ, which is why sequential-greedy re-aiming converges — for any
  weight depending only on `n`, so the weight can be tuned on measured coverage without
  touching the argument (`aim_optimization.md` §1.1, §1.2).
- **Camera constraint** — a region a camera may be **mounted** in: a point, polyline, or
  plane rectangle **dilated** by a `distance` tolerance. Unlike a sampling volume it is
  **not** a coverage input — it changes no number, and only generates cameras
  (`camera_placement.md` §1.1).
- **Constraint group** — a named container of camera constraints; the unit a placement
  **analysis** runs over, carrying the **camera template** (the `fov`/`aspect`/`near`/`far`
  of the camera model being planned for), the **pool size**, and the **strategy**
  (`maxCount`/`trials`/`epsilon`/`seed`) (`camera_placement.md` §3.1).
- **Placement analysis** — the trial loop over a built pool, run by **Analyze**. It
  measures no coverage: every rate it reports is the aim-free upper bound
  (`camera_placement.md` §4.4, §1.3).
- **Layout** — a set of mount positions, scored as the **union** of their reachable sets
  with every counted voxel worth 1. The unit a placement trial scores; the union is what
  penalizes a clustered layout (`camera_placement.md` §1.2).
- **Pool** — the built mount positions a placement analysis draws its layouts from. A
  position's reachable set is cached because it cannot change between trials, which is what
  makes a search cost one dispatch per position rather than one per trial
  (`camera_placement.md` §2.2, §3.3).
- **Knee** — the fewest cameras whose best layout comes within `epsilon` of the best score
  a search found; a preselection on the score-vs-count curve, not a verdict
  (`camera_placement.md` §4.5).
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
- **3D Gaussian Splat** (3DGS, **capture**) — a photogrammetric reconstruction of a
  real place stored as millions of oriented, coloured 3D Gaussians rather than
  triangles, rendered by projecting each to screen and blending them back-to-front.
  It has **no surface**: nothing to intersect a ray against, which is why it can be
  looked at but never measured (`gaussian_splats.md` §1).
- **Splat** (the entity) — a `SplatObject`: one scene-hierarchy item referencing one
  capture file under `assets/`, with a visibility checkbox and a registration
  transform. Like a camera constraint and unlike a sampling volume, it is **not** a
  coverage input — it changes no number (`gaussian_splats.md` §2.1).
- **Registration** — the position / rotation / **uniform** scale that takes a
  capture's arbitrary reconstructed frame into the scene's metric Y-up frame. The
  same notion `apps/splat-camera-export` calls an **alignment**
  (`gaussian_splats.md` §7).
- **Splat layer** — the second, `WebGLRenderer` canvas behind the main viewport
  canvas that draws the captures, and its eye-menu master toggle (§2.3, §2.4).
- **Center ray** — the axis of a camera's frustum: the ray from the camera's position along
  its forward direction, the stored quaternion applied to `(0, 0, −1)` (§5.1). It says what a
  camera is aimed at, independent of `fov`, `aspect`, `near`, and `far`.
- **Hit point** — where a center ray first meets the merged scene geometry (§14.6), or
  **null** when it meets nothing. Reported per camera by the camera info export (§15); it is
  **not** a coverage quantity — no analysis reads it and no number depends on it.
