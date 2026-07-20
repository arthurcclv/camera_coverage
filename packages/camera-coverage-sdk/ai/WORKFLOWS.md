# WORKFLOWS.md — `@linkervision/camera-coverage-sdk`

Common development workflows for the SDK. Repo-wide workflow rules live in the
root [`../../CLAUDE.md`](../../CLAUDE.md); this file is the SDK-specific detail.

## Commands

```bash
npm test                                    # node --test --experimental-strip-types "test/**/*.test.ts"
npm test -- --test-name-pattern "<name>"    # run a single test
npm run typecheck                           # tsc --noEmit
npm run build:wasm                          # crates/ → src/wasm/*.wasm (needs rustup + wasm32 target)
```

Node ≥ 22.6 is required — the SDK runs its TypeScript sources directly via native
type-stripping, so there is no build step for the library itself.

## The spec-first loop (mandatory for behavior changes)

This is the load-bearing workflow. Do **not** write implementation code ahead of
an approved spec change.

1. **Read the relevant spec section(s)** in `specs/spec.md` before touching
   anything. It is the source of truth, not background reading.
2. **Write the spec edit first** describing the new/changed behavior, and
   **present it for approval** before implementing.
3. **Implement** against the approved spec. Keep the spec-section → module table
   in `README.md` accurate if you add/move modules.
4. **Update the README's "Notes & spec interpretations"** if you made a new
   interpretation of an ambiguous point.
5. **Update the affected `ai/` doc(s) in the same change** — module/structure
   changes go in [ARCHITECTURE.md](./ARCHITECTURE.md), a new or reversed
   trade-off goes in [DECISIONS.md](./DECISIONS.md) (newest at top), a new
   coding pattern goes in [CONVENTIONS.md](./CONVENTIONS.md), a dependency/tooling
   change goes in [STACK.md](./STACK.md). Don't let these go stale.
6. **Add/adjust tests** (see below) — every change ships with a test.
7. **Verify** the spec and code haven't drifted; a behavior diff without a
   matching spec edit is incomplete.

## Choosing which test to add

| Kind of change | Test file |
|---|---|
| A spec §18 scenario / end-to-end behavior | `test/acceptance.test.ts` |
| A single module's logic (grid, camera, bvh, occupancy, svo, sampling) | `test/unit.test.ts` |
| Anything in the Rust crate or the TS↔WASM parity | `test/wasm.test.ts` |
| Worker protocol / streaming / client proxy | `test/worker.test.ts` |
| WGSL shaders / WebGPU compute path | `test/webgpu.test.ts` |

## Fixing a bug in a duplicated algorithm

The codebase keeps parallel implementations (see
[ARCHITECTURE.md](./ARCHITECTURE.md)). When you fix one, fix its twin:

- Bug in CPU compute (`compute/cpu.ts` / `kernel.ts`)? Check the WGSL
  (`shaders.ts`), and vice versa.
- Bug in a TS kernel (`kernels.ts`, `svo.ts`, `occupancy.ts`, `bvh.ts`)? Check
  the Rust crate (`crates/camera_coverage_wasm/src/lib.rs`), and vice versa.

Then update the parity test (`wasm.test.ts` for preprocessing, `webgpu.test.ts`
for compute) so the fix is pinned.

## Working on the WebGPU / WGSL path

`npm test` does **not** run real WGSL — it validates the CPU reference only.

1. Make the WGSL change in `src/shaders.ts` (mirror the CPU kernel exactly).
2. Run `npm test` — proves the CPU reference still holds.
3. Run `test/webgpu.test.ts` (part of `npm test`; needs a real GPU adapter via
   the `webgpu` native-Dawn package). **This is the only headless way to validate
   WGSL here** — Playwright/automated browsers on this machine expose no
   `navigator.gpu`.
4. Treat the change as unverified until step 3 (or real browser/hardware) passes
   — see [ARCHITECTURE.md](./ARCHITECTURE.md#webgpu-is-a-separate-risk-surface)
   for the two historical bug classes this step exists to catch.

## Building the Rust WASM kernels

```bash
rustup target add wasm32-unknown-unknown   # once
npm run build:wasm                         # → src/wasm/camera_coverage_wasm.wasm
```

The WASM tests skip cleanly if the artifact isn't built, so this is only needed
when working on the crate. The crate is a `cdylib` with a raw-pointer ABI (no
wasm-bindgen); if you change a kernel's ABI, update `src/wasm/loader.ts` in the
same change.

## Adding to the public API

New exports go through `src/index.ts` deliberately — everything there is public
and versioned. Prefer extending existing types (`ComputeOptions`, `EngineOptions`)
over adding new top-level surface.
