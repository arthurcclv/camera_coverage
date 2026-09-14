/**
 * Viewport top-right layer-visibility dropdown (spec §2.4). A single eye icon
 * button opens a checklist of the viewport-only layers — Coverage, Sections,
 * Cameras, Zones, Constraints, Splats, Geometry. Toggling a checkbox flips that
 * layer immediately and leaves
 * the menu open so several can be changed in one pass; the menu closes on an
 * outside click, Escape, or re-clicking the eye button. Rows are always present
 * regardless of scene contents (toggling an empty layer is a no-op).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface ViewportLayerMenuProps {
  coverageVisible: boolean;
  sectionsVisible: boolean;
  camerasVisible: boolean;
  /**
   * The per-camera name labels (spec §5.3). Subordinate to `camerasVisible`: with
   * the camera layer hidden there is no body for a label to sit beside.
   */
  cameraNamesVisible: boolean;
  zonesVisible: boolean;
  /** Constraint gizmos + the placement pool scatter (`camera_placement.md` §5.2, §6.1). */
  constraintsVisible: boolean;
  /** The whole 3D Gaussian Splat layer (`gaussian_splats.md` §5.2). */
  splatsVisible: boolean;
  /**
   * The **rendered** scene geometry — floor, walls, boxes, glTF
   * (`gaussian_splats.md` §5.3, spec §14.6). Drawing only: the merged collision
   * mesh, the workspace AABB and every coverage result are untouched, so this
   * never marks a result stale. It is the row that makes a splat capture
   * visible, since splats draw behind opaque double-sided geometry.
   */
  geometryVisible: boolean;
  onToggleCoverage(): void;
  onToggleSections(): void;
  onToggleCameras(): void;
  onToggleCameraNames(): void;
  onToggleZones(): void;
  onToggleConstraints(): void;
  onToggleSplats(): void;
  onToggleGeometry(): void;
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

// Camera names = a name beside a point, which is what the layer draws (§5.3).
function CameraNameIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="12" r="2" fill="currentColor" stroke="none" />
      <rect x="9" y="8" width="13" height="8" rx="2" />
      <path d="M12 12h7" />
    </svg>
  );
}

// Constraints = a rail with a mount point on it (`camera_placement.md` §6.1).
function ConstraintsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 18 10 11 21 11" />
      <circle cx="10" cy="11" r="2.5" />
    </svg>
  );
}

// Splats = a scatter of soft blobs (a Gaussian cloud, `gaussian_splats.md` §5.2);
// Geometry = a solid wireframe cube, the modelled scene the splats sit behind.
function SplatsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="7" cy="8" r="3" opacity="0.85" />
      <circle cx="15" cy="6" r="2.2" opacity="0.6" />
      <circle cx="12" cy="14" r="3.4" opacity="0.75" />
      <circle cx="18" cy="15" r="2" opacity="0.5" />
      <circle cx="7" cy="18" r="2" opacity="0.55" />
    </svg>
  );
}

function GeometryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M3 7l9 5 9-5" />
      <path d="M12 12v10" />
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
  const { t } = useTranslation('common');
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
        title={t('layerVisibility')}
        aria-label={t('layerVisibility')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EyeIcon />
      </button>
      {open && (
        <ul className="menu layer-menu" role="menu" aria-label={t('layerVisibility')}>
          <LayerRow label={t('layerCoverage')} icon={<LayersIcon />} checked={props.coverageVisible} onToggle={props.onToggleCoverage} />
          <LayerRow label={t('layerSections')} icon={<GridIcon />} checked={props.sectionsVisible} onToggle={props.onToggleSections} />
          <LayerRow label={t('layerCameras')} icon={<CameraIcon />} checked={props.camerasVisible} onToggle={props.onToggleCameras} />
          <LayerRow
            label={t('layerCameraNames')}
            icon={<CameraNameIcon />}
            checked={props.cameraNamesVisible}
            onToggle={props.onToggleCameraNames}
          />
          <LayerRow label={t('layerZones')} icon={<ZonesIcon />} checked={props.zonesVisible} onToggle={props.onToggleZones} />
          <LayerRow
            label={t('layerConstraints')}
            icon={<ConstraintsIcon />}
            checked={props.constraintsVisible}
            onToggle={props.onToggleConstraints}
          />
          {/* Splats last of the entity layers, and Geometry after it: the two
              read as a pair, since hiding the model is how the capture behind it
              is seen (`gaussian_splats.md` §5.2, §5.3). */}
          <LayerRow label={t('layerSplats')} icon={<SplatsIcon />} checked={props.splatsVisible} onToggle={props.onToggleSplats} />
          <LayerRow
            label={t('layerGeometry')}
            icon={<GeometryIcon />}
            checked={props.geometryVisible}
            onToggle={props.onToggleGeometry}
          />
        </ul>
      )}
    </div>
  );
}
