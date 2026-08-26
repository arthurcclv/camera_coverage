# DECISIONS.md — splat-camera-export

Technical decisions and their rationale, **newest at top**. A reversal appends a new
entry rather than editing an old one.

---

## The readback row flip is backend-conditional

**Decision.** `prepareForEncode` takes an explicit `flipRows` argument. The export rig
passes `!device.isWebGPU`.

**Why.** PNG rows are top-down, but the two backends disagree on readback row order:
WebGL2's `readPixels` originates at the **lower-left** (bottom-up, needs reversing), while
WebGPU's `copyTextureToBuffer` starts at the texture's **top-left** (already in PNG order).
The engine does no normalisation — `flipY: false` throughout the WebGPU texture path.

Flipping unconditionally, as the first implementation did, gives correct WebGL2 exports and
**vertically mirrored WebGPU** ones. It surfaced immediately after the `immediate: true`
fix made WebGPU exports non-black for the first time — the mirroring had presumably been
there all along, masked by the images being entirely black.

**Why `flipRows` is a parameter rather than read from the device.** Keeping the row-order
decision at the call site preserves `pixels.ts` as a dependency-free pure module and makes
both modes directly testable — including the assertion that they are exact mirrors of each
other, which no single-mode test can express. The automated suite only ever exercises
WebGL2, so the WebGPU branch's correctness rests entirely on these unit tests plus the
documented convention.

---

## Readback passes `immediate: true` — WebGPU otherwise races the copy

**Decision.** `Texture.read(..., { immediate: true })`.

**Why.** This was the WebGPU root cause left open by the entry below. The engine's
`readBuffer` branches on the flag:

```js
if (immediate) { this.submit(); read(); }        // copy is submitted, then mapped
else           { setTimeout(() => read()); }     // mapped without ensuring submission
```

Defaulting to `false` meant the recorded `copyTextureToBuffer` was never guaranteed to have
run before `mapAsync` resolved, so the staging buffer read back as zeros — every exported
image pure black. WebGL2 never hit it: that path reads the framebuffer through its own
fence, so `immediate` there is just a `gl.flush()`.

**Why it took a user report to find.** The bug is invisible to this repo's entire automated
suite, which cannot obtain a WebGPU adapter (see below). The failure was found by the §8.5
blank-readback guard firing in the user's browser and naming the backend — which is exactly
what that guard exists for, and the argument for keeping it even now that the cause is
known.

**Pattern worth noting:** both all-black bugs were *readback option* defaults, one per
backend, each silent, each producing a complete plausible deliverable. When an API offers
options governing synchronisation or attachment, the default is not necessarily the correct
choice for an out-of-frame read.

---

## A blank-readback guard, and a selectable graphics backend

**Decision.** Every readback is checked for being **entirely zero** before encoding; if it
is, the run aborts naming the active backend. A **Force WebGL2** option sits beside the
default WebGPU-preferred setting, and the active backend is displayed.

**Why.** Readback is the only step whose failure yields *output* instead of an error — a
complete zip of correctly-named, correctly-sized, entirely black images. It has now failed
that way twice, on both backends, for unrelated reasons. WebGL2 failed on multisampled
`glReadPixels`; the WebGPU path was reported black by a user after the WebGL2 fix.

The guard is exact against an opaque clear colour: a camera pointed at empty space still
returns the clear colour with **alpha 255**, so an all-zero buffer cannot be a legitimate
render. With a transparent background the condition isn't decidable, so the check is
skipped rather than risk failing a valid export.

**Why a backend switch rather than just fixing WebGPU.** This machine cannot run WebGPU
under Playwright — `navigator.gpu` is absent across every flag combination tried
(`--enable-unsafe-webgpu`, `--enable-features=Vulkan`, `--use-vulkan=swiftshader`,
`allow_unsafe_apis`). So **the entire automated end-to-end suite only ever exercises
WebGL2**, and no amount of local testing can validate a WebGPU fix. Given that, the honest
design is: make the failure loud, and give the user a verified-working path (WebGL2) plus a
way to tell us which backend broke.

Inspection ruled out the two obvious WebGPU culprits: `COPY_SRC` is unconditionally set on
every texture, and with `samples > 1` the colour buffer becomes the render pass's
`resolveTarget` (not a multisampled texture), so `copyTextureToBuffer` from it is valid.
The actual cause — a missing `immediate: true` — is recorded in the entry above; the guard
is what surfaced it.

**Standing caveat for this app:** WebGL2 passing is *no evidence* about WebGPU. The two
backends have independent render-target readback implementations.

---

## Camera enablement is imperative — the React `Entity`'s `enabled` prop is a no-op

**Decision.** `orbit-camera` / `through-camera` enablement is set on the entity in a layout
effect. The `enabled` prop is deliberately *not* passed.

**Why.** `@playcanvas/react`'s `Entity` accepts `enabled` in its **type** — it derives props
from `Partial<PublicProps<PcEntity>>`, and `enabled` is a public settable property — but its
implementation only applies `name`, `position`, `scale`, and `rotation`
(`applyEntityProperties`). The prop is silently ignored. It typechecks, reads as correct,
and does nothing.

The consequence was subtle: with both cameras enabled, both render to the backbuffer and
the later-created one wins. Loading a `scene.json` created the through-camera, which then
displayed its static view permanently — presenting as "**the orbit camera is frozen**",
when in fact orbit input was moving a camera that was no longer being rendered. Through
mode appeared to work only by the same accident (the through-camera also won there).

**Lesson worth generalising.** A prop that typechecks is not a prop that is applied. When a
React wrapper derives its prop types mechanically from an engine class, the type surface
can be strictly larger than the implemented surface. For anything load-bearing, verify it
lands — the only props confirmed applied by this `Entity` are `name`, `position`, `scale`,
`rotation`.

**Also worth noting:** exports were never affected, because `ExportRig.beginRun` disables
viewport cameras imperatively and so was already working around the broken prop.

---

## Only user-initiated alignment changes are persisted, and the key is versioned

**Decision.** `localStorage` is written only when the user has actually adjusted a
capture's alignment. The auto-applied default (§7.3) is never persisted. The key carries a
`v2` version prefix.

**Why.** The first implementation persisted on *every* alignment change, including the
default applied at load. That made the stored value indistinguishable from a deliberate
choice on the next load — so any capture opened once was frozen at whatever default was in
force at the time, and **later changes to the default became inert**. It surfaced exactly
that way: after switching the default to 180° Z, a previously-opened capture still loaded
upside-down, because the identity default persisted by an earlier build won.

The bug is subtle because the persistence logic looks obviously correct in isolation, and
its own test passed — the test verified that a saved alignment survives a reload, which is
true and desirable, without asking whether the saved value represented a *choice*.

**Consequences.**

- An untouched capture always follows the current default. Nothing is written for it.
- **Reset is a user action**, so an already-upright capture opts out permanently with one
  click — the mechanism that makes the default safe.
- v1 entries can't be told apart from real choices, so the version bump orphans them
  wholesale rather than trusting them. Old keys are left in place (harmless) rather than
  swept, to avoid prefix-matching deletes over someone's storage.

**General rule this implies:** never persist a default. Persist the delta from it, or a
flag saying the user chose. Otherwise the default is frozen the first time it is applied.

---

## Captures default to a 180° Z rotation

**Decision.** Every capture with no saved alignment starts at **180° about Z**
(`rotation = [0, 0, 1, 0]`), regardless of format. This is also the value of the
`Flip 180° Z` preset, so the button reads as pressed on load. Applying it raises a
dismissible notice; a saved or imported alignment always wins.

**Why a default at all.** 3DGS captures load Y-down relative to a Y-up viewer, so
identity left nearly every real capture upside-down and every user had to independently
discover the flip button.

**Why Z rather than X.** A 180° X rotation also un-flips Y and is the textbook
COLMAP→glTF basis change (COLMAP world space being Y-down/Z-forward, reaching Y-up means
negating Y and Z). Both are proper rotations and both fix "upside-down" — but they differ
by a **180° yaw**: X negates Y and Z, Z negates X and Y, so the two leave the scene facing
opposite ways. Z is what the PlayCanvas gsplat pipeline expects and is the app's
convention.

This distinction is easy to lose, so the test asserts the axis behaviour directly
(X→−X, Y→−Y, Z→Z) rather than just comparing quaternion components.

**Tension, acknowledged.** This is the app transforming the user's data before being
asked, which is exactly the class of behaviour [DESIGN.md](./DESIGN.md) argues against.
Three things keep it honest: the correction is **announced** in a notice naming the
rotation and pointing at Reset; it is a **starting point only**, immediately overwritten
by persistence, so an already-upright capture needs Reset exactly once; and it touches
**rotation only** — position and scale stay neutral.

**Alternatives considered.** (a) Per-format defaults — flip `.ply`, leave `.sog` alone on
the theory that SOG exporters pre-correct. Dropped in favour of one predictable rule.
(b) Infer orientation from the splat data (mass distribution along Y, dominant plane).
Rejected: fragile, and a wrong inference would be *unannounced* and far harder to reason
about than a stated convention.

---

## Camera markers are suppressed during an export run

**Decision.** `CameraMarkers` is unmounted for the duration of a run, not merely hidden
from the viewport camera.

**Why.** Markers are drawn with the engine's immediate-mode line API (`app.drawLine`),
which emits for **every active camera** — including the offscreen export rig. Disabling
the viewport camera (§8.1) does not suppress them, because immediate lines aren't tied
to it. Found in end-to-end testing: cam-2's frustum wireframe was baked into cam-1's
exported PNG.

**Alternative considered.** Put marker lines on a dedicated layer excluded from the
rig camera's `layers`. Correct, and more granular, but more machinery than the problem
warrants when the markers have no purpose during a headless batch anyway.

---

## Readback omits the `renderTarget` option

**Decision.** `Texture.read(0, 0, w, h)` — deliberately *without* `{ renderTarget }`.

**Why.** Passing it binds that target's framebuffer, which for `samples > 1` is the
**multisampled** one. `glReadPixels` on a multisampled framebuffer is
`GL_INVALID_OPERATION` — and it fails *silently* at the API level, resolving to an
all-zero buffer. The run completes and writes a zip of pure black images at the correct
sizes and filenames. Omitting the option makes the engine wrap the already-resolved
colour texture in a temporary single-sample target, which reads correctly at any sample
count.

Found in end-to-end testing with the default `samples: 4`. This is the single most
expensive-to-detect bug in the app; §8.3 documents it so nobody "helpfully" re-adds the
option.

---

## Euler↔quaternion conversion delegates to the engine's `Quat`

**Decision.** `align/alignment.ts` wraps `playcanvas`'s `Quat.setFromEulerAngles` /
`getEulerAngles` instead of implementing the formulae.

**Why.** These numbers are typed into a panel that drives an entity's rotation, so they
must match `setLocalEulerAngles` **exactly**. A hand-rolled pair is easy to get subtly
wrong: the first implementation here mixed an XYZ-composed quaternion with a ZYX
decomposition, which round-tripped 180° about X to 0° — exactly the kind of rotation the
flip preset depends on.

**Cost.** `alignment.ts` imports `playcanvas`. Verified that the engine imports cleanly
under `node --test` with no DOM, so the module stays unit-testable. The functions remain
pure (no side effects), just not dependency-free.

**Note on the test.** The round-trip preserves the *rotation*, not the digits: one axis
of an Euler triple is confined to ±90°, so Y=−135° legitimately respells as
(180, −45, 180). The test asserts digit equality inside the canonical range and rotation
equivalence (`|dot| = 1`) outside it.

---

## The `scene.json` reader is duplicated, not shared

**Decision.** A fresh ~150-line reader in `cameras/sceneCameras.ts`, rather than
importing `apps/sample-app/src/scene/sceneFile.ts` or extracting a shared package.

**Why.** Importing across app `src/` boundaries couples two independently-deployed apps
and is forbidden by the monorepo layout. Extracting into the SDK is worse: the SDK is a
headless coverage engine and has no business knowing the app's file format.

More importantly, the two readers want **different semantics**. The authoring app must
be strict — it round-trips the whole document, so an unknown key or version is a real
problem. This app needs to be *tolerant*: it consumes only `cameras[]`, and must keep
working when the coverage app grows a new entity type or bumps `formatVersion` for
reasons that don't concern cameras. Sharing one reader would force one of those two
policies onto the other.

**Cost.** The camera field rules exist in two places. Accepted, and bounded: only the
camera shape is duplicated, and it is pinned by tests on both sides.

---

## `far` is overridden for rendering by default

**Decision.** Render at a 1000 m far plane by default; the imported `far` is retained in
the manifest as `far` alongside the used value as `farRendered`, and a toggle restores
literal `scene.json` clipping.

**Why.** `scene.json`'s `far` is a *coverage* bound (the distance a camera is credited
with covering, often ~30 m), not a visibility bound. Using it as a clip plane slices the
visible splat and produces images that look like the site ends in a void — a confusing
artifact that reads as a splat problem rather than a settings one.

---

## Manual alignment, not automatic registration

**Decision.** Beyond the default orientation above, the splat→scene transform is dialled
in by hand, persisted per capture, and shareable as `alignment.json`.

**Why.** Automatic registration between a Gaussian splat and a parametric room model is
a real research problem (scale ambiguity, no correspondences, no shared features). A
half-working auto-align would be worse than none: it would silently produce a plausible
but wrong transform, which is exactly the failure class this app is built to avoid.
Manual alignment is honest about what the user must verify, and the `Through camera`
view makes verifying it cheap.

---

## Zip with store (level 0)

**Decision.** `fflate` with `level: 0`.

**Why.** PNG and JPEG are already compressed; deflating them again costs time
proportional to the batch and saves essentially nothing.

---

## `OrbitControls` is retained despite its deprecation notice

**Decision.** Keep `@playcanvas/react`'s `OrbitControls`, which logs a deprecation
notice pointing at the engine's `CameraControls` script.

**Why.** `CameraControls` lives under `playcanvas/scripts/*`, which ships **no type
declarations**, so adopting it means an untyped import plus a hand-written ambient
declaration. That is real, permanent friction traded for silencing one console line in a
control that works. Revisit when the engine ships types for that subpath, or when
`@playcanvas/react` removes the component.
