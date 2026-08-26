/**
 * The offscreen render rig and the settle protocol (spec §8).
 *
 * Impure: owns a PlayCanvas entity, a render target, and frame/event timing. The
 * logic worth testing (resolution policy, pixel post-processing) lives in
 * `imageSize.ts` and `pixels.ts`.
 */
import {
  ASPECT_MANUAL,
  Color,
  Entity,
  FILTER_LINEAR,
  PIXELFORMAT_RGBA8,
  Quat,
  RenderTarget,
  Texture,
  type AppBase,
} from 'playcanvas';
import type { PreviewCamera } from '../cameras/sceneCameras.ts';
import type { ImageSize } from './imageSize.ts';
import { rigAspect } from './imageSize.ts';
import { isBlankReadback, prepareForEncode } from './pixels.ts';

/** How long to wait for a sort to complete before giving up and rendering anyway (§8.2). */
const SORT_TIMEOUT_MS = 250;

export interface RigSettings {
  samples: number;
  settleFrames: number;
  background: [number, number, number, number];
  transparentBackground: boolean;
  /** `null` clips at each camera's own `far` (§5.2). */
  farOverride: number | null;
}

/**
 * Renders imported cameras offscreen at an exact pixel size, independent of the
 * viewport's size and device pixel ratio (§8).
 */
export class ExportRig {
  private readonly app: AppBase;
  private readonly entity: Entity;
  private texture: Texture | null = null;
  private renderTarget: RenderTarget | null = null;
  private size: ImageSize | null = null;
  private samples = 0;
  /** Viewport cameras disabled for the duration of a run, restored on `endRun`. */
  private suspended: Entity[] = [];

  constructor(app: AppBase) {
    this.app = app;
    this.entity = new Entity('export-rig', app as never);
    this.entity.addComponent('camera', {
      // `scene.json` fov is vertical, and so is PlayCanvas's when horizontalFov is
      // false — set it explicitly rather than relying on the default (§3).
      horizontalFov: false,
      aspectRatioMode: ASPECT_MANUAL,
    });
    this.entity.enabled = false;
    app.root.addChild(this.entity);
  }

  /**
   * Takes over rendering for a run (§8.1).
   *
   * The viewport cameras are disabled because the gsplat sorter is driven per
   * camera: with two active cameras it would thrash between them and a
   * `gsplat:sorted` event could belong to the wrong one, silently producing images
   * with another camera's splat ordering (§8.2).
   */
  beginRun(viewportCameras: readonly Entity[]): void {
    this.suspended = viewportCameras.filter((c) => c.enabled);
    for (const cam of this.suspended) cam.enabled = false;
    this.entity.enabled = true;
  }

  /** Restores the viewport cameras (§8.1). */
  endRun(): void {
    this.entity.enabled = false;
    for (const cam of this.suspended) cam.enabled = true;
    this.suspended = [];
  }

  /** The graphics device's maximum texture dimension, for the §9.1 clamp. */
  get maxTextureSize(): number {
    return this.app.graphicsDevice.maxTextureSize;
  }

  /** `WebGPU` or `WebGL2` — reported in the UI and in readback errors (§8.5). */
  get backendName(): string {
    return this.app.graphicsDevice.isWebGPU ? 'WebGPU' : 'WebGL2';
  }

  /**
   * Whether readback rows arrive bottom-up and must be reversed for PNG (§8.4).
   *
   * WebGL2's `readPixels` originates at the lower-left; WebGPU's `copyTextureToBuffer`
   * starts at the texture's top-left and is already in row order.
   */
  private get readbackIsBottomUp(): boolean {
    return !this.app.graphicsDevice.isWebGPU;
  }

  /** (Re)allocates the render target when the target size or sample count changes. */
  private ensureTarget(size: ImageSize, samples: number): RenderTarget {
    if (
      this.renderTarget &&
      this.size &&
      this.size.width === size.width &&
      this.size.height === size.height &&
      this.samples === samples
    ) {
      return this.renderTarget;
    }

    this.releaseTarget();

    const texture = new Texture(this.app.graphicsDevice, {
      name: 'export-color',
      width: size.width,
      height: size.height,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
    });
    const renderTarget = new RenderTarget({
      name: 'export-target',
      colorBuffer: texture,
      depth: true,
      samples,
    });

    this.texture = texture;
    this.renderTarget = renderTarget;
    this.size = size;
    this.samples = samples;
    return renderTarget;
  }

  private releaseTarget(): void {
    this.renderTarget?.destroy();
    this.texture?.destroy();
    this.renderTarget = null;
    this.texture = null;
    this.size = null;
  }

  /** Resolves on the next completed frame. */
  private nextFrame(): Promise<void> {
    return new Promise((resolve) => this.app.once('frameend', () => resolve()));
  }

  /**
   * Waits for the splat sort triggered by the current camera pose to complete
   * (§8.2), or for {@link SORT_TIMEOUT_MS} to elapse.
   *
   * The timeout is required rather than defensive: the engine skips re-sorting when
   * the camera has barely moved, so for two nearly-coincident cameras the event
   * legitimately never fires.
   */
  private awaitSort(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.app.scene.off('gsplat:sorted', finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, SORT_TIMEOUT_MS);
      this.app.scene.on('gsplat:sorted', finish);
    });
  }

  /**
   * Renders one camera and returns its top-down, encode-ready RGBA bytes (§8).
   *
   * Sequence per §8.2: pose the rig, let the sort settle, wait for the new ordering
   * to be uploaded and drawn, then read back.
   */
  async render(camera: PreviewCamera, size: ImageSize, settings: RigSettings): Promise<Uint8Array> {
    const renderTarget = this.ensureTarget(size, settings.samples);
    const component = this.entity.camera;
    if (!component) throw new Error('export rig has no camera component');

    // Quaternions transfer verbatim — both frames are right-handed Y-up with the
    // camera looking down -Z (§3) — so set the rotation directly rather than
    // routing it through Euler angles.
    const [px, py, pz] = camera.position;
    const [rx, ry, rz, rw] = camera.rotation;
    this.entity.setPosition(px, py, pz);
    this.entity.setRotation(new Quat(rx, ry, rz, rw));

    component.fov = camera.fov;
    component.horizontalFov = false;
    component.aspectRatioMode = ASPECT_MANUAL;
    component.aspectRatio = rigAspect(size);
    component.nearClip = camera.near;
    component.farClip = settings.farOverride ?? camera.far;
    component.renderTarget = renderTarget;

    const [r, g, b, a] = settings.background;
    component.clearColor = new Color(r, g, b, settings.transparentBackground ? 0 : a);

    // The pose change must reach the renderer before the sort can be triggered.
    await this.nextFrame();
    await this.awaitSort();
    // The applied ordering uploads during update, so further whole frames are
    // needed before the pixels reflect it (§8.2).
    for (let i = 0; i < Math.max(0, settings.settleFrames); i++) await this.nextFrame();

    if (!this.texture) throw new Error('export target was released mid-render');
    const backend = this.backendName;
    // Two deliberate choices here, each fixing an all-black-export bug on one backend.
    //
    // 1. No `renderTarget` — passing it binds *this* target's framebuffer, which for
    //    `samples > 1` is the multisampled one, and `glReadPixels` on a multisampled
    //    framebuffer is GL_INVALID_OPERATION (WebGL2). Omitting it makes the engine wrap
    //    the already-resolved colour texture in a temporary single-sample target.
    //
    // 2. `immediate: true` — required on WebGPU. Without it the engine records
    //    `copyTextureToBuffer` into the command encoder and then maps the staging buffer
    //    from a `setTimeout(0)` without ensuring the copy was ever submitted, so the read
    //    races the copy and returns zeros. `immediate` submits first, then maps. On WebGL2
    //    it only adds a `gl.flush()`, which is harmless.
    //
    // Both failures are silent — correct sizes, correct filenames, pure black pixels.
    const pixels = await this.texture.read(0, 0, size.width, size.height, { immediate: true });
    const bytes = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);

    // Fail loudly rather than write a black image (§8.6). An all-zero buffer cannot be a
    // real render against an opaque clear colour, so it means the readback did not work
    // on this backend — the one failure mode of this app that otherwise produces a
    // complete, plausible-looking, entirely useless deliverable.
    if (isBlankReadback(bytes, settings.transparentBackground)) {
      throw new Error(
        `the GPU readback returned no data on the ${backend} backend — every pixel is ` +
          `zero, which cannot happen with an opaque background. Try the other graphics ` +
          `backend in Render settings.`,
      );
    }

    // Row order is backend-dependent (§8.4) — only WebGL2 needs reversing.
    return prepareForEncode(
      bytes,
      size.width,
      size.height,
      settings.transparentBackground,
      this.readbackIsBottomUp,
    );
  }

  destroy(): void {
    this.endRun();
    this.releaseTarget();
    this.entity.destroy();
  }
}
