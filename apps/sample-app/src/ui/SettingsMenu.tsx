/**
 * The top bar's "Settings" dropdown (spec §18.3): a plain-text trigger opening a
 * menu using the same interaction model as the View selector (`ViewSelector.tsx`,
 * §2.4) — closes on an outside click, Escape, or re-clicking the trigger. A
 * general-purpose, growable list of settings entries; today it holds exactly one,
 * Language, which opens `LanguageDialog.tsx`.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageDialog } from './LanguageDialog.tsx';

export function SettingsMenu() {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [languageDialogOpen, setLanguageDialogOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

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
    <>
      <div className="settings-menu-anchor" ref={anchorRef}>
        <button
          type="button"
          className={`settings-menu-btn${open ? ' active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {t('settings')}
        </button>
        {open && (
          <ul className="menu settings-menu" role="menu" aria-label={t('settings')}>
            <li
              role="menuitem"
              className="settings-menu-row"
              onClick={() => {
                setOpen(false);
                setLanguageDialogOpen(true);
              }}
            >
              {t('language')}
            </li>
          </ul>
        )}
      </div>
      {languageDialogOpen && <LanguageDialog onClose={() => setLanguageDialogOpen(false)} />}
    </>
  );
}
