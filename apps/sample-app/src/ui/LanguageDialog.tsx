/**
 * The Language dialog (spec §18.3), opened from the Settings menu (`SettingsMenu.tsx`).
 * A centred modal over a dimmed backdrop — the same blocking-surface pattern as the
 * scene-file dialogs (§14.7) — listing the two supported locales as a radio-style
 * choice, each labeled in its own language regardless of which locale is currently
 * active. Buttons: Cancel, Apply. Cancel and Escape are a no-op, matching §14.7's
 * "cancelling is always the safe half"; Apply commits the selection (§18.2) and
 * closes the dialog without touching scene state.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal.tsx';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../i18n/index.ts';

export interface LanguageDialogProps {
  onClose(): void;
}

const LOCALE_LABEL_KEY: Record<SupportedLocale, string> = {
  en: 'languageNameEn',
  'zh-TW': 'languageNameZhTW',
};

export function LanguageDialog({ onClose }: LanguageDialogProps) {
  const { t, i18n } = useTranslation('common');
  const active = (i18n.resolvedLanguage as SupportedLocale) ?? 'en';
  const [selected, setSelected] = useState<SupportedLocale>(active);

  const apply = () => {
    void i18n.changeLanguage(selected);
    onClose();
  };

  return (
    <Modal
      title={t('languageDialogTitle')}
      onCancel={onClose}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="button" className="btn" onClick={apply}>
            {t('apply')}
          </button>
        </>
      }
    >
      <ul className="language-dialog-list" role="radiogroup" aria-label={t('languageDialogTitle')}>
        {SUPPORTED_LOCALES.map((locale) => (
          <li
            key={locale}
            role="radio"
            aria-checked={locale === selected}
            className={`language-dialog-row${locale === selected ? ' selected' : ''}`}
            onClick={() => setSelected(locale)}
          >
            <span className="language-dialog-check">{locale === selected ? '✓' : ''}</span>
            {t(LOCALE_LABEL_KEY[locale])}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
