# CLAUDE.md — sample-app

This file provides guidance to Claude Code (claude.ai/code) when working in the sample app. See the repo-root `CLAUDE.md` for monorepo layout and workflow rules that apply to both packages.

Vite/React/Three.js browser demo of the SDK, implemented from `specs/spec.md` — that spec is the source of truth for intended behavior. Seven feature docs sit beside it and own their features outright: [`specs/volumetric_rendering.md`](specs/volumetric_rendering.md) (the overlay renderer), [`specs/sampling_volumes.md`](specs/sampling_volumes.md) (zones), [`specs/aim_optimization.md`](specs/aim_optimization.md) (the camera aim optimizer), [`specs/camera_placement.md`](specs/camera_placement.md) (constraint-driven camera placement), [`specs/gaussian_splats.md`](specs/gaussian_splats.md) (3D Gaussian Splat site captures as a viewport backdrop), [`specs/geometry_assets.md`](specs/geometry_assets.md) (geometry as editable hierarchy entities, and importing `.glb`/`.gltf`/`.ply`/`.obj` assets), and [`specs/navigation.md`](specs/navigation.md) (the Perspective view's wheel/middle/pan/orbit navigation). It consumes the SDK by package name (`"@linkervision/camera-coverage-sdk": "*"`) via workspace symlink.

## Documentation

Deeper orientation lives in `ai/`: [DESIGN.md](ai/DESIGN.md) (what the demo does and why), [ARCHITECTURE.md](ai/ARCHITECTURE.md) (the three layers + module map), [DECISIONS.md](ai/DECISIONS.md), [CONVENTIONS.md](ai/CONVENTIONS.md), [WORKFLOWS.md](ai/WORKFLOWS.md), [STACK.md](ai/STACK.md), and [VISUAL_DESIGN.md](ai/VISUAL_DESIGN.md) (colors, typography, spacing, components, accessibility). This file stays focused on commands.

## Commands

```bash
npm run dev         # vite dev server
npm run build       # tsc -b && vite build
npm run typecheck
```
