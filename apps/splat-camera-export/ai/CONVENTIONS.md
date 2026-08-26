# CONVENTIONS.md — splat-camera-export

Coding standards. Match the existing code. See [WORKFLOWS.md](./WORKFLOWS.md) for the
spec-first process and [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map.

## The spec is the source of truth

Built from `specs/spec.md`. **Every source file opens with a doc comment citing the
spec section it implements.** Behavior changes update the spec first — see WORKFLOWS.md.

## The pure/impure split

The rule that shapes this codebase: **if it makes a decision, it goes in a pure module
and gets a test.** If it touches the GPU, the DOM, or the filesystem, it stays thin and
delegates every decision outward.

Concretely, an impure module may sequence, allocate, and plumb. It may not decide a
pixel size, a filename, a validation outcome, or a manifest field. `runExport.ts` is the
reference example: it owns the loop but calls `imageSizeFor`, `buildFilenames`, and
`buildManifest` for everything substantive.

## TypeScript & React

- **`strict`**, `tsc --noEmit` clean. `verbatimModuleSyntax`, `isolatedModules`,
  Bundler module resolution.
- **`.tsx`** for components (PascalCase, one per file); **`.ts`** for logic.
- Internal imports use explicit **`.ts` / `.tsx` extensions** (Vite resolves them).
- Plain React 19 with hooks — no component library, no CSS framework. Panels are
  `.panel` / `.panel-title` / `.hint` structures styled by class in `index.css`.
- **One-way data flow.** `App.tsx` holds canonical state and passes props down;
  children report events through callbacks. No imperative handles, no shared mutable
  state between App and the viewport.
- **Accessibility:** semantic roles are used — `listbox`/`option`, `radiogroup`/`radio`,
  `progressbar`, `aria-pressed`, `aria-selected`, and `aria-label` on every icon-only
  or ambiguous control.

## Result types over exceptions at boundaries

Parsers and runs return discriminated results, not thrown errors:

```ts
type ReadCamerasResult = { ok: true; cameras; notices } | { ok: false; error: string }
type ExportRunResult   = { status: 'done'; … } | { status: 'cancelled' } | { status: 'error'; error }
```

Every `error` string is **user-facing and specific** — it names the field and index
(`cameras[3]: rotation must be 4 finite numbers`) or the camera label. Exceptions are
reserved for programmer errors (a released render target, a missing 2D context).

`notices` is separate from `error` on purpose: a future `formatVersion` or an empty
camera list is worth saying but must not block the import.

## Naming

- Pure predicates read as questions: `isSafeAssetPath`, `isFlippedZ`, `isSplatEntry`.
- Builders say what they build: `buildFilenames`, `buildManifest`, `imageSizeFor`.
- Constants are `UPPER_SNAKE` (`SORT_TIMEOUT_MS`, `MIN_DIMENSION`, `DEFAULT_FAR`).
- Engine types that clash with app types are aliased at the import
  (`Entity as PcEntity`, `Quat as PcQuat`).

## Comments explain *why*, especially where the code looks wrong

This app has several places where the obvious code is the broken code. Those get a
comment stating the trap, because a future reader's instinct is to "fix" them:

- readback deliberately omitting `renderTarget` (§8.3)
- the sort-settle timeout being required rather than defensive (§8.2)
- markers unmounted rather than hidden (§6.3)
- `asset.data` left unset so the SOG parser still fetches its meta (§4)

Don't add narration comments for code that reads plainly.

## Tests

`node --test` with native type-stripping; one file per pure module, mirroring its name.
Tests assert **behavior and messages**, not implementation. Each covers the happy path,
every documented default, and every documented failure message.

When a test and the code disagree, work out which one encodes the real invariant — the
Euler round-trip test was wrong, not the code (see DECISIONS.md).
