# Sample App — Geometry assets (meshes as editable scene entities)

The feature spec for **authoring the scene's geometry in the app**: a **Geometry**
group in the scene hierarchy, one row per geometry object, and an **Add Geometry**
dialog that places `.glb` / `.gltf` / `.ply` / `.obj` assets from the scene folder's
`assets/` into the scene. Companion to [`spec.md`](./spec.md); this document owns the
full behavior of the feature, and §12 lists the edits required in `spec.md` so the two
stay consistent (workflow rule: spec-first, no drift).

> **Terms, first use.**
>
> **Geometry object** — one entry of the `Scene`'s `geometry` array (`spec.md` §14.1):
> the parametric **room** shell, a **box** obstacle, or — new here — a **mesh**
> referencing an asset file. Every geometry object reduces to world-space triangles
> that are merged into the single collision mesh the SDK measures against
> (`spec.md` §14.6).
>
> **Mesh asset** — a file holding **triangles**: glTF (`.gltf`, and its binary
> container `.glb`), PLY (Stanford polygon format), or OBJ (Wavefront). Unlike a
> **splat capture** (`gaussian_splats.md`), a mesh has surfaces, so a ray can
> intersect it — which is the whole difference: a mesh is something the coverage
> engine **measures against**, not merely something the user looks at.
>
> **Naming.** The entity keeps the name it already has — a **geometry object**
> (`GeometryObject`, ids `geom-N`, scene-file key `geometry`). The new kind is
> **`mesh`**. The hierarchy group is **Geometry**. "Asset" continues to mean a file
> under the scene folder's `assets/` (`spec.md` §14.2), mesh and capture alike.

---

## 1. Problem & goal

The app measures coverage against **modelled geometry** — the parametric room, box
obstacles, and GLB references (`spec.md` §4.1, §14.6). Today that list is
**read-only from inside the app**: `spec.md` §14.9 states outright that geometry "is
not selectable/editable like cameras/probes/sections" and that the list "is authored
by editing the scene file". Adding a rack, a gantry, or a parked trailer to a site
model means hand-editing JSON with coordinates nobody has, reloading, and looking.

That was defensible while geometry was a fixed backdrop the default scene built in
code. It stopped being defensible once the app grew everything else: cameras,
probes, sections, zones, volumes, constraints and splat captures are all added,
selected, transformed, named, disabled, duplicated, deleted and reordered from the
hierarchy. Geometry — the one thing every coverage number is computed *against* — is
the only scene content with no row.

**Goal.** Make geometry a first-class hierarchy citizen and let the user bring real
assets in:

- A **Geometry** group listing **every** geometry object, the default room and its
  boxes included, each with an **enabled checkbox**, a transform, a name, and the
  usual duplicate / delete / reorder actions.
- An **Add Geometry** dialog that lists the mesh assets already sitting in the scene
  folder's `assets/` and adds a row referencing the chosen one — the **Add 3DGS**
  pattern (`gaussian_splats.md` §3.2), applied to triangles.
- Four accepted formats: **`.glb`**, **`.gltf`**, **`.ply`** (mesh PLY — see §3.3),
  **`.obj`**, including the **multi-file** cases (`.gltf` + `.bin` + textures;
  `.obj` + `.mtl` + textures) that today's loader cannot resolve at all.
- A **`GeometryPanel`** for the selected object, with the readouts and presets an
  import actually needs: world size, triangle count, `Z-up → Y-up`, and unit
  conversions.

## 1.1 The mirror image of a splat

`gaussian_splats.md` §1.1 opens by stating that a splat touches **no** analysis
input. This feature is that statement inverted, and the inversion is load-bearing
enough to be spelled out rather than discovered:

- **A geometry edit marks the result stale** (`spec.md` §8.1). Adding, deleting,
  duplicating, transforming or toggling a geometry object changes the collision mesh
  and may change the workspace AABB, so the standing result no longer describes the
  scene on screen. (Renaming and reordering do not — they are presentation, exactly
  as for every other kind.)
- **Geometry grows the workspace AABB.** The analysis volume is the merged geometry's
  bounds plus a margin (`spec.md` §4.2), and an imported object that extends past the
  current bounds extends the volume. This is the deliberate opposite of a splat, which
  contributes no bounds because it is not measured. The cost is real and cubic — see
  §4.4 — and it is the user's to spend.
- **Geometry stays a "Place on surface" target** (`spec.md` §2.4.2). That tool clicks
  *the scene geometry*; imported meshes are scene geometry, so a camera can be dropped
  onto an imported wall. Nothing changes here except that there is more to click.
- **A geometry object is still not viewport-pickable** (§6.6). That is a selection
  decision, not an analysis one, and it is the single place this feature keeps a
  splat's rule rather than inverting it.

**The SDK is not touched.** `@linkervision/camera-coverage-sdk` receives what it
already receives — one merged, indexed, world-space `SceneMesh` via `loadScene`, and
a workspace AABB via `init`. Everything in this document happens on the app side of
that boundary.

---

## 2. Model & state

### 2.1 The `GeometryObject` entity

```ts
/** Common to every kind (spec §14.3). */
export interface GeometryBase {
  /** `geom-N`. */
  id: string;
  /** User-edited display label; blank falls back to §2.4's rule. */
  name: string;
  /** Whether the object is in the scene at all (§5.1) — drawn *and* measured. */
  enabled: boolean;
  position: Vec3;
  rotation: Quat;
  /** Per-axis. A triangle mesh takes a non-uniform scale correctly (§7). */
  scale: Vec3;
}

export interface RoomGeometryObject extends GeometryBase {
  kind: 'room';
  halfX: number; halfZ: number; height: number; thickness: number;
}

export interface BoxGeometryObject extends GeometryBase {
  kind: 'box';
  /** Axis-aligned bounds in the object's local frame. */
  min: Vec3; max: Vec3;
}

export interface MeshGeometryObject extends GeometryBase {
  kind: 'mesh';
  /** Path relative to the scene folder root, e.g. `assets/site/rack.obj` (§3.1). */
  src: string;
}

export type GeometryObject = RoomGeometryObject | BoxGeometryObject | MeshGeometryObject;
```

`id`, `name` and `enabled` are **new on all three kinds**; the transform and the
per-kind parameters are unchanged.

**One array, not two.** Meshes go into the existing `Scene.geometry` array rather
than a new editable array beside it. A splat earned its own array because it is
inert — it breaks `spec.md` §14.6's "every geometry object contributes to occlusion"
and §14.9's "geometry is not selectable/editable". A mesh breaks neither: it
contributes triangles like every other member, and §14.9's editability rule is what
this feature **deletes** (§12). A second array holding objects that behave
identically to the first would be a split by provenance, not by behaviour — the kind
that rots, because nothing tells you which array a given rule applies to.

**Why `id`/`name`/`enabled` and not just `id`.** A row needs a stable identity to be
selected, reordered, and pointed at by a panel; array position is not one, because
every insert, delete and reorder would silently re-point the selection. Given an id,
`name` and `enabled` follow the convention every other entity already carries
(`spec.md` §5.5), and their absence would make geometry the only kind you cannot name
or switch off.

### 2.2 The `mesh` kind and the loader table

One kind for all four formats, with the loader chosen by the `src` extension:

| Extension | Loader | Notes |
|---|---|---|
| `.glb` | `GLTFLoader` | Self-contained; no sibling resolution needed |
| `.gltf` | `GLTFLoader` | Siblings (`.bin`, textures) resolved per §3.4 |
| `.ply` | `PLYLoader` | **Mesh** PLY only — a splat PLY routes to Add 3DGS (§3.3) |
| `.obj` | `OBJLoader` (+ `MTLLoader`) | `mtllib` and its maps resolved per §3.4 |

All three loaders ship in `three/addons`, the import path the app already uses for
`GLTFLoader`, `OrbitControls` and `TransformControls` — **no new npm dependency**
(`ai/STACK.md`).

**Why not a kind per format.** `'gltf' | 'ply' | 'obj'` would be three exhaustively
switched branches that do the same thing, differing only in which loader they call —
and a file's `kind` could then contradict its own `src` extension, which is a state
nothing can resolve. The extension is already the authority on how to parse a file;
the model should not carry a second, disagreeing copy of that fact. A future `.fbx`
is then a row in the table above, not a new variant everything must re-handle.

**Legacy `gltf` reads as `mesh`.** Existing scene files carry `kind: 'gltf'`; the
reader maps it to `mesh` and the writer emits `mesh` (§8). There is exactly one kind
for asset-backed geometry at any moment, never two names for the same thing depending
on when the file was written.

### 2.3 Hierarchy node

A new `SceneNode` variant in `scene/sceneTree.ts`:

```ts
| { kind: 'geometry'; id: string; label: string; geometryId: string }
```

a **selectable leaf** under a passive auto-derived **"Geometry"** umbrella
(`group:geometry`) — the Cameras / Probes / Sections / Splats shape, not the
user-created zone/constraint-group shape. Node ids are namespaced `geom:` via
`nodeIdForGeometry` / `geometryIdForNode`. `buildSceneTree` gains a `geometry`
parameter; the tree stays **derived**, with no new mutable node state.

**Root order** becomes **Cameras → Probes → Sections → Zones → Constraints →
Geometry → Splats**.

Geometry sits second-to-last, immediately above Splats, rather than first. The
ordering runs from what the user works *on* toward what the scene is drawn *against*:
Cameras stays at the top because it is the list every session is spent in, and
Geometry sits beside Splats because the two are the scene's backdrop — one measured,
one not. Putting Geometry first would push the camera list down by a group plus a row
per object on every scene, for content that is usually set once.

**The Geometry group is always shown, and starts expanded.** It is the only group
with no "when non-empty" condition. An empty geometry list is a legal, reachable state
(§5.3), and the header is where the empty state is explained and where the group
context menu's **Add geometry…** lives — a group that vanished when emptied would take
the only route back with it.

### 2.4 Label

```ts
geometryLabel(o) =
  o.name.trim()
  || (o.kind === 'mesh' ? basename(o.src) : `${Room|Box} ${n}`)
```

- A **mesh** row falls back to the **basename of its `src`** — `rack.obj`,
  `site.glb` — the documented exception splats already established
  (`spec.md` §5.5, §14.2: "the filename is the scene's name"). An asset-backed
  object's identity is its file; two unnamed rows on two different files stay
  distinguishable, and a duplicated row reads as a duplicate.
- A **room** or **box** row has no file, so it falls back to the ordinal
  **within its own kind**: `Room 1`, `Box 3`. Numbering per kind, not per group,
  because `Geometry 4` says nothing and the kinds are visually distinct anyway.

Only the **basename** is shown, not the folder-relative path — `site/rack.obj`
crowds a narrow left panel, and the panel's Source field (§7) carries the full path
for the case where two bundles hold the same filename.

`name` round-trips and is **omitted on write when blank** (`spec.md` §14.3), so an
unnamed object has no `name` key and reads back labelled by this rule.

---

## 3. Assets

### 3.1 Path resolution & accepted extensions

A mesh's `src` follows the **existing `gltf` rule** (`spec.md` §14.2): a path
**relative to the scene folder root**, resolved through the picked directory handle,
validated by **`isSafeAssetPath`** — absolute paths, URLs, `..` segments and
`\` are rejected on import (`spec.md` §14.8). That function already accepts
multi-segment paths, so `assets/site/rack.obj` needs no format change.

**Accepted extensions**: `.glb`, `.gltf`, `.ply`, `.obj`. Case-insensitive.

A `.mtl`, a `.bin`, or a texture file is **never** a `src` — those are dependencies,
reached only through the file that references them (§3.4), and they are not listed as
addable in §3.2.

### 3.2 Adding geometry — the **Add Geometry** dialog

The hierarchy header **"+" menu** (`spec.md` §5.5) gains a **Geometry…** entry — the
second entry that opens a dialog rather than spawning an entity, and the second that
is not always enabled. The **Add Geometry** dialog lists the mesh assets already
present under the scene folder's `assets/` and adds a row referencing the chosen one.

- **The user puts the file there.** The app never writes into `assets/` — the same
  rule, for the same reasons, as Add 3DGS (`spec.md` §14.9's no-file-management rule,
  and a `read`-mode folder handle until the first save).
- **Listing walks `assets/` recursively, with no depth limit.** Exported model
  bundles arrive as their own folder (`assets/site/model.obj` +
  `assets/site/textures/`), and flattening one by hand before the app can see it
  would defeat the point. This **diverges deliberately** from Add 3DGS's
  root-only rule (`gaussian_splats.md` §3.2) and from §14.2's flatness rule for scene
  *files*: a capture is one file and a scene file must sit one level from `assets/`,
  while a model is a **set** of files that ships as a directory.
  - Rows show the **folder-relative path** (`site/model.obj`) and the file's **byte
    size**, sorted case-insensitively and stably by path, so the list does not
    reshuffle between openings. **No file is read or parsed to build the list** —
    metadata only — with the single exception of `.ply` header sniffing (§3.3), which
    reads the first bytes of each `.ply` and nothing else.
  - The walk is **asynchronous** and the dialog shows a progress state
    (`scanning assets/… 412 files`) until it completes, so a deep or large folder
    never blocks the UI. There is **no depth cap and no entry cap**: the ceiling is
    whatever the user's own `assets/` holds. If a real folder ever makes this dialog
    slow to open, the fix is a cap here, stated in this bullet — not a silent
    truncation added elsewhere.
- **An asset already referenced by this scene is still listed and still selectable** —
  two rows on one file is how two placements of the same rack are made, and §3.5
  makes it cheap.
- **Opens on the first selectable row**; **ArrowUp/ArrowDown** walk the selectable
  rows only, clamping at both ends; **Enter** and **double-click** commit. This is the
  Load and Add 3DGS list behavior exactly, and it is the *same code* —
  `sceneFileList.moveListSelection` (`ai/CONVENTIONS.md`: a keyboard move is
  `(rows, selected) → selected` and belongs in a tested pure module).
- **Commit** adds a `MeshGeometryObject` with the next free id, `enabled: true`, an
  **identity transform**, a blank `name`, and **auto-selects** it — so the
  `GeometryPanel` (§7) is open on it with its size readout, ready to fix up-axis and
  units. Loading (§4.2) starts immediately. The add **marks the result stale** (§1.1).
- **No scene folder yet.** At boot there is no save target (`spec.md` §14.1), so
  there is no `assets/` to read: the **Geometry…** entry is **disabled** with the hint
  *"Load or save a scene first."*, exactly as **3D Gaussian Splat…** is.
- **No `assets/` folder, or nothing addable in it.** The dialog says so and offers no
  commit; it does not create the folder.
- The **Geometry group header's context menu** offers the same **Add geometry…**
  item, so the empty-list state has a route out of itself (§2.3). This is the first
  non-empty group menu besides Cameras' **Export camera info**, and it is declared in
  the same exhaustive per-group record (`ui/groupMenu.ts`).

### 3.3 `.ply` is claimed — routing by header

`.ply` is already in `SPLAT_EXTENSIONS` (`gaussian_splats.md` §3.1): the Add 3DGS
dialog lists every `assets/**.ply` as a Gaussian capture, because that is one of the
formats captures ship in. A **mesh** PLY and a **splat** PLY share an extension and
are different files entirely.

They are distinguishable from the header alone, which is **plain ASCII text at the
head of every PLY**, binary variants included, and terminated by `end_header`:

- a **splat** PLY declares per-vertex Gaussian properties — `f_dc_0`, `scale_0`,
  `rot_0`, `opacity`;
- a **mesh** PLY declares `element face …`.

The routing rule:

| Header | Add Geometry | Add 3DGS |
|---|---|---|
| has `element face`, no Gaussian properties | **listed, selectable** | listed with the reason *"that's a mesh PLY"* |
| has Gaussian properties | listed with the reason *"that's a 3DGS capture — use Add 3DGS"* | **listed, selectable** |
| neither (points only, no faces) | listed with the reason *"no faces — nothing to occlude"* (§4.5) | listed, selectable (Spark may still decode it) |
| header unreadable / not a PLY | listed with the reason *"not a readable PLY"* | as today |

Listing the wrong-kind file **with its reason** rather than hiding it is the choice
both existing dialogs already make (`spec.md` §14.4's invalid `*.json`,
`SOG_BUNDLE_REASON`): a folder explains itself instead of looking empty.

The sniff is a **pure function over the header text** (`scene/plyHeader.ts`), so it
is unit-tested against fixtures with no file system involved; `sceneIO` reads the
first 4 KB of each `.ply` and hands it over. 4 KB is comfortably past `end_header` in
every real file; a header that has not ended by then reports *"not a readable PLY"*
rather than reading further.

### 3.4 Multi-file assets — sibling resolution

Two of the four formats reference sibling files by relative URI: a `.gltf` names its
`.bin` and its textures, and a `.obj` names an `.mtl` which names its own maps. The
current loader calls `parseAsync(bytes, '')` — an **empty resource path** — so a
`.gltf` with a separate `.bin` fails today, before this feature.

Resolution runs through the **same directory handle** everything else uses:

- A `THREE.LoadingManager` with a **`setURLModifier`** that, for each requested
  relative URI, resolves it **against the referencing file's own directory**,
  validates the result with **`isSafeAssetPath`** (so `../../etc/passwd`, an absolute
  path, or an `http:` URL is refused), reads the bytes through the folder handle, and
  returns a **blob URL**.
- Blob URLs are **revoked** once the parse settles — success or failure — so a
  repeated add does not leak a URL per texture.
- A **missing sibling** fails the object's load, and the row reports
  `⚠ missing: site/model.mtl` naming the file (§9). It does not fail the scene.
- **Nothing outside the scene folder is ever fetched.** The URL modifier is the only
  route to bytes, and it refuses anything `isSafeAssetPath` refuses, so a
  hand-authored `.mtl` pointing at a remote URL loads nothing.

This is the decision `gaussian_splats.md` §3.1 declined for PCSOGS bundles, and the
difference is that there it was avoidable (the `.sog` zip carries the same data in
one file) and here it is not: `.gltf` and `.obj` **are** the formats, and a `.obj`
without its `.mtl` is untextured by definition.

### 3.5 One parse per `src`

Parsed assets are cached **keyed by `src`** and shared: two rows on one file cost
**one** read, **one** parse, and **one** set of GPU buffers, while keeping
independent transforms, names and visibility. The cache is **refcounted by
referencing rows**; an entry is disposed when the last row referencing that `src` is
deleted (§6.3) or the scene is replaced (§8).

The render side shares the parsed `BufferGeometry` between rows (each row gets its own
`THREE.Mesh` with its own matrix); the collision side re-transforms the cached
triangles per row, since each row bakes its own transform into world space
(`geometryModel.transformTriMesh`).

**A scene replacement is App's signal, not the loader's** — the same reasoning as
`gaussian_splats.md` §3.3: two scene files in one folder share an asset loader while
being different scenes, so the import path releases the cache explicitly rather than
letting the loader infer it from a changed folder.

---

## 4. Load, build & cost

### 4.1 Two builds from one parse

A geometry object feeds two things, and they are rebuilt on different schedules:

| Build | What it is | Rebuilt |
|---|---|---|
| **Render group** | `THREE.Object3D`s in the viewport scene, materials intact, forced double-sided (`spec.md` §14.6), section clip planes applied (§13.9) | immediately, on every edit |
| **Collision mesh + workspace AABB** | the merged world-space `SceneMesh` for `loadScene`, and the bounds for `init` | **lazily, at the next Run** (§4.3) |

`buildStaticGeometrySync` stays exactly as it is: the default scene references no
asset, so App still seeds its initial state synchronously.

### 4.2 Streaming load & load state

Rows appear **immediately**; bytes and triangles arrive after. Per row:

| State | Badge |
|---|---|
| reading | `41%` (bytes read / file size; `loading…` when the size is unknown) |
| parsing | `parsing…` |
| loaded | `128k tris` |
| loaded, over the warning threshold | `4.2M tris ⚠` (§4.4) |
| missing | `⚠ missing from assets/` |
| missing dependency | `⚠ missing: site/model.mtl` (§3.4) |
| unparseable | `⚠ could not be parsed` |
| no triangles | `⚠ no faces — nothing to occlude` (§4.5) |

Load state is **derived side state** — a `Map<geometryId, MeshLoadState>` held beside
the scene, never part of `GeometryObject` and never serialized, exactly like the splat
map (`gaussian_splats.md` §6.2) and the retained per-run probe/section data.

**Parsing runs on the main thread**, in an async task. The loaders are already there
and glTF's materials and textures do not cross a worker boundary cleanly — only raw
geometry does — so a worker would either split the format handling in two or degrade
how imported models look. The honest cost is a hitch while a large file parses, and
§4.4 is what keeps that from being a surprise. Reads stream (the byte counter above
is real progress); the parse itself is one step.

Room and box objects have no load state at all: they are synchronous, and their rows
carry no badge.

### 4.3 The collision mesh is rebuilt at the next Run

A geometry edit updates the **render group** at once and **does not** re-merge the
collision mesh or re-init the engine. It sets the stale flag (`spec.md` §8.1); the
merge, the AABB derivation, `init` and `loadScene` all happen as part of the next run.

The alternative — rebuilding on each edit commit — pays a full re-merge of every
triangle in the scene each time a gizmo drag ends, which on a multi-million-triangle
site model is a visible freeze per nudge, repeated through exactly the sequence of
small adjustments that placing an asset consists of. Nothing between edits needs the
merged mesh: the viewport draws the render group, and **Place on surface** raycasts
the render group too (`spec.md` §2.4.2).

Consequences, stated so they are not discovered:

- Between a geometry edit and the next run, the **stats panel's workspace and voxel
  counts describe the last run's workspace**, like every other number it shows while
  the Recompute badge is up. The badge is the signal; there is no second one.
- **Auto-run** (on by default, throttled to 10/sec, `spec.md` §8.1) will therefore
  re-merge during a drag as it already re-computes during a camera drag. A geometry
  edit **cancels a superseded in-flight run**, which §8.1 already specifies for
  "a resolution, geometry, or sampling change".
- A run whose AABB differs from the engine's current one is a **full re-init**, not an
  incremental recompute — the same path a resolution change takes.

### 4.4 Cost, and the triangle guardrail

Two costs grow with what is imported, and neither is hidden:

- **Triangles.** 1M triangles ≈ 12 MB of positions + 12 MB of indices in the merged
  collision mesh, again as GPU buffers, re-merged at every run.
- **Bounds.** The workspace AABB follows the merged geometry (`spec.md` §4.2), and
  voxel count is **cubic** in extent. On the reference site (440 × 201 × 1120 m at
  1 m) the volume is already ~10⁸ voxels; an asset that doubles one extent doubles
  the run.

The guardrail is **information, never a refusal**:

- Every loaded mesh row badges its **triangle count** (§4.2).
- Above **`WARN_TRIANGLES_OBJECT` = 2,000,000** for one object, or
  **`WARN_TRIANGLES_SCENE` = 5,000,000** merged, the row and the stats panel show an
  amber note that runs will be slow. Both are named constants so this spec can state
  them and a change is one edit.
- The **stats panel** states the workspace extent and voxel count the **next** run
  will use whenever it differs from the standing one, derived from the render group's
  bounding boxes (cheap — no re-merge), so a 1000× unit error is visible within a
  second of adding rather than at the end of a long run.
- Nothing is blocked. A hard cap would be a number invented here that is wrong for
  somebody, with no way past it; the user knows their machine and their site.

### 4.5 Zero-triangle assets are refused

An asset that parses but yields **no triangles** — a faceless PLY (a point cloud), an
OBJ of only points or lines, a glTF whose nodes are all lights or cameras — is
**refused at the Add Geometry dialog**, listed with the reason *"no faces — nothing to
occlude"* and unselectable. A hand-edited scene file referencing one loads, and the
row badges the same reason (§9).

It would otherwise be a row that occupies the hierarchy, occludes nothing, and still
**grows the workspace AABB** — diluting every coverage rate with voxels nothing can
cover, which is precisely the failure `spec.md` §4.2 excludes splats to avoid. Keeping
the refusal makes §14.6's "**every** geometry object contributes to occlusion" literally
true, which is worth more than a raw scan used as a visual reference — and a visual
reference is what a splat capture is for.

---

## 5. Visibility, and the empty scene

### 5.1 The per-object checkbox takes the object out of the scene

A geometry row's **enabled checkbox** is not a draw toggle. `enabled: false` means the
object is **not in the scene**: not drawn, **no triangles** in the merged collision
mesh, and **no contribution** to the workspace AABB. Toggling it **marks the result
stale**.

This is what makes the checkbox answer the question a site survey actually asks —
*what does coverage look like without this rack?* — in one click and one run, instead
of deleting the object and undoing a deletion the app has no undo for. The
alternative reading (hide but keep occluding) would leave an invisible object
blocking every camera ray, producing a number no one can explain from the viewport.

**A disabled object stays hidden even while selected** — the **splat exception**
(`spec.md` §2.4.3), not the selection-wins rule, and for two reasons:

- It is genuinely *not in the scene*. Every other kind's selected-disabled tier draws a
  gizmo's own wireframe so a drag has something to aim at; a geometry object is not a
  gizmo but the scene's own surfaces, and re-drawing a rack the user has just unticked
  would read as the checkbox not working.
- Dimming it would mean writing `opacity` onto its materials — and from §3.5 those
  materials come from a **parse shared between every row on that file**, so a
  selected-disabled tier would dim every other copy of the same asset with it.

Its `TransformControls` gizmo **still attaches**: the object keeps an invisible render
node, so a hidden object can be moved and re-ticked to check the result — exactly the
editability the selection-wins rule exists to protect, reached the way a splat reaches
it. §2.4.3 gains geometry to its "the exception" paragraph rather than a row in its
tier table.

### 5.2 The **Geometry** layer row still means drawing only

The viewport's eye-menu **Geometry** row (`spec.md` §2.4, §14.6) is unchanged: it sets
the render group invisible and touches nothing else — not the merged mesh, not the
AABB, not a standing result, and it never marks stale. It exists so a splat capture
can be seen behind the model.

So the word **Geometry** now names two controls with different meanings, and that is
deliberate:

- the **layer** row is about **drawing** — it is in the eye menu, beside Cameras and
  Splats, which are also draw-only;
- a **row checkbox** is about **what is in the scene** — it is in the hierarchy, beside
  every other entity's checkbox, which also govern membership.

The split already exists for every other kind (the **Cameras** layer toggle hides
cameras that still measure), and splats carry exactly this pair. Renaming the layer
rows to *Show …* was considered and rejected: it would touch every layer row and both
locales to fix a confusion the existing pairs have not produced.

### 5.3 An empty geometry list is legal; Run is blocked

Deleting or disabling everything leaves **no triangles and no bounds**. That state:

- **loads, saves, renders and edits normally** — cameras, splats, probes, sections and
  constraints are unaffected;
- **blocks Run**, which disables with *"No geometry to measure"*;
- **clears any standing result** rather than leaving an overlay describing a scene that
  no longer exists;
- shows **no workspace** in the stats panel.

It is a useful state, not merely a tolerable one: a scene of cameras aimed at a splat
capture, exported through `apps/splat-camera-export`, needs no triangles at all.
`computeAabb` (`scene/geometryModel.ts`) gains an **explicit empty case** — today it
throws `computeAabb: empty mesh`, which would be an uncaught error on the user's last
delete.

### 5.4 A failed load blocks Run too

While **any enabled** geometry object is **still loading** or has **failed to load**
(§9), Run disables with *"Geometry failed to load"* / *"Geometry still loading"*. An
enabled-but-absent occluder would otherwise silently inflate every coverage number,
which is the one thing a missing splat cannot do and the reason the two kinds diverge
here (§9).

The block is cleared by fixing the file, **unticking** the row, or deleting it — each
an explicit choice the user makes and can see, which is exactly what an incomplete
scene should require.

---

## 6. Hierarchy integration (`spec.md` §5.5)

### 6.1 Selection

The unified selection gains a `'geometry'` case:
`{ kind: 'camera' | 'probe' | 'section' | 'zone' | 'volume' | 'constraintGroup' |
'constraint' | 'splat' | 'geometry'; id }`. Selecting a geometry object deselects
everything else, drives the `GeometryPanel` (§7), and attaches the single
`TransformControls` gizmo.

### 6.2 Row content

Label per §2.4, the enabled checkbox (§5.1), and — for `mesh` rows only — the load-state
badge of §4.2. Room and box rows carry no badge.

### 6.3 Delete

Right-click → **Delete** (`DeletableKind` gains `'geometry'`, so
`ui/entityMenu.ts`'s `Record<DeletableKind, …>` fails to compile until the handler is
wired — the guard that type exists for). Removes the row, clears the selection if it
was selected, disposes its render meshes, cancels an in-flight load, and releases the
parse-cache entry **if it was the last row on that `src`** (§3.5). **Marks the result
stale.**

Deleting the **last** geometry object is allowed and lands in §5.3's empty state.

### 6.4 Duplicate

Right-click → **Duplicate** creates a deep copy with the next free id and auto-selects
it, carrying **every property verbatim** — kind and per-kind parameters, `src`, `name`
(blank stays blank), `enabled`, and the full transform — so the copy **coincides with
the original** and is then moved by its gizmo. That is the rule every other kind
follows (`spec.md` §5.5), and an offset would be a second rule for no reason: a copy
placed "somewhere near" is a position the user did not choose and must undo.

The copy **shares the original's parse** (§3.5), so duplicating a rack twenty times
down an aisle costs twenty rows, not twenty parses. **Marks the result stale.**

### 6.5 Reordering

Geometry rows are **draggable to reorder within the Geometry group**
(`spec.md` §5.5.1), like every other draggable kind. Array order is display order and
round-trips in the file with no new field. It **never marks stale**: the merge is
order-independent (the collision mesh is a union of triangles, and render order for
opaque double-sided meshes is decided by depth, not by array position).

### 6.6 Not viewport-pickable

A geometry object is selected **from its hierarchy row only**. A viewport click on
geometry continues to count as a **miss**, and continues to deselect (`spec.md` §5.2).

Making geometry pickable was considered and rejected on a concrete ground: the room's
floor and walls fill most of the viewport, so "click empty space to deselect" would
lose almost all of its empty space, and every stray click while framing a shot would
change the selection. Moving deselect onto Escape alone would rewrite a gesture that
works for every existing kind, to benefit the one kind that is usually set once.
**Place on surface** is unaffected — it suspends picking while armed and raycasts the
same geometry it always did (§1.1).

---

## 7. `GeometryPanel` — the selected-object editor

The left detail panel for a selected geometry object (`ui/GeometryPanel.tsx`),
alongside the existing per-kind panels:

- **Name** — the editable display name (blank ⇒ §2.4's label).
- **Kind** — `Room` / `Box` / `Mesh`, read-only.
- **Source** (mesh only) — the full folder-relative `src`, read-only, with the load
  state and triangle count (§4.2). Re-pointing a row at a different file is
  `Delete` + `Add`, which is also what keeps the parse cache's refcount honest — the
  same rule and the same reason as `SplatPanel`'s Source.
- **Size** — the object's **world-space bounding-box extent** in metres
  (`12.4 × 3.1 × 8.0 m`), recomputed as the transform changes. This is the readout
  that makes a wrong up-axis or a millimetre-unit file obvious within a second of
  adding, and it is why it is on the panel rather than in a tooltip.
- **Position** — X / Y / Z in metres, via the existing numeric fields (`spec.md`
  §5.2.1).
- **Rotation** — X / Y / Z **Euler degrees**, converted to and from the stored
  quaternion by `cameras/math.ts`'s shared `eulerToQuat`/`quatToEuler`, with X bounded
  to ±90 for the same `YXZ`-decomposition reason `SplatPanel` states.
- **Scale** — X / Y / Z, **per-axis**, each strictly positive with a floor of `1e-3`.
  A triangle mesh takes a non-uniform scale correctly — the uniform-scale restriction
  exists only because scaling a Gaussian's covariance non-uniformly shears it
  (`gaussian_splats.md` §2.1), and no triangle has a covariance. `0` and negatives are
  refused by the field and by the reader (§8): a zero scale collapses the object and a
  negative one mirrors it, inverting every triangle's winding.
- **Presets**, the three corrections an import actually needs:
  - **Z-up → Y-up** — −90° about X, **replacing** the rotation (so pressing it twice
    is idempotent, and it reads as **pressed** while the rotation *is* that value —
    the `Flip 180° Z` convention).
  - **Units** — **mm** (×0.001), **cm** (×0.01), **inch** (×0.0254), each writing a
    uniform `scale`, replacing rather than compounding.
  - **Reset transform** — identity position, rotation, and `[1,1,1]` scale.
- **Parameters** (room / box only) — `halfX`, `halfZ`, `height`, `thickness`, or
  `min`/`max`, shown **read-only**. They are readable because "how tall is this room"
  is a fair question; they are not editable because in-app primitive authoring is a
  separate feature (§14), and `spec.md` §14.9's "use GLB for arbitrary shapes" still
  stands.

**The gizmo sits on the object, not on its origin.** A geometry object's `position`
is the origin of its *frame*, and that is routinely nowhere near the shape: a default
`box` is local `min`/`max` at `position [0,0,0]`, and an imported asset is wherever its
author put its origin. So the render node `TransformControls` attaches to is placed at
the object's **local geometric centre** (carried through its own rotation and scale)
and its content is offset back by the same amount, which leaves every vertex exactly
where it was. The panel keeps showing — and the file keeps storing — the object's own
`position`; the readback subtracts the offset that placed the node, through the one
shared `pivotOffset` so the two directions cannot drift.

**Gizmo modes.** A selected geometry object supports **Move**, **Rotate** *and*
**Scale** (`spec.md` §2.4). `resolveMode` currently forces Scale back to translate for
everything except a sampling volume; geometry joins volume as a scale-capable
selection. Scale is per-axis on the gizmo, matching the panel.

---

## 8. Scene file (import / export, `spec.md` §14)

- **`formatVersion` 3 → 4.** The reader **accepts 1, 2, 3 and 4**; the writer emits
  **4**. Unlike every additive change since v1 (`name`, `clipRange`, camera `enabled`,
  section footprints, `splats`), this one is **not** back-compatible in the direction
  that matters: a v3 reader rejects an unknown geometry `kind`, so a file containing
  `kind: "mesh"` would abort on an older build rather than degrade. Pretending
  otherwise by keeping v3 would hand older builds a file they abort on with a schema
  error instead of a version error. The bump is the honest signal.
- **Reading v1–v3.** `kind: "gltf"` reads as `kind: 'mesh'`. Every geometry object
  gains a **back-filled `id`** — `geom-1`, `geom-2`, … **by array position** — a blank
  `name`, and `enabled: true`. A v1–v3 file therefore loads with exactly the scene it
  always described, now addressable. Saving it rewrites it as v4.
- **Back-filling never collides.** Ids are read in **two passes**: the ids the file
  **spells out** are collected first, then each object without one takes the **lowest
  `geom-N` still free**. A v1–v3 file carries no ids at all, so every object falls to
  the second pass and the result is `geom-1`, `geom-2`, … by array position exactly as
  above. The passes matter only for a **hand-edited v4** that gives some objects an id
  and not others: `[{ "id": "geom-2" }, {}, {}]` reads as `geom-2`, `geom-1`, `geom-3`
  rather than aborting on a clash the file never contained. A back-filled id is the
  reader's own invention, so letting one veto a legal file would be the reader
  rejecting its own output.
- **Per-object shape.** `{ id, kind, enabled?, name?, position, rotation, scale }`
  plus the per-kind fields (`halfX`/`halfZ`/`height`/`thickness`, `min`/`max`, or
  `src`). `enabled` is **optional on read** (default `true`) and **omitted on write
  when `true`**, like the camera and splat flags; `name` is **omitted when blank**;
  `id` is always written.
- **Validation** (part of the same all-or-nothing pass as everything else): the ids the
  file **spells out** unique within `geometry` (a back-filled id is chosen free, so it
  cannot conflict), known `kind`, safe `src` per `isSafeAssetPath`, `scale`
  components finite and `> 0`, `rotation` a 4-tuple, `enabled` boolean when present.
  **Asset loading is not part of this gate** — see §9.
- **Array order is display order**, preserved verbatim, as for every other array.
- **Asset copying (§14.5).** `planAssetCopy` takes the **dependency closure**, not just
  the `src` list:

  | Format | Dependencies scanned |
  |---|---|
  | `.glb`, mesh `.ply` | none — self-contained |
  | `.gltf` | `buffers[].uri` + `images[].uri` (skipping `data:` URIs) |
  | `.obj` | every `mtllib` operand |
  | `.mtl` (reached from an `.obj`) | every `map_*` / `bump` / `disp` / `refl` operand |

  Each dependency is resolved **relative to the referencing file**, validated by
  `isSafeAssetPath`, and added to the same deduplicated copy set the splat and mesh
  `src`s already feed. The scan runs **at save time** over bytes re-read from the
  target folder — nothing is retained in memory after import, and no dependency list
  is persisted on the object, which would go stale the moment someone edited the
  `.mtl` on disk. A **missing dependency aborts the cross-folder Save As…** before
  anything is written, naming the file — the existing rule for a missing asset,
  extended to the files an asset itself needs.
- **Dirty check.** `geometry` is part of `serializeScene`, so every geometry edit marks
  the scene unsaved through the existing baseline comparison, with no extra plumbing.
- **Not persisted.** Load state (§4.2), the parse cache, and the layer toggles.

Example (replacing the §14.3 sketch's `geometry`):

```json
{
  "formatVersion": 4,
  "geometry": [
    { "id": "geom-1", "kind": "room", "halfX": 10, "halfZ": 10, "height": 6,
      "thickness": 0.3,
      "position": [0,0,0], "rotation": [0,0,0,1], "scale": [1,1,1] },
    { "id": "geom-2", "kind": "box", "min": [-7,0,-7], "max": [-4,2.5,-4],
      "position": [0,0,0], "rotation": [0,0,0,1], "scale": [1,1,1] },
    { "id": "geom-3", "kind": "mesh", "name": "Rack row A",
      "src": "assets/site/rack.obj",
      "position": [2,0,3], "rotation": [0,0.707,0,0.707], "scale": [1,1,1] },
    { "id": "geom-4", "kind": "mesh", "src": "assets/shelf.glb", "enabled": false,
      "position": [0,0,0], "rotation": [0,0,0,1], "scale": [0.001,0.001,0.001] }
  ]
}
```

**`apps/splat-camera-export` is unaffected.** Its `scene.json` reader is deliberately
narrow and tolerant (its spec §5.1): it consumes `formatVersion` and `cameras`, and an
unknown *future* version loads with a **non-blocking notice** rather than an error. It
never reads `geometry`.

---

## 9. Error handling (`spec.md` §14.8)

A mesh's file failing is **survivable on import** and **fatal to a run** — the
deliberate middle between today's geometry rule (abort the import) and the splat rule
(load, badge, run anyway).

Aborting the import, as today, throws away a 96-camera layout because one prop is
missing, and this feature's whole premise is that geometry is repairable in-app.
Running anyway, as a splat allows, produces a coverage number that is wrong by an
amount nothing can quantify, because the missing object is an **occluder**. So: the
scene loads, the row says what is wrong, and **Run is blocked until an explicit choice
is made** (§5.4).

Additions to the §14.8 table:

| Case | Handling |
|---|---|
| Unsafe geometry `src` (absolute / URL / `..` / outside folder) | abort the import, keep current scene, show error (unchanged) |
| Duplicate **explicit** geometry id (two objects spelling out the same `id`), unknown `kind`, non-finite or non-positive `scale` component, malformed `rotation`, non-boolean `enabled` | abort the import, keep current scene, show error |
| `formatVersion` > 4 | abort, keep current scene, show error (1–4 accepted) |
| Referenced mesh **missing** from `assets/` | **import succeeds**; row badges `⚠ missing from assets/`; **Run blocked** while the row is enabled (§5.4) |
| Mesh unreadable or **fails to parse** | **import succeeds**; row badges `⚠ could not be parsed`; Run blocked while enabled |
| A **dependency** (`.bin`, `.mtl`, texture) missing or unsafe | **import succeeds**; row badges `⚠ missing: <path>`; Run blocked while enabled |
| Mesh parses to **zero triangles** | **import succeeds**; row badges `⚠ no faces — nothing to occlude`; Run blocked while enabled (§4.5) |
| A splat PLY referenced as `geometry`, or a mesh PLY referenced as a `splat` | each reports through its own kind's badge — the geometry row `⚠ could not be parsed`, the splat row `⚠ could not be decoded`; the Add dialogs prevent both (§3.3) |
| Every geometry object deleted or disabled | legal; **Run disabled** with *"No geometry to measure"*; standing result cleared (§5.3) |
| One object or the merged scene over the triangle warning threshold | amber note on the row and in the stats panel; **nothing blocked** (§4.4) |
| No `assets/`, or nothing addable in it | the **Add Geometry** dialog says so and offers no commit |
| No save target yet (boot) | the "+" menu's **Geometry…** entry is disabled: *"Load or save a scene first."* |
| Referenced mesh **or one of its dependencies** missing on a cross-folder Save As… | abort before writing the scene file, keep target, show error naming the file (§8) |

---

## 10. Terminology (`spec.md` §17)

- **Geometry object** — one member of the scene's `geometry` list: a `room`, a `box`,
  or a `mesh`. **Coverage input**: it contributes triangles to the merged collision
  mesh and bounds to the workspace AABB, so every geometry edit marks the result stale
  — the exact inverse of a splat.
- **Mesh** (the kind) — a geometry object referencing a triangle asset under `assets/`
  (`.glb`, `.gltf`, `.ply`, `.obj`), with a transform, a name, and a visibility flag.
- **Mesh asset** — the file itself. Distinguished from a **capture** (a splat file) by
  what it holds: triangles a ray can hit, versus Gaussians it cannot.
- **Dependency closure** — a mesh asset plus every sibling file it references
  (`.bin`, `.mtl`, textures), transitively. The unit a cross-folder Save As… copies
  (§8).

---

## 11. Tests

Per repo policy, every change ships with a test. The loaders need a WebGL context and
`three/addons`, so the boundary sits where the codebase already draws it
(`ai/CONVENTIONS.md`): every **judgement** lives in a pure module and is tested; the
impure loader/layer code stays thin and is verified by running the app.

Tested under `node --test`:

- **`geometryLabel`** — `name` wins when non-blank; a `mesh` falls back to
  `basename(src)`, not an ordinal; `room`/`box` fall back to `Room N` / `Box N`
  numbered **within their own kind**; whitespace-only name counts as blank.
- **`planGeometryAssetList`** (`scene/meshAssets.ts`) — filters to the accepted
  extensions; lists a splat PLY, a faceless PLY and an unreadable PLY **with their
  reasons** and unselectable; sorts case-insensitively and stably **by
  folder-relative path**; nested paths listed; an already-referenced asset still
  selectable; empty and no-`assets/` cases; `.mtl`/`.bin`/texture files never listed.
- **`classifyPlyHeader`** (`scene/plyHeader.ts`) — Gaussian properties ⇒ splat;
  `element face` ⇒ mesh; vertices with neither ⇒ point cloud; ASCII and
  `binary_little_endian` headers; CRLF line endings; a header with no `end_header`
  inside the sniff window ⇒ unreadable; a non-PLY magic ⇒ unreadable.
- **`scanAssetDependencies`** (`scene/assetDeps.ts`) — glTF JSON yields
  `buffers[].uri` + `images[].uri` and **skips `data:` URIs**; `.obj` yields every
  `mtllib` operand (including two on one line); `.mtl` yields `map_Kd`/`map_Bump`/
  `bump`/`disp`/`refl` operands; paths resolve **relative to the referencing file**
  (`assets/site/model.obj` + `tex/wall.png` ⇒ `assets/site/tex/wall.png`); `..`,
  absolute and URL operands are **rejected**, not resolved; `.glb` and `.ply` yield
  nothing; a transitive `.obj` → `.mtl` → texture chain resolves fully and
  deduplicates.
- **`parseSceneFile` / `serializeScene`** — a v3 file's `kind: "gltf"` reads as
  `mesh`; ids back-fill as `geom-1…` by position; a file **mixing** explicit and
  absent ids back-fills around the taken ones (`[{"id":"geom-2"},{},{}]` ⇒ `geom-2`,
  `geom-1`, `geom-3`) instead of aborting; `enabled` absent ⇒ `true` and
  omitted on write when `true`; `name` omitted when blank; writer emits
  `formatVersion` 4; a v5 file is rejected; v1/v2/v3/v4 accepted; array order
  preserved; each §9 abort case rejected with its message; a zero or negative `scale`
  component rejected.
- **`planAssetCopy`** — includes mesh `src`s, splat `src`s **and** the dependency
  closure of each mesh, deduplicated across all three (a texture shared by two `.mtl`s
  copies once); a missing dependency is reported, naming the file.
- **`sceneReducer`** — add / delete / duplicate / toggle-enabled / transform /
  rename / reorder geometry; delete clears a matching selection; duplicate copies
  verbatim with a fresh id and **no offset**; deleting the last object is allowed;
  **add, delete, duplicate, transform and toggle-enabled mark the result stale, while
  rename and reorder do not** (the inverse of the splat suite's assertion, and the
  reason both are worth asserting).
- **`buildSceneTree`** — the Geometry group appears **even when empty**, sits
  **between Constraints and Splats**, holds every kind of geometry object, and its
  rows carry the §2.4 labels.
- **`nodeEnabled`** — a geometry node routes to its own `enabled` lookup.
- **`computeAabb` / `computeWorkspaceBounds`** — the **empty** case returns the
  explicit no-workspace result instead of throwing (§5.3); a single object's bounds;
  bounds after a non-uniform scale and a rotation.
- **`transformTriMesh`** — a non-uniform scale composed with a rotation, since
  geometry is now the one entity that can carry one (a case the current suite does not
  cover).
- **`runBlocker`** (the pure Run gate) — blocked with no enabled geometry, blocked while
  an enabled row is loading or failed, **not** blocked by a *disabled* failed row,
  not blocked by a splat in any state, and allowed otherwise. This is the gate §5.3
  and §5.4 both hang off, so it is one tested function rather than a condition spelled
  out at each use site. It returns the **reason** a run is refused (or `null`), not a
  boolean — hence `runBlocker`, not `canRun`.
- **`meshLoadBadge`** — each state's badge text, including the threshold-crossing
  amber variant and the dependency-missing message naming its file (§4.2).
- **`unitPresetScale` / `zUpToYUp`** — the preset values; `zUpToYUp` is idempotent
  (applying twice equals applying once) and reports pressed when the rotation *is*
  that value; unit presets replace rather than compound.
- **`resolveMode`** — geometry is scale-capable; probe/section stay translate-only;
  splat stays Move/Rotate (a regression guard on the one shared switch this feature
  edits).
- **`deleteHandlers` / `duplicateHandlers`** — the `Record<DeletableKind, …>` covers
  `'geometry'` (compile-time, asserted by the suite's existing exhaustiveness test).
- **i18n parity** — every new key exists in both `en` and `zh-TW` (the existing
  `localeParity` suite covers this automatically once the keys are added).

Not covered by tests, and deliberately kept thin: `scene/meshLoader.ts` — the
`LoadingManager` URL modifier, blob-URL lifecycle, the three loader calls, the parse
cache's disposal, and the render-group swap. Every decision it would otherwise make is
one of the pure functions above.

---

## 12. Edits required in `spec.md` (consistency)

**Applied per stage** (§13). The rows below marked *(stage 2)* / *(stage 3)* describe
behavior that does not exist yet and are applied when that stage lands; everything else
is already in `spec.md`. A row that spans stages is applied in the part that shipped.

| `spec.md` section | Edit |
|---|---|
| §2.2 Layout / file map | Add `scene/runGate.ts`, `scene/sceneView/transformMode.ts`, `ui/GeometryPanel.tsx` — and, *(stage 2)*, `scene/meshAssets.ts`, `scene/plyHeader.ts`, `scene/assetDeps.ts`, `scene/meshLoader.ts`, `ui/AddGeometryDialog.tsx`; note the Geometry group in `SceneHierarchy.tsx`'s line and `GeometryPanel` in the left-panel detail list. |
| §2.4 Viewport toolbar | **Scale** is no longer volume-only: a selected **geometry object** is scale-capable, per-axis (§7). Note that geometry keeps Move/Rotate/Scale while splats keep Move/Rotate. |
| §2.4.2 Place on surface | Unchanged rule, but state that imported meshes are ordinary placement targets, and that a **geometry object** is not itself placeable (it is not a point). |
| §2.4.3 Disabled entities | State that a disabled geometry object is excluded from the collision mesh and the workspace AABB — the first kind whose checkbox changes a number — and that it joins the **splat exception** to "selection wins": hidden even while selected, with its gizmo still attached (§5.1). |
| §4.1 Geometry | Replace "`room`/`box` primitives and `gltf` references" with the three kinds (`room`, `box`, `mesh`) and the four accepted asset formats; note that the list is now user-authored (§3.2). |
| §4.2 Workspace | State that **imported meshes grow the AABB** and that voxel count is cubic in extent, with the stats panel's next-run readout as the warning (§4.4). Splats still contribute no bounds. |
| §5.2 Selection | A viewport click on geometry still misses and deselects (§6.6). |
| §5.5 Hierarchy | Add the `{ kind: 'geometry' }` node and the **Geometry** umbrella; root order → Cameras → Probes → Sections → Zones → Constraints → **Geometry** → Splats; the group is **always shown**, expanded; `buildSceneTree`'s new `geometry` parameter; the `'geometry'` selection case; row checkbox semantics (§5.1) and the mesh load badge; the label rule (§2.4); "+" → **Geometry…** as the second dialog-opening, conditionally-disabled entry; the group-header menu's **Add geometry…**; Duplicate/Delete rules; **which geometry actions mark the result stale** (§1.1). |
| §5.5.1 Reordering | Add **geometry** to the draggable kinds; reordering geometry never marks stale. |
| §8.1 Staleness | State the geometry rule: add / delete / duplicate / transform / toggle-enabled mark stale; rename and reorder do not; a geometry edit **cancels a superseded in-flight run** (already covered by "a resolution, geometry, or sampling change") and the following run is a **full re-init** when the AABB moved. Add the **lazy rebuild** rule (§4.3) and the two Run blocks (§5.3, §5.4). |
| §10 Stats panel *(stage 3)* | Add the next-run workspace/voxel readout and the triangle-count/threshold note (§4.4). |
| §13.9 Clip | No behavior change; note that imported meshes receive the same material clipping planes as every other render mesh. |
| §14.1 `Scene` model | `GeometryObject` gains `id`/`name`/`enabled`; the `gltf` kind becomes `mesh`; geometry is now addable, selectable and editable (the §14.9 rule this deletes). |
| §14.2 Folder layout *(stage 2)* | `assets/` may hold **model bundles in subfolders**; a mesh `src` may be multi-segment; the Add Geometry listing is **recursive** (§3.2), unlike scene files and captures. |
| §14.3 File format | `formatVersion` **4**; reader accepts 1–4; the per-object shape with `id`/`name`/`enabled`; legacy `gltf` → `mesh`; id back-fill by position; the bump's justification (§8). Update the sketch. |
| §14.4 Import *(stage 2)* | Step 5 no longer loads GLBs as a gate: **mesh loading is asynchronous and non-blocking**, and a missing/unparseable mesh reports on its row instead of aborting (§9) — with the compensating **Run block** (§5.4), which is what keeps a broken scene from producing a number. Step 6 releases the **parse cache** alongside the decode cache. |
| §14.5 Export / Save As… *(stage 3)* | `planAssetCopy` copies the **dependency closure** (§8); a missing dependency aborts a cross-folder save, naming the file. |
| §14.6 Geometry rendering & collision | `mesh` objects of all four formats render with their own materials (PLY without materials takes the default import material, using vertex colours when present; OBJ takes its `.mtl` when resolvable), all forced double-sided; **normals are computed when absent**; the collision statement stays exact because §4.5 refuses zero-triangle assets; add the **lazy rebuild** (§4.3) and the sibling-resolution rule (§3.4); restate the layer-toggle-vs-checkbox split (§5.2). |
| §14.7 UI controls *(stage 2)* | Add the **Add Geometry** dialog (§3.2) to the modal list, with its recursive listing and its keyboard rules. |
| §14.8 Error handling | Add the §9 rows; amend the "Referenced GLB missing or fails to parse" row, which no longer aborts. |
| §14.9 Out of scope | **Delete** the in-app geometry-authoring bullet outright and replace it with what remains out of scope: creating **primitives** in-app, editing their intrinsic parameters, and writing into `assets/` (still nothing is ever copied or transcoded in-app). Keep "additional primitive kinds". |
| §17 Terminology | Add **geometry object**, **mesh**, **mesh asset**, **dependency closure** (§10); amend the splat entries' contrasts where they say "unlike geometry, which is not editable". |

Also required outside `spec.md` (per the repo's `ai/` docs rule):

| Doc | Edit |
|---|---|
| `ai/DESIGN.md` | The product shift this makes: the app no longer takes its geometry as given — a site model is brought in, placed and switched off from inside the app, and the coverage question becomes "against which version of the site?" |
| `ai/ARCHITECTURE.md` | The geometry load path (dialog → reducer → loader → parse cache → render group), the **two builds on two schedules** (§4.1), and the pure/impure split of the new modules. |
| `ai/DECISIONS.md` | New entries, newest at top: one `geometry` array over a second editable array; `mesh` as one kind with an extension-keyed loader table; **`formatVersion` 4** and why this bump is not additive; the checkbox meaning membership rather than visibility; **lazy collision rebuild at Run**; PLY routed by header sniff; sibling resolution through the folder handle; **dependency-closure copying** over a persisted dep list; recursive `assets/` listing with no depth cap (and the stall risk accepted with it); warn-never-block on triangles; row-only selection. |
| `ai/CONVENTIONS.md` | The pure-decision / impure-loader split as applied here (`meshAssets.ts`/`plyHeader.ts`/`assetDeps.ts` vs `meshLoader.ts`); the rule that a format sniff is a pure function over bytes already read. |
| `ai/STACK.md` *(stage 2)* | `PLYLoader`, `OBJLoader`, `MTLLoader` from `three/addons` — **no new dependency**; note the `LoadingManager.setURLModifier` mechanism. |
| `ai/VISUAL_DESIGN.md` | The Geometry group row, the mesh row badge states (including the amber threshold variant), the `GeometryPanel` layout with its size readout and preset buttons, and the Add Geometry dialog. |
| `ai/WORKFLOWS.md` *(stage 2)* | How to bring a real site model in: drop the bundle in `assets/`, Add Geometry, fix up-axis/units from the readout, Run. |

---

## 13. Implementation stages

One approved spec, three stages, each green before the next starts.

1. **Model & hierarchy.** `id`/`name`/`enabled` on `GeometryObject`; `formatVersion` 4
   with the legacy `gltf` → `mesh` mapping and id back-fill; the **Geometry** group,
   rows, selection, `GeometryPanel` (transform + read-only params), delete / duplicate
   / reorder / toggle; the stale rules; the lazy rebuild (§4.3); the empty-scene rule
   (§5.3); scale-capable `resolveMode`. **Existing `gltf` assets only** — no new
   formats, no dialog.
2. **Adding assets.** The **Add Geometry** dialog with its recursive listing, the
   `mesh` loader table (PLY, OBJ), the PLY header sniff, the zero-triangle refusal,
   streaming load states and row badges, the parse cache, and the Run block on a
   failed or loading object (§5.4).
3. **Multi-file assets & polish.** Sibling resolution (§3.4), the dependency-closure
   copy on Save As… (§8), the up-axis / unit presets and the size readout (§7), and
   the triangle guardrail with its stats-panel readout (§4.4).

---

## 14. Out of scope / future

- **Creating primitives in-app** — a `+ ▸ Box` / `+ ▸ Room` massing tool, and editing
  a primitive's intrinsic parameters (§7). A real feature, but a different one: it
  needs its own defaults, creation UX and panel controls, and nothing about importing
  assets depends on it.
- **Writing into `assets/`** — importing a file from outside the scene folder,
  copying, converting or transcoding (`spec.md` §14.9). The user drops the file in;
  the app references it. Save As… remains the one operation that copies asset bytes.
- **A file picker for arbitrary paths** — everything stays inside the scene folder, so
  every scene file in it resolves assets identically.
- **Parsing in a worker** (§4.2), and with it a progress bar for the parse itself
  rather than for the read.
- **Mesh decimation or LOD** — no simplification is offered for a model too heavy to
  run against; §4.4 warns and stops there.
- **Material or appearance editing** — colour, opacity, or per-object material
  overrides. Materials come from the asset, minus the forced double-sidedness
  `spec.md` §14.6 already imposes.
- **Per-object occlusion opt-out** — a mesh that draws but does not occlude. The
  checkbox is all-or-nothing by design (§5.1); a visual-only object is what a splat
  capture is for.
- **Viewport picking and gizmo handles on geometry** (§6.6).
- **Undo** — the app has none (`spec.md` §5.5.1); a mis-drag is recovered by dragging
  back, and a mis-delete by re-adding. Geometry raises the stakes on this, and it is
  the obvious next thing to want.
- **Instancing** — twenty rows on one rack share a parse and a `BufferGeometry` (§3.5)
  but still draw as twenty meshes and merge as twenty copies of the triangles.
- **Deriving geometry from a splat capture** (`gaussian_splats.md` §13) — still the
  large open question, and still a different one.
