# Voxel Volumetric Rendering

Technical design of the sample app's **voxel volumetric renderer** — a generic
primitive that draws a set of voxels as volumetric fog. It is **independent of what
the voxels mean and how they are colored**: the caller supplies, per voxel, a
position, an edge size, a scalar **intensity**, and a **color**. Mapping coverage
data onto those inputs, and the user-facing visualization modes (e.g. white coverage
fog, red blind-spot fog), are defined in [`spec.md`](./spec.md) §9 — **not here**.

App-wide terms (coverage, coverage fraction, blind spot) are defined in
[`spec.md`](./spec.md) §13.

---

## 1. Purpose & interface

The renderer turns a set of voxels into translucent volumetric fog. Its entire
contract is per-voxel appearance plus one global knob — it carries no notion of
coverage, cameras, or which color means what.

Per-voxel input:

- **center** — cube center, world space.
- **size** — cube edge length, world space.
- **intensity** — scalar ≥ 0 (normally 0..1); how strongly the voxel contributes.
- **color** — RGB.

Global input:

- **intensityScale** — a single multiplier applied to every voxel's **alpha** (§3),
  so it is an overall *opacity* knob rather than a brightness one. Defaults to **1**:
  compositing takes the max along a ray rather than a running sum (§4), so a
  fully-covered voxel is opaque and a 9%-covered one is a 9% wash however many
  voxels stand behind it — the value needs no re-tuning as the workspace grows.
- **compositeMode** — how a voxel's fragment varies across its own silhouette. It
    selects the **path term** only (§3); both modes composite identically, as alpha
    over the scene (§4).
  - **`flat`** (default) — the chord term is **dropped**, so every fragment of a
    voxel is equally opaque and cubes read as hard-edged.
  - **`soft`** — the fragment's alpha scales with the **fraction of the cube the
    view ray crossed**, fading each voxel out at its silhouette edges so a cloud
    reads as fog rather than as a cluster of cubes.

The renderer takes **no draw-order input**. It renders alone, in its own scene and
its own pass (§4), so there is no other layer in the pass to sequence it against —
occlusion against the rest of the scene comes from the shared depth buffer instead.
It therefore takes no part in the caller's transparent-layer convention
(`scene/renderOrder.ts`, `spec.md` §9, §13.5).

The renderer exposes an incremental build API (`reset()` + add-voxels) so callers
can stream voxels in as they are produced; it does not know or care where the
voxels come from.

---

## 2. Proxy geometry

A single unit cube mesh, **GPU-instanced** (`THREE.InstancedMesh`), one instance per
voxel, drawn with a **GLSL `ShaderMaterial`** under Three.js's `WebGLRenderer`
(`spec.md` §2.3). The cube is **not** shaded as a surface — it is only the bounding
volume of the fog cell; the material's **fragment shader** computes the fog
contribution for the portion of the view ray inside it.

Each instance's **transform** (the `InstancedMesh` instance matrix: `center` +
uniform scale = `size`) places and scales the proxy cube so the rasterizer produces
fragments over its screen footprint. The fog math itself reads the cube's geometry
from dedicated per-instance attributes rather than decoding the matrix, so the
shader forms the world-space AABB (`center ± size/2`) directly and portably.

Per-instance data (`THREE.InstancedBufferAttribute`s, passed to the fragment shader
as varyings):

- **center** (vec3 attribute) and **size** (float attribute) — the cube's world-space
  AABB is `center ± size/2`.
- **intensity** (float attribute).
- **color** (vec3 attribute).

---

## 3. Ray–voxel intersection & contribution (fragment shader)

For each fragment of each instance, in world (or view) space:

1. Form the view ray (from the camera position through the fragment).
2. **Slab-test** the ray against the instance's cube AABB → `t_enter`, `t_exit`.
3. **Chord length** `chord = max(0, t_exit - t_enter)` — the distance the ray
   travels inside the voxel. A ray through the cube center travels ~`size`; a ray
   grazing an edge travels less.
4. **Path term**, per `compositeMode` (§1) — a 0..1 fraction, never a length:
   - **`flat`** (default): `pathTerm = 1`. Every fragment of a voxel emits the same
     value, which reads as hard cube silhouettes.
   - **`soft`**: `pathTerm = clamp(chord / size, 0, 1)` — the fraction of the cube
     the ray crossed. This produces **soft volumetric falloff** at cube edges instead
     of hard silhouettes, and is the reason for a per-fragment (not
     per-instance-constant) shader.
5. **Fragment**: `rgb = color`, `alpha = clamp(intensity * pathTerm * intensityScale, 0, 1)`.

**The colour is the hue; the intensity is the opacity.** This is the load-bearing
choice, and it is what §4's compositing depends on. `intensity` drives **alpha**, so
a voxel at 9% coverage paints a 9% wash of its hue over whatever is behind it and
cannot be "outvoted" by a bright backdrop. The fragment emits that colour
**premultiplied** (`color * alpha`), which is what lets the fog target be max-blended
without the hue and the alpha coming apart (§4).

**Resolution independence.** `pathTerm` is a dimensionless 0..1 fraction in both
modes, so neither mode's per-voxel alpha depends on voxel size — and compositing
takes the **max** along a ray rather than a sum (§4), so putting more voxels on the
same ray does not thicken the fog either. `intensityScale` therefore holds its
meaning across both a refined grid and a larger workspace.

The slab/chord math is authored as a **pure TypeScript reference** and unit-tested;
the GLSL fragment shader mirrors it (see §6), echoing the SDK's "CPU reference is the
tested truth" discipline. That mirroring carries the whole verification burden here —
WebGL2 is the only render backend (`spec.md` §2.3), and a shader cannot run under
`node --test`, so the reference is what is actually tested and the shader is held to
it by review and by a source-parity test.

---

## 4. Compositing — max among the fog, alpha over the scene

The fog needs **two different blend rules at once**, and a single draw call has
only one:

- *among its own voxels* — a per-channel **max**, so a pixel shows the single
  strongest voxel along the ray and a deep column of fog does not pile up;
- *against the scene* — **alpha over**, so the fog stays legible on a bright floor
  or a photographic capture.

Drawing the fog into the main framebuffer forces a choice, and **both choices are
wrong**:

| Blended into the main framebuffer | What breaks |
|---|---|
| `MaxEquation` | Maxes against the *scene colour*, which becomes a per-channel floor. On a large site per-voxel coverage falls below a lit floor on every channel and the overlay **disappears entirely** while still being drawn. |
| Source-over alpha | Accumulates as `1 - (1 - a)^n` through the depth of the workspace, turning the overlay into an **opaque wall** that hides the model. |

So the fog is a **two-target pass** (`scene/fogCompositor.ts`):

```
pass 1  scene  -> sceneTarget (colour + DepthTexture)
pass 1b splat depth (depth only, no colour) -> sceneTarget
pass 2  fog    -> fogTarget, cleared (0,0,0,0), colour only
                  depth attachment SHARED with sceneTarget, depth-test on,
                  depth-write off, MaxEquation, premultiplied color*alpha
pass 3  full-screen triangle -> canvas
                  screen = scene.rgb * (1 - fog.a) + fog.rgb
pass 4  overlay scene -> canvas, autoClear off (§4.1)
                  occlusion by shader discard against sceneTarget's DepthTexture,
                  sampled once per overlay at its anchor -> all-or-nothing
```

- **Max is safe in pass 2** precisely because that target holds *only fog*. There
  is no scene colour to lose a max against, so a pixel ends up at the strongest
  voxel and stacking never accumulates — and max is commutative, so the fog needs
  **no depth sorting and no OIT**, in any draw order.
- **The fragment is premultiplied** (`color * alpha`, `alpha`). The overlay is a
  single hue (`spec.md` §9), so `max(C·aᵢ) = C·max(aᵢ)` and colour and alpha stay
  consistent; emitting straight colour would max the hue independently of the alpha
  and desaturate the winner.
- **Depth is shared, not recomputed.** `fogTarget` is given `sceneTarget`'s
  `DepthTexture`, so the fog depth-tests against exactly what the main pass wrote —
  geometry in front of a voxel hides it — with **no second traversal of the scene**
  and no list of which objects count as occluders. The fog pass clears colour only;
  clearing depth would let every voxel through.
- **`depthWrite: false`** so voxels never occlude each other.
- **Pass 1b exists because one scene layer writes no depth of its own.** 3DGS
  captures are drawn `depthWrite: false` to preserve Spark's own back-to-front
  blending, so pass 1 leaves nothing in the `DepthTexture` where a capture stands
  and the fog would paint straight over it. A depth-only redraw of the splat group
  supplies that depth without disturbing the visible pass — owned and specified by
  `gaussian_splats.md` §4.5. Everything else in the scene is an ordinary
  depth-writing mesh and needs no such help.
- **Pass 3 has no per-channel floor**: the fog contributes in proportion to its
  alpha instead of having to out-brighten what is behind it.

Two things about this pass are easy to get wrong, and both were:

- **Pass 2 must not auto-clear.** Three.js clears the bound target on every
  `render` unless `autoClear` is off, which silently wipes the depth pass 2 exists
  to read. The symptom is not subtle and not an error: the fog draws over
  everything, through walls included.
- **Pass 3 owns the colour-space conversion.** Three.js applies its output
  transform only when rendering to the canvas, so both targets hold **linear**
  values. The composite mixes them in linear — which is correct — and must convert
  to the output colour space itself (`#include <colorspace_fragment>`). Omit it and
  every pixel ships linear values to an sRGB display: the entire scene, not just
  the fog, renders visibly darker.

**Ordering against the other transparent layers is depth, not draw order.** The fog
is alone in its own scene and its own pass, so a `renderOrder` on its mesh would
sequence it against nothing. Its relationship to the section heatmap planes and the
volume fills is decided in pass 2 and pass 3 instead, and the two come out
differently:

- the **section plane writes depth** (`spec.md` §13.5), so it lands in the shared
  `DepthTexture` and a plane in front of a voxel hides it — per viewpoint, which is
  what the old fixed draw order was approximating;
- the **volume fill does not** (`depthWrite: false`, `sampling_volumes.md` §5), so
  it leaves nothing for pass 2 to test against and the fog composites **over** it.
  The fill therefore no longer tints over the fog; the fog tints over the fill.

The fog consequently takes no entry in `scene/renderOrder.ts` — that table lists
only the layers whose order still decides something.

The cost over drawing in-scene is one full-screen colour target, one full-screen
triangle, and the blit of the scene through it.

### 4.1 Pass 4 — the post-composite overlay

Not everything drawn in the scene wants to be *hazed* by the fog. The camera **name
labels** (`spec.md` §5.3) are chrome that names an object, not a surface the fog is
measuring: a label under the overlay is exactly as unreadable as the fog is dense,
which is the opposite of what a label is for. They are therefore drawn in a **fourth
pass**, straight to the canvas after pass 3, from a scene of their own that is never
added to the viewport scene — the same arrangement the fog itself uses, and the same
`autoClear: false` composite the orientation gizmo's corner draw already does
(`spec.md` §2.4). Pass 4 runs **before** that gizmo, which stays topmost.

**Pass 4 has no usable depth buffer, and that is the whole design problem.** Pass 3 is
a full-screen triangle: it writes colour to the canvas and nothing else, so by pass 4
the canvas depth bears no relation to the scene. An overlay that still wants to be
occluded by geometry — and the labels do, so a camera behind a wall does not announce
itself through the wall — therefore cannot use `depthTest` at all. It reads
`sceneTarget`'s `DepthTexture` in its own shader instead, the same shared depth the fog
depth-tests through in pass 2; `FogCompositor` exposes it as `sceneDepthTexture` for
the purpose.

**The sample is taken at the overlay's *anchor*, not per fragment — so the test is
all-or-nothing.** A label is chrome attached to a point in the scene: what decides
whether it may be seen is whether **that point** is obstructed, not whether each of its
pixels is (`spec.md` §5.3). The vertex shader therefore carries the anchor's screen
position and view depth to the fragment shader as varyings — constant across the quad,
since every corner is offset from one anchor — and the fragment shader samples the
depth texture *there*. The whole quad survives or the whole quad discards; a pillar
crossing the label does not cut the name in half, and the surviving label draws over
geometry, captures and fog alike.

Sampling in the fragment shader rather than the vertex shader is deliberate: the test's
result is per-**label**, but `discard` only exists in the fragment stage, and a vertex
texture fetch buys nothing when the sample is the same for all four vertices.

**The test is damped, not switched** (`spec.md` §5.3). One texel against one threshold
is a knife edge in two directions at once — the anchor's pixel drifts sub-pixel as the
view moves, and the depth written there is itself unstable where the anchor is
near-coplanar with a surface or standing in front of a capture whose depth comes from
the pass 1b redraw. A label on that boundary flickers frame to frame; a label crossing a
wall's silhouette pops. So the raw result is smoothed twice over.

**Spatially**, inside the probe shader: each tap ramps across a depth **band** instead
of switching, the taps are taken over a small ring (3x3, a few device pixels across)
instead of one texel, and their mean is shaped so mostly-clear reads fully visible and
mostly-buried fully hidden.

**Temporally**, by keeping one texel of state per overlay and easing it toward the raw
result — which needs a pass of its own, because the state has to survive the frame:

```
pass 4a probe points -> stateTarget (capacity x 1, RGBA16F), never cleared
                        one point per label, its slot picks the texel
                        raw visibility from the depth ring + band
                        blend CONSTANT_ALPHA / ONE_MINUS_CONSTANT_ALPHA
                        => texel = k * raw + (1 - k) * texel  (an EMA)
pass 4  label quads  -> canvas, alpha = its own texel of stateTarget
                        discard below ~0 visibility / ~0 texel alpha (an early-out)
```

The two `discard` thresholds in pass 4 are an **early-out, not the test**: the eased
value multiplies alpha, as above, and both cutoffs sit far enough below anything visible
to be a cost saving only — a label already faded out, and the label's transparent
margin.

The easing is done **by the blend unit**, not in a shader: `gl.blendColor`'s constant
alpha is `k`, so the target accumulates an exponential moving average of the raw test
with no ping-pong pair and no read of the bound target. `k = 1 - exp(-dt / tau)` with
`tau` ~150 ms makes the fade **frame-rate independent**, and `dt` is clamped so a long
stall resumes with a bounded step instead of a jump.

Three consequences worth knowing:

- **The state target is never cleared** after its one-time initialisation to 0, which is
  also why a new label fades in: its texel starts at zero. The two events that would
  otherwise force a clear are handled without one, because a clear would restart *every*
  label's fade — visible on a ~96-camera site, where the first growth step fires during a
  normal load. A slot handed on from a departed label has **its own texel** zeroed by a
  one-point draw, so the new label fades in and no other average moves; and a **capacity
  change copies** the old row into the grown target rather than starting it empty — one
  triangle over the new row, sampling the old texture at `uv.x * newCapacity /
  oldCapacity`, which is texel-for-texel under `NearestFilter` and zero past the old
  capacity. Both are draws and pass 4a's own caller has the renderer, so both are queued
  and flushed at the top of the next pass 4a, before the probe.

  Both are draws rather than a scissored or viewport-limited **clear** for one reason
  worth writing down: `WebGLRenderer` multiplies a viewport and a scissor by its pixel
  ratio, so on a HiDPI display either would address the wrong texels of a target whose
  size is counted in labels, not in screen pixels.
- **Pass 4a is one fragment per label**, so the nine depth taps are paid ~100 times a
  frame rather than once per label pixel — cheaper than testing in the label shader, not
  just smoother.
- **RGBA16F, not RGBA8**: an 8-bit texel quantises the EMA's increments and the average
  stalls short of its limit. Half float costs 2 bytes per label and removes the
  question.

Two things this pass must get right:

- **Compare linearised depths.** A `DepthTexture` holds the non-linear window-space
  `z`, whose precision is crushed toward the far plane; comparing raw values makes the
  discard threshold distance-dependent. Both sides are linearised to view-space
  distance first, which means branching on the **projection in use** — the app has
  three orthographic views as well as two perspective ones (`spec.md` §2.4), and the
  ortho linearisation has no reciprocal term.
- **Clear the anchor's own object.** The depth at a camera's anchor pixel is usually
  the camera **body**'s front surface — the body is in the scene, centred on that very
  point — so a strict comparison would hide every label behind its own gizmo. The
  comparison carries a tolerance of the body's **radius** plus what the depth buffer
  itself cannot resolve at that distance, and nothing else. Both terms are sized from
  something real. The radius is the body's own, world-sized and fixed at every scale
  (0.22 m) — but the **larger** of the two body sizes, the selected body's 0.308 m, and
  the same for every label: one uniform rather than a per-anchor attribute, because the
  0.09 m between them is well under the precision term it is added to. The precision
  term is a 24-bit buffer's worst-case quantisation — `z² · (1/near − 1/far) / 2²⁴`
  under a perspective camera, a constant `(far − near) / 2²⁴` under an orthographic one
  — carried with a **safety factor of 8**, because quantisation is only the first of the
  errors between a depth texel and the surface it stands for: the interpolation across
  the fragment and the linearisation back to view space each add their own, and a
  capture's pass-1b depth (§4) is noisier still than either. Eight of the cheapest
  error, not a fraction of the eye distance: the factor makes the term a *fixed*
  multiple of what the buffer cannot resolve, and at the app's `near`/`far` it is 0.76 m
  at 400 m and 6 m at 1120 m. A tolerance that instead grew as a fraction of the eye
  distance hides the failure this pass exists to catch: on a 1120 m site viewed from
  400 m, 1% of the distance is a 4 m blind spot around every body, and a camera mounted
  on a wall keeps its label when seen from the wrong side of the wall. The ramp band is
  one further tolerance wide, so an occluder is fully counted at twice it.
- **An anchor behind the eye reads as hidden.** Its clip `w` is negative, so its
  projected position is meaningless and the quad is clipped by the near plane anyway.
  Its state is driven to 0 rather than left where it was, so a label that comes back
  into view **fades in** instead of appearing at whatever opacity it had when it left.
- **Where the depth texture is empty, nothing is occluded.** Pass 1b fills in the 3DGS
  captures' depth (§4 above), so labels behind a capture are hidden by it; anything
  else that renders without writing depth will not occlude a label, and that is the
  correct default — an overlay hidden by something invisible is a bug report.

The cost is one extra draw of a handful of small quads and no additional target.

Consequences, for callers to reason about (§9 of `spec.md` relies on these):

- A voxel with `intensity = 0` is fully transparent and invisible (both modes).
- Higher intensity → more opaque, so the voxel's hue increasingly replaces what is
  behind it. This holds against a bright scene as much as a dark one.
- **Stacking does not thicken.** The pixel reflects the **single strongest** voxel
  along the ray, so depth of field costs nothing and `intensityScale` does not need
  re-tuning as the workspace grows.
- **`soft`-specific:** the chord fraction fades a voxel out at its silhouette edges,
  so a cloud reads as fog rather than as a cluster of cubes.
- **`flat`-specific:** every fragment of a voxel is equally opaque, so voxels read as
  hard cubes — which is what makes an individual voxel's coverage legible.

---

## 5. Rendering strategy

- Single instanced cube mesh; intensity, color, and transform as per-instance data
  → large sparse voxel sets render in one draw call.
- `depthWrite:false` with one fragment shaded per instance per covered pixel means
  heavy overdraw is expected; this is acceptable for the demo's scene sizes.
- **Back-face rasterization (`side: BackSide`).** Because the contribution is
  analytic (the slab test intersects the *view ray* with the AABB, with `t_enter`
  clamped to 0), the chord is identical whichever cube face generates the fragment.
  Back faces sit on the far side of each cube along the view ray, so they survive
  near-plane clipping and the camera being *inside* the fog volume — cases where
  front faces would be clipped or back-face-culled and the fog would appear cropped
  as the viewpoint moves. The instanced mesh is also `frustumCulled = false`, since
  its per-instance transforms spread far beyond the base cube's bounds. (In `flat`
  mode the fragment is a per-instance constant — `color` at
  `intensity * intensityScale` alpha, no chord — so it too is identical whichever
  face spawns the fragment, and a back-face fragment still guarantees the ray
  crosses the cube.)

---

## 6. Tests

Per repo policy (every change gets a test), following the `coverageOverlay.test.ts`
pattern (pure functions under `node:test`):

- **Chord length / slab test** — pure TS reference: ray through cube center returns
  ~`size`; edge-grazing ray returns less; a miss returns 0; ray origin inside the
  cube handled.
- **Path term** — `flat` returns 1 regardless of chord (a grazing and a full-chord
  ray of the same voxel agree); `soft` returns `chord / size`, is 0 on a miss, 1
  through the centre, and is **never > 1** whatever the voxel size.
- **Voxel alpha** — `alpha = clamp(intensity * pathTerm * intensityScale, 0, 1)`:
  `intensity = 0` → fully transparent; monotonic in `intensity` and in
  `intensityScale`; clamped at 1 so an over-driven scale cannot produce alpha > 1.
- **Alpha never depends on voxel size** — the property that keeps `intensityScale`
  stable when the grid is refined (§3). Two voxels of different `size` with the same
  intensity and the same *fractional* chord produce the same alpha.
- **Max composite among the fog** — the strongest voxel wins and stacking never
  accumulates (twenty voxels at 0.3 stay at 0.3); an empty set is fully transparent;
  the result is invariant under permutation, which is what removes the need for a
  depth sort. The accumulated colour stays premultiplied by the winning alpha.
- **Composite over the scene** — a transparent fog leaves the scene untouched; an
  opaque one replaces it; and a **dim fog over a bright scene is still visible**,
  tinting it — the property whose absence made the overlay vanish at site scale
  (§4).

- **Passes 4a + 4 (camera name labels, §4.1)** — `test/cameraLabels.test.ts`.
  `renderProbePass()` branches its depth linearisation on the projection in use and reads
  as unoccluded when there is no depth texture yet; the state target is **cleared exactly
  once** and the bound render target, `autoClear`, clear colour and viewport are all
  restored, pinned against a recording renderer stub; a layer with no labels runs no pass
  at all. The **never-cleared** guarantee is pinned on both its paths, by a recorded call
  sequence with no `clear` in it: a recycled slot produces one reset draw for exactly that
  slot, and crossing the capacity step produces one copy draw at the right scale — each
  followed by a frame that is a plain probe again.
- **The label's offset clears the body** — the vertex shader carries the body's world
  radius and projects it, so the 4 px gap is measured from the body's drawn edge; the
  radius follows the selection, which scales the body up.
- **The fade** — `fadeStep` is pinned as `1 - exp(-dt / tau)`: one 32 ms frame moves
  exactly as far as two 16 ms frames (frame-rate independence, the property the whole
  design rests on), a zero-length or backwards frame moves nothing, and a multi-second
  stall is capped — the cap sitting deliberately below `tau`. The blend factors
  (`ConstantAlphaFactor` / `OneMinusConstantAlphaFactor`) are asserted, since they
  *are* the easing; and the first frame's step is 0, which is what makes a label fade
  in on load rather than pop.
- **Shader source parity for both passes** — the label shader's `clip.w` pixel-size
  term, its state-texel lookup and alpha multiply, and its *absence* of any depth work;
  the probe shader's anchor-vs-slot split, both `…DepthToViewZ` conversions, the tap
  ring, the per-tap band `smoothstep`, the shaping `smoothstep`, the behind-the-eye
  case, and the absence of `gl_FragCoord` — sampling there would be exactly the
  per-pixel test `spec.md` §5.3 rules out. The **damping** is pinned the same way: the
  tap ring, the `smoothstep` band per tap, the shaping `smoothstep` over their mean, and
  the fact that the result multiplies alpha rather than driving a bare `discard`.

- **Shader source parity** — the GLSL fragment shader's source is asserted to carry
  the reference's terms (the slab `min`/`max` pair, the `tEnter` clamp to 0, the
  `chord` clamp to 0, the `chord / size` path fraction, and the clamped
  `intensity * pathTerm * intensityScale` alpha). A source assertion is a weak test and is meant as one: it catches a term
  silently dropped in an edit, not a wrong shader. It exists because the shader cannot
  execute under `node --test`, so without it the port from the pure reference has no
  automated check at all.
