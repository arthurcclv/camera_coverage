# STACK.md — splat-camera-export

Technologies and the role each plays. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how
they fit and [DECISIONS.md](./DECISIONS.md) for why.

## Core

| Tech | Version | Role |
|---|---|---|
| **TypeScript** | ^5.5 | All source. `strict`, Bundler resolution, `isolatedModules`, `verbatimModuleSyntax`. |
| **React** | ^19.1 | UI shell — panels, camera list, progress. Plain React + hooks; no component library, no CSS framework. |
| **Vite** | ^6 | Dev server + bundler. ES-module workers (`worker.format: 'es'`) for the engine's splat sort worker. |
| **Node.js** | ≥ 22.6 | Runs the tests via native TS type-stripping. |

## Rendering

| Tech | Version | Role |
|---|---|---|
| **`playcanvas`** | ^2.21 | The engine. Provides the `gsplat` asset type and `GSplatComponent`, the render-target/`Texture.read` readback used by export, and the `Quat` math the alignment panel delegates to. |
| **`@playcanvas/react`** | ^0.11 | Declarative React bindings — `<Application>`, `<Entity>`, `<Camera>`, `<GSplat>`, `useApp`, and `OrbitControls`. |

Device preference is `[DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2]` — WebGPU when the browser
offers it, WebGL2 otherwise. Both readback paths work; the export code touches no
backend-specific API.

**Splat formats** come from the engine's `gsplat` handler, which dispatches on the file
extension: `.ply`, `.compressed.ply`, `.sog` (bundle), and `.meta.json` (SOG). The
extension is taken from `asset.file.filename`, which is why a blob URL still parses
(spec §4).

**Unified gsplat rendering** is enabled (`<GSplat unified />`) — the engine's new default;
the non-unified path is deprecated. Both sorters fire the `gsplat:sorted` scene event the
export settle protocol depends on (§8.2).

## Export

| Tech | Version | Role |
|---|---|---|
| **`fflate`** | ^0.8 | Zips the batch, with `level: 0` (store) since PNG/JPEG are already compressed. |
| **`OffscreenCanvas`** | platform | PNG/JPEG encoding via `convertToBlob`. |

## The SDK

**`@linkervision/camera-coverage-sdk`** is a dependency for **types only** — `Vec3` and
`Quat`, imported with `import type` so no engine code enters the bundle. The coverage
engine itself is not used: this app renders, it does not analyse.

Consumed by package name (`"*"`) via the npm-workspace symlink, as raw `.ts`.

## Testing

`node --test --experimental-strip-types` — no test framework, no transpile step, matching
`sample-app` and the SDK. `playcanvas` imports cleanly in that environment (verified),
so `align/alignment.ts` stays unit-testable despite depending on the engine's math.

End-to-end GPU verification is done with **Playwright** driving headless Chromium over
ANGLE/SwiftShader against a synthetic 9-splat PLY fixture — see
[WORKFLOWS.md](./WORKFLOWS.md). Playwright is not a project dependency; it is invoked
ad hoc.
