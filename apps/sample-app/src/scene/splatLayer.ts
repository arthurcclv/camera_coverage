/**
 * The splat layer (`gaussian_splats.md` §4): a `Group` **inside the viewport's own
 * scene** holding a `SparkRenderer` plus one anchor per row, the streamed load
 * path, the per-`src` decode cache, and the clip's `SplatEdit` lifecycle.
 *
 * **No renderer of its own.** Spark requires a `WebGLRenderer`
 * (`SparkRendererOptions.renderer`, plus `renderer.properties`/`state`/
 * `initTexture`/`xr`), and since the viewport *is* a `WebGLRenderer` (`spec.md`
 * §2.3) the captures simply draw into it. That is what gives geometry and splats
 * **one depth buffer**: a capture is occluded by the walls in front of it and
 * occludes what stands behind it, instead of being painted behind everything on a
 * separate canvas (§4.1).
 *
 * The `SparkRenderer` is an `Object3D`, so it draws when the scene draws — this
 * module owns no canvas, no clear colour, no `setSize`, and no render call.
 *
 * This module is deliberately **thin and untested** — the `SparkRenderer`, the
 * stream load, `mesh.visible`, the `SplatEdit` lifecycle, and disposal. Every
 * judgement it would otherwise make inline lives in the pure `splats.ts` /
 * `splatAssets.ts` (`gaussian_splats.md` §11).
 */
// Named imports, not a namespace one, so rollup can tree-shake `three` down to
// the handful of classes this module actually needs.
import { Group, Object3D, type Camera, type WebGLRenderer } from 'three';
import type {
  PackedSplats,
  SparkRenderer,
  SplatEdit,
  SplatEditSdf,
  SplatMesh,
} from '@sparkjsdev/spark';

import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

import {
  basename,
  decodedSplatCount,
  needsSplatDepthPass,
  splatDecodeFailure,
  type SdfBox,
  type SplatLoadFailure,
  type SplatLoadState,
  type SplatObject,
} from './splats.ts';
import type { GizmoAttachable } from './gizmoSet.ts';
import type { SplatDepthWriter } from './fogCompositor.ts';

/** The viewport background (§4.2) — owned by `scene.background`, as it always was. */
export const VIEWPORT_CLEAR_COLOR = 0x1a1d22;

/**
 * Resolves a splat's folder-relative `src` to its bytes (`gaussian_splats.md`
 * §4.4 step 1). Supplied by App from the save target's directory handle, and
 * `null` before any Load or Save — at which point no splat can exist yet
 * (§3.2). Rejecting means the capture is **missing**, which is survivable: the
 * row reports it and no coverage number changes (§9).
 */
export type SplatAssetLoader = (src: string) => Promise<File>;

/** What `sync` needs each frame's worth of state (`gaussian_splats.md` §4, §5). */
export interface SplatLayerState {
  splats: readonly SplatObject[];
  /** Asset resolver, or null while there is no scene folder (§3.2). */
  loader: SplatAssetLoader | null;
  /** The section clip's world band as a box, or null when nothing clips (§5.4). */
  clip: SdfBox | null;
  /** The eye menu's **Splats** master toggle (§5.2). */
  visible: boolean;
}

/** Spark's module namespace, pulled in on the first load (§4.2). */
type Spark = typeof import('@sparkjsdev/spark');

/** One decoded capture, shared by every row referencing the same `src` (§3.3). */
interface CacheEntry {
  /** Row ids referencing this `src` — the refcount that decides disposal. */
  refs: Set<string>;
  state: SplatLoadState;
  /** The decoded splats, once the load resolved. */
  packed: PackedSplats | null;
  /** Bumped by disposal so a resolving load knows it has been superseded. */
  token: number;
}

/**
 * Progress as a 0..1 fraction, or null when the stream length is unknown —
 * which is what the row's `loading…` badge reports (§6.2).
 */
function progressFraction(event: ProgressEvent): number | null {
  return event.lengthComputable && event.total > 0 ? event.loaded / event.total : null;
}

/**
 * The splat layer. Created eagerly by `createViewport` (one code path whether or
 * not a scene has a capture, §4.2) and added to the viewport's scene.
 */
export class SplatLayer implements GizmoAttachable, SplatDepthWriter {
  /**
   * The layer's group inside the viewport scene — the `SparkRenderer`, the row
   * anchors, and the clip edit, nothing else. Hiding the layer is this group's
   * `visible`, which Spark's own `traverseVisible` collection then skips (§5.2).
   */
  readonly group = new Group();
  /**
   * The viewport's renderer — Spark needs it to construct its `SparkRenderer`
   * (§4.1). Held, never driven: this layer issues no render call of its own.
   */
  private readonly renderer: WebGLRenderer;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
  }

  /**
   * One anchor per row, holding that row's registration (`gaussian_splats.md`
   * §2.1). The `SplatMesh` hangs under it at identity, so:
   *   - the anchor is a stable `TransformControls` target whatever the load
   *     state — a hidden or still-loading capture is still draggable (§5.1);
   *   - one decoded capture serves several rows at different transforms (§3.3);
   *   - `enabled: false` is `anchor.visible = false`, which Spark's own
   *     `traverseVisible` collection then skips outright.
   */
  private readonly anchors = new Map<string, Object3D>();
  private readonly meshes = new Map<string, SplatMesh>();
  /** Decoded captures keyed by `src`, refcounted by referencing rows (§3.3). */
  private readonly captures = new Map<string, CacheEntry>();

  private spark: Spark | null = null;
  private sparkImport: Promise<Spark> | null = null;
  private sparkRenderer: SparkRenderer | null = null;

  /**
   * The clip's single world-space `SplatEdit` (§5.4) — **one for the whole
   * layer**, not one per capture: Spark evaluates an edit on world-space splat
   * centres and treats an edit parented outside any `SplatMesh` as global.
   * Created when a clip first becomes active, removed when it clears, so an
   * unclipped scene does no per-frame work for it.
   */
  private clipEdit: { edit: SplatEdit; sdf: SplatEditSdf } | null = null;

  /**
   * The clip most recently pushed by {@link sync}, kept so a capture that
   * finishes loading **after** the clip became active is clipped too (§5.4).
   * Spark itself only arrives with the first load (§4.2), so the very first
   * `applyClip` of a scene opened with `clipSectionId` already set has no
   * `SplatEditSdf` class to construct yet.
   */
  private clip: SdfBox | null = null;

  private loadStateHandler: ((states: ReadonlyMap<string, SplatLoadState>) => void) | null = null;
  private loader: SplatAssetLoader | null = null;
  private disposed = false;

  /**
   * Register the callback for a change in any row's load state (§6.2). The map
   * is keyed by **splat id**, so App holds it exactly as the spec's derived side
   * state beside the scene — rows sharing a `src` therefore share a state,
   * which is the visible half of the one-decode-per-`src` rule (§3.3).
   */
  onLoadStates(handler: (states: ReadonlyMap<string, SplatLoadState>) => void): void {
    this.loadStateHandler = handler;
    this.emitLoadStates();
  }

  /**
   * Draw the captures **again, invisibly**, so the coverage fog has something to
   * depth-test against (`volumetric_rendering.md` §4, `fogCompositor.ts`).
   *
   * The visible pass keeps `depthWrite: false`, which is what preserves Spark's own
   * back-to-front blending — turning it on there makes the capture break into
   * hard-edged plates, and Spark's own docs warn about it. This pass writes depth
   * with colour off instead, so the fog is occluded by a capture in front of it and
   * the capture itself renders exactly as before.
   *
   * Three details, each of which silently produced a wrong frame while this was
   * being built:
   *
   *  - **It must run after the scene pass.** Spark generates its splats on the
   *    frame's first render, so a genuine *pre*-pass draws nothing and lays no
   *    depth — a no-op that looks like the feature simply not working.
   *  - **Only the splat group is drawn**, not the whole scene. Re-rendering the
   *    scene would blend every transparent gizmo, section plane and volume fill a
   *    second time on top of itself.
   *  - **`autoClear` is off.** `render` clears the bound target otherwise, throwing
   *    away the scene colour and depth this pass exists to add to.
   */
  writeDepth(renderer: WebGLRenderer, camera: Camera): void {
    // Nothing loaded, or the layer is hidden: no depth to contribute, and the fog
    // should behave exactly as it did before captures existed (`splats.ts`).
    const spark = this.sparkRenderer;
    const wanted = needsSplatDepthPass({
      sparkReady: spark !== null,
      meshCount: this.meshes.size,
      visible: this.group.visible,
    });
    if (!wanted || !spark) return; // `|| !spark` narrows the type; `wanted` already covers it

    const material = spark.material;
    const prevAutoClear = renderer.autoClear;
    material.colorWrite = false;
    material.depthWrite = true;
    renderer.autoClear = false;
    renderer.render(this.group, camera);
    renderer.autoClear = prevAutoClear;
    material.colorWrite = true;
    material.depthWrite = false;
  }

  /** The row's `TransformControls` attach target — its anchor (§5.1, §7). */
  getAttachTarget(id: string): Object3D | undefined {
    return this.anchors.get(id);
  }

  /** The anchor's world transform after a gizmo drag; scale is panel-only (§7). */
  readTransform(id: string): { position: Vec3; rotation: Quat } | null {
    const anchor = this.anchors.get(id);
    if (!anchor) return null;
    const { position: p, quaternion: q } = anchor;
    return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
  }

  /**
   * Reconcile the layer against the scene's splats (`gaussian_splats.md` §4.4,
   * §5). Creates an anchor on first sight of a row, applies its registration and
   * `enabled`, starts (or joins) the load for its `src`, and tears down whatever
   * the scene no longer holds — releasing a decoded capture only when the last
   * row referencing it is gone (§3.3, §6.3).
   */
  sync(state: SplatLayerState): void {
    if (this.disposed) return;
    // A **new loader means a new folder**, so every decode keyed by a
    // folder-relative `src` is now about a different file: two scene folders can
    // each hold an `assets/site.spz` with completely different bytes. Dropping
    // the cache on that edge is what §3.3's "or the scene is replaced" means in
    // practice. App memoizes the loader on the save target's *folder*, not the
    // target, so a plain Save does not re-decode a resident capture.
    if (this.loader !== null && state.loader !== this.loader) this.releaseAll();
    this.loader = state.loader;
    this.group.visible = state.visible;

    // `src` → the live rows referencing it, built in the same pass that walks
    // the rows rather than re-derived in `releaseUnreferenced`: this loop
    // already has every row in hand, and the refcount is exactly what it sees.
    const referenced = new Map<string, Set<string>>();
    const seen = new Set<string>();
    for (const splat of state.splats) {
      seen.add(splat.id);
      const refs = referenced.get(splat.src);
      if (refs) refs.add(splat.id);
      else referenced.set(splat.src, new Set([splat.id]));
      let anchor = this.anchors.get(splat.id);
      if (!anchor) {
        anchor = new Object3D();
        this.anchors.set(splat.id, anchor);
        this.group.add(anchor);
      }
      anchor.position.set(splat.position[0], splat.position[1], splat.position[2]);
      anchor.quaternion.set(splat.rotation[0], splat.rotation[1], splat.rotation[2], splat.rotation[3]);
      // Uniform by construction (§2.1): a per-axis scale would shear every
      // Gaussian, which is why the gizmo's scale mode stays volume-only (§7).
      anchor.scale.setScalar(splat.scale);
      // A disabled splat stays hidden **even while selected** — the one
      // deliberate divergence from `spec.md` §2.4.3, since re-drawing a capture
      // the user just hid by clicking its row would read as a broken checkbox
      // (§5.1). Its gizmo still attaches, because the anchor still exists.
      anchor.visible = splat.enabled;
      this.attach(splat);
    }

    for (const [id, anchor] of [...this.anchors]) {
      if (seen.has(id)) continue;
      this.group.remove(anchor);
      this.anchors.delete(id);
      this.detach(id);
    }
    this.releaseUnreferenced(referenced);
    this.clip = state.clip;
    this.applyClip();
  }

  /**
   * Drop every mesh and every decoded capture, cancelling in-flight loads
   * (`gaussian_splats.md` §3.3, §4.2). The anchors stay: they carry the rows'
   * registrations and are the gizmo's attach targets, and `sync` rebuilds the
   * meshes over the fresh decodes.
   *
   * Public because "the scene is replaced" (§8) is not something the layer can
   * see: two scene files in one folder share a loader, so `SceneView` calls this
   * from App's one scene-replacement path instead (`spec.md` §14.4).
   */
  releaseAll(): void {
    for (const [id, mesh] of [...this.meshes]) {
      this.detach(id);
      // Every row **and** every decode is going at once here, so a mesh may
      // free its own hold on the shared `PackedSplats` — which {@link detach}
      // alone must never do (§3.3). `PackedSplats.dispose()` guards each buffer
      // it frees, so the entry loop below disposing the same decode again is
      // harmless.
      mesh.dispose();
    }
    for (const entry of this.captures.values()) {
      entry.token += 1;
      entry.packed?.dispose();
    }
    this.captures.clear();
    // Every row's state came off a cache entry, so the rows now have none —
    // App's derived map would otherwise keep badging a capture that is gone
    // (§6.2).
    this.emitLoadStates();
  }

  dispose(): void {
    this.disposed = true;
    this.clearClip();
    this.releaseAll();
    for (const anchor of this.anchors.values()) this.group.remove(anchor);
    this.anchors.clear();
    if (this.sparkRenderer) {
      this.group.remove(this.sparkRenderer);
      this.sparkRenderer.dispose();
      this.sparkRenderer = null;
    }
  }

  // --- loading (`gaussian_splats.md` §3.3, §4.4) -----------------------------

  /**
   * Ensure `splat.src` is being (or has been) decoded and that this row holds a
   * mesh on it once it is. Rows sharing a `src` cost **one** read, **one**
   * decode, and **one** set of GPU textures (§3.3).
   */
  private attach(splat: SplatObject): void {
    let entry = this.captures.get(splat.src);
    if (!entry) {
      entry = { refs: new Set(), state: { status: 'loading', progress: null }, packed: null, token: 0 };
      this.captures.set(splat.src, entry);
      void this.load(splat.src, entry);
    }
    entry.refs.add(splat.id);
    if (entry.packed && !this.meshes.has(splat.id)) this.buildMesh(splat.id, entry.packed);
    this.emitLoadStates();
  }

  /**
   * Read and decode one capture (§4.4). **Asynchronous and non-blocking**: the
   * row exists and is selectable immediately, and nothing in the app waits on
   * this. A scene replacement or a row deletion bumps the entry's token, so a
   * load that resolves afterwards is discarded rather than adding a mesh to a
   * scene that is gone.
   */
  private async load(src: string, entry: CacheEntry): Promise<void> {
    const token = entry.token;
    const live = () => !this.disposed && entry.token === token && this.captures.get(src) === entry;

    const loader = this.loader;
    if (!loader) {
      // No scene folder to resolve against. A splat can only be added once one
      // exists (§3.2), so this is the transient case of an import whose loader
      // has not been pushed yet; the next `sync` retries.
      this.captures.delete(src);
      return;
    }

    let file: File;
    try {
      file = await loader(src);
    } catch {
      if (live()) this.fail(entry, 'missing');
      return;
    }
    if (!live()) return;

    try {
      const spark = await this.loadSpark();
      if (!live()) return;
      // **`stream`, not `fileBytes`**: a raw `.ply` of a 1120 m site can run past
      // a gigabyte, and buffering it into one `ArrayBuffer` just to hand it over
      // is an avoidable out-of-memory failure. Spark takes a `ReadableStream`
      // with its length directly (§4.4).
      //
      // `lod: true` enables Spark's in-memory, view-dependent level of detail.
      // Its *streaming* LOD (`PagedSplats`) is not available here: it fetches
      // chunks by `rootUrl` over HTTP, and a capture behind a File System Access
      // handle has no URL to fetch (§13).
      const packed = new spark.PackedSplats({
        stream: file.stream(),
        streamLength: file.size,
        fileName: basename(src),
        lod: true,
        onProgress: (event) => {
          if (live() && entry.state.status === 'loading') {
            entry.state = { status: 'loading', progress: progressFraction(event) };
            this.emitLoadStates();
          }
        },
      });
      await packed.initialized;
      if (!live()) {
        packed.dispose();
        return;
      }
      entry.packed = packed;
      // `loaded` means **decoded**. Spark's accumulate/sort runs in a worker, so
      // the capture emits no geometry for its first several frames — measured at
      // frame 7–8 — and this badge is deliberately not a claim about what is on
      // screen (§4.4, §6.2).
      // Via `decodedSplatCount`, not `packed.numSplats`: the LOD load path parks
      // the payload under `lodSplats` and leaves `numSplats` at 0 (§6.2).
      entry.state = { status: 'loaded', splatCount: decodedSplatCount(packed) };
      for (const id of entry.refs) if (!this.meshes.has(id)) this.buildMesh(id, packed);
      this.emitLoadStates();
      // This load is what brought Spark itself in (§4.2), so a clip that was
      // already active when the scene opened could not build its `SplatEdit`
      // yet — and no `sync` need follow, since load completion is not a scene
      // edit. Re-applying here is what clips a capture that finishes loading
      // into a scene whose section is already clipping (§5.4).
      this.applyClip();
    } catch {
      // Unreadable, undecodable, or Spark's dynamic import failed — one badge
      // covers all three, since the remedy is the same. The one exception is a
      // hand-referenced PCSOGS `meta.json`, whose remedy *is* a different file,
      // so `splatDecodeFailure` gives that row its own reason (§9).
      if (live()) this.fail(entry, splatDecodeFailure(src));
    }
  }

  /** Spark's ~5 MB ESM build, pulled in only once a scene actually has a splat (§4.2). */
  private loadSpark(): Promise<Spark> {
    if (this.spark) return Promise.resolve(this.spark);
    this.sparkImport ??= import('@sparkjsdev/spark').then((spark) => {
      this.spark = spark;
      return spark;
    });
    return this.sparkImport;
  }

  /**
   * One row's mesh over a shared decode (§3.3). `editable: true` is what allows
   * the clip's `SplatEdit` to reach it (§5.4); `raycastable` is off because a
   * splat is never viewport-pickable (§6.5).
   */
  private buildMesh(id: string, packed: PackedSplats): void {
    const anchor = this.anchors.get(id);
    const spark = this.spark;
    if (!anchor || !spark) return;
    if (!this.sparkRenderer) {
      // Constructed once, on the first load, and added to the splat group.
      // `onDirty` is Spark's "I have new sort/LOD results, re-render" signal —
      // the hook to use if the viewport ever moves off a continuous animation
      // loop, which it has not (§4.4).
      this.sparkRenderer = new spark.SparkRenderer({ renderer: this.renderer });
      this.group.add(this.sparkRenderer);
    }
    // `lod` is deliberately absent: with `packedSplats` supplied, Spark reads the
    // level-of-detail data off the **shared decode** (`packedSplats.lodSplats`,
    // built with `lod: true` in `load`) and a per-mesh `lod` option would be a
    // no-op here. `editable: true` is what lets the clip's `SplatEdit` reach this
    // mesh (§5.4); `raycastable: false` because a splat is never viewport-pickable
    // (§6.5), so its raycast index would be built for nothing.
    const mesh = new spark.SplatMesh({ packedSplats: packed, editable: true, raycastable: false });
    this.meshes.set(id, mesh);
    anchor.add(mesh);
  }

  /**
   * Drop one row's mesh. Deliberately **not** `mesh.dispose()`: that would free
   * the shared `PackedSplats` out from under every other row on the same `src`
   * (§3.3). The decode is released by {@link releaseUnreferenced} instead.
   */
  private detach(id: string): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    mesh.removeFromParent();
    this.meshes.delete(id);
  }

  /**
   * Release every decoded capture no live row references any more (§3.3, §6.3).
   * An **unticked** row still references its capture — hide is not unload, which
   * is what makes re-ticking instant (§5.1).
   */
  private releaseUnreferenced(referenced: ReadonlyMap<string, Set<string>>): void {
    let changed = false;
    for (const [src, entry] of [...this.captures]) {
      const refs = referenced.get(src);
      if (refs && refs.size > 0) {
        entry.refs = refs;
        continue;
      }
      // Last row on this `src` is gone: cancel an in-flight load and free the
      // decode and its GPU textures.
      entry.token += 1;
      entry.packed?.dispose();
      this.captures.delete(src);
      changed = true;
    }
    if (changed) this.emitLoadStates();
  }

  private fail(entry: CacheEntry, failure: SplatLoadFailure): void {
    entry.state = { status: 'error', failure };
    this.emitLoadStates();
  }

  /** Fan the per-`src` states out to the per-row map App holds (§6.2). */
  private emitLoadStates(): void {
    if (!this.loadStateHandler) return;
    const states = new Map<string, SplatLoadState>();
    for (const entry of this.captures.values()) {
      for (const id of entry.refs) states.set(id, entry.state);
    }
    this.loadStateHandler(states);
  }

  // --- the section clip (`gaussian_splats.md` §5.4) --------------------------

  /**
   * Apply (or clear) the clip band as a **single inverted SDF erase** over the
   * whole layer (§5.4).
   *
   * `invert: true` on the edit applies it *outside* the box, where the SDF's
   * `opacity: 0` multiplies those Gaussians' alpha to zero; inside the band
   * every capture is untouched. `radius: 0` gives the sharp band the geometry
   * clip has, and `scale` carries the box's **half-extents** (Spark's `BOX` case
   * is the standard rounded-box SDF, with `sizes.xyz` from `scale` and `sizes.w`
   * from `radius`; the SDF's own transform is taken with its scale forced to 1,
   * so `scale` really is a size parameter and not part of that transform).
   */
  private applyClip(): void {
    const clip = this.clip;
    if (!clip) {
      this.clearClip();
      return;
    }
    const spark = this.spark;
    if (!spark) return; // no capture loaded yet, so nothing to erase
    if (!this.clipEdit) {
      const sdf = new spark.SplatEditSdf({
        type: spark.SplatEditSdfType.BOX,
        opacity: 0,
        radius: 0,
      });
      const edit = new spark.SplatEdit({
        rgbaBlendMode: spark.SplatEditRgbaBlendMode.MULTIPLY,
        sdfSmooth: 0,
        softEdge: 0,
        invert: true,
        // Passed explicitly rather than parented under the edit, so Spark reads
        // the list instead of traversing, and the SDF's world transform is its
        // own local one — which is what §5.4 specifies it in.
        sdfs: [sdf],
      });
      // Added to the **scene**, not under any `SplatMesh`, which is what makes
      // Spark collect it as a global edit applying to every capture (§5.4).
      this.group.add(edit);
      this.clipEdit = { edit, sdf };
    }
    const { sdf } = this.clipEdit;
    sdf.position.set(clip.position[0], clip.position[1], clip.position[2]);
    sdf.quaternion.identity(); // the band is an axis-aligned world slab (§5.4)
    sdf.scale.set(clip.halfExtents[0], clip.halfExtents[1], clip.halfExtents[2]);
    sdf.updateMatrixWorld(true);
  }

  private clearClip(): void {
    if (!this.clipEdit) return;
    this.group.remove(this.clipEdit.edit);
    this.clipEdit = null;
  }
}
