# DESIGN.md — sample-app

Product vision, goals, and design principles for the demo app. The authoritative
behavioral definition is [`../specs/spec.md`](../specs/spec.md) (with volumetric
rendering detailed in [`../specs/volumetric_rendering.md`](../specs/volumetric_rendering.md)
the region-of-interest tool in [`../specs/sampling_volumes.md`](../specs/sampling_volumes.md),
the aim optimizer in [`../specs/aim_optimization.md`](../specs/aim_optimization.md), and
camera placement in [`../specs/camera_placement.md`](../specs/camera_placement.md));
this file is the plain-language orientation.

## Vision

A browser demo that exercises `@linkervision/camera-coverage-sdk` end to end —
`init → loadScene → setSampling → setCameras → compute` — and visualizes the
result. It is a **readable reference for SDK consumers**, not a shipping product.

## What a user can do

- Explore a fixed enclosed room (open-top box with freestanding obstacles) seeded
  with 10 CCTV-style cameras.
- **Move / rotate / re-aim each camera** and change its FOV and detection range
  (far), via in-viewport gizmos or panel sliders.
- **Look through the selected camera** — the **Selected** view renders the viewport
  from that camera, framed by an outline marking its true image, so "what does this
  camera actually see?" is answered directly instead of inferred from the frustum
  wireframe. In that view a drag **aims** the camera, which is the fastest way to
  point one at a blind spot you can see.
- **Run the coverage computation** on demand, or leave **auto-run** on (default)
  so it recomputes shortly after any input change.
- See coverage as a **color-coded volumetric voxel overlay** in two modes:
  *Coverage* (intensity = fraction of cameras that see the voxel) and *Blind
  spots* (only voxels seen by no camera).
- **Optimize a camera's aim, or the whole scene's** — for each camera, find the
  orientation that contributes most of what no *other* camera already contributes
  (`specs/aim_optimization.md`). Per camera it draws a yaw × pitch **score heatmap**
  you can hover to swing the camera live; across the scene it runs a sequential-greedy
  pass and offers the result as a set of proposals to Apply or Discard. Nothing is
  written to the scene until Apply.
- **Say where cameras *may* go, and let the app pick** — draw the mount regions a site
  actually offers (a bracket, a gantry rail, a wall, each with a tolerance) and search
  them for a small set of positions that together see as much as possible
  (`specs/camera_placement.md`). The answer comes as a **score-vs-count curve**, because
  the interesting question is not "where do 10 cameras go" but "how many do I need" —
  the tool marks the fewest that get within a point of the best it found, and the user
  moves the slider from there. Placement chooses positions only; the aim optimizer above
  then points them, and the stats panel reports what they actually cover. It is the app's
  one **mode**: the columns stay where they are, but everything in them gives way to the
  tool — candidate positions and strategy on the left, the curve and the plan on the right —
  so the target group cannot drift, the exit cannot be navigated away from, and no geometry
  can be edited under a live build (see DECISIONS.md).
- **Drop probes** — points whose exact per-camera visibility is read back from the
  most recent run and drawn as green sightlines to the cameras that see them.
- Add **sections** — axis-aligned slabs aggregated into a 2D coverage heatmap.
- Carve the workspace into **zones** — named regions of interest built from
  editable oriented boxes ("sampling volumes"), seeded from the scene's BVH with
  **Generate from geometry** or added/edited by hand. Each zone reports its **own**
  coverage results, and restricting coverage to zones (the `useZones` toggle)
  narrows the sampled set so irrelevant free space stops diluting the rate. Each
  zone has an independent **enabled** checkbox (like cameras/sections): the
  overlay/sections/stats show the **union of the enabled zones**, so you can isolate
  one, combine several, or show all.
- Read a **stats panel** (overall coverage, valid voxels, blind-spot count,
  elapsed time, per-camera rates) and browse a **scene hierarchy tree** of cameras,
  probes, sections, and zones/volumes.
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
   canonical arrays (cameras, probes, selection, options) and pushes them, as one
   snapshot, through the `SceneView` bridge into the imperative Three.js scene
   objects (`update()`/`setOptions()`). No react-three-fiber.
3. **Two independent WebGPU surfaces.** The **render** backend (Three.js
   `WebGPURenderer`, main thread) is separate from the SDK's **compute** backend
   (in the worker). Each falls back independently — render to WebGL2, compute to
   the CPU reference — and the stats panel shows both.
4. **Pure decision logic is factored out of React/Three to be testable.**
   Selection, transform-space mapping, panel split, tree derivation, overlay
   encoding, probe voxel lookup, and volumetric slab/chord math are pure
   functions with unit tests; React/Three are the untested glue.
5. **Every expensive measurement is cached against what it depends on, not re-taken.**
   The aim optimizer captures a mount point's reachable set once and then scores
   orientations for free; placement builds a *pool* of mount points once and then
   scores whole layouts for free. Both work because a reachable set does not depend on
   where cameras point or on how many exist — so the cache's validity is a short, statable
   list (geometry, resolution, counted set, range), and camera edits are deliberately not
   on it.
6. **Probes read retained results, not fresh raycasts.** Per-point visibility is
   decoded from the masks of the *most recent completed run*, against a snapshot
   of that run's enabled-camera list — so it can go stale, and the UI says so.

## Non-goals

Scene save/load, mesh import, multiple scenes, authentication, mobile support,
and any persistence of camera/probe layouts are explicitly out of scope.
