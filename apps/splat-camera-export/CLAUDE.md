# CLAUDE.md — splat-camera-export

This file provides guidance to Claude Code (claude.ai/code) when working in this app. See
the repo-root `CLAUDE.md` for monorepo layout and workflow rules that apply to every
package.

Vite/React/PlayCanvas browser app that loads a **3D Gaussian Splat** capture, imports the
camera layout from a coverage-app `scene.json`, and **exports one rendered image per
camera**. Implemented from `specs/spec.md` — that spec is the source of truth for intended
behavior. It consumes the SDK **for types only** (`Vec3`, `Quat`); the coverage engine is
not used.

## Documentation

Deeper orientation lives in `ai/`: [DESIGN.md](ai/DESIGN.md) (what it's for and the
failure modes that shape it), [ARCHITECTURE.md](ai/ARCHITECTURE.md) (the pure/impure split
+ module map), [DECISIONS.md](ai/DECISIONS.md), [CONVENTIONS.md](ai/CONVENTIONS.md),
[WORKFLOWS.md](ai/WORKFLOWS.md) (including the end-to-end GPU check),
[STACK.md](ai/STACK.md), and [VISUAL_DESIGN.md](ai/VISUAL_DESIGN.md).

## Commands

```bash
npm run dev         # vite dev server
npm run build       # tsc -b && vite build
npm run typecheck
npm test            # node --test over the pure modules
```

## Before changing the render or export path

`npm test` and `npm run typecheck` **cannot** tell you an export is correct — every bug
this app has actually produced was invisible to both (a zip of pure black images, a
frustum wireframe baked into a deliverable, a vertically mirrored render). Run the
end-to-end check in [ai/WORKFLOWS.md](ai/WORKFLOWS.md), which samples pixels rather than
trusting that files exist.

Traps, each documented at its call site — don't "fix" them:

- Readback omits `{ renderTarget }` on purpose (spec §8.3) — passing it reads the
  multisampled framebuffer and silently returns zeros.
- The sort-settle timeout is required, not defensive (§8.2).
- Camera markers are unmounted during a run, not merely hidden (§6.3).
- A SOG asset's `data` is left unset so the parser still fetches its meta (§4).
- Camera `enabled` is set imperatively; the React `Entity` prop typechecks but is never
  applied (§6.1).
- The auto-applied alignment default is never persisted, or it would freeze the default
  for every already-opened capture (§7.4).
