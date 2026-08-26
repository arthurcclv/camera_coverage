# @linkervision/splat-camera-export

Load a **3D Gaussian Splat** capture of a real site, import the camera layout you planned
in the coverage app, and export **one rendered image per camera** — what each planned
camera would actually see.

Where `apps/sample-app` answers *how much of the volume is covered*, this answers *what
shows up on the monitor*. A camera can cover 98% of a zone and still be aimed at a pillar.

## Quick start

```bash
npm install          # at the repo root
npm run dev -w @linkervision/splat-camera-export
```

Then, in the app:

1. **Load splat…** — a `.ply`, `.compressed.ply`, `.sog`, or a SOG bundle (select the
   `meta.json` *together with* its `.webp` files).
2. **Import scene.json…** — the file saved by the coverage app. Only its `cameras[]` is
   read; every other key is ignored.
3. **Align the splat.** A capture is reconstructed at an arbitrary origin, orientation,
   and scale, so this step matters — until it is right, the exports are pictures of
   nothing in particular.

   Captures start with a **180° Z rotation already applied**, since 3DGS captures load
   Y-down relative to a Y-up viewer; the app says so in a notice, and the
   **Flip 180° Z** button shows as pressed. If your capture was already upright, press
   **Reset** — that choice is remembered, so you only do it once per file.

   From there, dial position/rotation/scale and switch to **Through camera** to confirm
   the framing before committing to a batch. Your alignment is remembered per capture
   (and always wins over the default on reload) and can be exported as `alignment.json`.
4. **Export.** You get a zip of images plus a `cameras.json` manifest.

## Output

```
scene-camera-renders.zip
  Front.png               # named after the camera
  Loading-bay.png
  cameras.json            # pose, projection, size, and alignment for every image
```

Each image is named for the camera that shot it, so it stays identifiable outside the zip.
Names are sanitized for cross-platform filesystems, and duplicates get a `-2`, `-3` suffix
(camera names are free text, so two can genuinely match). Filenames don't encode scene
order — `cameras.json` preserves that.

Under the default **From camera** resolution mode each image keeps its camera's authored
aspect at a 1080 px height — so a 16:9 camera exports 1920×1080 and a 1:1 camera exports
1080×1080. **Fixed** mode applies one size to all.

`cameras.json` records both `far` (as authored in `scene.json`) and `farRendered` (what was
actually used), plus the alignment transform, so a batch is reproducible.

## Notes

- **`far` is overridden by default.** In `scene.json`, `far` bounds the volume a camera is
  credited with *covering* (often ~30 m). Used as a clip plane it would slice the visible
  splat, so rendering uses 1000 m unless you tick *clip at camera `far`*.
- **Coverage-disabled cameras** are imported and listed but excluded from the run by
  default — "disabled for coverage" doesn't mean "uninteresting to preview".
- **Cancelling downloads nothing.** A partial batch presented as a deliverable is worse
  than none.
- Requires WebGL2; WebGPU is used when the browser offers it.

## Development

```bash
npm run dev
npm run build
npm run typecheck
npm test
```

`specs/spec.md` is the source of truth for behavior. `ai/` holds design, architecture,
decisions, conventions, workflows, stack, and visual-design notes — start with
[`ai/DESIGN.md`](ai/DESIGN.md).

**If you touch the render or export path**, run the end-to-end check in
[`ai/WORKFLOWS.md`](ai/WORKFLOWS.md). The unit tests cannot catch the failures that matter
here: this app's bugs tend to produce plausible output (correctly-named, correctly-sized
images that are black, mirrored, or contaminated) rather than errors.
