# Viewport Navigation

Technical design of the sample app's **Perspective-view camera navigation** — how
the wheel, the middle button, and the left/right drags move the viewport camera.

Scope is the **Perspective** view only. The three **orthographic** views
(Top/Front/Right) and the **Selected** view keep the navigation
[`spec.md`](./spec.md) §2.4 and §2.4.1 already give them; §7 states exactly what
this document does *not* change.

App-wide terms are defined in [`spec.md`](./spec.md) §17 (Terminology).

---

## 1. Purpose & the two defects it replaces

The Perspective view previously navigated with a stock `OrbitControls`: a fixed
world-space **pivot**, with the wheel dollying the camera along the vector to that
pivot and the pan rate scaled by the distance to it. Both of that model's
user-visible failures come from the same root — every distance is measured against
a pivot the camera is converging on:

- **Zoom stalls.** Each notch multiplies the camera-to-pivot distance by a
  constant, so the camera approaches the pivot asymptotically and never reaches or
  passes it. The view appears to stop zooming at an arbitrary depth.
- **Pan shrinks with zoom.** Pan is scaled by the camera-to-pivot distance so that
  a pixel of drag moves the world one pixel. As the dolly drives that distance
  toward zero, a full drag moves the camera almost nowhere.

This design replaces the fixed pivot with a **ground-plane reference** (§2). The
wheel becomes an unbounded **forward/backward translation** rather than a dolly
toward a point, and pan is measured against the ground rather than against a
collapsing pivot.

The model is the one Google Maps uses: the world is treated as **one known
surface**, so the depth of the point under the cursor is a closed-form ray-plane
intersection rather than something that must be measured from the scene. No depth
buffer is read and no raycast index is built.

---

## 2. The reference distance

Every rule below is expressed in terms of a single scalar, the **reference
distance** `dRef` — the distance from the camera to the ground under a given
screen point.

**Ground plane.** The horizontal world plane **y = 0**. That is where the
viewport's grid is drawn and where an untransformed room's floor top surface sits
(`spec.md` §4.1). It is a **fixed** plane: it does not track scene contents, is
not re-derived per room, and never moves under the user mid-gesture.

**Scene diagonal** `D` — the length of the diagonal of the current scene content
bounding box, the same union `spec.md` §2.4's auto-fit uses. It is **recomputed at
each gesture start**, and **at most once per animation frame** while a continuous
gesture runs, so that navigation speed tracks what is actually on screen: loading a
Gaussian-splat capture (`gaussian_splats.md`) into a room-scale scene grows `D` by
roughly three orders of magnitude and navigation must follow it immediately. When
the bounds are degenerate or non-finite, `D` falls back to the same fallback bounds
the auto-fit uses.

**Derivation.** Given a screen point, build the ray from the camera through it and
intersect the ground plane:

- **Hit in front of the camera** — `dRef` is that hit distance, **clamped to a
  maximum of `3 × D`**. The clamp is what keeps a grazing ray finite: as the view
  approaches the horizon the intersection distance runs to infinity, and without
  the clamp a one-pixel drag would fling the camera across the workspace.
- **No usable hit** — the ray is parallel to the plane, or the intersection lies
  behind the camera (looking away from the ground, or flying below it and looking
  down). `dRef` falls back to **`0.10 × D`**.

`dRef` is a **derived quantity, never stored state**. The two **continuous**
gestures — the wheel (§4.1) and the middle drag (§4.2) — recompute it **per input
event**, so their speed tracks the ground as the camera flies toward or away from
it. That costs nothing: given `D`, `dRef` is one ray-plane intersection off the
live camera pose, which is the whole point of §6's choice of yardstick. The
**right-drag** is the exception and latches it once at drag-start (§4.3), because
there a mid-gesture change is visible as a lurch rather than as acceleration.

`D` is the part that is **not** free — it measures the scene — and it is the
quantity the once-per-frame cap above applies to. A trackpad emits wheel events
faster than the display refreshes, and re-walking the scene graph for each would
put a full bounds computation in the input path.

Neither is retained: nothing in the scene file (`spec.md` §14) or the viewport's
remembered framing records `dRef` or `D`.

---

## 3. The pivot

`OrbitControls`' pivot is no longer a persistent scene point. It is **re-seated at
the start of every left-drag and right-drag**, from two separately chosen parts:

- **Direction — always the viewport centre ray**, so the pivot stays in front of
  the camera whichever gesture seated it.
- **Distance — `dRef` under the viewport centre for a left-drag** (§4.4), and
  **`dRef` under the cursor for a right-drag** (§4.3). Pan's rate is derived from
  the camera-to-pivot distance, so seating that distance from the cursor is what
  makes a ground pixel stick to it; orbit cares about the pivot as a *point*, so
  it takes the centre.

Left-drag rotation is otherwise unchanged: the camera orbits that point at its
current distance, and the orthographic views' locked rotation is untouched.

Consequently:

- Orbit circles the ground the user is looking at, at whatever scale they are
  working — not a point fixed when the view was first framed.
- The pivot is **carried along by the wheel and the middle-drag** (§4), which
  translate camera and pivot by the same vector. Translation therefore never
  changes the camera-to-pivot distance, which is why forward motion is unbounded
  and cannot stall.
- Because the pivot is per-gesture scratch, a view's **remembered framing**
  (`spec.md` §2.4) is its **camera pose** — position and orientation — and no
  longer includes a pivot. **Returning** to the Perspective view therefore seats
  the pivot **along the camera's current view axis** (direction as above, distance
  `dRef` at the centre) rather than restoring a saved point: the orbit controls
  end every update by looking at the pivot, so a pivot anywhere off that axis
  would silently re-aim the camera and lose the orientation the user left.

**Accepted limitation.** Close to a wall, the ground point under the viewport
centre can lie beyond it, so orbit pivots on the floor behind the wall rather than
on the wall. Placing the pivot on the nearest visible surface instead would require
either a depth-buffer probe or a raycast index over the splats, both of which this
design deliberately avoids (§6).

---

## 4. Gestures

### 4.1 Wheel — forward/backward translation

One notch translates **the camera and the pivot together** along the **ray through
the mouse cursor** by

```
step = max(0.10 × dRef, 0.05 m) × modifier
```

where `dRef` is taken at the **cursor**, and `modifier` is **5** with **Shift**
held, **1/5** with **Alt** held, and **1** otherwise — **Shift wins** when both are
held, arbitrarily but definitely, so the pair never cancels back to 1. The floor is
applied **before** the modifier, so **Alt** still slows an already-floored step
rather than being swallowed by it.

- **Along the cursor ray**, not the view axis: translating a perspective camera
  along a ray leaves every world point on that ray projecting to the same pixel, so
  whatever is under the cursor stays under it regardless of its depth. No depth
  match is needed for this to hold.
- **`0.10 × dRef`** makes the step proportional to how far the ground is, so the
  motion decelerates as the camera descends toward the floor and accelerates over
  open ground. At the `0.10 × D` fallback the notch is 1% of the scene diagonal.
- **The `0.05 m` floor** is what keeps the wheel from re-acquiring the stall it was
  meant to fix. Without it, descending toward the floor would shrink the step
  without bound and the camera could never pass through it; with it, continued
  scrolling always makes progress and the camera can travel below the ground plane
  and inside geometry.
- **No travel limit.** Nothing clamps how far the camera may translate, in either
  direction. This is deliberate; §5 records what it costs.

### 4.2 Middle-drag — continuous forward/backward

A middle-button drag is the wheel's continuous form: dragging **up** flies forward,
**down** flies back, translating camera and pivot along the **view axis** by

```
step = 2 × dRef × (pixels dragged up ÷ viewport height)
```

so a drag of the full viewport height travels **twice** the reference distance.
`dRef` is taken at the **viewport centre** — the drag has no cursor position of its
own to mean anything, since only its vertical delta is read — and, being a
continuous gesture, is re-sampled **per event** like the wheel's (§2), so a drag
held down decelerates as it approaches the ground rather than punching through at
its starting speed.

It exists so that crossing a workspace whose long axis is over a kilometre does not
require dozens of wheel notches.

### 4.3 Right-drag — pan

`dRef` is sampled under the **cursor at drag-start** and held fixed for the whole
gesture; pan translates the camera 1:1 against it, so that a point **on the ground
plane** stays under the cursor for the duration of the drag. Re-sampling as the
cursor moved would keep 1:1 across depth discontinuities at the cost of the view
lurching mid-gesture, and is not done.

The resulting rate — world units per pixel of drag — therefore **varies with how
far the ground under the cursor is**. That is the intended behavior and is not the
defect of §1: pan collapsed previously because the *pivot distance* was collapsing,
not because the rule was 1:1.

**Accepted limitation.** Pixels stick exactly only for content **on the ground
plane**. A pixel grabbed on a wall, a pole, or a splat structure slides, by the
ratio between that surface's depth and the ground's.

### 4.4 Left-drag — orbit

Unchanged from `spec.md` §2.4 apart from the pivot re-seating of §3.

### 4.5 Damping

The accumulated wheel and middle-drag translation is **eased out per frame using
the same damping factor as rotation and pan** (0.08), rather than applied
instantly, so that a fast scroll glides and the viewport reads as one system.

Once the remainder falls below **1e-4 m** it is applied outright rather than eased,
so a translation **terminates** instead of approaching its target asymptotically —
the same failure this design removes at the scale of the whole scene, and it would
otherwise reappear at the scale of a frame.

The pending translation is **per-gesture scratch like `dRef` and the pivot**: it is
discarded on a **view switch** and by **Reset view**, so travel still easing out
cannot drift a framing the user has already left or just reset. In particular it
never reaches an orthographic view, which §7 leaves untouched.

### 4.6 Input normalisation

`wheel` events are normalised by `deltaMode` into notch units — **pixels ÷ 100**,
**lines × 1**, **pages × 10** — so that a mouse notch and a trackpad flick move
comparable distances across browsers.

Some browsers report a **shift-modified** wheel on `deltaX` rather than `deltaY`;
the non-zero axis is used, so the Shift speed modifier of §4.1 works everywhere.

A **trackpad pinch** arrives as a `ctrl`-modified wheel event; it is treated as the
same forward/backward gesture and its default is prevented, so a pinch flies the
camera rather than zooming the page. **Ctrl is therefore not available as a speed
modifier**, which is why §4.1 uses Shift and Alt. The wheel listener is registered
**non-passive** so the default can be prevented.

---

## 5. Consequences of unbounded travel

The camera may be translated arbitrarily far from the scene. Nothing clamps how far
it may go, in either direction; past the perspective camera's far plane nothing is
drawn, and there is no landmark to navigate back by.

Recovery is the **Reset view** button in the viewport's top-middle toolbar
(`spec.md` §2.4), which re-frames the active view on the current scene bounds. It is
the only way back — the Perspective view is framed once when the viewport is
constructed and, unlike the orthographic views, has no auto-fit that re-runs.

A **travel clamp** was considered and rejected: bounding the camera to some multiple
of the scene diagonal would make getting lost impossible, but it also silently
refuses motion the user asked for, with nothing on screen explaining why the wheel
stopped working. An explicit way home is the better trade, and it is one the ortho
views wanted anyway (nothing else re-fits them after geometry changes).

---

## 6. Why no depth probe and no splat raycast

Two other sources for "the distance to what is under the cursor" were considered
and rejected:

- **Reading the scene depth buffer.** WebGL2 forbids `readPixels` on a
  `DepthTexture`, so this needs an extra 1×1 render pass sampling the shared depth
  texture plus a synchronous read-back per gesture. It is the only option that
  sticks pixels to *every* surface including splats — at the cost of GPU
  round-trips in the input path and of navigation maths that cannot be unit-tested
  without a GPU.
- **Raycasting the splats.** Splat meshes are constructed `raycastable: false`
  (`gaussian_splats.md` §6.5) precisely so no raycast index is built for them. Reversing that
  would give exact surface distances at the cost of index build time and memory on
  a large capture.

The ground-plane model gives Maps-grade behavior for a site laid out on flat
ground, needs neither, and is **pure geometry**: every quantity in §2–§4 is a
function of the camera pose, the cursor position, the viewport size and `D`, and is
unit-testable headlessly.

---

## 7. Unchanged by this design

- **Orthographic views** (Top/Front/Right) keep `spec.md` §2.4's model exactly:
  rotation locked, left-drag pans, the wheel **and the middle drag** scale the
  frustum. `OrbitControls`' own zoom is therefore enabled per view — off in
  Perspective, where §4.1 and §4.2 replace it, and on in the three elevations. Under parallel
  projection translating the camera along its own axis changes nothing on screen,
  so "forward/backward" has no meaning there; and ortho pan is already 1:1 at every
  zoom level, so neither defect of §1 exists in those views.
- **The Selected view** keeps `spec.md` §2.4.1: orbit, pan and zoom all disabled,
  left-drag aims the selected camera instead.
- **Selection, the click-vs-drag threshold, and deselect-on-miss** (`spec.md` §5.2)
  are unaffected; a drag past the threshold still suppresses the click.
- **`TransformControls` interlock** — navigation stays disabled for the duration of
  a gizmo drag, and re-enables afterwards only in views where it is allowed
  (`spec.md` §2.4.1).
- **Place on surface** and the **polyline draw mode** keep working during
  navigation (`spec.md` §2.4.2, `camera_placement.md` §6.2).
