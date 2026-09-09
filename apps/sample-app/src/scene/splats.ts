/**
 * The 3D Gaussian Splat entity and every **decision** around it
 * (`gaussian_splats.md` §2, §5.4, §6.2) — the model, the display label, the
 * accepted capture extensions, the row badge, and the clip-band → SDF-box
 * mapping.
 *
 * Pure by design, and deliberately separate from `splatLayer.ts`: Spark needs a
 * WebGL2 context, workers and wasm, none of which `node --test` has, so the
 * boundary sits where `sceneFileList.ts`/`sceneIO.ts` already draw it — every
 * judgement here, the renderer plumbing there (`gaussian_splats.md` §11,
 * `ai/CONVENTIONS.md`).
 *
 * A splat is something the user **looks at**, never something the coverage
 * engine measures: it contributes no triangles to the collision mesh, no bounds
 * to the workspace AABB, and no voxels to any marked set, so no splat edit ever
 * marks the coverage result stale (`gaussian_splats.md` §1.1, `spec.md` §8.1).
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import type { ClipBand } from './sectionHeatmap.ts';

/**
 * A capture's **registration** (`gaussian_splats.md` §10) — the transform that
 * takes its arbitrary reconstructed frame into the scene's metric Y-up frame,
 * and what `apps/splat-camera-export` calls an *alignment*.
 *
 * Its own type because the three fields never travel apart: the entity carries
 * them, both `SplatPanel` presets write them as a set (§7), and the layer's
 * anchor reads them as a set (§4.3). {@link identityRegistration} is the one
 * they all start from.
 */
export interface Registration {
  position: Vec3;
  rotation: Quat;
  /**
   * Uniform, strictly positive. **Not** a `Vec3`: a Gaussian's shape is a
   * covariance, not a mesh, so a non-uniform scale shears every Gaussian in the
   * capture into visible smears (§2.1). `apps/splat-camera-export`'s
   * `align/alignment.ts` reached the same conclusion for the same reason.
   */
  scale: number;
}

/**
 * One capture placed in the scene (`gaussian_splats.md` §2.1). Held in its own
 * top-level `splats` array on the `Scene` (`spec.md` §14.1) rather than as a
 * fourth `GeometryObject` kind, which would break both "every geometry object
 * contributes to occlusion" (§14.6) and "geometry is not selectable/editable"
 * (§14.9).
 *
 * The registration is **inlined** rather than nested under a key of its own:
 * `position`/`rotation`/`scale` are the serialized shape `spec.md` §14.3
 * specifies, so `SplatObject extends Registration` keeps the file format
 * unchanged while still giving the three fields one name where they travel
 * together.
 */
export interface SplatObject extends Registration {
  /** `splat-N`. */
  id: string;
  /** User-edited display label; blank falls back to the filename (§2.3). */
  name: string;
  /** Path relative to the scene folder root, e.g. `assets/site.spz` (§3.1). */
  src: string;
  /** Whether the viewport draws it (§5.1). */
  enabled: boolean;
}

/**
 * The single-file capture formats Spark can decode from a byte stream
 * (`gaussian_splats.md` §3.1). A bare PCSOGS bundle (a `meta.json` plus sibling
 * `.webp` payloads) is deliberately absent — `SplatMeshOptions` has no channel
 * for sibling files, and the `.sog` zip carries the same data in one file.
 */
export const SPLAT_EXTENSIONS = ['.spz', '.sog', '.ply', '.splat', '.ksplat'] as const;

/** The PCSOGS bundle manifest, listed with its reason rather than silently dropped (§3.1). */
export const SOG_BUNDLE_MANIFEST = 'meta.json';

/** Why a `meta.json` is listed but not selectable (`gaussian_splats.md` §3.1, §9). */
export const SOG_BUNDLE_REASON = "that's a SOG bundle — use its .sog zip instead";

/** The scene folder subdirectory a splat's `src` is offered from (§3.2). */
export const SPLAT_ASSET_DIR = 'assets';

/** Whether a file name carries one of the accepted capture extensions (§3.1). */
export function isSplatFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SPLAT_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/** The last path segment of a folder-relative `src` (`assets/site.spz` → `site.spz`). */
export function basename(src: string): string {
  const at = src.lastIndexOf('/');
  return at < 0 ? src : src.slice(at + 1);
}

/**
 * A splat row's display label (`gaussian_splats.md` §2.3): its own `name`, or —
 * uniquely among the entity kinds — the **basename of its `src`** rather than an
 * ordinal `Splat N`.
 *
 * A splat's identity *is* its file, and `spec.md` §14.2 already treats a filename
 * as authoritative for exactly this reason ("the filename is the scene's name").
 * It also keeps two unnamed rows on two different captures distinguishable, and
 * makes a duplicated row read as a duplicate rather than as an unrelated second
 * capture.
 */
export function splatLabel(splat: Pick<SplatObject, 'name' | 'src'>): string {
  const trimmed = splat.name.trim();
  return trimmed.length > 0 ? trimmed : basename(splat.src);
}

/**
 * A **fresh** identity registration — position `[0,0,0]`, no rotation, scale 1
 * (`gaussian_splats.md` §3.2, §7): what a freshly added splat carries and what
 * the panel's **Reset transform** writes back.
 *
 * A function rather than a shared constant because both `Vec3` and `Quat` are
 * mutable tuples: one exported literal would be aliased into every splat in the
 * scene, and the first gizmo drag would move all of them. Returning a new one
 * per call is also what lets the type be plain `Registration` instead of a
 * `readonly` literal each caller has to cast back out of.
 */
export function identityRegistration(): Registration {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
}

/**
 * A splat added from the **Add 3DGS** dialog (§3.2): enabled, blank-named, at an
 * identity transform, so the `SplatPanel` opens on it ready to register.
 */
export function defaultSplat(id: string, src: string): SplatObject {
  return { id, name: '', src, enabled: true, ...identityRegistration() };
}

/**
 * The `Flip 180° Z` rotation (`gaussian_splats.md` §7) — the standard correction
 * for a capture whose reconstructed frame is Z-down relative to the metric Y-up
 * scene. Ported from `apps/splat-camera-export`'s `FLIP_Z_ROTATION` so the two
 * apps agree, and applied as a **replacement** of the rotation rather than a
 * composition, so pressing it twice is idempotent instead of drifting back to
 * identity.
 */
export const FLIP_Z_ROTATION: Quat = [0, 0, 1, 0];

/** True when the rotation is (numerically) {@link FLIP_Z_ROTATION} — the button's pressed state. */
export function isFlippedZ(rotation: Quat): boolean {
  return Math.abs(Math.abs(rotation[2]) - 1) < 1e-6;
}

/** Why a capture is not on screen (`gaussian_splats.md` §9). */
export type SplatLoadFailure =
  /** Referenced file absent from `assets/`. */
  | 'missing'
  /** Unreadable, or Spark could not decode it. */
  | 'undecodable'
  /**
   * A **PCSOGS bundle manifest** referenced by a hand-edited scene file: it
   * cannot be decoded from one file, and the remedy is a different file rather
   * than a repair, so §9 gives it the reason instead of the bare undecodable
   * badge. The Add dialog never offers one (§3.1).
   */
  | 'sogBundle';

/**
 * Which failure a capture that **would not decode** reports
 * (`gaussian_splats.md` §9). Everything that fails to read or decode is
 * `undecodable`, except a `meta.json`, whose row names its `.sog` zip — the
 * same choice the Load dialog makes for an invalid `*.json`, and the reason
 * `SOG_BUNDLE_REASON` exists in the first place.
 *
 * A decision, so it lives here rather than in the layer's `catch` (§11).
 */
export function splatDecodeFailure(src: string): SplatLoadFailure {
  return basename(src).toLowerCase() === SOG_BUNDLE_MANIFEST ? 'sogBundle' : 'undecodable';
}

/**
 * A row's load state (`gaussian_splats.md` §6.2) — **derived side state**, held
 * beside the scene like the retained per-run probe/section data (`spec.md`
 * §12.3, §13.4). Never part of `SplatObject`, never serialized, and nothing in
 * the app blocks on it.
 *
 * `loaded` means **decoded**: Spark's sort runs in a worker, so the capture
 * appears a few frames later (§4.4). There is deliberately no fifth state
 * between the two.
 */
export type SplatLoadState =
  | { status: 'loading'; /** 0..1, or null when the length is unknown. */ progress: number | null }
  | { status: 'loaded'; splatCount: number }
  | { status: 'error'; failure: SplatLoadFailure };

const FAILURE_BADGE: Record<SplatLoadFailure, string> = {
  missing: '⚠ missing from assets/',
  undecodable: '⚠ could not be decoded',
  sogBundle: '⚠ SOG bundle — use its .sog zip',
};

/** Millions-of-splats readout, e.g. `4.2M splats` / `820k splats` (§6.2). */
function splatCountText(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M splats`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}k splats`;
  return `${count} splats`;
}

/**
 * The badge a splat row shows for its load state (`gaussian_splats.md` §6.2), or
 * `null` when there is nothing to say yet (no layer has reported on this row).
 */
export function splatBadge(state: SplatLoadState | undefined): string | null {
  if (!state) return null;
  switch (state.status) {
    case 'loading':
      return state.progress === null ? 'loading…' : `${Math.round(state.progress * 100)}%`;
    case 'loaded':
      return splatCountText(state.splatCount);
    case 'error':
      return FAILURE_BADGE[state.failure];
  }
}

/**
 * A decoded capture, as far as counting its splats is concerned — the structural
 * shape of Spark's `PackedSplats`, kept structural so this stays testable
 * without importing Spark (§11).
 */
export interface DecodedSplats {
  numSplats: number;
  /** The level-of-detail pyramid, when the decode produced one. */
  lodSplats?: { numSplats: number } | undefined;
}

/**
 * How many splats a decoded capture actually holds (`gaussian_splats.md` §6.2).
 *
 * **Not simply `numSplats`.** Loading with `lod: true` (§4.4) sends Spark's
 * worker down its LOD branch, which returns the payload under **`lodSplats`
 * alone** — no top-level `packedArray` — so `PackedSplats.initialize` takes its
 * empty branch and leaves `numSplats` at **0**. Reading it directly reported
 * `0 splats` on every capture that loaded perfectly well; the mesh renders fine
 * either way, because `SplatMesh.update` looks for `lodSplats` itself. The same
 * shape comes back for a non-LOD load whose encoding carries `lodOpacity`, which
 * is why the fallback is unconditional rather than keyed on our own `lod` flag.
 *
 * The number is therefore the count Spark is **holding** after its LoD build,
 * which may differ from the file's original count — and holding is what costs
 * frames (§4.6), so that is the honest figure for this badge.
 */
export function decodedSplatCount(packed: DecodedSplats): number {
  return packed.numSplats > 0 ? packed.numSplats : packed.lodSplats?.numSplats ?? 0;
}

/**
 * Whether the coverage fog's depth pass has any capture depth to draw
 * (`gaussian_splats.md` §4.5).
 *
 * The pass exists only to give the fog an occluder where a capture stands. With
 * nothing decoded yet, or the whole layer hidden (§5.2), there is no such capture —
 * and then the pass must be **skipped outright**, not run empty: a scene without
 * captures has to cost nothing and the fog has to behave exactly as it did before
 * captures existed. Kept here, pure, because it is a judgement; the render calls it
 * gates cannot run under `node --test`.
 */
export function needsSplatDepthPass(layer: {
  /** Has Spark's renderer been constructed? It arrives with the first load (§4.2). */
  sparkReady: boolean;
  /** Decoded captures currently in the group. */
  meshCount: number;
  /** The splat group's own visibility — the Splats eye-menu row (§5.2). */
  visible: boolean;
}): boolean {
  return layer.sparkReady && layer.meshCount > 0 && layer.visible;
}

/** A world-space, axis-aligned box for a Spark SDF erase (`gaussian_splats.md` §5.4). */
export interface SdfBox {
  /** Box centre in world meters. */
  position: Vec3;
  /** Half-extents — what `SplatEditSdf.scale` carries (its `radius` is corner rounding). */
  halfExtents: Vec3;
}

/**
 * The section clip's world band as an SDF box (`gaussian_splats.md` §5.4).
 *
 * `spec.md` §13.9 clips **geometry** with two world planes on each mesh's material.
 * A Gaussian has no rasterized surface for a plane to cut, so the band is instead
 * one inverted `SplatEdit` holding a `BOX` SDF at `opacity: 0`, which zeroes the
 * alpha of every Gaussian *outside* the box.
 *
 * Unbounded in-plane is expressed as the **workspace AABB**'s extent on the
 * other two axes, matching the geometry clip's infinite planes closely enough
 * that a band clamped to the full extent erases nothing. The mapping is a pure
 * function of the band and the AABB alone — **no capture's registration enters
 * it**, which is also why the clip imposes no requirement of its own on that
 * registration being uniform.
 */
export function clipBandToSdfBox(band: ClipBand, worldMin: Vec3, worldMax: Vec3): SdfBox {
  const position: Vec3 = [0, 0, 0];
  const halfExtents: Vec3 = [0, 0, 0];
  for (const axis of [0, 1, 2] as const) {
    if (axis === band.axis) {
      position[axis] = (band.min + band.max) / 2;
      halfExtents[axis] = Math.max(0, (band.max - band.min) / 2);
    } else {
      position[axis] = (worldMin[axis] + worldMax[axis]) / 2;
      halfExtents[axis] = Math.max(0, (worldMax[axis] - worldMin[axis]) / 2);
    }
  }
  return { position, halfExtents };
}
