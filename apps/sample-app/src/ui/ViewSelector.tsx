/**
 * Viewport top-middle View selector (spec §2.4). A button showing the current
 * view's name and a chevron opens a menu of the four viewport cameras —
 * Perspective / Top / Front / Right — with a checkmark on the active one.
 * Selecting a view switches which camera the viewport renders through (§2.4)
 * and closes the menu; the menu also closes on an outside click, Escape, or
 * re-clicking the button. Labeled "View", never "Camera" — that word is
 * reserved for the coverage cameras (§5) and the Cameras layer toggle.
 */
import { useEffect, useRef, useState } from 'react';
import { VIEW_IDS, VIEW_LABELS, type ViewId } from '../scene/viewCameras.ts';

export interface ViewSelectorProps {
  activeView: ViewId;
  onSelect(view: ViewId): void;
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ViewSelector({ activeView, onSelect }: ViewSelectorProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Close on outside interaction or Escape (spec §2.4), matching the layer menu.
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
    <div className="view-menu-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`btn secondary view-menu-btn${open ? ' active' : ''}`}
        title="View"
        aria-label={`View: ${VIEW_LABELS[activeView]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="view-menu-label">{VIEW_LABELS[activeView]}</span>
        <ChevronIcon />
      </button>
      {open && (
        <ul className="menu view-menu" role="menu" aria-label="View">
          {VIEW_IDS.map((view) => (
            <li
              key={view}
              role="menuitemradio"
              aria-checked={view === activeView}
              className={`view-menu-row${view === activeView ? ' selected' : ''}`}
              onClick={() => {
                onSelect(view);
                setOpen(false);
              }}
            >
              <span className="view-menu-check">{view === activeView ? '✓' : ''}</span>
              {VIEW_LABELS[view]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
