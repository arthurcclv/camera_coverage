/**
 * Selected-geometry editor (`geometry_assets.md` §7): the display name, the
 * object's kind, a mesh's read-only source, and the transform that places it in
 * the scene.
 *
 * **Every field here marks the coverage result stale** — the exact opposite of
 * `SplatPanel`, and for the one reason that governs this whole feature: a
 * geometry object contributes triangles to the collision mesh and bounds to the
 * workspace, so moving it changes what the cameras can see (§1.1). Only the
 * name does not.
 *
 * **Scale is per-axis**, unlike a splat's single number: a triangle mesh takes a
 * non-uniform scale correctly, because no triangle has a covariance to shear
 * (`gaussian_splats.md` §2.1). That is also why a geometry object is a
 * scale-capable gizmo selection while a splat is not (`spec.md` §2.4).
 *
 * **A primitive's own parameters are read-only.** "How tall is this room" is a
 * fair question; authoring a room by typing its height is a separate feature
 * (§14), and `spec.md` §14.9's "use GLB for arbitrary shapes" still stands.
 */
import { useTranslation } from 'react-i18next';
import { eulerToQuat, quatToEuler } from '../cameras/math.ts';
import { basename, type GeometryObject, type GeometryTransform } from '../scene/geometryModel.ts';
import { Vec3Field } from './Vec3Field.tsx';

export interface GeometryPanelProps {
  object: GeometryObject | null;
  /** The row's resolved label (§2.4) — App owns the per-kind ordinals. */
  label: string;
  onRename(id: string, name: string): void;
  onChange(id: string, patch: Partial<GeometryTransform>): void;
}

/**
 * Smallest scale component the field accepts. `0` collapses the object to
 * nothing and a negative value mirrors it, inverting every triangle's winding —
 * the file reader refuses both too (§8).
 */
const MIN_GEOMETRY_SCALE = 1e-3;

export function GeometryPanel({ object, label, onRename, onChange }: GeometryPanelProps) {
  const { t } = useTranslation(['scene', 'common']);
  if (!object) return null;

  const euler = quatToEuler(object.rotation);

  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const p = [...object.position] as GeometryTransform['position'];
    p[axis] = v;
    onChange(object.id, { position: p });
  };
  const setScale = (axis: 0 | 1 | 2, v: number) => {
    const s = [...object.scale] as GeometryTransform['scale'];
    s[axis] = v;
    onChange(object.id, { scale: s });
  };
  const setEuler = (patch: Partial<ReturnType<typeof quatToEuler>>) =>
    onChange(object.id, { rotation: eulerToQuat({ ...euler, ...patch }) });

  return (
    <div className="panel">
      <p className="panel-title">
        {t('geometryPanel.titlePrefix', { label })}
        <span className="badge">{t(`sceneHierarchy.geometry.kind.${object.kind}`)}</span>
      </p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="geometry-name">{t('common:name')}</label>
          <input
            id="geometry-name"
            className="text-input"
            type="text"
            value={object.name}
            // Blank falls back to the file's basename for a mesh, `Room N` /
            // `Box N` for a primitive (§2.4) — which is exactly `label`.
            placeholder={object.kind === 'mesh' ? basename(object.src) : label}
            onChange={(e) => onRename(object.id, e.target.value)}
          />
        </div>

        {/* The asset this row points at, read-only (§7). Re-pointing a row at a
            different file is Delete + Add, which is also what keeps the parse
            cache's refcount honest (§3.5). */}
        {object.kind === 'mesh' && (
          <div className="row">
            <label>{t('geometryPanel.sourceLabel')}</label>
            <span className="splat-source" title={object.src}>
              {object.src}
            </span>
          </div>
        )}

        <Vec3Field
          label={t('common:position')}
          digits={2}
          columns={[
            { label: 'X', value: object.position[0], onCommit: (v) => setPosition(0, v) },
            { label: 'Y', value: object.position[1], onCommit: (v) => setPosition(1, v) },
            { label: 'Z', value: object.position[2], onCommit: (v) => setPosition(2, v) },
          ]}
        />

        {/* Euler degrees over the stored quaternion, through the app's shared
            pair (`cameras/math.ts`). X is bounded to ±90 for the `YXZ`
            decomposition reason `SplatPanel` records — and ±90 about X is
            exactly the Z-up→Y-up correction a CAD or photogrammetry export
            needs, which is the preset stage 3 adds here (§7). */}
        <Vec3Field
          label={t('common:rotation')}
          digits={2}
          columns={[
            { label: 'X', value: euler.pitch, min: -90, max: 90, onCommit: (v) => setEuler({ pitch: v }) },
            { label: 'Y', value: euler.yaw, onCommit: (v) => setEuler({ yaw: v }) },
            { label: 'Z', value: euler.roll, onCommit: (v) => setEuler({ roll: v }) },
          ]}
        />

        <Vec3Field
          label={t('common:scale')}
          digits={3}
          columns={[
            { label: 'X', value: object.scale[0], min: MIN_GEOMETRY_SCALE, onCommit: (v) => setScale(0, v) },
            { label: 'Y', value: object.scale[1], min: MIN_GEOMETRY_SCALE, onCommit: (v) => setScale(1, v) },
            { label: 'Z', value: object.scale[2], min: MIN_GEOMETRY_SCALE, onCommit: (v) => setScale(2, v) },
          ]}
        />

        {/* Read-only shape parameters (§7). */}
        {object.kind === 'room' && (
          <div className="row">
            <label>{t('geometryPanel.roomParams')}</label>
            <span className="hint">
              {t('geometryPanel.roomParamsValue', {
                x: (object.halfX * 2).toFixed(1),
                z: (object.halfZ * 2).toFixed(1),
                height: object.height.toFixed(1),
                thickness: object.thickness.toFixed(2),
              })}
            </span>
          </div>
        )}
        {object.kind === 'box' && (
          <div className="row">
            <label>{t('geometryPanel.boxParams')}</label>
            <span className="hint">
              {t('geometryPanel.boxParamsValue', {
                x: (object.max[0] - object.min[0]).toFixed(2),
                y: (object.max[1] - object.min[1]).toFixed(2),
                z: (object.max[2] - object.min[2]).toFixed(2),
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
