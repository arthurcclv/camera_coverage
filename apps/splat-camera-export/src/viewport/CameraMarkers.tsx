/**
 * Camera gizmos in the orbit view (spec §6.3): a clickable body plus a frustum
 * wireframe sized from the camera's `fov`/`aspect`.
 *
 * Drawn imperatively with the engine's immediate-mode line API rather than as mesh
 * entities — the markers are pure overlay, never picked up by the export rig's
 * render (which runs with the viewport camera disabled, §8.1).
 */
import { useLayoutEffect } from 'react';
import { useApp } from '@playcanvas/react/hooks';
import { Color, Mat4, Quat, Vec3 } from 'playcanvas';
import type { PreviewCamera } from '../cameras/sceneCameras.ts';

/** How far down -Z the frustum wireframe is drawn (§6.3) — not `far`, which is unreadable at 1000 m. */
const DISPLAY_DEPTH = 1.2;

const SELECTED = new Color(1, 0.75, 0.2);
const ENABLED = new Color(0.4, 0.8, 1);
const DISABLED = new Color(0.45, 0.45, 0.5);

/** The frustum's 4 far-plane corners in camera-local space, at {@link DISPLAY_DEPTH}. */
function frustumCorners(fov: number, aspect: number): Vec3[] {
  const halfH = Math.tan((fov * Math.PI) / 360) * DISPLAY_DEPTH;
  const halfW = halfH * aspect;
  // Camera looks down -Z (§3).
  return [
    new Vec3(-halfW, -halfH, -DISPLAY_DEPTH),
    new Vec3(halfW, -halfH, -DISPLAY_DEPTH),
    new Vec3(halfW, halfH, -DISPLAY_DEPTH),
    new Vec3(-halfW, halfH, -DISPLAY_DEPTH),
  ];
}

export interface CameraMarkersProps {
  cameras: readonly PreviewCamera[];
  selectedId: string | null;
  /** Hidden entirely while rendering through a camera, and for the selected camera itself (§6.1). */
  hiddenId?: string | null;
}

/**
 * Draws a marker per camera each frame. Returns `null` — it contributes lines, not
 * entities, so nothing is added to the React-managed scene graph.
 */
export function CameraMarkers({ cameras, selectedId, hiddenId }: CameraMarkersProps) {
  const app = useApp();

  useLayoutEffect(() => {
    const onUpdate = () => {
      const world = new Mat4();
      for (const camera of cameras) {
        if (camera.id === hiddenId) continue;

        const [px, py, pz] = camera.position;
        const [rx, ry, rz, rw] = camera.rotation;
        const origin = new Vec3(px, py, pz);
        world.setTRS(origin, new Quat(rx, ry, rz, rw), Vec3.ONE);

        const color = camera.id === selectedId ? SELECTED : camera.enabled ? ENABLED : DISABLED;
        const corners = frustumCorners(camera.fov, camera.aspect).map((c) => world.transformPoint(c, new Vec3()));

        // Frustum edges: origin to each corner, plus the far rectangle.
        for (const corner of corners) app.drawLine(origin, corner, color);
        for (let i = 0; i < 4; i++) app.drawLine(corners[i], corners[(i + 1) % 4], color);

        // A small cross at the eye point marks the body (§6.3).
        const s = 0.06;
        app.drawLine(new Vec3(px - s, py, pz), new Vec3(px + s, py, pz), color);
        app.drawLine(new Vec3(px, py - s, pz), new Vec3(px, py + s, pz), color);
        app.drawLine(new Vec3(px, py, pz - s), new Vec3(px, py, pz + s), color);
      }
    };

    app.on('update', onUpdate);
    return () => {
      app.off('update', onUpdate);
    };
  }, [app, cameras, selectedId, hiddenId]);

  return null;
}
