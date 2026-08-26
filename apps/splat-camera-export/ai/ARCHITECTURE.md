# ARCHITECTURE.md — splat-camera-export

Structure and module map. See [DESIGN.md](./DESIGN.md) for why, `specs/spec.md` for
authoritative behavior.

## The organizing principle

**Pure decision logic is separated from the impure PlayCanvas/DOM sinks**, and the
split is drawn so that everything worth testing lands on the pure side. The GPU-bound
modules are kept deliberately thin — plumbing, not judgment.

```
                 ┌────────────────────────────────────────────┐
   App.tsx ──────┤ canonical state: cameras, alignment,       │
   (React)       │ settings, selection, run status            │
                 └───────────────┬────────────────────────────┘
                                 │ props (one direction)
       ┌─────────────────────────┼──────────────────────────┐
       │                         │                          │
   ui/ panels             viewport/Viewport.tsx        (notices)
   (presentational)       the single entry into
                          PlayCanvas — owns the app,
                          the splat, and the rig
                                 │
                    ┌────────────┴────────────┐
                    │                         │
            render/exportRig.ts        export/runExport.ts
            (GPU: target, settle,      (orchestration; makes no
             readback)                  decisions of its own)
                    │                         │
                    └────────────┬────────────┘
                                 │ delegates every decision to:
        cameras/sceneCameras.ts · align/alignment.ts
        render/imageSize.ts · render/pixels.ts
        export/filenames.ts · export/manifest.ts   ← all pure, all tested
```

## Layers

| Folder | Contents |
|---|---|
| `cameras/` | The `scene.json` camera reader (§5) and label resolution (§5.4). Pure. |
| `align/` | The splat→scene similarity transform, Euler conversion, presets, `alignment.json` (§7). Pure. |
| `render/` | `imageSize.ts` and `pixels.ts` are pure policy; `exportRig.ts` and `png.ts` are the GPU/canvas sinks. |
| `export/` | `filenames.ts` and `manifest.ts` are pure; `zip.ts` and `runExport.ts` are the impure edges. |
| `viewport/` | Everything inside `<Application>` — the splat entity, view modes, markers, and asset loading. |
| `ui/` | Presentational React panels plus the shared `NumberInput` and colour helpers. |
| `test/` | One file per pure module. |

## The one PlayCanvas entry point

`viewport/Viewport.tsx` is the only place the engine is entered. `<Application>` creates
the app; everything needing `useApp()` lives in its child `SceneContents`, which owns:

- **splat loading** — a `File[]` → `gsplat` Asset, with blob URLs and a `mapUrl`
  mapping for SOG siblings (`splatAsset.ts`)
- **the scene graph** — the splat entity carrying the alignment transform, the orbit
  camera, and the through-camera
- **the export rig** — created once per app lifetime, driven by an `ExportRequest`

App and Viewport communicate one-way: App passes an `ExportRequest` object whose
identity change starts a run; Viewport reports back through `onExportProgress` /
`onExportDone` callbacks. There is no shared mutable state and no imperative handle.

## Two rotation paths, on purpose

The declarative `<Entity rotation>` prop takes **Euler degrees**, but every rotation
that crosses a file boundary is a **quaternion**. So:

- **Exactness required** (the export rig, the through-camera): the quaternion is set
  imperatively via `setRotation`, never round-tripped through Euler.
- **Human input** (the alignment panel): Euler degrees, converted through
  `align/alignment.ts` — which **delegates to the engine's own `Quat`** rather than
  reimplementing the formulae, so the panel's numbers agree with `setLocalEulerAngles`
  exactly. See [DECISIONS.md](./DECISIONS.md).

## The export pipeline

One camera at a time, sequentially — the shared render target and the per-camera splat
sort make concurrency unprofitable:

```
pose the rig  →  await gsplat:sorted (250 ms timeout)  →  await N frames
      →  Texture.read (resolved texture, NOT the MSAA framebuffer)
      →  flipVertical + alpha  →  OffscreenCanvas encode  →  accumulate
                                                                  ↓
                                       buildManifest  →  zip (store)  →  download
```

`runExport.ts` owns the sequence but no policy: sizes come from `imageSizeFor`,
names from `buildFilenames`, the manifest from `buildManifest`. That is what makes the
manifest structurally unable to disagree with what the run actually did.

## What is not unit-tested, and why that's the design

`exportRig`, `png`, `zip`, `splatAsset`, and the components need a GPU and a browser.
They are thin *because* they can't be unit-tested — the pure modules exist precisely so
the logic worth testing sits outside them. The GPU path is covered by the end-to-end
check described in [WORKFLOWS.md](./WORKFLOWS.md).
