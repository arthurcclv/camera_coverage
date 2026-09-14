/**
 * Viewport top-middle View selector (spec §2.4). A button showing the current
 * view's name and a chevron opens a menu of the five viewport cameras —
 * Perspective / Top / Front / Right / Selected — with a checkmark on the active
 * one. Selecting a view switches which camera the viewport renders through (§2.4)
 * and closes the menu; the menu also closes on an outside click, Escape, or
 * re-clicking the button. Labeled "View", never "Camera" — that word is
 * reserved for the coverage cameras (§5) and the Cameras layer toggle, which is
 * why the camera view's row reads "Selected" (§2.4.1).
 *
 * A row may be **disabled** — the Selected row is, whenever the selection is not
 * a camera (§2.4.1). A disabled row is dimmed, carries a tooltip explaining why,
 * and does not respond to clicks.
 *
 * Immediately to its right sits the **Reset view** button (§2.4), which re-frames
 * the active view on the current scene bounds. It lives here rather than beside
 * this component so the two read as one toolbar group. It is disabled in the
 * Selected view, which has no framing of its own to reset (§2.4.1).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VIEW_IDS, type ViewId } from '../scene/viewCameras.ts';

/** i18n key per view (spec §18.4), replacing `VIEW_LABELS`'s hardcoded strings. */
const VIEW_LABEL_KEYS: Record<ViewId, string> = {
  perspective: 'viewPerspective',
  top: 'viewTop',
  front: 'viewFront',
  right: 'viewRight',
  camera: 'viewSelected',
};

export interface ViewSelectorProps {
  activeView: ViewId;
  onSelect(view: ViewId): void;
  /** Views that cannot currently be chosen, mapped to the reason (a tooltip). */
  disabledViews?: ReadonlyMap<ViewId, string>;
  /** Re-frame the active view on the current scene bounds (spec §2.4). */
  onResetView(): void;
}

/**
 * Four corner brackets closing on a centre dot — "frame the scene", which is what
 * the reset does; deliberately not a circular-arrow undo glyph, which would imply
 * it reverts the last action.
 */
function FrameIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8V5a2 2 0 0 1 2-2h3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ViewSelector({ activeView, onSelect, disabledViews, onResetView }: ViewSelectorProps) {
  const { t } = useTranslation('common');
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

  // The Selected view is derived wholly from the selected camera (spec §2.4.1),
  // so there is no framing to reset. Same dimmed-plus-tooltip treatment the
  // Selected *row* gets when no camera is selected.
  const resetDisabledReason = activeView === 'camera' ? t('resetViewDisabledReason') : undefined;

  return (
    <div className="view-toolbar-group">
      <div className="view-menu-anchor" ref={anchorRef}>
        <button
          type="button"
          className={`btn secondary view-menu-btn${open ? ' active' : ''}`}
          title={t('view')}
          aria-label={`${t('view')}: ${t(VIEW_LABEL_KEYS[activeView])}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="view-menu-label">{t(VIEW_LABEL_KEYS[activeView])}</span>
          <ChevronIcon />
        </button>
        {open && (
          <ul className="menu view-menu" role="menu" aria-label={t('view')}>
            {VIEW_IDS.map((view) => {
              const disabledReason = disabledViews?.get(view);
              return (
                <li
                  key={view}
                  role="menuitemradio"
                  aria-checked={view === activeView}
                  aria-disabled={disabledReason ? true : undefined}
                  title={disabledReason}
                  className={`view-menu-row${view === activeView ? ' selected' : ''}${disabledReason ? ' disabled' : ''}`}
                  onClick={() => {
                    if (disabledReason) return;
                    onSelect(view);
                    setOpen(false);
                  }}
                >
                  <span className="view-menu-check">{view === activeView ? '✓' : ''}</span>
                  {t(VIEW_LABEL_KEYS[view])}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button
        type="button"
        className="btn secondary view-reset-btn"
        title={resetDisabledReason ?? t('resetView')}
        aria-label={t('resetViewLabel')}
        disabled={!!resetDisabledReason}
        onClick={onResetView}
      >
        <FrameIcon />
      </button>
    </div>
  );
}
