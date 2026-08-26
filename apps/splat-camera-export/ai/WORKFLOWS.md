# WORKFLOWS.md — splat-camera-export

How to work on this app. Repo-wide rules live in the root `CLAUDE.md`.

## Commands

```bash
npm run dev         # vite dev server
npm run build       # tsc -b && vite build
npm run typecheck   # tsc --noEmit
npm test            # node --test over the pure modules
```

## The spec-first loop

1. **Read the relevant `specs/spec.md` section.** It is the source of truth, not
   background reading.
2. **For any behavior change, edit the spec first and get approval** before writing
   implementation code.
3. Implement, with each touched file's header comment still citing the right section.
4. **Add or update tests** for the change.
5. **Update the `ai/` docs** in the same change if it alters module structure, adds or
   reverses a decision, introduces a convention, changes a dependency, or changes a
   visual rule. New decisions go at the **top** of DECISIONS.md.

A diff that changes behavior without a matching approved spec edit is incomplete.

## Verifying a change

`npm test` and `npm run typecheck` cover the pure modules and the types. They **cannot**
tell you the export is correct — every bug this app has actually shipped was invisible to
them (a black zip, a wireframe baked into a deliverable, a mirrored image). Anything
touching the render or export path needs the end-to-end check.

### The end-to-end check

Renders a synthetic splat through two cameras and inspects the resulting zip. The
fixture is a **3×3 grid of large, opaque, differently-coloured Gaussians** — chosen
because it is *vertically asymmetric*, so a row-flip bug is detectable by sampling
pixels rather than by eye.

1. Generate the fixture: a 9-splat binary-little-endian PLY with the standard property
   set (`x y z f_dc_0..2 opacity scale_0..2 rot_0..3`), remembering that the renderer
   applies a sigmoid to `opacity`, `exp` to `scale`, and `0.5 + C0 * f_dc` to colour
   (`C0 = 0.28209479177387814`) — so the fixture must write the inverses. Plus a
   `scene.json` with two cameras of **different aspect and FOV**.
2. `npm run dev`, then drive it with Playwright headless Chromium:
   `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`.

   > **This only ever tests WebGL2.** `navigator.gpu` is absent in Playwright's Chromium
   > on this machine under every flag combination tried (`--enable-unsafe-webgpu`,
   > `--enable-features=Vulkan`, `--use-vulkan=swiftshader`,
   > `--enable-dawn-features=allow_unsafe_apis`). The two backends have **independent**
   > render-target readback implementations, so a green suite says nothing about WebGPU.
   > Anything touching readback needs a manual check in a real browser on both backends —
   > use the **Auto / Force WebGL2** switch in Render settings to compare.
3. Feed the files (`setInputFiles`: the splat input is the `multiple` one), click Export,
   capture the download.
4. **Check the pixels, not just the files.** Assertions that actually catch bugs:
   - the image has **many distinct colours** (a black zip has exactly 1)
   - the dominant colour equals the configured clear colour
   - sampling each expected blob centre yields the **right colour at the right
     position** — this is what proves the vertical flip, the horizontal orientation,
     and the pose are all correct
   - no frustum wireframe is present
   - `cameras.json` sizes match the per-camera aspects (a 16:9 and a 1:1 camera must
     export 1920×1080 and 1080×1080 under derive mode)

Reference: `spec.md` §12 lists what is unit-tested versus GPU-only.

## Adding a camera-format field

The reader is intentionally duplicated from `sample-app` (see DECISIONS.md), so adding a
field means:

1. Spec §5.2's table, first.
2. `cameras/sceneCameras.ts` — the field, its default, and its validation message.
3. `test/sceneCameras.test.ts` — the default *and* the failure message.
4. `export/manifest.ts` + its test, if the field should be recorded.

## Gotchas that will cost you an hour

- **Don't pass `{ renderTarget }` to `Texture.read`.** It reads the multisampled
  framebuffer and silently returns zeros. §8.3.
- **Don't shorten the settle protocol.** Splats sort in a worker and the order uploads a
  frame later; the 250 ms timeout is required because the engine skips re-sorting when
  the camera barely moved. §8.2.
- **Don't leave immediate-mode debug drawing on during a run.** It renders for every
  active camera, including the rig. §6.3.
- **Don't set `asset.data` on a SOG asset.** The parser treats a present `data` as an
  already-fetched meta and skips loading it. §4.
- **Don't route an exact rotation through the Euler prop.** Use `setRotation` with the
  quaternion.
- **Don't persist a default.** Writing the auto-applied alignment to `localStorage` makes
  it indistinguishable from a user choice on the next load, which freezes the default for
  every capture already opened once. Persist only user-initiated changes; bump
  `ALIGNMENT_STORAGE_PREFIX` if the rules change. §7.4.
- **Don't pass `enabled` to the React `Entity`.** It typechecks and does nothing — the
  library applies only `name`, `position`, `scale`, `rotation`. Set enablement on the
  entity imperatively. Two enabled cameras present as a *frozen viewport*, not as an
  error. §6.1.
- **Don't drop `immediate: true` from the readback.** On WebGPU the copy is then mapped
  without being submitted, and every exported image is black. Invisible to the automated
  suite, which only gets WebGL2. §8.3.
- **Don't flip readback rows unconditionally.** WebGL2 is bottom-up and needs it; WebGPU is
  already top-down and gets mirrored by it. §8.4.
- **A vertically symmetric test image proves nothing about orientation.** The PLY fixture's
  colour grid is asymmetric on purpose.

## Testing persistence

A test that "a saved value survives a reload" is not enough — that passed while the
default was frozen. Also assert that an **untouched** capture writes *nothing*, and that a
capture with a **stale** stored entry still picks up the current default.
