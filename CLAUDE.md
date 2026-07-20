# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

npm workspaces monorepo, two packages:

- `packages/camera-coverage-sdk` — `@linkervision/camera-coverage-sdk`, the actual engine. Implemented from `packages/camera-coverage-sdk/specs/spec.md` — that spec is the source of truth for behavior; the README maps spec sections to modules. See `packages/camera-coverage-sdk/CLAUDE.md` for SDK commands and architecture.
- `apps/sample-app` — Vite/React/Three.js browser demo of the SDK, implemented from `apps/sample-app/specs/spec.md`. Consumes the SDK by package name (`"@linkervision/camera-coverage-sdk": "*"`) via workspace symlink. See `apps/sample-app/CLAUDE.md` for app commands.

`npm install` at the repo root wires both up.

## Documentation

Each package carries its own AI/contributor documentation set under `ai/`
(orientation beyond the spec and the commands here):

- SDK — `packages/camera-coverage-sdk/ai/` — `DESIGN.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `DECISIONS.md`, `WORKFLOWS.md`, `STACK.md`. (No `VISUAL_DESIGN.md` — the SDK is a headless engine with no UI.)
- App — `apps/sample-app/ai/` — those six plus `VISUAL_DESIGN.md` (the UI palette, typography, spacing, components, and accessibility).

Each package's own `CLAUDE.md` links into its `ai/` set. The `specs/spec.md` in
each package remains the source of truth for behavior; the `ai/` docs explain the
product, structure, and process around it.

## Workflow rules

- **Read the relevant spec before changing anything.** `packages/camera-coverage-sdk/specs/spec.md` and `apps/sample-app/specs/spec.md` are the source of truth for intended behavior, not just background reading — check the applicable section(s) before touching engine or app code.
- **Update the spec first, and get approval before implementing.** For any behavior change, write the spec edit describing the new/changed behavior and present it to the user for approval before writing implementation code. Don't code ahead of an approved spec change.
- **Keep the spec consistent with the implementation.** The spec and code must never drift — a diff that changes behavior without a corresponding (approved) spec update is incomplete.
- **Add tests for every new change.** New functionality or bug fixes need a corresponding test (unit, acceptance, WASM-parity, or WebGPU as applicable); don't rely on manual verification alone.
- **Keep the `ai/` docs current.** Each package's `ai/` set (`DESIGN.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `DECISIONS.md`, `WORKFLOWS.md`, `STACK.md`, and the app's `VISUAL_DESIGN.md`) is orientation, not folklore — it must track the code same as the spec does. A change that alters module structure, adds/reverses a technical decision, introduces a new coding convention, changes a dependency, or (app) changes a color/type/spacing/component rule is incomplete until the matching `ai/` doc is updated in the same change. New decisions append to `DECISIONS.md` (newest at top); don't let a doc silently go stale.
