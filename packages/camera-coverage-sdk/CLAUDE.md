# CLAUDE.md — `@linkervision/camera-coverage-sdk`

This file provides guidance to Claude Code (claude.ai/code) when working in the SDK package. See the repo-root `CLAUDE.md` for monorepo layout and workflow rules that apply to both packages.

The SDK is implemented from `specs/spec.md` — that spec is the source of truth for behavior; the `README.md` maps spec sections to modules.

## Documentation

Deeper orientation lives in `ai/`: [DESIGN.md](ai/DESIGN.md) (vision, goals, design principles), [ARCHITECTURE.md](ai/ARCHITECTURE.md) (module map + the four axes of duplication), [DECISIONS.md](ai/DECISIONS.md) (technical decisions + known gaps), [CONVENTIONS.md](ai/CONVENTIONS.md), [WORKFLOWS.md](ai/WORKFLOWS.md), and [STACK.md](ai/STACK.md). This file stays focused on commands and the highest-value architectural cautions.

## Commands

```bash
npm test                      # node --test --experimental-strip-types "test/**/*.test.ts"
npm test -- --test-name-pattern "<name>"   # run a single test
npm run typecheck              # tsc --noEmit
npm run build:wasm             # compiles crates/camera_coverage_wasm → src/wasm/*.wasm; needs rustup + wasm32 target
```
Node ≥ 22.6 is required (native TS type-stripping, no build step for the SDK itself).

## SDK architecture

Everything is oriented around one pipeline: **scene → occupancy/BVH preprocessing → per-chunk GPU (or CPU) visibility compute → merged result → accessor**. Read `README.md` before making non-trivial changes — it has a spec-section-to-module table and documents the exact interpretations/edge cases chosen where the spec was ambiguous (validity semantics, `CAMERA_INSIDE_GEOMETRY`, pre-cull losslessness, etc.). See [ai/ARCHITECTURE.md](ai/ARCHITECTURE.md) for the module map and the four axes of parallel implementation (CPU/WGSL compute, WASM/TS preprocessing, dense/SVO storage, word-parameterized camera masks) that must be kept in sync when fixing bugs.

The single highest-value caution: **treat any WebGPU/WGSL change as unverified until it passes `test/webgpu.test.ts` or runs on real hardware** — `npm test` alone only proves the CPU reference is correct, not the GPU path, and two real bugs (a WGSL operator-precedence error, a BVH empty-scene infinite loop) only ever surfaced this way. Details and history in [ai/ARCHITECTURE.md](ai/ARCHITECTURE.md#webgpu-is-a-separate-risk-surface).
