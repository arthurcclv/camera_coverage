# DESIGN.md — sample-app

Product vision, goals, and design principles for the demo app. The authoritative
behavioral definition is [`../specs/spec.md`](../specs/spec.md) (with volumetric
rendering detailed in [`../specs/volumetric_rendering.md`](../specs/volumetric_rendering.md));
this file is the plain-language orientation.

## Vision

A browser demo that exercises `@linkervision/camera-coverage-sdk` end to end —
`init → loadScene → setSampling → setCameras → compute` — and visualizes the
result. It is a **readable reference for SDK consumers**, not a shipping product.

## What a user can do

- Explore a fixed enclosed room (open-top box with freestanding obstacles) seeded
  with 10 CCTV-style cameras.
- **Move / rotate / re-aim each camera** and change its FOV, via in-viewport
  gizmos or panel sliders.
- **Run the coverage computation** on demand, or leave **auto-run** on (default)
  so it recomputes shortly after any input change.
- See coverage as a **color-coded volumetric voxel overlay** in two modes:
  *Coverage* (intensity = fraction of cameras that see the voxel) and *Blind
  spots* (only voxels seen by no camera).
- **Drop probes** — points whose exact per-camera visibility is read back from the
  most recent run and drawn as green sightlines to the cameras that see them.
- Read a **stats panel** (overall coverage, valid voxels, blind-spot count,
  elapsed time, per-camera rates) and browse a **scene hierarchy tree** of cameras
  and probes.
- Adjust **sampling resolution** (voxel size) and overlay appearance (mode, hue,
  intensity).

## Layout & audience

Desktop-only, a three-column layout: a left inspector (scene hierarchy +
context panel), a central 3D viewport with toolbars, and a right column of
controls/stats. No mobile, no persistence.

## Design principles

1. **The room is static; only cameras and probes are editable.** The scene mesh
   is built once and reused for both rendering and `loadScene`; there is no
   in-app scene editing.
2. **React owns state; Three.js objects are dumb sinks.** React holds the
   canonical arrays (cameras, probes, selection, options) and pushes them into
   imperative Three.js scene objects via `update()`/`setOptions()`. No
   react-three-fiber.
3. **Two independent WebGPU surfaces.** The **render** backend (Three.js
   `WebGPURenderer`, main thread) is separate from the SDK's **compute** backend
   (in the worker). Each falls back independently — render to WebGL2, compute to
   the CPU reference — and the stats panel shows both.
4. **Pure decision logic is factored out of React/Three to be testable.**
   Selection, transform-space mapping, panel split, tree derivation, overlay
   encoding, probe voxel lookup, and volumetric slab/chord math are pure
   functions with unit tests; React/Three are the untested glue.
5. **Probes read retained results, not fresh raycasts.** Per-point visibility is
   decoded from the masks of the *most recent completed run*, against a snapshot
   of that run's enabled-camera list — so it can go stale, and the UI says so.

## Non-goals

Scene save/load, mesh import, multiple scenes, authentication, mobile support,
and any persistence of camera/probe layouts are explicitly out of scope.
