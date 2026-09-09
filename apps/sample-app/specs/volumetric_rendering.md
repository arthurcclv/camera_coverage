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

The renderer turns a set of voxels into an additive volumetric fog. Its entire
contract is per-voxel appearance plus one global knob — it carries no notion of
coverage, cameras, or which color means what.

Per-voxel input:

- **center** — cube center, world space.
- **size** — cube edge length, world space.
- **intensity** — scalar ≥ 0 (normally 0..1); how strongly the voxel contributes.
- **color** — RGB.

Global input:

- **intensityScale** — a single multiplier applied to every voxel's contribution
  (the overall brightness knob).
- **renderOrder** — the mesh's Three.js draw order (`setRenderOrder(order)`,
  alongside `setVisible`/`setIntensityScale`). The primitive stays
  visualization-agnostic — it only forwards the value onto its mesh (and re-applies
  it across buffer reallocation); *what* order to use is the caller's layer
  convention. In the sample app that convention lives in `scene/renderOrder.ts` and
  places the coverage fog between the section planes and the volume fills (§4;
  `spec.md` §9, §13.5).
- **compositeMode** — how per-voxel contributions combine along a view ray:
  - **`max`** (default) — the pixel shows the **largest** single voxel contribution
    along the ray (per-channel max), not the sum. In this mode the chord term is
    **dropped** (§3), so every voxel contributes a flat `color * intensity *
    intensityScale` and cubes read as hard-edged.
  - **`additive`** — contributions **sum**; the fog reads like accumulated opacity
    (§4). Uses the chord-length term (§3). Both modes are order-independent (§4).

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
4. **Contribution**, per `compositeMode` (§1):
   - **`additive`**: `rgb = color * intensity * chord * intensityScale`. The
     chord-length term produces **soft volumetric falloff** at cube edges instead of
     hard cube silhouettes — the core of the volumetric look and the reason for a
     per-fragment (not per-instance-constant) shader.
   - **`max`**: `rgb = color * intensity * intensityScale`. The chord term is
     **dropped** — every fragment of a voxel emits the same flat contribution, and
     compositing keeps the largest (§4). This renders the **exact maximum intensity**
     among the intersecting voxels rather than an integral along the ray, and reads as
     hard cube silhouettes.

**Resolution independence.** In `additive` mode, because contribution is
`intensity * chord`, the total accumulated along a ray is a Riemann sum of intensity
over path length. Refining the voxel grid (smaller cubes, more of them along the ray)
leaves the integral — and thus the apparent result — essentially unchanged, so
`intensityScale` does not need re-tuning when voxel size changes. In `max` mode the
result is simply the largest intensity present, which is likewise grid-independent (it
does not depend on how many voxels a ray crosses).

The slab/chord math is authored as a **pure TypeScript reference** and unit-tested;
the GLSL fragment shader mirrors it (see §6), echoing the SDK's "CPU reference is the
tested truth" discipline. That mirroring carries the whole verification burden here —
WebGL2 is the only render backend (`spec.md` §2.3), and a shader cannot run under
`node --test`, so the reference is what is actually tested and the shader is held to
it by review and by a source-parity test.

---

## 4. Compositing — order-independent (additive or max)

Contributions are composited with **no transparency sorting and no OIT** (no
weighted-blended OIT, no MRT passes); both modes are order-independent by
construction. `depthWrite: false`, `depthTest: true` in both modes:

- **`max`** (default): per-channel max blending (`blending: CustomBlending`,
  `blendEquation: MaxEquation`, One/One factors). The framebuffer keeps
  `max(src, dst)` per channel, so the pixel ends up at the largest single voxel
  contribution along the ray. Max is commutative/associative → order-independent.
- **`additive`**: additive blending (`blending: AdditiveBlending`). Addition is
  commutative, so overlapping / stacked voxels accumulate to the same result
  regardless of draw order.

- **`depthWrite: false`** so voxels never occlude each other.
- **`depthTest: true`** against the already-drawn opaque scene (room, boxes, floor,
  gizmos), so a wall or box correctly hides fog behind it; fog in front of geometry
  glows over it.

While the fog's *internal* compositing is order-independent by construction (above),
its ordering **relative to other transparent layers** (section heatmap planes, volume
fills) is not — and must not be left to Three.js's viewpoint-dependent transparency
sort. Callers pin it via `setRenderOrder` (§1): drawing a depth-writing layer (the
section plane) first lets the fog's `depthTest` resolve occlusion against it per
viewpoint (`spec.md` §9, §13.5). The primitive itself is agnostic to the chosen value.

Consequences, for callers to reason about (§9 of `spec.md` relies on these):

- A voxel with `intensity = 0` contributes nothing and is invisible (both modes).
- Higher intensity → brighter; against a dark background this reads like higher
  opacity.
- **Additive-specific:** a voxel's `color` sets the hue of its glow; per-voxel colors
  from different voxels simply add where they overlap along the ray, and stacking
  brightens.
- **Max-specific:**
  - The pixel reflects the **single brightest** voxel along the ray; stacking does
    **not** brighten. Against a dark scene this reads as "the strongest voxel wins".
  - Blending maxes against whatever is already in the framebuffer (the opaque scene),
    so the scene color acts as a per-channel floor — fog only shows where it exceeds
    the scene. For the demo's dark scene this is unnoticeable.
  - Max is **per-channel**, so mixed-hue voxels along one ray would max each channel
    independently (a red and a green voxel → yellowish). The coverage mappings in
    `spec.md` §9 use a single hue per mode (white / red), where per-channel max is
    exactly "brightest voxel wins" with no hue artifacts.

---

## 5. Rendering strategy

- Single instanced cube mesh; intensity, color, and transform as per-instance data
  → large sparse voxel sets render in one draw call.
- Additive blend with `depthWrite:false` means heavy overdraw is expected (every
  fragment of every instance shades); this is acceptable for the demo's scene sizes.
- **Back-face rasterization (`side: BackSide`).** Because the contribution is
  analytic (the slab test intersects the *view ray* with the AABB, with `t_enter`
  clamped to 0), the chord is identical whichever cube face generates the fragment.
  Back faces sit on the far side of each cube along the view ray, so they survive
  near-plane clipping and the camera being *inside* the fog volume — cases where
  front faces would be clipped or back-face-culled and the fog would appear cropped
  as the viewpoint moves. The instanced mesh is also `frustumCulled = false`, since
  its per-instance transforms spread far beyond the base cube's bounds. (In `max`
  mode the fragment value is a per-instance constant — `color * intensity *
  intensityScale`, no chord — so it too is identical whichever face spawns the
  fragment, and a back-face fragment still guarantees the ray crosses the cube.)

---

## 6. Tests

Per repo policy (every change gets a test), following the `coverageOverlay.test.ts`
pattern (pure functions under `node:test`):

- **Chord length / slab test** — pure TS reference: ray through cube center returns
  ~`size`; edge-grazing ray returns less; a miss returns 0; ray origin inside the
  cube handled.
- **Contribution mapping** — `additive` `rgb = color * intensity * chord *
  intensityScale`: `intensity = 0` → zero contribution; monotonic in `intensity` and
  in `intensityScale`; per-channel scaling by `color` is correct.
- **Max-mode contribution drops chord** — max-mode per-voxel value is
  `color * intensity * intensityScale`, independent of `chord` (equal for a grazing
  and a full-chord ray of the same voxel), unlike additive.
- **Composite reducers** — `additive` sums a set of contributions; `max` takes the
  per-channel maximum; both are order-independent (permuting the inputs is invariant);
  the max of a set equals its brightest element per channel.

- **Shader source parity** — the GLSL fragment shader's source is asserted to carry
  the reference's terms (the slab `min`/`max` pair, the `tEnter` clamp to 0, the
  `chord` clamp to 0, and the `color * intensity * pathTerm * intensityScale`
  product). A source assertion is a weak test and is meant as one: it catches a term
  silently dropped in an edit, not a wrong shader. It exists because the shader cannot
  execute under `node --test`, so without it the port from the pure reference has no
  automated check at all.
