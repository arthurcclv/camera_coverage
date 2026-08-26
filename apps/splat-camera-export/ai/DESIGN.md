# DESIGN.md — splat-camera-export

What this app is for and why it behaves the way it does. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for structure and `specs/spec.md` for the
authoritative behavior.

## The problem

`apps/sample-app` answers a geometric question: *how much of this volume do my
cameras cover?* It reasons about a parametric room and box obstacles, and reports
coverage percentages over voxels.

What it cannot answer is the question an operator actually asks: **what will I see on
the monitor?** A camera can be 98% "covering" a zone and still be useless — pointed at
a pillar, framing mostly ceiling, or looking straight into a window.

This app answers that second question by rendering each planned camera against a
**3D Gaussian Splat capture of the real site**, and handing back one image per camera.

## The shape of the tool

Deliberately **read-and-render**: cameras in, images out.

- It does not edit cameras. That is `sample-app`'s job, and duplicating it would
  create two sources of truth for a camera layout.
- It does not compute coverage. That is the SDK's job.
- It does not author or train splats.

The whole app is therefore a pipeline with a UI bolted to its inputs: pick a splat,
pick a `scene.json`, register the two, press export.

## The three ideas that matter

### 1. Alignment is the hard part, so it is explicit

A splat reconstructed by COLMAP/3DGS training lives in an arbitrary frame at an
**arbitrary scale**. The imported cameras live in the room's metric Y-up frame. There
is no reason for these to coincide, and if they don't, every exported image is
meaningless — but *plausibly* meaningless: you get pictures, they're just pictures of
nothing in particular.

So alignment (spec §7) is a first-class, visible, persisted, exported transform rather
than a hidden heuristic. The UI makes it obvious that it must be set, the
`Through camera` view (§6.1) lets you confirm it before committing to a batch, and the
manifest records it so any exported batch can be reproduced or audited.

The one presumption the app does make is a **default 180° Z rotation** on load (§7.3):
3DGS captures are Y-down relative to a Y-up viewer, so under identity nearly every real
capture arrived upside-down. This is a concession to the common case, but it is
deliberately *not* a hidden heuristic: it is announced in a notice, it moves rotation
only, the preset button visibly reflects it, and persistence overwrites it the moment the
user disagrees. A stated convention is acceptable; a silent guess about the file's
contents would not be.

Uniform scale only — a non-uniform scale shears Gaussians and is never the right answer
for registering a reconstruction.

### 2. A silent wrong image is the worst failure mode

Everything about the export path is shaped by one observation: **this tool's failures
tend to produce output rather than errors.** A zip of correctly-named, correctly-sized
images that are all black, or all showing the previous camera's splat ordering, or
vertically mirrored, looks like success.

Two real instances, both found in end-to-end testing and both now spec'd:

- Splats sort **per camera, in a worker**, and the ordering uploads a frame later. A
  naive readback captures the *previous* camera's ordering (§8.2).
- `glReadPixels` on a **multisampled** framebuffer is `GL_INVALID_OPERATION`, which
  yields an all-zero buffer rather than throwing — a zip full of pure black (§8.3).
- Immediate-mode camera markers draw for **every** active camera, including the export
  rig, baking frustum wireframes into the deliverables (§6.3).

Hence: an explicit settle protocol, readback through the resolved texture, marker
suppression during runs, and the row-flip and resolution policy sitting in pure tested
functions rather than inline in the render loop.

### 3. Cancel means nothing is delivered

A partial batch presented as a deliverable is worse than no batch, because the gap is
invisible downstream. Cancelling downloads nothing; a camera that fails to render
aborts the whole run and names itself (§9.5).

## Why the reader is tolerant but the parser is strict

The `scene.json` reader (§5.1) ignores every key it doesn't need and accepts unknown
future `formatVersion`s, because this app only needs cameras and should not break when
the coverage app grows a new entity type. But an individual *camera* that fails
validation kills the whole import (§5.3) — a partial camera set silently under-exports.

Tolerant about what it doesn't care about; strict about what it does.

## Why `far` is overridden by default

In `scene.json`, `far` bounds the volume a camera is credited with *covering* — often
~30 m. Used as a render clip plane it would slice the visible splat at that distance,
producing images that look like the site ends in a void. The render uses a 1000 m
override by default and records both values in the manifest (§5.2). Users who want
exactly the coverage frustum can ask for it.
