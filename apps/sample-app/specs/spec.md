# Sample App — Camera Coverage SDK Demo

A browser demo of [`@linkervision/camera-coverage-sdk`](../../../packages/camera-coverage-sdk/).
It loads an enclosed room with box obstacles and 10 cameras, lets the user adjust
each camera's position / rotation / FOV, runs the coverage calculation on demand,
and visualizes the result as a color-coded voxel overlay in the scene.

---

## 1. Goals & scope

- Demonstrate the SDK end-to-end: `init` → `loadScene` → `setSampling` →
  `setCameras` → `compute`, with results streamed and visualized.
- Keep the scene small enough that the **CPU reference backend** stays responsive,
  while still exercising the **WebGPU** path where available.
- Be a readable reference for SDK consumers, not a polished product.

Non-goals: saving/loading scenes, importing external meshes, multi-scene support,
authentication, mobile layout.

---

## 2. Tech stack & project wiring

| Concern | Decision |
|---|---|
| Bundler / dev server | **Vite** + TypeScript |
| UI | **React** — control panels, buttons, stats readouts |
| 3D rendering | **Vanilla Three.js**, driven imperatively inside a `useEffect`/ref (no react-three-fiber) |
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
      viewport.ts          Three.js renderer, orbit + transform controls, render loop
      cameraGizmos.ts      per-camera frustum gizmos
      coverageOverlay.ts   instanced-cube overlay from ChunkResult
    cameras/
      defaults.ts          10 default camera configs
      math.ts              Euler <-> quaternion helpers
    ui/
      CameraPanel.tsx      selected-camera editors
      CameraList.tsx       camera selection list + per-camera enable/disable toggle
      OverlayControls.tsx  viz toggles + opacity + resolution slider
      StatsPanel.tsx       coverage summary readout
      RunBar.tsx           Run button + auto-run toggle + stale/backend indicators
```

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

- **Select** a camera by clicking its frustum gizmo in the viewport or its row in
  the camera list.
- **Panel sliders** edit the selected camera: position X/Y/Z, yaw/pitch/roll, FOV.
- **TransformControls** gizmo (translate + rotate modes) on the selected camera in
  the viewport, kept in two-way sync with the panel.

### 5.3 Frustum gizmos

Each camera renders as a frustum wireframe reflecting its `fov`/`aspect`/`far`, so
aim and coverage volume are visible. The selected camera's gizmo is highlighted.
A disabled camera's gizmo is dimmed and its frustum wireframe hidden (§5.4).

### 5.4 Enable / disable

- Each row in the camera list has a **checkbox toggle** to enable/disable that
  camera, independent of selection. Toggling doesn't change the current selection.
- Disabled cameras stay in the scene (dimmed gizmo, no frustum wireframe) and keep
  their position/rotation/FOV editable, but are **excluded from `setCameras()`**
  passed to the engine, so they don't participate in `compute()` — no coverage
  rate is reported for them and they can't be flagged as `CAMERA_INSIDE_GEOMETRY`.
- Toggling a camera marks the result stale, same as any other camera edit (§8.1).
- The well-covered threshold's max and the overlay's coverage-fraction opacity
  denominator (§9) track the **enabled** camera count, not the total.

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

Built from streamed `ChunkResult`s using `accessor(result).forEachLeaf((min, size,
mask, valid) => …)`.

- **Instanced cubes** (one `THREE.InstancedMesh`), one instance per covered/valid
  leaf, positioned at `min` with edge `size`.
- **Opacity by coverage fraction**: every voxel is rendered **white**; its
  opacity encodes what fraction of the involved (enabled) cameras can see it.
  Let `f = popcount(mask) / involvedCameraCount`. A voxel seen by **100%** of the
  involved cameras is white at the **peak opacity (0.8)**; a voxel seen by **none**
  is fully **transparent (0)**; opacity is **linearly interpolated** in between
  (`opacity = f * peakOpacity`). Per-voxel opacity is carried as a per-instance
  attribute multiplied into the material's alpha.
- Room geometry and cameras remain visible through partially-covered voxels.
- **Controls** (`OverlayControls.tsx`):
  - opacity slider — sets the **peak opacity** (opacity of a fully-covered
    voxel), default **0.8**,
  - "hide well-covered voxels" toggle (drop instances above a camera-count
    threshold),
  - "blind spots only" toggle (show only `mask == 0` valid voxels; because
    their coverage fraction is 0, this binary filter renders them at the peak
    opacity rather than transparently),
  - overlay visibility on/off.

---

## 10. Stats panel

From `CoverageSummary`:

- `overallRate` — fraction of valid voxels seen by ≥ 1 camera.
- `perCamera[]` — per-camera `coverageRate`, listed alongside each camera.
  Disabled cameras (§5.4) aren't sent to the engine, so they have no entry here.
- `validVoxels`, `elapsedMs`.
- Active backend (WebGPU / CPU) and current `voxelSize` / voxel count.

---

## 11. Error handling

| Case | Handling |
|---|---|
| `WEBGPU_UNAVAILABLE` on `auto` init | fall back to CPU (§3.2) |
| `SCENE_TOO_LARGE` (fine voxel on CPU) | catch, show message, keep previous valid state |
| `CAMERA_INSIDE_GEOMETRY` | surface which camera; keep it flagged in the list (disabled cameras are excluded, so never flagged) |
| `TOO_MANY_CAMERAS` | not reachable (10 ≤ 128), but guarded |
| Worker/device errors | reported in a status area; engine re-init offered |

---

## 12. Out of scope / future

- Mode 2 (coverage-count thresholding), per-camera coverage isolation view.
- Height-band / box sampling regions as a live control.
- Scene editing (adding/removing boxes), mesh import.
- Persisting camera layouts.
