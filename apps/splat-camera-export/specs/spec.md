# splat-camera-export — spec

Source of truth for the behavior of `apps/splat-camera-export`
(`@linkervision/splat-camera-export`). Read this before changing app code; change
this (with approval) before changing behavior. See the repo-root `CLAUDE.md` for
the monorepo workflow rules.

## 1. Purpose

A browser app that loads a **3D Gaussian Splat** capture of a real site, imports the
**camera layout** designed in the coverage tool (`apps/sample-app`'s `scene.json`,
sample-app spec §14.3), registers the two into a common frame, and **exports one
rendered image per camera** — what each planned camera would actually see in the real
space.

This closes the loop on coverage planning: `sample-app` answers *how much of the volume
is covered*; this app answers *what does the operator's monitor actually show*.

**Non-goals** (§15) — no coverage computation, no camera editing, no splat authoring or
training. It is a **read-and-render** tool: cameras in, images out.

## 2. Stack & layout

| Tech | Version | Role |
|---|---|---|
| **React** | ^19.1 | UI shell — panels, camera list, export progress. Plain React + hooks, no component library. |
| **`@playcanvas/react`** | ^0.11 | Declarative React renderer for the PlayCanvas engine — the viewport. |
| **`playcanvas`** | ^2.21 | Engine. Provides the `gsplat` asset type, `GSplatComponent`, and the render-target readback used by export (§8). |
| **`fflate`** | ^0.8 | Zips the exported PNGs (§9.3). |
| **Vite** | ^6 | Dev server + bundler. |
| **TypeScript** | ^5.5 | `strict`, `verbatimModuleSyntax`, Bundler resolution — same settings as `sample-app`. |

`@linkervision/camera-coverage-sdk` is a dependency for **types only** (`Vec3`, `Quat`),
imported with `import type` so no engine code enters the bundle. The coverage engine is
not used.

```
apps/splat-camera-export/
  index.html
  vite.config.ts
  tsconfig.json
  specs/spec.md            # this file
  ai/                      # DESIGN, ARCHITECTURE, CONVENTIONS, DECISIONS, WORKFLOWS, STACK, VISUAL_DESIGN
  src/
    main.tsx
    App.tsx
    index.css
    cameras/
      sceneCameras.ts      # §5  pure scene.json → PreviewCamera[]
      label.ts             # §5.4 display names
    align/
      alignment.ts         # §7  pure alignment transform model
    render/
      imageSize.ts         # §9.1 pure resolution policy
      pixels.ts            # §8.4 pure row-flip / RGBA → RGB
      exportRig.ts         # §8  impure: render target, settle protocol, readback
      png.ts               # §8.5 impure: OffscreenCanvas PNG encode
    export/
      filenames.ts         # §9.2 pure naming + collision resolution
      manifest.ts          # §9.4 pure cameras.json manifest
      zip.ts               # §9.3 impure: fflate packaging + download
    viewport/
      Viewport.tsx         # §6  Application + GSplat + view modes
      CameraMarkers.tsx    # §6.3 camera gizmos in orbit view
      splatAsset.ts        # §4  impure: File → gsplat Asset
    ui/                    # §10 panels
  test/                    # mirrors the pure modules
```

`src/` layers mirror `sample-app`'s convention: **pure logic modules are separated from
the impure PlayCanvas/DOM sinks**, and every source file opens with a doc comment citing
its spec section. Only the pure modules are unit-tested (§12).

## 3. Frames, units, conventions

- **Scene frame** — the frame `scene.json` is authored in: right-handed, **Y-up**, meters
  (sample-app spec §14.3). Cameras look down **−Z** with **+Y** up, matching glTF, Three.js,
  and PlayCanvas alike, so a camera quaternion transfers **verbatim** — no basis change.
- **Splat frame** — whatever frame the capture was reconstructed in. Arbitrary origin,
  arbitrary orientation, **arbitrary scale**. It is *not* assumed to match the scene frame;
  reconciling the two is the alignment step (§7) and is the app's central correctness
  concern.
- **Rotations** are quaternions `[x, y, z, w]` wherever they cross a file boundary. Euler
  angles appear **only** in the alignment UI (§7.2), where degrees are what a human can
  actually dial in.
- **FOV** — `scene.json` `fov` is **vertical** degrees (sample-app spec §5.1, SDK
  `CameraConfig.fov`). PlayCanvas `CameraComponent.fov` is also vertical when
  `horizontalFov` is `false` (the default), so it maps **1:1**; the app sets
  `horizontalFov = false` explicitly rather than relying on the default.

## 4. Loading the splat

- The splat is chosen with a **local file picker** (`<input type="file">`); no server, no
  URL field. Accepted extensions: **`.ply`**, **`.sog`**, **`.compressed.ply`**, and
  **`.meta.json`** (SOG bundle) — the formats the engine's `gsplat` asset type handles.
- The picked `File` becomes a **blob URL** loaded as a `gsplat` **Asset**. Because a blob
  URL carries no filename, the asset is created with the **original filename supplied
  separately** so the engine selects the right parser from the extension rather than
  guessing from the URL.
- A **`.meta.json` SOG bundle references sibling files** (`.webp` payloads) by relative
  path, which a single-file blob URL cannot resolve. For that format the picker accepts a
  **multi-file selection** (or a directory), and the sibling files are registered as blob
  URLs under their relative names so the bundle's references resolve. If the required
  siblings are missing, loading fails with a message naming them (§11).
- **One splat at a time.** Loading a second replaces the first and releases the previous
  asset and blob URLs.
- Load state is surfaced as **idle → loading (with progress %) → ready | error**. Splat
  files are large; progress comes from the asset loader's progress events.

## 5. Importing cameras

### 5.1 Reader scope — cameras only

Camera import reads the **same `scene.json`** the coverage app writes (sample-app spec
§14.3), but is a **deliberately narrow, tolerant reader**: it consumes `formatVersion` and
`cameras[]` and **ignores every other key** — `geometry`, `probes`, `sections`, `zones`,
`volumes`, `clipSectionId`, `useZones` — including keys added by future format versions.

- **Version policy.** `formatVersion` must be a positive integer and is otherwise
  **not gated**: versions 1 and 2 both carry the camera shape this app needs, and a future
  version that only adds non-camera keys must keep working. An unreadable or absent
  `formatVersion` is an error; an unknown *future* version loads with a **non-blocking
  notice** (§11) rather than a refusal.
- **No shared module with `sample-app`.** The reader is a **fresh ~80-line module** in this
  app, not an import from `apps/sample-app/src` (cross-app source imports are forbidden —
  each app owns its `src/`) and not an extraction into the SDK (the SDK is a headless
  coverage engine and has no business knowing the app's file format). The cost is a small,
  intentional duplication of the camera-parsing rules; the benefit is that this app's
  reader can be tolerant where the authoring app must be strict. `ai/DECISIONS.md` records
  this.

### 5.2 Camera shape

Each entry of `cameras[]` yields a `PreviewCamera`:

| Field | Source | Rule |
|---|---|---|
| `id` | `id` | Non-empty string. **Required.** |
| `name` | `name` | Optional; trimmed. Blank/absent → `''`, displayed via the fallback (§5.4). |
| `position` | `position` | 3 finite numbers. **Required.** |
| `rotation` | `rotation` | 4 finite numbers, quaternion `[x,y,z,w]`. **Required.** Normalized on read; a zero-length quaternion is an error. |
| `fov` | `fov` | Finite, in **(0, 180)** exclusive. **Required.** |
| `aspect` | `aspect` | Finite, **> 0**. Optional — defaults to **16/9** when absent. |
| `near` | `near` | Finite, **> 0**. Optional — defaults to **0.1**. |
| `far` | `far` | Finite, **> `near`**. Optional — defaults to **1000** (the export renders the whole splat; the coverage `far` is a *coverage* range, not a visibility range — see below). |
| `enabled` | `enabled` | Optional boolean, **defaults `true`** (matches the omit-on-write rule, sample-app spec §14.3). |

**`far` is deliberately not inherited.** In `scene.json`, `far` bounds the volume a camera
is credited with *covering* (often ~30 m); using it as the render clip plane would slice
the visible splat at that distance and produce misleading images. So the render uses a
**far override** — default **1000 m**, editable (§10.3) — while the *imported* `far` is
retained in the manifest (§9.4) and shown in the camera list for reference. A per-run
toggle **"clip at camera `far`"** restores the literal `scene.json` value for users who
want exactly the coverage frustum.

### 5.3 Import semantics

- Import **fully replaces** the current camera list; it never merges.
- **Order is file order** — the list is not re-sorted, so exported filenames (§9.2) follow
  the order the coverage app wrote.
- Disabled cameras (`enabled: false`) are **imported and listed** (dimmed), because
  "disabled for coverage" does not mean "uninteresting to preview". Whether they export is
  a run setting, default **off** (§10.3).
- An entry that fails validation **fails the whole import** with a message naming the index
  and field (§11) — a partial camera set would silently under-export.
- Import requires no splat: cameras can be loaded first, and vice versa. Export requires
  both (§9).

### 5.4 Display names

A camera's label is its trimmed `name`, or — when blank — the default derived from its id:
`cam-N` → **`Camera N`**, and any other id form falls back to the raw id. This mirrors
sample-app spec §5.6 so labels match between the two apps.

## 6. Viewport

A single PlayCanvas `Application` fills the main area, WebGL2 by default with WebGPU
preferred when available (`deviceTypes={[DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2]}`). The
splat renders as a `GSplat` component on an entity carrying the **alignment transform**
(§7).

### 6.1 View modes

- **Orbit** (default) — a free-look camera with orbit controls, used to inspect the splat
  and judge alignment. Imported cameras draw as markers (§6.3).
- **Through camera *N*** — the viewport renders from the **selected** imported camera,
  using its exact position, rotation, and vertical FOV, with the viewport's own aspect.
  This is the **alignment and framing check**: what you see here is what export writes,
  modulo resolution and aspect.

Switching modes never mutates camera data. In *Through camera* mode the orbit controls are
detached, and the selected camera's own marker is hidden (it would be degenerate at the
eye point).

**Exactly one viewport camera is enabled at a time.** Two enabled cameras both render to
the backbuffer and the later-created one wins, which presents as the viewport *freezing* —
the scene camera's static view is displayed while orbit input moves a camera that is no
longer being shown. Enablement is therefore driven **imperatively** on the entity, not via
the declarative `enabled` prop, which the React layer accepts in its type but never
applies (§2).

### 6.2 Aspect preview

*Through camera* mode optionally **letterboxes** the viewport to the selected camera's
`aspect`, so the on-screen framing matches the exported image instead of the window shape.
Default **on**; toggling it does not change any exported pixel.

### 6.3 Camera markers

In Orbit mode each imported camera draws as a small **body** plus a **frustum wireframe**
sized from its `fov`/`aspect` and a fixed display depth (not `far` — that would be
unreadably large at 1000 m). The **selected** camera's marker is highlighted; **disabled**
cameras are dimmed. Clicking a marker selects that camera. A toggle hides the whole marker
layer.

Markers are drawn with the engine's **immediate-mode line API**, which emits for *every*
active camera — including the offscreen export rig. They are therefore **suppressed for
the duration of an export run** (§9.5); otherwise each exported image is contaminated with
the other cameras' frustum wireframes. Disabling the viewport camera (§8.1) is **not**
sufficient on its own, because immediate lines are not tied to it.

## 7. Alignment — registering the splat to the scene frame

**The central correctness problem.** A capture reconstructed by COLMAP/3DGS training sits
in an arbitrary frame at arbitrary scale; the imported cameras sit in the room's metric
Y-up frame. Without registration the two have no spatial relationship and every exported
image is meaningless. The app therefore treats alignment as a first-class, explicit,
inspectable transform rather than an assumption.

### 7.1 Model

A single **similarity transform** applied to the splat entity:
`{ position: Vec3 (m), rotation: Quat, scale: number (uniform) }`.

**Uniform scale only** — a non-uniform scale would shear the Gaussians and is never the
right answer for registering a reconstruction. Identity is
`{ position: [0,0,0], rotation: [0,0,0,1], scale: 1 }`.

The transform moves the **splat into the scene frame** (not the cameras into the splat
frame), so imported camera values stay exactly as authored and the manifest (§9.4) reports
scene-frame poses.

### 7.2 Controls

- **Position** (3 fields, meters), **rotation** (3 fields, **Euler degrees**, converted to
  the stored quaternion), **uniform scale** (1 field, > 0). Numeric text entry with the
  same parse → clamp → revert-on-invalid discipline as `sample-app` (its spec §5.2): an
  unparseable or out-of-range entry reverts rather than committing garbage.
- **`Flip 180° Z`** preset — one click, `rotation = [0, 0, 1, 0]`. 3DGS captures load
  Y-down relative to a Y-up viewer, so this is the standard correction; it is also the
  **default** for a fresh capture (§7.3), which means the button reads as **pressed** on
  load and acts as a visible indicator of the applied convention. Applied as a
  *replacement* of the rotation, not a composition, so pressing it twice is idempotent.
- **`Reset`** — back to identity. This is how a capture that was already upright is
  corrected, and it persists (§7.4).
- **`Frame splat`** — moves the orbit camera to fit the splat's bounds. A view convenience;
  it does **not** modify the alignment.

### 7.3 Default orientation

A capture with **no saved alignment** (§7.4) starts with a **180° Z rotation** applied —
`rotation = [0, 0, 1, 0]`, the same value as the `Flip 180° Z` preset (§7.2), which
therefore reads as pressed on load. **Rotation only**: position stays `[0,0,0]` and scale
`1`.

3DGS captures load **Y-down** relative to a Y-up viewer, so identity left nearly every
real capture upside-down. A 180° Z rotation negates **X and Y**, un-flipping the scene.

**Why Z and not X.** A 180° rotation about X also un-flips Y and is the textbook
COLMAP→glTF basis change (it negates Y and Z). Both are proper rotations and both fix
"upside-down", but they differ by a **180° yaw**, so they leave the scene facing opposite
ways. Z is what the PlayCanvas gsplat pipeline expects and is this app's convention.

Because this means the app **transforms the user's data before being asked**, the
correction is never silent: it raises a **dismissible notice** (§11) naming the rotation
and pointing at **Reset**. It is a stated convention about the format, not a measurement
of the file's contents, and the UI says so.

**A saved or imported alignment always wins** — the default applies only when there is
nothing to restore.

### 7.4 Persistence

The alignment is **persisted to `localStorage`, keyed by a version prefix plus the splat
filename and byte size**, so returning to the same capture restores its registration
instead of re-dialing it. It is also **exportable/importable as `alignment.json`**
(`{ position, rotation, scale }`) for sharing a registration between users, and is
**recorded in the export manifest** (§9.4) so any exported batch is reproducible.

**Only user-initiated changes are persisted.** The auto-applied default (§7.3) is *not*
written to storage. This distinction is load-bearing, not hygiene: persisting the default
makes it indistinguishable from a deliberate choice on the next load, which freezes every
already-opened capture at whatever default was in force the first time and renders any
later change to the default **inert**. So:

- A capture the user has **never adjusted** always follows the *current* default, however
  that default later changes.
- A capture the user **has** adjusted — including pressing **Reset**, which is how an
  already-upright capture opts out — restores that choice and is never re-defaulted.

The key carries a **version prefix** so entries written under superseded persistence rules
can be orphaned wholesale. Entries from a build that persisted defaults cannot be
distinguished from real choices, so they are abandoned rather than trusted.

## 8. Rendering a camera offscreen

The export path renders **off-screen at the target resolution**, independent of the
viewport's size and device pixel ratio, so output is reproducible across machines.

### 8.1 The rig

A dedicated **export camera entity** (created imperatively, outside the React tree — its
transform is set from quaternions directly via `setPosition`/`setRotation`, avoiding the
Euler round-trip the declarative `Entity` `rotation` prop would impose) with:

- `fov` = the camera's vertical FOV, `horizontalFov = false`
- `aspectRatioMode` = **manual**, `aspectRatio` = the target `width / height`
- `nearClip` = the camera's `near`; `farClip` = the far override (§5.2)
- `renderTarget` = a `RenderTarget` over an **RGBA8 color `Texture`** at the target size,
  with a **depth buffer**, no mipmaps, and **no anti-aliasing beyond the configured
  sample count** (§9.1)
- `clearColor` = the configured background (§10.3)

The rig camera is **excluded from the on-screen view** and the on-screen camera is
excluded from the render target; only one of them renders per frame during export.

### 8.2 The settle protocol — why a naive readback is wrong

PlayCanvas sorts Gaussians **per camera, in a Web Worker**: moving the camera posts a sort
request, the worker replies asynchronously (firing **`gsplat:sorted`** on the scene), and
the new ordering is **uploaded to the GPU on the following frame**. Reading pixels
immediately after moving the camera therefore captures the **previous camera's splat
order** — visibly wrong compositing, and wrong in a way that looks plausible enough to ship
unnoticed.

For **each** camera the export loop therefore:

1. Sets the rig transform and projection.
2. Waits for **`gsplat:sorted`** on the scene, with a **250 ms timeout**. The timeout is
   required, not defensive: the engine skips re-sorting when the camera barely moved, so
   for two nearly-coincident cameras the event legitimately never fires.
3. Waits **`settleFrames`** further completed frames (default **2**, configurable §10.3) so
   the applied ordering is uploaded and drawn.
4. Reads back (§8.3).

Frames are counted from the application's own frame-end event — the normal update+render
loop must run, since the order upload happens during update, not during a bare render call.

### 8.3 Readback

Pixels come from the color texture via the engine's public
`Texture.read(0, 0, width, height)`, which resolves to a `Uint8Array` of RGBA bytes. It is
`await`ed per camera; export is inherently a sequence of GPU round-trips and is not
pipelined (the shared render target and the per-camera sort make concurrency unprofitable
here).

**`immediate: true` is required.** Without it the WebGPU implementation records
`copyTextureToBuffer` into the command encoder and then maps the staging buffer from a
`setTimeout(0)` **without ensuring the copy was submitted** — the map races the copy and
resolves against unwritten memory, returning zeros. `immediate` submits the encoder before
mapping. On WebGL2 the flag only adds a `gl.flush()`, so it is safe to pass unconditionally.
This is a **backend-specific silent failure**: the WebGL2 path is unaffected and gives no
warning that the WebGPU path is broken.

**The `renderTarget` option is deliberately not passed** (see also §8.5). Supplying it binds *this*
target's framebuffer, which for `samples > 1` is the **multisampled** one — and
`glReadPixels` on a multisampled framebuffer is `GL_INVALID_OPERATION`. The failure is
silent at the API level: it yields an all-zero buffer, so the run completes and writes a
zip full of **pure black images at the correct sizes and filenames**. Omitting the option
makes the engine wrap the already-resolved colour texture in a temporary single-sample
target, which reads correctly at any sample count.

### 8.4 Pixel post-processing (pure, tested)

- **Vertical flip — backend-dependent.** PNG rows are **top-down**, but readback row order
  is not the same on both backends:
  - **WebGL2** — `readPixels` originates at the **lower-left**, so rows arrive bottom-up
    and **must be reversed**.
  - **WebGPU** — `copyTextureToBuffer` starts at the texture's **top-left**, so rows are
    **already** in PNG order and must **not** be touched.

  Flipping unconditionally therefore produces correct WebGL2 exports and **vertically
  mirrored WebGPU** ones. The row order is passed in as an explicit `flipRows` argument
  rather than assumed, and both modes are tested (including that they are exact mirrors of
  each other), because the mistake is invisible to a symmetric test image and to the
  automated suite, which only ever runs WebGL2 (§12).
- **Alpha.** The background clear color is **opaque**, so alpha is expected to be 255
  everywhere. Alpha is nonetheless **forced to 255** on write, so a splat's stochastic
  alpha can never leave semi-transparent holes in a deliverable image. A run setting
  **"transparent background"** instead clears with alpha 0 and preserves the rendered
  alpha, for compositing use.

### 8.5 Blank-readback guard

Readback is the one step whose failure produces **output rather than an error** — a
complete zip of correctly-named, correctly-sized, entirely black images. Both the WebGL2
and WebGPU paths have failed this way in practice (§8.3), and the two backends have
independent render-target readback implementations, so working on one is no evidence about
the other.

Every readback is therefore checked before encoding: if **every byte is zero**, the run
**aborts** (§9.5) with an error naming the active backend and suggesting the other one.
Against an **opaque** clear colour this test has no false positives — a camera pointed at
empty space still returns the clear colour with alpha 255, so an all-zero buffer cannot be
a legitimate render.

With a **transparent background** the condition is not decidable (alpha 0 is expected, and
a genuinely empty frame *is* all-zero), so the check is **skipped** rather than risk
failing a valid export.

This is a guard, not a substitute for the fix: it converts a silent wrong deliverable into
a loud, actionable failure.

### 8.6 Encoding

The RGBA buffer is written into an `OffscreenCanvas` of the target size via `ImageData`
and encoded with `convertToBlob({ type })`. **PNG** (default, lossless) and **JPEG** (with
a quality setting) are supported; JPEG is the pragmatic choice for large batches, where PNG
renders of photographic splat content are several MB each.

## 9. Export

Export requires **a loaded splat and at least one camera in the run set**; the button is
disabled with an explanatory hint otherwise.

### 9.1 Resolution policy (pure, tested)

Per camera, from the run settings:

- **Derive from camera** (default) — height = the configured **base height** (default
  **1080**); width = `round(height × camera.aspect)`. Each camera keeps its authored
  aspect, so a 4:3 camera exports 4:3 and a 16:9 camera exports 16:9.
- **Fixed size** — an explicit width × height applied to every camera, overriding aspect.
  The rig's `aspectRatio` still matches the *output* size, so the image is correctly
  proportioned rather than stretched; a camera whose authored aspect differs simply sees a
  different amount of the scene, and the UI says so.

Both paths then: round to **even** dimensions (JPEG chroma subsampling, and it keeps sizes
tidy), clamp each axis to **≥ 16** and to the device's **maximum texture size**, and — when
clamping changed the result — report the effective size in the UI rather than silently
exporting something other than what was asked for.

A **multi-sample count** (default 4, or 1 to disable) applies to the render target for
edge quality.

### 9.2 Filenames (pure, tested)

`label.ext` — **the camera's name**, and nothing else. A file is named for the camera that
shot it (`Entrance.png`), so an image is identifiable on its own, out of the zip, without
consulting the manifest.

The name is the camera's display label (§5.4) — its `name`, or `Camera N` when blank —
**sanitized**: trimmed, path separators and characters illegal on Windows
(`< > : " / \ | ? *`) plus control characters replaced with `-`, runs of separators
collapsed, leading/trailing dots and separators removed, and reserved device names (`CON`,
`PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) prefixed with `_`. An empty result falls
back to the camera `id`, and then to `camera`.

**Uniqueness is enforced, and now load-bearing.** Camera names are free text and nothing
stops two cameras sharing one, so a duplicate gains a `-2`, `-3`, … suffix before the
extension, in file order (`Entrance.png`, `Entrance-2.png`). Comparison is
**case-insensitive**, since the target filesystem may be — `Entrance` and `ENTRANCE`
collide.

**Order is not encoded in the filename.** A plain name cannot also carry the camera's
position in the scene file, so a directory listing sorts alphabetically rather than by
scene order. `cameras.json` (§9.4) preserves the authored order, and is the reference for
it.

### 9.3 Packaging

All images go into **one zip**, downloaded via an object URL. `fflate` zips with
**store (level 0)** — PNG and JPEG are already compressed, so deflating them again costs
time and saves nothing.

The whole batch is held in memory before download; at 1080p that is a few MB per image, so
a large batch is large. The UI shows an **accumulated-size readout** as the run proceeds,
and warns past **512 MB** rather than failing opaquely.

### 9.4 Manifest

The zip contains **`cameras.json`** alongside the images, recording enough to reproduce or
post-process the batch:

```json
{
  "generator": "@linkervision/splat-camera-export",
  "sourceScene": "scene.json",
  "splat": { "filename": "site.ply", "byteSize": 184320000 },
  "alignment": { "position": [0,0,0], "rotation": [0,0,0,1], "scale": 1 },
  "render": {
    "format": "png", "samples": 4, "settleFrames": 2,
    "background": [0.1, 0.1, 0.12, 1], "farOverride": 1000
  },
  "cameras": [
    { "file": "Entrance.png", "id": "cam-1", "name": "Entrance",
      "position": [2, 2.5, -3], "rotation": [0, 0.38, 0, 0.92],
      "fov": 60, "aspect": 1.7778, "near": 0.1,
      "far": 30, "farRendered": 1000,
      "width": 1920, "height": 1080, "enabled": true }
  ]
}
```

Poses are in the **scene frame** (§7.1), verbatim from the import. `far` is the imported
value and `farRendered` what was actually used (§5.2). The manifest is built by a **pure
function** from the run inputs, so it is unit-tested against drift from the actual run
settings.

### 9.5 Progress & cancellation

Export is a visible, interruptible run: a **determinate progress bar** (`k / n`), the
current camera's label, accumulated size, and a **Cancel** button. Cancelling stops before
the next camera and downloads **nothing** — a partial zip presented as a deliverable is
worse than no zip. A camera that fails to render aborts the run with its label in the
message (§11).

The UI stays responsive because each camera's step already awaits real frames and a GPU
readback.

## 10. UI

Two-column: a **left panel** (controls) and the **viewport** (§6), matching the
`sample-app` visual language — dark surface, the same panel/hint/field type scale and
spacing, semantic roles and keyboard operability throughout. `ai/VISUAL_DESIGN.md` holds
the specifics.

### 10.1 Source panel

The splat picker with load state and progress (§4), and the `scene.json` picker with the
imported camera count (§5). Each shows its filename once loaded.

### 10.2 Camera list

One selectable row per imported camera, in file order: label, a compact readout of
`fov` and `aspect`, and a **per-camera include-in-run checkbox**. Disabled cameras are
dimmed and unchecked by default (§5.3). The selected row drives *Through camera* mode
(§6.1). Header controls: **select all / none**, and the resulting **run count**.

### 10.3 Render settings

Resolution mode with base height or fixed width × height (§9.1); **format** (PNG/JPEG +
quality); **samples**; **background color** and **transparent background** (§8.4);
**far override** and **clip at camera `far`** (§5.2); **settle frames** (§8.2); and
**include disabled cameras**. Every setting is inert until the next run — changing one
mid-run does not affect the run in flight.

### 10.4 Alignment panel

The §7.2 controls, plus alignment import/export and the persistence indicator.

### 10.5 Export bar

The export button, the effective per-camera resolution for the current selection, the
estimated batch size, and — during a run — the §9.5 progress UI.

## 11. Errors

Every failure surfaces as an **inline, dismissible message** naming the specific cause; no
silent failures and no `alert()`. Specifically:

| Case | Message |
|---|---|
| Unsupported splat extension | names the extension and the accepted set (§4) |
| Splat parse/load failure | the loader's error, with the filename |
| SOG bundle missing siblings | names the missing files (§4) |
| `scene.json` not valid JSON | the parser error with position |
| Missing/invalid `formatVersion` | states what was found |
| Future `formatVersion` | **non-blocking notice**, import proceeds (§5.1) |
| Default rotation applied on load | **notice** naming the rotation and pointing at Reset (§7.3) |
| `cameras` absent or not an array | states what was found |
| Invalid camera entry | `cameras[3]: rotation must be 4 finite numbers` (§5.3) |
| Zero cameras in file | notice — import succeeds with an empty list |
| WebGL2/WebGPU unavailable | blocking message; the app cannot run |
| Requested size exceeds device limits | notice with the clamped size (§9.1) |
| Render/readback failure mid-run | aborts the run, names the camera (§9.5) |
| Readback returned no data (all-zero) | aborts the run, names the **active backend** and suggests the other (§8.5) |

## 12. Testing

`npm test` runs `node --test` with native TypeScript type-stripping — the same harness as
`sample-app`, with tests mirroring the pure modules one file each:

- **`sceneCameras`** — every field rule and default in §5.2; the ignore-unknown-keys and
  version-tolerance rules (§5.1); each §11 validation message; `enabled` defaulting;
  quaternion normalization and the zero-quaternion rejection.
- **`imageSize`** — derive-from-camera vs fixed (§9.1); even rounding; the `≥ 16` and
  max-texture-size clamps; non-16:9 aspects.
- **`filenames`** — index padding across batch sizes; each sanitization rule; reserved
  names; the empty-label and duplicate-label fallbacks; case-insensitive uniqueness (§9.2).
- **`pixels`** — also the blank-readback guard (§8.5): all-zero detected, a
  clear-colour-only frame **not** flagged (the no-false-positive property that makes the
  guard safe), a single non-zero byte anywhere disproving it, and the transparent-background
  skip. Plus the vertical flip against a known asymmetric buffer (§8.4); alpha forcing;
  the transparent-background path.
- **`manifest`** — the §9.4 shape, including `far` vs `farRendered` and the alignment
  round-trip.
- **`alignment`** — Euler↔quaternion round-trip, the `Flip 180° Z` preset (including that
  it negates X and Y but **not** Z, verified through the engine's own vector transform
  rather than hand-rolled algebra), identity/reset, the **default orientation** (§7.3) and
  its rotation-only scope, and the `alignment.json` parse rules including scale `> 0`.
- **`label`** — the `cam-N` → `Camera N` fallback chain (§5.4).

The PlayCanvas-dependent modules (`exportRig`, `png`, `zip`, `splatAsset`, components) need
a GPU and a browser and are **not** unit-tested; the pure modules above exist precisely so
that the logic worth testing sits outside them. The settle protocol (§8.2) is verified
manually against a real capture — the documented check is that two adjacent cameras export
without splat-order artifacts.

## 13. Commands

```bash
npm run dev         # vite dev server
npm run build       # tsc -b && vite build
npm run typecheck
npm test
```

## 14. Out of scope

Camera editing (that is `sample-app`); coverage computation; automatic splat↔scene
registration (alignment is manual, §7); video/turntable output; depth, normal, or
segmentation passes; multiple splats in one scene; server-side or headless rendering;
`transforms.json`/COLMAP camera import (§5 reads `scene.json` only — a future addition,
deliberately not built speculatively).
