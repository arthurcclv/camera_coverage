# CONVENTIONS.md — `@linkervision/camera-coverage-sdk`

Coding standards and organization for the SDK package. Match the existing code.
See [WORKFLOWS.md](./WORKFLOWS.md) for the spec-first process that governs *when*
you write code, and [ARCHITECTURE.md](./ARCHITECTURE.md) for module layout.

## The spec is the source of truth

Behavior lives in `specs/spec.md`, not in code you happen to read. Source
comments cite spec sections directly (`// §6.2`, `§7.2 pre-cull`). When you touch
behavior, update the spec first and keep the two in lockstep — a diff that
changes behavior without a matching spec edit is incomplete. This is a hard rule.

## TypeScript

- **`strict` everywhere**, `tsc --noEmit` clean.
- **Explicit `.ts` import extensions** (`./engine.ts`) and `import type` for
  type-only imports — required by `verbatimModuleSyntax` +
  `allowImportingTsExtensions`. The package is published and run as raw `.ts`.
- **No TS `enum`.** The package is `erasableSyntaxOnly` (Node type-strips at
  runtime), so no construct may emit runtime code from types (enums, parameter
  properties, namespaces). Runtime enum-like values use the `const` object +
  type-alias pattern:
  ```ts
  export const CellType = { EmptySpace: 0, MixedSpace: 1, SolidGeometry: 2 } as const;
  export type CellType = (typeof CellType)[keyof typeof CellType];
  ```
  Same shape for `EngineErrorCode`.
- **Typed arrays for hot data.** Geometry, voxel, camera, BVH, and result buffers
  are `Float32Array`/`Uint32Array`/`Uint8Array`, laid out to match GPU struct
  layouts and to cross the worker boundary as transferables — never object
  arrays.
- **Fixed-size vectors are tuples:** `Vec3 = [x,y,z]`, `Quat = [x,y,z,w]` (xyzw).

## Errors

Throw `EngineError(code, message, detail?)` with a code from `EngineErrorCode`
(`WEBGPU_UNAVAILABLE`, `SCENE_TOO_LARGE`, `TOO_MANY_CAMERAS`,
`CAMERA_INSIDE_GEOMETRY`, `DEVICE_LOST`, `INVALID_STATE`) for any condition a
caller might branch on — never a bare `Error`. Codes are part of the public API.

## Naming & files

| Kind | Convention | Example |
|---|---|---|
| Modules | camelCase, kebab-case when multi-word | `engine.ts`, `triangle-aabb.ts` |
| Grouped modules | subfolder by concern | `compute/`, `geometry/`, `worker/`, `wasm/` |
| Constants | `SCREAMING_SNAKE` | `MAX_CAMERAS`, `CAM_WORDS`, `PASS2_VISIBILITY`, `LEAF` |
| Tests | `<subject>.test.ts` under `test/` | `acceptance.test.ts`, `wasm.test.ts` |
| Rust crate | snake_case | `camera_coverage_wasm`, `build_bvh` |

## The public API surface

Everything re-exported from `src/index.ts` is public and versioned. The headline
surface is `createEngine()` / `CoverageEngine`, the `VisibilityEngine` interface,
and `accessor(result)`. Lower-level building blocks (`buildBvh`,
`computeOccupancy`, `buildSvo`, `prepareCamera`, the WGSL shader sources, …) are
also exported for custom pipelines and visualization — keep them stable, and add
new exports to `index.ts` deliberately.

## Documentation in code

- Public types and exported functions get JSDoc that cites the spec section they
  implement (see `src/types.ts`).
- Non-obvious interpretations of ambiguous spec points are documented; the
  `README.md` collects them under "Notes & spec interpretations."
- Non-trivial invariants (CAM_WORDS masking, transfer ownership, the
  stackless-traversal hit/miss links) are explained inline where they live.

## Parity — the four axes that must stay in sync

See [ARCHITECTURE.md](./ARCHITECTURE.md). When you change one side, change the
other and update the parity test:

- CPU backend (`compute/cpu.ts`, `kernel.ts`) ↔ WGSL (`shaders.ts`) — same struct
  layouts, ray test, traversal.
- Rust WASM kernels (`crates/`) ↔ pure-TS kernels (`kernels.ts`, `svo.ts`, …).

## Testing

- Runner is `node:test` (`node --test --experimental-strip-types "test/**/*.test.ts"`).
  No Jest/Vitest, no bundler.
- **Every change ships with a test** — unit, acceptance (§18), WASM-parity, or
  WebGPU as applicable. Manual verification alone is insufficient.
- `test/acceptance.test.ts` encodes spec §18 scenarios and is the behavioral
  contract; the CPU backend is the reference it runs against.
- `test/wasm.test.ts` skips cleanly when the `.wasm` artifact hasn't been built.
- `test/webgpu.test.ts` is the only file exercising real WGSL (native Dawn); it
  skips when no GPU adapter is present. A WGSL change is unverified until it runs
  here or on real hardware.
