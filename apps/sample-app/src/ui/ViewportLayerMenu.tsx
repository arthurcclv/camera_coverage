/**
 * Viewport top-right layer-visibility dropdown (spec §2.4). A single eye icon
 * button opens a checklist of the viewport-only layers — Coverage, Sections,
 * Cameras, Zones. Toggling a checkbox flips that layer immediately and leaves
 * the menu open so several can be changed in one pass; the menu closes on an
 * outside click, Escape, or re-clicking the eye button. Rows are always present
 * regardless of scene contents (toggling an empty layer is a no-op).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ViewportLayerMenuProps {
  coverageVisible: boolean;
  sectionsVisible: boolean;
  camerasVisible: boolean;
  zonesVisible: boolean;
  onToggleCoverage(): void;
  onToggleSections(): void;
  onToggleCameras(): void;
  onToggleZones(): void;
}

// Layer glyphs (spec §2.4). Coverage = stacked planes (the volumetric overlay),
// Sections = a 2×2 grid echoing the heatmap cells, Cameras = a camera body,
// Zones = a dashed ROI box for the sampling-volume gizmos.
function LayersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function ZonesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 3">
      <rect x="3" y="3" width="18" height="18" rx="1" />
    </svg>
  );
}

// The eye that opens the menu (spec §2.4).
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function LayerRow({ label, icon, checked, onToggle }: { label: string; icon: ReactNode; checked: boolean; onToggle(): void }) {
  return (
    <li role="menuitemcheckbox" aria-checked={checked} className="layer-menu-row" onClick={onToggle}>
      <input type="checkbox" checked={checked} readOnly tabIndex={-1} aria-hidden="true" />
      <span className="layer-menu-icon">{icon}</span>
      {label}
    </li>
  );
}

export function ViewportLayerMenu(props: ViewportLayerMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Close on outside interaction or Escape (spec §2.4). Clicks inside the anchor
  // (the eye button and the checklist rows) are ignored so toggling keeps the
  // menu open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (!anchorRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="layer-menu-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`btn secondary icon-btn${open ? ' active' : ''}`}
        title="Layer visibility"
        aria-label="Layer visibility"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EyeIcon />
      </button>
      {open && (
        <ul className="menu layer-menu" role="menu" aria-label="Layer visibility">
          <LayerRow label="Coverage" icon={<LayersIcon />} checked={props.coverageVisible} onToggle={props.onToggleCoverage} />
          <LayerRow label="Sections" icon={<GridIcon />} checked={props.sectionsVisible} onToggle={props.onToggleSections} />
          <LayerRow label="Cameras" icon={<CameraIcon />} checked={props.camerasVisible} onToggle={props.onToggleCameras} />
          <LayerRow label="Zones" icon={<ZonesIcon />} checked={props.zonesVisible} onToggle={props.onToggleZones} />
        </ul>
      )}
    </div>
  );
}
