/**
 * The PlayCanvas viewport (spec §6) and the host for the export rig (§8).
 *
 * Everything inside `<Application>` needs `useApp()`, so the scene contents,
 * splat loading, and the export run all live in `SceneContents` below.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Application, Entity } from '@playcanvas/react';
import { Camera, GSplat } from '@playcanvas/react/components';
// `OrbitControls` logs a deprecation notice in favour of the engine's
// `CameraControls` script, which ships no type declarations under
// `playcanvas/scripts/*`; see ai/DECISIONS.md.
import { OrbitControls } from '@playcanvas/react/scripts';
import { useApp } from '@playcanvas/react/hooks';
import {
  BoundingBox,
  DEVICETYPE_WEBGL2,
  DEVICETYPE_WEBGPU,
  Entity as PcEntity,
  Quat,
  Vec3,
} from 'playcanvas';
import { rgbToHex } from '../ui/color.ts';
import type { Alignment } from '../align/alignment.ts';
import { quatToEuler } from '../align/alignment.ts';
import type { PreviewCamera } from '../cameras/sceneCameras.ts';
import { ExportRig } from '../render/exportRig.ts';
import { runExport, type ExportProgress, type ExportRunResult, type ExportRunSettings } from '../export/runExport.ts';
import type { SplatSource } from '../export/manifest.ts';
import { loadSplat, type LoadedSplat, type LoadProgress } from './splatAsset.ts';
import { CameraMarkers } from './CameraMarkers.tsx';

export type ViewMode = 'orbit' | 'through';

/**
 * Graphics backend preference (§2). Exposed because the two backends have different
 * render-target readback implementations, so an export can fail on one and work on the
 * other (§8.6) — and the WebGPU path cannot be covered by this repo's automated
 * end-to-end check, which only ever gets WebGL2.
 */
export type BackendPreference = 'auto' | 'webgl2';

// `DeviceType` is not re-exported from the package root, so derive it from the constants.
type DeviceType = typeof DEVICETYPE_WEBGPU | typeof DEVICETYPE_WEBGL2;

const DEVICE_TYPES: Record<BackendPreference, DeviceType[]> = {
  auto: [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
  webgl2: [DEVICETYPE_WEBGL2],
};

/** An export the UI has asked for; a new object identity starts a run. */
export interface ExportRequest {
  id: number;
  cameras: readonly PreviewCamera[];
  settings: ExportRunSettings;
  sourceScene: string;
}

export interface ViewportProps {
  backend: BackendPreference;
  /** Reports the backend actually in use, once the device exists (§2). */
  onBackendReady: (name: string) => void;
  splatFiles: readonly File[] | null;
  cameras: readonly PreviewCamera[];
  selectedId: string | null;
  viewMode: ViewMode;
  showMarkers: boolean;
  alignment: Alignment;
  background: [number, number, number, number];
  exportRequest: ExportRequest | null;
  onSplatLoaded: (splat: { filename: string; byteSize: number } | null) => void;
  onSplatProgress: (p: LoadProgress | null) => void;
  onError: (message: string) => void;
  onExportProgress: (p: ExportProgress) => void;
  onExportDone: (r: ExportRunResult) => void;
  isExportCancelled: () => boolean;
  onSelect: (id: string) => void;
}

export function Viewport(props: ViewportProps) {
  return (
    <div className="viewport">
      <Application
        // Changing the preference must rebuild the graphics device, hence the key.
        key={props.backend}
        deviceTypes={DEVICE_TYPES[props.backend]}
        graphicsDeviceOptions={{ antialias: true, alpha: false }}
        // Splat rendering is the whole point; keep the canvas at native size.
        className="pc-canvas"
      >
        <SceneContents {...props} />
      </Application>
    </div>
  );
}

function SceneContents({
  splatFiles,
  cameras,
  selectedId,
  viewMode,
  showMarkers,
  alignment,
  background,
  exportRequest,
  onSplatLoaded,
  onSplatProgress,
  onError,
  onExportProgress,
  onExportDone,
  isExportCancelled,
  onBackendReady,
}: ViewportProps) {
  const app = useApp();
  const [splat, setSplat] = useState<LoadedSplat | null>(null);
  const orbitCameraRef = useRef<PcEntity | null>(null);
  const throughCameraRef = useRef<PcEntity | null>(null);
  const rigRef = useRef<ExportRig | null>(null);

  const selected = useMemo(
    () => cameras.find((c) => c.id === selectedId) ?? null,
    [cameras, selectedId],
  );

  // --- splat loading (§4) -------------------------------------------------

  useEffect(() => {
    if (!splatFiles || splatFiles.length === 0) return;

    let cancelled = false;
    let loaded: LoadedSplat | null = null;

    (async () => {
      onSplatProgress({ loaded: 0, total: 0 });
      const result = await loadSplat(app, splatFiles, (p) => {
        if (!cancelled) onSplatProgress(p);
      });
      if (cancelled) {
        if (result.ok) result.splat.dispose();
        return;
      }
      onSplatProgress(null);
      if (!result.ok) {
        onError(result.error);
        onSplatLoaded(null);
        return;
      }
      loaded = result.splat;
      setSplat(result.splat);
      onSplatLoaded({ filename: result.splat.filename, byteSize: result.splat.byteSize });
    })();

    return () => {
      cancelled = true;
      // Replacing a splat releases the previous asset and its blob URLs (§4).
      loaded?.dispose();
      setSplat((current) => (current === loaded ? null : current));
    };
    // `onError`/`onSplatLoaded`/`onSplatProgress` are stable callbacks from App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, splatFiles]);

  // --- the export rig (§8) ------------------------------------------------

  useLayoutEffect(() => {
    const rig = new ExportRig(app);
    rigRef.current = rig;
    onBackendReady(rig.backendName);
    return () => {
      rig.destroy();
      rigRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app]);

  useEffect(() => {
    if (!exportRequest || !splat) return;
    const rig = rigRef.current;
    if (!rig) return;

    let done = false;
    (async () => {
      const viewportCameras = [orbitCameraRef.current, throughCameraRef.current].filter(
        (e): e is PcEntity => e !== null,
      );
      const result = await runExport({
        rig,
        viewportCameras,
        cameras: exportRequest.cameras,
        settings: exportRequest.settings,
        alignment,
        splat: { filename: splat.filename, byteSize: splat.byteSize } satisfies SplatSource,
        sourceScene: exportRequest.sourceScene,
        onProgress: onExportProgress,
        isCancelled: isExportCancelled,
      });
      if (!done) onExportDone(result);
    })();

    return () => {
      done = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportRequest]);

  // --- background (§8.1) --------------------------------------------------

  // The declarative Camera prop takes a CSS string; the export rig sets a real
  // `Color` imperatively, where alpha (transparent background) actually applies.
  const clear = useMemo(() => rgbToHex(background), [background]);

  // --- alignment (§7) -----------------------------------------------------

  // The declarative Entity takes Euler degrees, so the stored quaternion is
  // converted here; the export rig sets its rotation from the quaternion directly
  // (§8.1) and never round-trips through Euler.
  const alignEuler = useMemo(() => {
    const e = quatToEuler(alignment.rotation);
    return [e.x, e.y, e.z] as [number, number, number];
  }, [alignment.rotation]);

  const throughRotation = useMemo(() => {
    if (!selected) return [0, 0, 0] as [number, number, number];
    const e = quatToEuler(selected.rotation);
    return [e.x, e.y, e.z] as [number, number, number];
  }, [selected]);

  const through = viewMode === 'through' && selected !== null;

  // Rendering through a camera must be exact, so set the quaternion imperatively
  // rather than trusting the Euler round-trip the prop would impose (§6.1).
  useLayoutEffect(() => {
    const entity = throughCameraRef.current;
    if (!entity || !selected) return;
    const [rx, ry, rz, rw] = selected.rotation;
    entity.setRotation(new Quat(rx, ry, rz, rw));
  }, [selected, viewMode]);

  /**
   * Exactly one viewport camera is enabled at a time (§6.1).
   *
   * This must be imperative: the React `Entity`'s `enabled` prop typechecks but is
   * never applied by the library, so passing it leaves both cameras enabled and the
   * later-created one silently wins the backbuffer — the viewport freezes on the
   * scene camera while orbit input moves a camera that is no longer being rendered.
   */
  useLayoutEffect(() => {
    if (orbitCameraRef.current) orbitCameraRef.current.enabled = !through;
    if (throughCameraRef.current) throughCameraRef.current.enabled = through;
  }, [through, selected]);

  return (
    <>
      {splat && (
        <Entity
          name="splat"
          position={alignment.position}
          rotation={alignEuler}
          scale={[alignment.scale, alignment.scale, alignment.scale]}
        >
          {/* Unified rendering is the engine's new default; the non-unified path is
              deprecated. Its sorter fires the same `gsplat:sorted` event the export
              settle protocol waits on (§8.2). */}
          <GSplat asset={splat.asset} unified />
        </Entity>
      )}

      {/* `enabled` is NOT passed as a prop: the React `Entity` accepts it in its type
          (via `PublicProps<PcEntity>`) but never applies it, so it is a silent no-op.
          Both cameras would stay enabled and the later-created one would win the
          backbuffer. It is driven imperatively instead — see the effect above. */}
      <Entity name="orbit-camera" ref={orbitCameraRef}>
        <Camera clearColor={clear} nearClip={0.05} farClip={2000} fov={60} />
        {!through && <OrbitControls distance={6} distanceMin={0.1} distanceMax={500} />}
      </Entity>

      {selected && (
        <Entity
          name="through-camera"
          ref={throughCameraRef}
          position={selected.position}
          rotation={throughRotation}
        >
          <Camera
            clearColor={clear}
            fov={selected.fov}
            horizontalFov={false}
            nearClip={selected.near}
            farClip={2000}
          />
        </Entity>
      )}

      {/* Suppressed during an export run: immediate-mode lines are drawn for every
          active camera, including the offscreen rig, so leaving them on bakes the
          other cameras' frustum wireframes into the exported images (§6.3). */}
      {showMarkers && !through && exportRequest === null && (
        <CameraMarkers cameras={cameras} selectedId={selectedId} hiddenId={null} />
      )}
    </>
  );
}

/** Fits an orbit distance to a bounding box — used by the `Frame splat` action (§7.2). */
export function frameDistanceFor(box: BoundingBox, fov: number): number {
  const radius = box.halfExtents.length();
  return radius / Math.tan((fov * Math.PI) / 360) + radius;
}

export { Vec3 };
