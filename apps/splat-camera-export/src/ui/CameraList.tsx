/**
 * The camera list (spec §10.2): one selectable row per imported camera in file
 * order, with a per-camera include-in-run checkbox.
 */
import { cameraLabel } from '../cameras/label.ts';
import type { PreviewCamera } from '../cameras/sceneCameras.ts';

export interface CameraListProps {
  cameras: readonly PreviewCamera[];
  selectedId: string | null;
  included: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onSetAll: (included: boolean) => void;
}

export function CameraList({
  cameras,
  selectedId,
  included,
  onSelect,
  onToggle,
  onSetAll,
}: CameraListProps) {
  const runCount = cameras.filter((c) => included.has(c.id)).length;

  return (
    <section className="panel">
      <h2 className="panel-title">
        Cameras
        <span className="badge">{runCount} in run</span>
      </h2>

      {cameras.length === 0 ? (
        <p className="hint">Import a scene.json to list its cameras.</p>
      ) : (
        <>
          <div className="button-row">
            <button type="button" className="btn btn-small" onClick={() => onSetAll(true)}>
              All
            </button>
            <button type="button" className="btn btn-small" onClick={() => onSetAll(false)}>
              None
            </button>
          </div>
          <ul className="camera-list" role="listbox" aria-label="Imported cameras">
            {cameras.map((camera) => {
              const label = cameraLabel(camera);
              return (
                <li key={camera.id}>
                  <div
                    className={
                      'camera-row' +
                      (camera.id === selectedId ? ' is-selected' : '') +
                      (camera.enabled ? '' : ' is-disabled')
                    }
                    role="option"
                    aria-selected={camera.id === selectedId}
                    tabIndex={0}
                    onClick={() => onSelect(camera.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(camera.id);
                      }
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={included.has(camera.id)}
                      aria-label={`Include ${label} in the export`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggle(camera.id)}
                    />
                    <span className="camera-label">{label}</span>
                    <span className="camera-meta">
                      {camera.fov.toFixed(0)}° · {camera.aspect.toFixed(2)}
                    </span>
                    {!camera.enabled && <span className="badge badge-muted">off</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
