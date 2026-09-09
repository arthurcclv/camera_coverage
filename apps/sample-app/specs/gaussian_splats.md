# Sample App — 3D Gaussian Splats (site captures as a viewport backdrop)

The feature spec for placing **3D Gaussian Splat captures** into the scene as
first-class hierarchy entities. Companion to [`spec.md`](./spec.md); this document
owns the full behavior of the feature, and §12 below lists the edits required in
`spec.md` so the two stay consistent (workflow rule: spec-first, no drift).

> **Terms, first use.** A **3D Gaussian Splat** (3DGS, "splat") capture is a
> photogrammetric reconstruction of a real place stored as millions of oriented,
> coloured 3D Gaussians rather than triangles. It is rendered by projecting each
> Gaussian to screen and blending them back-to-front — there is no surface, no
> normal, and nothing to intersect a ray against. That single fact drives most of
> this document: a splat is something the user **looks at**, never something the
> coverage engine **measures**.
>
> **Naming.** The entity is a **splat** (`SplatObject`, ids `splat-N`, scene-file
> key `splats`). One `SplatObject` references one capture **file** under the scene
> folder's `assets/` (`spec.md` §14.2). The hierarchy group is **Splats**.

---

## 1. Problem & goal

The app answers *how much of the workspace volume is covered* against **modelled**
geometry — the parametric room, boxes, and imported GLB (`spec.md` §14.6). For the
real sites this tool is aimed at (the reference workspace is 440 × 201 × 1120 m), the
modelled geometry is a simplification: the GLB has the walls and the gross massing,
but not the gantries, pipe runs, stacked containers, signage, or parked vehicles that
a person siting a camera actually reasons about.

A 3DGS capture of the site has all of it. The sibling app
[`apps/splat-camera-export`](../../splat-camera-export/specs/spec.md) already loads
one and renders what each camera sees; what it cannot do is show the capture
**while you are placing and aiming cameras**, next to the coverage overlay, the
constraint rails, and the section heatmaps.

**Goal.** Let the user drop a capture file into the scene folder's `assets/` and add
it to the scene as a **hierarchy item with a visibility checkbox**, so the real site
can be shown behind the analysis at any time and hidden again in one click.
Concretely:

- A **Splats** group in the scene hierarchy, one row per capture, each with an
  **enabled checkbox** (`spec.md` §5.4's row-checkbox convention).
- A **transform** per splat — position, rotation, **uniform** scale — so an
  arbitrarily-oriented capture can be registered into the room's metric Y-up frame.
- The capture rendered **in every view**, including the **Selected** camera view
  (`spec.md` §2.4.1), where "what this camera sees" becomes literal.
- A **section clip** (`spec.md` §13.9) that cuts the capture as well as the geometry,
  so a cross-section reveals the real interior.

## 1.1 SDK involvement — none

The SDK (`@linkervision/camera-coverage-sdk`) is **not touched**. A splat contributes
**no triangles** to the merged collision `SceneMesh` (`spec.md` §14.6), **no bounds**
to the workspace AABB (`spec.md` §4.2), and **no voxels** to any marked set
(`sampling_volumes.md` §2.2). Nothing about a splat can change a coverage number.

Three consequences are load-bearing and are specified explicitly rather than left to
be discovered:

- **Splats never mark the result stale** (`spec.md` §8.1) — adding, deleting,
  duplicating, moving, renaming, or toggling one never triggers a recompute. This is
  the rule constraints already follow (`camera_placement.md` §1.1).
- **Splats are not a "Place on surface" target** (`spec.md` §2.4.2). A camera dropped
  onto a captured wall would sit against geometry the engine has no triangle for, and
  every subsequent run would report it seeing straight through the surface it is
  mounted on. The pick continues to hit modelled geometry only.
- **Splats do not affect the viewport auto-fit** (`spec.md` §2.4). The fit frames the
  analysis domain; a backdrop that extends past it must not pull the camera back.

---

## 2. Model & state

### 2.1 The `SplatObject` entity

```ts
export interface SplatObject {
  /** `splat-N`. */
  id: string;
  /** User-edited display label; blank falls back to the filename (§2.3). */
  name: string;
  /** Path relative to the scene folder root, e.g. `assets/site.spz` (§3.1). */
  src: string;
  /** Whether the viewport draws it (§5.1). */
  enabled: boolean;
  position: Vec3;
  rotation: Quat;
  /** Uniform, strictly positive. */
  scale: number;
}
```

Held in a **new top-level array** on the `Scene` (`spec.md` §14.1):
`splats: SplatObject[]`, seeded **empty** by `defaultScene()`.

**Why not a fourth `GeometryObject` kind.** Reusing `geometry` would have bought the
existing `assets/` `src` resolution and asset-copy machinery for free, and was
rejected anyway, because it breaks two invariants that are currently absolute and
useful:

- `spec.md` §14.6 — "**every** geometry object contributes to occlusion". Every
  member of `geometry` reduces to world-space triangles that end up in the one
  `SceneMesh`. A splat has none, so `buildStaticGeometry` would need a
  silently-skipping branch and the array's contract would become "most of these
  occlude".
- `spec.md` §14.9 — geometry "is not selectable/editable like
  cameras/probes/sections". A splat row is selectable, editable, addable, and
  deletable by design.

A separate array keeps both statements literally true, and costs only the explicit
plumbing listed in §12.

**Uniform scale, not `Vec3`.** A Gaussian's shape is a covariance, not a mesh; a
non-uniform scale shears every Gaussian in the capture into visible smears. This is
the same conclusion, for the same reason, that
`apps/splat-camera-export/src/align/alignment.ts` already reached ("Uniform scale
only — a non-uniform scale would shear the Gaussians"), so the two apps agree. That
shearing is the **whole** reason: the clip (§5.4) is specified in world space and
never inverse-transforms a capture's registration, so it imposes no requirement of
its own here.

### 2.2 Hierarchy node

A new `SceneNode` variant in `scene/sceneTree.ts`:

```ts
| { kind: 'splat'; id: string; label: string; splatId: string }
```

a **selectable leaf** (no children), under a passive auto-derived **"Splats"**
umbrella (`group:splats`), present when any splat exists — the same shape as the
Cameras / Probes / Sections groups, not the user-created zone/constraint-group shape.
Node ids are namespaced `splat:` via `nodeIdForSplat` / `splatIdForNode`, matching
every other kind. The tree stays **derived**: `buildSceneTree` gains a `splats`
parameter and no new mutable node state exists.

**Root order** becomes **Cameras → Probes → Sections → Zones → Constraints →
Splats**, fixed. Splats sit last because they are the only group that cannot change a
number — the ordering already runs from analysis inputs toward presentation.

### 2.3 Label — the filename, not an ordinal

```ts
splatLabel(s) = s.name.trim() || basename(s.src)
```

Every other entity falls back to an ordinal (`Camera N`, `Probe N`, `Section N`,
`Zone N`). A splat falls back to the **basename of its `src`** — `site.spz`,
`yard-scan.ply` — because a splat's identity *is* its file, and the app already
treats a filename as the authoritative name for exactly this reason: `spec.md` §14.2,
on scene files, "**The filename is the scene's name** … a name inside the file would
drift from the filename the moment either changed."

It also keeps two unnamed rows on two different captures distinguishable, which
`Splat 1` / `Splat 2` would not, and makes a **duplicate** row (§6.4) read as an
obvious duplicate rather than as a second, unrelated capture.

`name` still round-trips and is still **omitted on write when blank** (`spec.md`
§14.3), so an unnamed splat has no `name` key and reads back labelled by its file.

---

## 3. Assets

### 3.1 Path resolution

A splat's `src` follows the **same rule as a `gltf` object's** (`spec.md` §14.2): a
path **relative to the scene folder root**, resolved through the picked directory
handle, so every scene file in a folder resolves captures identically and one large
capture is shared by all of them.

- Validated by the existing **`isSafeAssetPath`** (`scene/sceneFile.ts`) — absolute
  paths, URLs, `..` segments, and anything outside the folder are rejected on import
  (`spec.md` §14.8).
- Conventionally `assets/<file>`; that is the only place §3.2 will offer, and the
  only place a cross-folder Save As… will copy to.

**Accepted extensions** — the single-file `SplatFileType`s Spark can decode from a
byte stream: **`.spz`**, **`.sog`**, **`.ply`**, **`.splat`**, **`.ksplat`**.

A bare **PCSOGS bundle** (a `meta.json` plus sibling `.webp` payloads) is **not
accepted**. Spark's `SplatMeshOptions` has no channel for supplying sibling files, so
loading one would need a second, hand-rolled decode path
(`unpackSplats({ input, extraFiles })`) with its own missing-sibling error surface —
for data that the `.sog` zip already carries in one file. Picking a `meta.json` in
§3.2 reports "*that's a SOG bundle — use its `.sog` zip instead*".

### 3.2 Adding a splat — the **Add 3DGS** dialog

The hierarchy header **"+" menu** (`spec.md` §5.5) gains a **3D Gaussian Splat…**
entry, the only entry that opens a dialog rather than spawning an entity. The
**Add 3DGS** dialog lists the capture files **already present in the scene folder's
`assets/`** and adds a row referencing the chosen one.

- **The user puts the file there.** The app never writes into `assets/`. This is
  deliberate: `spec.md` §14.9 excludes in-app **file management**, Load grants the
  folder handle **`mode: 'read'`** and write permission is only requested lazily on a
  save (`spec.md` §14.5) — and copying a multi-hundred-megabyte capture through the
  browser is
  a slow, failable operation that would need its own progress and quota error
  surface. Dropping the file into `assets/` in Finder is one step, and the file is
  then shared by every scene file in the folder, which is the entire point of
  `assets/`.
- **Listing.** `assets/` at the folder root only, **non-recursive** — the same
  flatness rule §14.2 applies to scene files. Entries are filtered to the accepted
  extensions (§3.1) and sorted **case-insensitively** and stably, exactly as
  `planSceneFileList` sorts scene files, so the list does not reshuffle between
  openings. Each row shows the filename and its **byte size** (from
  `FileSystemFileHandle.getFile().size` — metadata only; **no file is read or
  decoded to build the list**).
- **A file already referenced by this scene is still listed and still selectable** —
  adding it twice is a legitimate way to place two differently-aligned copies of one
  capture, and §3.3 makes it cheap.
- **Opens on the first selectable row**, so the commit button always has a
  subject, and **ArrowUp/ArrowDown walk the selectable rows only**, clamping at
  both ends rather than wrapping — a listed-but-unselectable `meta.json` is there
  to explain its own exclusion, not to be stopped on. **Enter** and a
  **double-click** both commit. This is the Load dialog's list behavior exactly
  (`spec.md` §14.7), and it is the *same code*: the move is
  `sceneFileList.moveListSelection`, since a keyboard shortcut inside a dialog is
  `(rows, selected) → selected` and belongs in a tested pure module, not inline
  in the component (`ai/CONVENTIONS.md`).
- **Commit** adds a `SplatObject` with the next free id, `enabled: true`, an
  **identity transform** (`position [0,0,0]`, `rotation [0,0,0,1]`, `scale 1`), a
  blank `name`, and **auto-selects** it — so the `SplatPanel` (§7) is open on it and
  the gizmo attached, ready to register. Loading (§4.4) starts immediately.
- **No scene folder yet.** At boot there is no save target (`spec.md` §14.1), so
  there is no `assets/` to read. The **3D Gaussian Splat…** entry is then **disabled**
  with the hint *"Load or save a scene first."* — it is the one "+" entry that is not
  always enabled, because it is the one that needs a folder.
- **No `assets/` folder, or nothing in it.** The dialog says so and offers no commit;
  it does not create the folder.

### 3.3 One decode per `src`

Decoded captures are cached **keyed by `src`** and shared: each `SplatMesh` is
constructed with `{ packedSplats }` from the cache, so two rows on one file cost
**one** read, **one** decode, and **one** set of GPU textures while keeping fully
independent transforms and visibility.

This matters because §5.1 keeps an unticked capture resident: without sharing, a
duplicated 400 MB capture would double both its memory and its multi-second decode
for nothing. The cache is **refcounted by referencing rows** and the entry is
disposed when the last row referencing that `src` is deleted (§6.3) or the scene is
replaced (§8).

**A scene replacement is App's signal, not the layer's.** The layer drops the
whole cache by itself when the *asset loader* changes, i.e. when the scene
**folder** changes — a decode keyed by a folder-relative `src` is about different
bytes the moment the folder is different. But two scene files in one folder share
a loader while being entirely different scenes (`spec.md` §14.2), so the import
path calls the layer's release explicitly, alongside the coverage overlay's own
clear (`spec.md` §14.4). Otherwise a capture decoded for the outgoing scene would
be handed to the incoming one purely because both name `assets/site.spz`.

---

## 4. Render layer

### 4.1 Why a second canvas

The app's viewport renders through Three.js's **`WebGPURenderer`** (`spec.md` §2.3),
and is committed to it: `scene/volumetric.ts` builds the coverage fog as a **TSL**
node material (`volumetric_rendering.md` §2), `scene/constraintGizmos.ts` uses
`PointsNodeMaterial` + `instancedBufferAttribute`, and `spec.md` §13.9's clip depends
on `ClippingGroup`, "the WebGPU renderer's clipping path".

**Spark cannot draw into that renderer.** `SparkRendererOptions.renderer` is typed
`THREE.WebGLRenderer` and required, and the splats themselves are drawn with GLSL
`RawShaderMaterial` into `WebGLRenderTarget`s — a material class the WebGPU renderer
does not support on either its WebGPU or its WebGL2 backend. Three.js 0.185 has no
native splat renderer to substitute.

So the splats are drawn by a **`WebGLRenderer` on a second canvas, stacked behind the
WebGPU one**. The alternatives were weighed and rejected: migrating the viewport to
`WebGLRenderer` would mean rewriting the coverage fog, the constraint gizmos, and the
clip path — the visual core of the app — and an offscreen render plus per-frame
`readRenderTargetPixels` readback would put a GPU→CPU→GPU stall in the frame loop.

**The cost, stated plainly: the two canvases share no depth buffer.** Splats are
therefore **always behind** every modelled mesh and every gizmo, and never occlude
them. §5.3 is what makes that usable rather than a defect.

### 4.2 The canvas stack

`createViewport` builds **both** renderers up front, and the WebGL layer owns the
background permanently — one code path whether or not a scene has a splat:

```
.viewport { position: relative }
  canvas.viewport-splats  { position:absolute; inset:0; z-index:0;
                            pointer-events:none }   ← WebGLRenderer
  canvas.viewport-main    { position:absolute; inset:0 }   ← WebGPURenderer
```

The splat canvas takes `z-index: 0` and the main one keeps **`auto`**: DOM order
(the splat canvas is appended first) already puts geometry above the backdrop,
and a `z-index: 1` on the main canvas would tie with the viewport toolbars' own
`z-index: 1` — which must stay above both canvases.

- The **WebGL canvas** clears to **`0x1a1d22`** — the colour `scene.background`
  carries today (`scene/viewport.ts`).
- The **WebGPU canvas** is created with **`alpha: true`** and its scene's
  **`background` set to `null`**, so it clears transparent and composites over the
  layer beneath. The orientation gizmo's `autoClear = false` overlay (`spec.md` §2.4)
  is unaffected.
- The splat canvas is **`pointer-events: none`**: `OrbitControls`,
  `TransformControls`, and every pick keep receiving events on the main canvas alone.
  This is also why splats are not viewport-pickable (§6.5).
- **One `ResizeObserver`, one `setSize` pair.** The existing observer sizes both
  renderers, so they cannot drift.
- **One animation loop.** In `renderer.setAnimationLoop`, the splat layer renders
  **first**, then the WebGPU scene, then the orientation gizmo.
- `dispose()` tears down both renderers, the splat scene, every `SplatMesh`, and the
  decode cache (§3.3).

**No Spark until a splat exists.** The WebGL layer needs only `three`'s
`WebGLRenderer`, already in the bundle, to clear the background. Spark's ESM build is
~5 MB (inlined sort workers and base64 wasm), so it is pulled in with
**`await import('@sparkjsdev/spark')` on the first splat load** and Vite emits it as
its own chunk — a scene with no splat pays nothing. The `SparkRenderer` is
constructed once, on that first load, and added to the splat scene.

### 4.3 Both renderers share the same camera objects

The splat layer renders **the very same camera object** the WebGPU renderer is using
for the active view — no mirroring, no matrix copying, and therefore no possibility
of the backdrop lagging the geometry by a frame during an orbit.

This is safe because `three` (`build/three.module.js`) and `three/webgpu`
(`build/three.webgpu.js`) both import their core classes from the **same**
`build/three.core.js`. There is exactly one `PerspectiveCamera` class and one
`OrthographicCamera` class in the bundle, so Spark's internal
`camera instanceof THREE.OrthographicCamera` branch resolves correctly on the
viewport's cameras and the three **orthographic elevations render correctly**, as does
the perspective **Selected** view (`spec.md` §2.4.1) with its generous near/far pair.

The splat layer holds its **own `THREE.Scene`** containing the `SparkRenderer` and the
`SplatMesh`es and nothing else — no lights (splats carry their own colour), no grid,
no gizmos. A shared scene was rejected: the WebGPU renderer would attempt to compile
Spark's `RawShaderMaterial`, and Three.js layer masks live on the **camera**, which
the two renderers deliberately share.

### 4.4 Load path

For each `SplatObject`, in order:

1. Resolve `src` through the scene folder handle; **`isSafeAssetPath`** first, then
   `getFileHandle` → `getFile()`.
2. If `src` is already in the decode cache (§3.3), take it and go to step 5.
3. `await import('@sparkjsdev/spark')` (first splat only, §4.2).
4. Decode the file's **stream**, not a buffer, into the cache entry's
   `PackedSplats`:
   `new PackedSplats({ stream: file.stream(), streamLength: file.size, fileName, lod: true, onProgress })`.
   - **The decode, not the mesh** — the cached unit is the `PackedSplats`, because
     that is what §3.3 shares between rows; each row's `SplatMesh` is then
     constructed over it in step 5.
   - **`stream`, not `fileBytes`** — a raw `.ply` of a 1120 m site can run past a
     gigabyte, and buffering it into one `ArrayBuffer` to hand over is an avoidable
     out-of-memory failure. Spark accepts a `ReadableStream` with its length directly.
   - **`lod: true`** enables Spark's in-memory, view-dependent level of detail.
     Spark's *streaming* LOD (`PagedSplats`) is **not** available here: it fetches
     chunks by `rootUrl` over HTTP, and a capture behind a File System Access handle
     has no URL to fetch. It also parks the payload under `lodSplats` and leaves
     `numSplats` at 0, which is why the row's count comes from a helper and not
     straight off the decode (§6.2).
5. Build the row's mesh over that shared decode —
   `new SplatMesh({ packedSplats, editable: true, raycastable: false })` — parent it
   to the row's anchor carrying the transform (§2.1) and `enabled` (§5.1), and mark
   the row **loaded** with its splat count.
   - **`editable: true`** is what allows the `SplatEdit` the clip needs (§5.4).
   - **`raycastable: false`** because a splat is never viewport-pickable (§6.5), so
     its raycast index would be built for nothing.
   - No per-mesh `lod` option: with `packedSplats` supplied, Spark reads the
     level-of-detail data off the shared decode.

Load is **asynchronous and non-blocking**: the row exists and is selectable
immediately, the rest of the app is unaffected, and progress is reported on the row
(§6.2). Loads of several splats proceed concurrently; a scene replacement (§8) or a
row deletion cancels and discards an in-flight load rather than adding a mesh to a
scene that is gone.

**Decoded is not the same as drawn.** `SplatMesh.initialized` resolves **before**
anything renders: Spark's accumulate/sort runs in a worker, and the mesh emits no
geometry for its first several frames (measured: the first real draw call landed on
**frame 7–8** for a 20 k-splat mesh — a fifth of a second at 60 Hz, and the delay is
sort work, not file size). Two consequences the implementation must respect:

- **The row's `loaded` badge (§6.2) is driven by `initialized`, and the capture
  appears slightly after it.** That is accepted rather than papered over: the
  alternative is a "decoding…" sub-state that exists only to describe a fifth of a
  second. What must *not* happen is code that treats `initialized` as "the capture is
  on screen" — a first-frame screenshot, an auto-fit, or a test asserting pixels
  right after the await would all read an empty layer.
- **`SparkRendererOptions.onDirty`** is the callback Spark provides for "I have new
  sort/LOD results, re-render" — the correct signal for a repaint, and the hook to
  use if the viewport ever moves off a continuous animation loop.

A related trap for anything that inspects the layer: the `SparkRenderer` object
itself draws **one triangle every frame** regardless of content, so a non-zero
draw-call or triangle count is **not** evidence that a capture is visible.

### 4.5 What the split means for the coverage overlay

The coverage fog stays where it is, in the WebGPU scene, and **nothing about it
changes for the existing app**. Measured on the real `volumetric.ts` material: the
composited result with a transparent WebGPU canvas over a WebGL layer clearing to
`0x1a1d22` differs from today's opaque-background result by **0.07/255 in `max` mode
and 0.12/255 in `additive`**. Invisible, in both composite modes. Geometry and fog
still share one framebuffer, so `volumetric_rendering.md` §4's "the scene color acts
as a per-channel floor" holds exactly as before for everything the engine measures.

**Against a capture it is different, and deliberately left that way.** A splat is on
the layer *beneath*, so the fog no longer max-blends against it in a shared
framebuffer — the fog composites over it. Where coverage fog and capture overlap, the
**fog covers the capture** rather than tinting it, more strongly at higher intensity.

That is documented rather than mechanised, because the controls it calls for already
exist and are already in the user's hands:

- the eye menu's **Coverage** row (`spec.md` §2.4) turns the overlay off outright —
  the natural pairing is Coverage on to judge coverage, Coverage off to read the site;
- **Overlay intensity scale** (`spec.md` §9.2, `OverlayControls`) dials the fog down
  against a bright backdrop, which is exactly the knob it already is.

Auto-coupling the overlay's appearance to whether a splat is visible is rejected on
the same ground as auto-ghosting the geometry (§5.3): it makes one layer's look depend
on another layer's state, which is surprising, and it overrides a setting the user set
deliberately.

### 4.6 Capture size

Splat count, not file size, is what costs frames. Measured in this app's stacked
configuration on an M-series Mac in Chrome (WebGPU backend), orbiting a synthetic
capture spread through the full 440 × 201 × 1120 m reference site with `lod: true`:

| splats | ms/frame | fps |
|---|---|---|
| 500 k | 10.0 | 100 |
| 2 M | 16.0 | 62 (at vsync) |
| 6 M | 45.6 | 22 |

Treat these as indicative, not a benchmark — the measurement's two biases pull in
opposite directions. The synthetic splats fill the whole *volume* at a 1.2 m radius,
far more overdraw than a real capture whose Gaussians hug surfaces (pessimistic); the
canvas was 640 × 400 at pixel ratio 1, against a real full-window viewport at DPR 2
(optimistic).

The practical reading: **a couple of million splats orbits comfortably; six million
does not.** Nothing in the app caps or downsamples a capture — the app has no say in
how the file was exported — so this is guidance for whoever produces the capture, and
the reason the row reports its splat count (§6.2) rather than only its file size. If a
capture turns out too heavy, the remedies are all upstream: export fewer splats, or
crop the capture to the area being planned.

---

## 5. Visibility

### 5.1 The per-splat checkbox

Each splat row carries an **enabled checkbox**, the same unified `onToggleEnabled`
row control cameras, sections, zones, constraint groups, and constraints use
(`spec.md` §5.5). `enabled` round-trips in the scene file.

**Unticking sets `mesh.visible = false` and does nothing else.** The capture stays
decoded and resident, so re-ticking is **instant** — which is the whole point of a
checkbox, and what makes flipping between the modelled room and the real site a
usable comparison. Memory is freed on **delete** (§6.3) or on scene replacement (§8),
not on untick.

The consequence is explicit and is the user's to manage: **several large captures in
one scene cost their memory whether or not they are ticked.** §3.3's per-`src`
sharing means duplicating a row does not add to that cost; adding a second, different
capture does. Unloading on untick was rejected because it would make re-ticking a
multi-second load with a progress bar, which a checkbox must not be.

**A disabled splat stays hidden even when selected** — the one deliberate divergence
from `spec.md` §2.4.3, which un-hides a disabled entity while it is selected. That
exception exists so a gizmo's own wireframe is visible while you edit it; a splat is
not a gizmo, and re-drawing a capture the user has explicitly hidden because they
clicked its row would read as the checkbox not working. The **`TransformControls`
gizmo still attaches** to a hidden splat, so it can be moved while invisible, and
§2.4.3's rule is otherwise unchanged for every other kind.

### 5.2 The **Splats** layer row

The viewport's top-right **eye menu** (`spec.md` §2.4) gains a **Splats** row: a
master show/hide-all for the splat layer, defaulting to visible, exactly parallel to
**Cameras** relating to per-camera state. Off hides the whole splat layer; on shows
each splat per its own checkbox. Purely visual, never persisted to the scene file,
and — like every layer toggle — it cannot change a number.

Implemented as the splat **scene's** visibility, so the layer costs nothing to hide.

### 5.3 The **Geometry** layer row

The eye menu also gains a **Geometry** row, defaulting to visible. Off hides the
**render** group built by `sceneGeometryBuild.ts` — floor, walls, boxes, and glTF
meshes.

This row is what makes splats useful at all. The default room is floor plus four
**opaque, double-sided** walls (`spec.md` §14.6), and with splats drawn behind them
(§4.1) a capture would be entirely hidden; even against an imported site GLB it would
only show around the edges. Being able to hide the model and see the capture in the
same frame, with the same cameras and the same coverage overlay, is the feature.

**It hides drawing and nothing else.** The merged collision `SceneMesh`, the
workspace AABB, and every coverage result are untouched — this is a viewport layer
toggle, so it never marks the result stale and never triggers a recompute. Ghosting
the geometry's materials automatically whenever a splat is enabled was rejected: it
couples two unrelated appearances, and translucent double-sided walls stack into mush
at site scale.

### 5.4 Section clip cuts the splat too

When a section is clipping (`scene.clipSectionId != null`, `spec.md` §13.9), the
clip's world band applies to **the splats as well as the geometry**, so a
cross-section reveals the captured interior instead of leaving the full capture
standing behind the cut model.

The geometry path (two world clipping planes on a `ClippingGroup`) does not exist on
the other canvas, so the band is expressed as a **Spark SDF erase**.

**One edit for the whole layer, in world space.** Spark applies an edit *after* the
mesh's object→world transform (`transform.applyGsplat` precedes
`rgbaDisplaceEdits.modify` in the generator), so edits evaluate on **world-space**
splat centres; and a `SplatEdit` that is **not** parented under any `SplatMesh` is
collected as a **global edit** and applied to every editable mesh in the scene.
Together those mean the clip is a **single** `SplatEdit` added to the splat scene
(not one per capture), carrying the band as a plain world-space box:

- One `SplatEdit` on the splat scene, `{ rgbaBlendMode: MULTIPLY, sdfSmooth: 0,
  softEdge: 0, invert: true }`, holding one
  `SplatEditSdf { type: BOX, opacity: 0, radius: 0 }`.
- `invert: true` applies the edit **outside** the box, where `opacity: 0` multiplies
  those Gaussians' alpha to zero. Inside the band, every capture is untouched.
- The edit is added when a clip becomes active and removed when it clears; with no
  clip there is no edit and no per-frame work.
- **A clip already active when a capture finishes loading applies to it.** The
  `SplatEdit`/`SplatEditSdf` classes arrive with Spark itself, which is not
  imported until the first load (§4.2) — so a scene *opened* with
  `clipSectionId` already set cannot build the edit on its first pass, and load
  completion is not a scene edit that would bring another one. The layer
  therefore holds the current band and re-applies it when a decode lands, rather
  than leaving the capture unclipped until the next unrelated edit.
- **`SplatEditSdf.scale` is the box's half-extents** and `radius` is its corner
  rounding — Spark's BOX case is the standard rounded-box SDF
  (`abs(p) - sizes.xyz + sizes.w`), with `sizes.xyz` taken from `scale` and `sizes.w`
  from `radius`. `radius: 0` gives the sharp band the geometry clip has. The SDF's
  own `position`/`quaternion` place it; its `scale` is a size parameter, not part of
  that transform.

**The mapping is a pure function**, and a short one. `sectionClipBand`
(`scene/sectionHeatmap.ts`) already yields a **world-space**
`ClipBand { axis, min, max }` — an axis-aligned slab — and the SDF is specified in
world space, so no per-capture inverse transform is involved:

```ts
clipBandToSdfBox(band, worldMin, worldMax):
  { position: Vec3; halfExtents: Vec3 }   // rotation is always identity
```

Half-extents are the band's half-thickness along `band.axis` and the
**workspace-AABB** extent along the other two axes, so the cut is unbounded in-plane,
matching the geometry clip's infinite planes. `clipBandToSdfBox` is the tested unit
(§11).

A capture's own registration needs no part in this, which also means the clip does
**not** depend on that registration's scale being uniform. Uniform scale is still
required (§2.1), but for its original and only reason: a non-uniform scale shears the
Gaussians.

---

## 6. Hierarchy integration (`spec.md` §5.5)

### 6.1 Selection

The app's unified selection gains a `'splat'` case:
`{ kind: 'camera' | 'probe' | 'section' | 'zone' | 'volume' | 'constraintGroup' |
'constraint' | 'splat'; id }`. Selecting a splat deselects everything else, drives the
`SplatPanel` (§7), and attaches the single `TransformControls` gizmo — unchanged
invariant: only one gizmo is ever attached.

### 6.2 Row content

Label per §2.3, plus the enabled checkbox (§5.1) and one badge reflecting **load
state** (§4.4):

| State | Badge |
|---|---|
| loading | `41%` (from Spark's `onProgress`; `loading…` when length is unknown) |
| loaded | `4.2M splats` |
| missing | `⚠ missing from assets/` (§9) |
| failed | `⚠ could not be decoded` (§9) |
| failed, and the `src` is a PCSOGS `meta.json` | `⚠ SOG bundle — use its .sog zip` (§3.1, §9) |

Load state is **derived side state**, not part of `SplatObject` and never serialized —
a `Map<splatId, SplatLoadState>` held beside the scene, like the retained per-run
probe/section data (`spec.md` §12.3, §13.4). The badge is the only place a splat's
loading is surfaced; nothing blocks on it.

`loaded` means **decoded**, and the capture draws a few frames later (§4.4). The badge
is not a claim about what is on screen, and there is deliberately no fifth state
between the two.

### 6.3 Delete

Right-click → **Delete** (`spec.md` §5.5's context menu; `DeletableKind` gains
`'splat'`, which is what makes `entityMenu.ts`'s `Record<DeletableKind, …>` fail to
compile until the handler is wired — the whole point of that type). Removes the row,
clears the selection if it was selected, disposes the mesh, releases the decode cache
entry **if it was the last row on that `src`** (§3.3), and cancels an in-flight load.
**Never marks the result stale** (§1.1).

### 6.4 Duplicate

Right-click → **Duplicate** creates a deep copy with the next free id and
auto-selects it, carrying **every property verbatim** — `src`, `name` (blank stays
blank, so the copy is labelled by the same filename, §2.3), `enabled`, and the full
transform, so the copy initially coincides with the original and is then moved by its
gizmo. The copy **shares the original's decode** (§3.3), so duplicating to compare two
alignments of one capture costs a row, not a gigabyte. **Never marks the result
stale.**

### 6.5 Not viewport-pickable

A splat is selected **from the hierarchy only** — like a zone or a constraint group,
which also have no pickable body (`spec.md` §5.5). A viewport click can never hit a
splat: the splat canvas is `pointer-events: none` (§4.2) and the splat is not in the
picked scene (§4.3).

Spark can raycast an `SplatMesh` (`raycastable`), and this was considered and
rejected: it needs a second raycast against a different scene graph, and a
hit-priority rule between the two — which cannot be resolved by depth, because the
two canvases share no depth buffer (§4.1). Selecting from the row is unambiguous. See
also §1.1 on "Place on surface".

### 6.6 Reordering

Splat rows are **draggable to reorder within the Splats group** (`spec.md` §5.5.1),
like every other draggable kind; reparenting is not offered (there is nothing to
reparent into). Array order is display order (§8). Draw order is **not** affected:
Spark sorts all Gaussians globally by view depth across every `SplatMesh`, so row
order is presentation only.

---

## 7. `SplatPanel` — the selected-splat editor

The left detail panel for a selected splat (`ui/SplatPanel.tsx`), alongside
`CameraPanel` / `ProbePanel` / `SectionPanel` / `VolumePanel` / `ZonePanel` /
`ConstraintGroupPanel` / `ConstraintPanel`:

- **Name** — the editable display name (blank ⇒ the filename label, §2.3).
- **Source** — `src`, read-only, with the load state and splat count (§6.2). Not
  editable: a splat's file is settled when it is added, and re-pointing a row at a
  different capture is `Delete` + `Add` (which is also what keeps the decode cache's
  refcount honest).
- **Position** — X / Y / Z, via the existing `Vec3Field` / `NumberInput`, in meters.
- **Rotation** — X / Y / Z **Euler degrees**, converted to and from the stored
  quaternion by the app's own shared pair, `cameras/math.ts`'s
  `eulerToQuat`/`quatToEuler` (as
  `apps/splat-camera-export/src/align/alignment.ts` delegates to PlayCanvas's, and
  for the same stated reason: a hand-rolled pair is easy to get subtly wrong).
  Columns are axis-correct — X is pitch, Y yaw, Z roll.
  **X is bounded to ±90°**, which is that convention's own range rather than a
  restriction: `YXZ` puts X in the middle, so its decomposition is an `asin` and
  every rotation in SO(3) is reachable with |X| ≤ 90 — a typed 120° would read
  back as something else. ±90 is also exactly the registration a Z-up capture
  needs to stand up in a Y-up scene, so the bound is 90 and **not** the camera
  panel's 89. Y and Z are unbounded.
- **Scale** — one **uniform**, strictly positive number (§2.1). The field's floor
  is **1e-3**: `0` collapses the capture to nothing and a negative scale mirrors
  it, so the input refuses both, and the file reader refuses them too (§8).
- **Flip 180° Z** — the standard correction for a 3DGS capture, whose reconstructed
  frame is commonly Z-down relative to the metric Y-up scene; ported from
  `alignment.ts`'s preset of the same name so the two apps agree. It **replaces**
  the rotation rather than composing with it, so pressing it twice is idempotent
  instead of drifting back to identity — and because it is a replacement, the
  button also reads as **pressed** (`aria-pressed`) while the registration *is*
  that rotation, which is the only way a replacing preset can say whether it is
  currently in effect.
- **Reset transform** — back to identity (`[0,0,0]`, `[0,0,0,1]`, `1`).

**Gizmo modes.** A selected splat supports the viewport's **Translate** and **Rotate**
transform modes (`spec.md` §2.4). **Scale is panel-only**: `TransformControls`'s scale
mode is per-axis, and dragging one axis handle would write a non-uniform scale — the
one thing §2.1 forbids. (`spec.md` §2.4's Scale mode remains volume-only.)

---

## 8. Scene file (import / export, `spec.md` §14)

- **`Scene` model (§14.1).** Add `splats: SplatObject[]`; `defaultScene()` seeds it
  **empty**.
- **`scene.json` (§14.3).** Add a top-level **`"splats"`** array. Each serialized
  splat carries `{ id, src, enabled, position, rotation, scale }` plus **`name` when
  non-blank**. **`enabled`** is optional on read (default `true`) and — since splats
  are enabled by default — **omitted on write when `true`**, exactly as the camera
  flag is. `rotation` is a quaternion `[x,y,z,w]`, `position` is meters, Y-up;
  `scale` is a single number.
- **`formatVersion` stays `3`.** `splats` reads as `[]` when absent, so every
  existing file loads unchanged — the same additive, back-compatible precedent §14.3
  already sets for `name`, `clipRange`, the camera `enabled` flag, and the section
  footprint bounds, none of which bumped the version. A bump to `4` was rejected
  because a version **> 3 is rejected outright**: a scene carrying a backdrop would
  become unopenable by an older build, which is a steep price for a visual addition
  that an older reader can safely ignore.
- **Array order is significant** — `splats` is hierarchy display order, preserved
  verbatim on read and write, like every other entity array (§14.3). Reordering is
  not a format change.
- **Asset copying (§14.5).** `planAssetCopy` gains the splat srcs:
  `planAssetCopy(geometry, splats)` collects every `gltf` `src` **and** every splat
  `src`, deduplicated. A cross-folder **Save As…** therefore copies captures the same
  way it copies GLBs, so the destination folder holds a complete scene, and the
  pre-commit count and the replace warning include them. An **in-place Save** writes
  only the scene file, as before.
- **Import (§14.4).** Import **replaces** `splats` from the file (may be empty).
  Validation is part of the same all-or-nothing pass: ids unique within the category,
  `src` safe per `isSafeAssetPath`, `scale` finite and `> 0`, `rotation` a 4-tuple,
  `enabled` a boolean when present, a missing/blank `name` read as the filename label
  (never an error). **A missing or undecodable capture file does not abort the
  import** — see §9.
- **Not persisted.** The **Splats** and **Geometry** layer toggles (§5.2, §5.3) are
  transient viewport state, like every other layer toggle (`spec.md` §2.4), and load state
  (§6.2) is derived. Neither is written.
- **Dirty check.** `splats` is part of `serializeScene` output, so adding, editing,
  reordering, or toggling a splat marks the scene unsaved through the existing
  baseline comparison (§14.4) with no extra plumbing.

Example addition to the §14.3 sketch:

```json
{
  "formatVersion": 3,
  "splats": [
    { "id": "splat-1", "src": "assets/site.spz",
      "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": 1 },
    { "id": "splat-2", "name": "North dock", "src": "assets/dock.sog",
      "enabled": false,
      "position": [12, 0, -40], "rotation": [0, 0.707, 0, 0.707], "scale": 0.98 }
  ]
}
```

---

## 9. Error handling (`spec.md` §14.8)

A splat's file failing is **non-fatal**, unlike a `gltf` reference. The scene is a
96-camera layout with its geometry, cameras, constraints, and coverage results; the
splat is a backdrop that cannot change any of them (§1.1). Refusing to open the
layout because a decorative capture is absent would be the wrong trade. Instead the
row **reports its own state** — the same choice the Load dialog makes for an invalid
`*.json`, which is "listed greyed and unselectable, **with its reason**, so a stray
`package.json` is visibly excluded rather than mysteriously absent" (§14.4) — and
never silently drops the entry, which would lose the reference on the next Save.

Additions to the §14.8 table:

| Case | Handling |
|---|---|
| Unsafe splat `src` (absolute / URL / `..` / outside folder) | abort the import, keep current scene, show error (as for `gltf`) |
| Duplicate splat id, non-positive or non-finite `scale`, malformed `rotation`, non-boolean `enabled` | abort the import, keep current scene, show error |
| Referenced capture **missing** from `assets/` | **import succeeds**; the row badges `⚠ missing from assets/`; nothing is drawn; coverage unaffected |
| Referenced capture unreadable or **fails to decode** | **import succeeds**; the row badges `⚠ could not be decoded`; nothing is drawn; coverage unaffected |
| A `meta.json` picked in the Add dialog | not offered — listed with its reason and unselectable (§3.1) |
| A `meta.json` referenced by a hand-edited scene file | **import succeeds**; the row badges `⚠ SOG bundle — use its .sog zip` rather than the bare undecodable badge, since the remedy is a different file and not a repair |
| No `assets/` folder, or it holds no accepted file | the Add dialog says so and offers no commit |
| No scene folder yet (boot) | the "+" menu's **3D Gaussian Splat…** entry is disabled with *"Load or save a scene first."* |
| `WebGLRenderer` unavailable (no WebGL2 context) | the splat layer is inert; the viewport renders as today on the WebGPU canvas with its own opaque background restored; splat rows badge `⚠ no WebGL context` |
| Spark's dynamic import fails | the affected rows badge `⚠ could not be decoded`; the rest of the app is unaffected |
| Referenced capture missing on a **cross-folder Save As…** | abort before writing the scene file, keep target, show error naming the asset (unchanged §14.5 rule — a copy cannot invent bytes) |

The last row is a deliberate asymmetry: a missing capture is survivable when
**reading** a scene and not when **copying** one into a folder that is supposed to end
up self-contained.

---

## 10. Terminology (`spec.md` §16)

- **3D Gaussian Splat (3DGS, "splat capture")** — a photogrammetric reconstruction
  stored as oriented, coloured 3D Gaussians rather than triangles. Rendered by
  projection and back-to-front blending; has no surface to intersect.
- **Splat** (the entity) — a `SplatObject`: one hierarchy item referencing one
  capture file under `assets/`, with a visibility flag and a registration transform.
  **Visual only** — never an analysis input.
- **Registration** — the position / rotation / uniform scale that takes a capture's
  arbitrary reconstructed frame into the scene's metric Y-up frame. The same notion
  `apps/splat-camera-export` calls an **alignment**.
- **Splat layer** — the second, WebGL canvas behind the main viewport canvas, and its
  eye-menu master toggle.

---

## 11. Tests

Per repo policy (every change gets a test). **Spark cannot run under
`node --test`** — it needs a WebGL2 context, workers, and wasm — so the boundary is
drawn where the codebase already draws it: `sceneFileList.ts` vs `sceneIO.ts`,
`alignment.ts` vs the viewport. Every **judgement** lives in a pure module and is
tested; the impure `scene/splatLayer.ts` stays thin and is verified by running the
app.

Tested under `node --test`:

- **`planSplatAssetList`** — filters to the accepted extensions (§3.1); rejects
  `meta.json` with its reason; case-insensitive stable order; already-referenced
  files still listed; empty and no-`assets/` cases.
- **`splatLabel`** — `name` wins when non-blank; falls back to `basename(src)`, not
  an ordinal; whitespace-only name is blank; nested and bare `src` both basename
  correctly.
- **`isSafeAssetPath`** on splat srcs — absolute, URL, `..`, and outside-folder
  rejected; `assets/site.spz` accepted (extends the existing suite).
- **`parseSceneFile` / `serializeScene` round-trip** — `splats` absent ⇒ `[]`;
  `enabled` absent ⇒ `true` and omitted on write when `true`; `name` omitted on write
  when blank; array order preserved; `formatVersion` still `3`; each §9 abort case
  rejected with its message.
- **`sceneReducer`** — add / delete / duplicate / toggle-enabled / set-transform /
  reorder; delete clears a matching selection; duplicate copies verbatim with a fresh
  id; **no splat action sets the stale flag** (§1.1).
- **`planAssetCopy`** — includes splat srcs alongside `gltf` srcs, deduplicated
  across the two (a capture referenced twice copies once).
- **`clipBandToSdfBox`** — centre sits at the band's midpoint along `band.axis`;
  half-extent along that axis is half the band's thickness; the other two
  half-extents span the workspace AABB; each of the three `axis` values; a band
  clamped to the full extent yields a box enclosing the whole workspace (nothing
  erased). No transform cases: the box is world-space and no capture's registration
  enters it (§5.4).
- **Euler ⇄ quaternion** round-trip and the **Flip 180° Z** preset, against
  `cameras/math.ts` (mirrors the reasoning in `alignment.ts`) — including
  **pitch ±90**, the Z-up→Y-up registration the panel's X bound exists for (§7).
- **`identityRegistration`** — the values, and that each call returns **fresh**
  tuples, so one added splat's drag cannot move another's.
- **`splatDecodeFailure`** — a `meta.json` at any depth and in any case reports
  `sogBundle`; everything else, including a `meta.json.spz`, reports
  `undecodable` (§9).
- **`nodeEnabled`** (`scene/sceneTree.ts`) — every node kind routes to its own
  `enabled` lookup and a group header is never dimmed, which is what replaced the
  hierarchy row's nested ternary chain ending in a bare `true`.

Not covered by tests, and deliberately kept thin: `splatLayer.ts` — canvas creation,
`SparkRenderer` construction, the stream load, `mesh.visible`, the `SplatEdit`
lifecycle, and disposal.

**What the spike verified instead**, for the parts no unit test can reach — recorded
here so a later change knows what was actually measured rather than assumed
(Chrome 152, WebGPU backend, Spark 2.1.0, three 0.185.1):

- `three` and `three/webgpu` share one `three.core.js`, so their camera classes are
  identical objects and a `three/webgpu` camera satisfies Spark's
  `instanceof THREE.OrthographicCamera` — the basis for sharing camera objects (§4.3).
- Splats render through the transparent WebGPU canvas alongside WebGPU geometry in the
  same frame (§4.2).
- Spark's **orthographic** projection is correct: a 10 m slab in a known top-down
  ortho frustum measured 195 × 210 px against 200 × 200 px predicted, the overshoot
  being the splats' own radius (§4.3).
- The transparent canvas does not change the coverage fog (§4.5).
- Frame cost by splat count (§4.6).

---

## 12. Edits required in `spec.md` (consistency)

| `spec.md` section | Edit |
|---|---|
| §2.2 Layout / file map | Add `scene/splats.ts`, `scene/splatAssets.ts`, `scene/splatLayer.ts`, `ui/SplatPanel.tsx`, `ui/AddSplatDialog.tsx`; note the Splats umbrella and `SplatPanel` in the left-panel detail list. |
| §2.3 Render backend | Note the **second `WebGLRenderer` canvas** behind the WebGPU one, that it owns the `0x1a1d22` background, and that the WebGPU canvas is `alpha: true` with `scene.background = null` (§4.1, §4.2). |
| §2.4 Viewport toolbar | Add the **Splats** and **Geometry** rows to the eye-menu list, both defaulting to visible (§5.2, §5.3); note that Translate/Rotate apply to a selected splat and **Scale stays volume-only** (§7). |
| §2.4.1 Selected view | Note that splats render in this view too (§4.3). |
| §2.4.2 Place on surface | State that splats are **not** a placement target, with the reason (§1.1). |
| §2.4.3 Disabled entities | State the splat divergence: a disabled splat stays hidden **even when selected**, though its gizmo still attaches (§5.1). |
| §4.2 Workspace | State that splats contribute **no bounds** to the workspace AABB (§1.1). |
| §5.5 Hierarchy | Add the `{ kind: 'splat' }` node and the **Splats** umbrella; root order → Cameras → Probes → Sections → Zones → Constraints → **Splats**; `buildSceneTree`'s new `splats` parameter; the `'splat'` selection case; the row checkbox and load badge; the filename label fallback as the documented exception to the ordinal rule; "+" → **3D Gaussian Splat…** as the one dialog-opening and conditionally-disabled entry; Duplicate/Delete rules; **no splat action marks the result stale**. |
| §5.5.1 Reordering | Add **splat** to the draggable kinds. |
| §8.1 Staleness | State that splats are never analysis inputs, so no splat action marks the result stale (mirrors `camera_placement.md` §1.1). |
| §9.2 Overlay intensity | Note that the intensity scale is also the dial for fog read over a splat capture, which the fog covers rather than tints (§4.5). |
| §13.9 Clip | Extend the scope sentence: the clip now also cuts **splats**, by **one** world-space SDF erase on the splat layer rather than `ClippingGroup` planes (§5.4). Still no recompute. |
| §14.1 `Scene` model | Add `splats: SplatObject[]`; `defaultScene()` seeds it empty. |
| §14.2 Folder layout | Note that `assets/` also holds **capture files** (`.spz`/`.sog`/`.ply`/`.splat`/`.ksplat`) and that a splat `src` resolves by the same relative-path rule as a `gltf` `src`. |
| §14.3 File format | Add the top-level `"splats"` array and its per-splat shape; `enabled` optional on read / omitted on write when `true`; `name` omitted when blank; **`formatVersion` stays `3`** with the additive-precedent reasoning; `splats` order is display order. |
| §14.4 Import | Import replaces `splats`; validation joins the all-or-nothing pass; **capture loading is not part of it** — a missing/undecodable capture does not abort (contrast step 5's GLB rule). |
| §14.5 Export / Save As… | `planAssetCopy(geometry, splats)` — captures copy on a cross-folder Save As… and count toward the pre-commit total and the replace warning; a missing capture aborts that save. |
| §14.7 UI controls | Add the **Add 3DGS** dialog (§3.2). |
| §14.8 Error handling | Add the §9 rows. |
| §14.9 Out of scope | Clarify that the non-authorable, non-selectable rule covers **`geometry`** objects; splats are a separate array and are authorable (§2.1). |
| §16 Terminology | Add **3D Gaussian Splat**, **splat**, **registration**, **splat layer** (§10). |

Also required outside `spec.md` (per the repo's `ai/` docs rule):

| Doc | Edit |
|---|---|
| `ai/STACK.md` | Add `@sparkjsdev/spark@2.1.0` (peer `three >=0.180.0`), that it is **dynamically imported** and why (~5 MB), and that it is WebGL-only. |
| `ai/ARCHITECTURE.md` | The two-canvas viewport, the shared-camera rationale (one `three.core.js`), the splat scene, the decode cache, and the pure/impure split of the new modules. |
| `ai/DECISIONS.md` | New entries (newest at top): two stacked canvases over a WebGL migration; `splats[]` over a `GeometryObject` kind; pick-from-`assets/` over an in-app copy; hide-not-unload; uniform scale; **one world-space SDF clip for the whole layer**; `formatVersion` unchanged; dynamic import; hierarchy-only picking; filename label fallback; **fog-over-capture left to the existing Coverage and intensity controls**. Each entry records what the spike measured, since several of these rest on measurements rather than on reading docs. |
| `ai/CONVENTIONS.md` | The pure-decision / impure-layer split as applied here (`splats.ts`/`splatAssets.ts` vs `splatLayer.ts`). |
| `ai/VISUAL_DESIGN.md` | The Splats group row, the splat row badge states, the two new eye-menu rows and their glyphs, and the `SplatPanel` layout. |

---

## 13. Out of scope / future

- **Splats as occluders.** Deriving collision geometry from a capture (meshing it, or
  voxel-carving it) so coverage is computed against the real site. This is the
  obvious next question and a much larger one: it changes what a coverage number
  *means*, and it needs its own accuracy story.
- **Depth interaction between splats and geometry.** Splats are always behind
  (§4.1). Correct mutual occlusion needs a shared depth buffer, i.e. one renderer.
- **Viewport picking and "Place on surface" on a capture** (§6.5, §1.1).
- **In-app import of a capture file** — copying, converting, or transcoding into
  `assets/` (§3.2), including `.ply` → `.spz` transcoding, which Spark can do
  (`transcodeSpz`).
- **PCSOGS bundles** (bare `meta.json` + `.webp` siblings) (§3.1).
- **Streaming LOD / paging** — needs an HTTP `rootUrl`, which a directory handle does
  not provide (§4.4).
- **Assisted registration** — point-pair picking or automatic alignment against the
  modelled geometry. The transform is typed and dragged by hand (§7).
- **Sharing the registration with `apps/splat-camera-export`** — that app has its own
  `alignment.json` (its spec §7); teaching it to read `splats[]` from a `scene.json`
  would remove its manual pick-and-align step, and is a change to a second app.
- **Per-splat appearance controls** — opacity, colour grading, `maxStdDev`, or
  spherical-harmonic degree limits.
- **A splat as a section-heatmap or probe backdrop** beyond what the clip already
  gives (§5.4).
