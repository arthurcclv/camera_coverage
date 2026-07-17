import type { CameraConfig } from '@linkervision/camera-coverage-sdk';

export interface CameraListProps {
  cameras: CameraConfig[];
  selectedId: string | null;
  flaggedIds: Set<string>;
  disabledIds: Set<string>;
  perCamera: { id: string; coverageRate: number }[] | null;
  onSelect(id: string): void;
  onToggleEnabled(id: string): void;
}

function dotColor(rate: number | undefined, flagged: boolean): string {
  if (flagged) return '#ff7d7d';
  if (rate === undefined) return '#5da9e0';
  const t = Math.max(0, Math.min(1, rate));
  const hue = (t * 120) / 360;
  return `hsl(${hue * 360}, 85%, 55%)`;
}

export function CameraList({ cameras, selectedId, flaggedIds, disabledIds, perCamera, onSelect, onToggleEnabled }: CameraListProps) {
  const rateById = new Map(perCamera?.map((p) => [p.id, p.coverageRate]));

  return (
    <div className="camera-list">
      {cameras.map((cam) => {
        const flagged = flaggedIds.has(cam.id);
        const enabled = !disabledIds.has(cam.id);
        const rate = rateById.get(cam.id);
        return (
          <div
            key={cam.id}
            className={`camera-row${cam.id === selectedId ? ' selected' : ''}${enabled ? '' : ' disabled'}`}
            onClick={() => onSelect(cam.id)}
          >
            <input
              type="checkbox"
              className="camera-row-toggle"
              checked={enabled}
              title={enabled ? 'Disable camera' : 'Enable camera'}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleEnabled(cam.id)}
            />
            <span className="dot" style={{ background: dotColor(rate, flagged) }} />
            <span>{cam.id}</span>
            {flagged && <span className="badge flagged">inside geometry</span>}
            {enabled && rate !== undefined && <span className="rate">{(rate * 100).toFixed(0)}%</span>}
          </div>
        );
      })}
    </div>
  );
}
