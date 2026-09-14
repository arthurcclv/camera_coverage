/**
 * i18next setup (spec §18): English (default) and Traditional Chinese (zh-TW),
 * detected from the browser on first load and overridden/persisted through the
 * Settings → Language dialog (`LanguageDialog.tsx`).
 *
 * `supportedLngs` is the closed set of §18.1 — anything else the browser or a
 * stale storage value reports (`zh`, `zh-CN`, …) falls back to `fallbackLng`
 * rather than being coerced to zh-TW, matching §18.2's "anything else defaults
 * to English." `load: 'currentOnly'` keeps `zh-TW` from being reduced to a
 * generic `zh`, which would collapse the exact-match rule.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import commonEn from '../locales/en/common.json';
import cameraEn from '../locales/en/camera.json';
import sceneEn from '../locales/en/scene.json';
import optimizeEn from '../locales/en/optimize.json';
import placementEn from '../locales/en/placement.json';
import sectionsEn from '../locales/en/sections.json';
import volumesEn from '../locales/en/volumes.json';

import commonZhTW from '../locales/zh-TW/common.json';
import cameraZhTW from '../locales/zh-TW/camera.json';
import sceneZhTW from '../locales/zh-TW/scene.json';
import optimizeZhTW from '../locales/zh-TW/optimize.json';
import placementZhTW from '../locales/zh-TW/placement.json';
import sectionsZhTW from '../locales/zh-TW/sections.json';
import volumesZhTW from '../locales/zh-TW/volumes.json';

/** The namespaced key structure of spec §18.4 — one dictionary per feature area. */
export const NAMESPACES = ['common', 'camera', 'scene', 'optimize', 'placement', 'sections', 'volumes'] as const;

/** The closed locale set of spec §18.1/§18.6. */
export const SUPPORTED_LOCALES = ['en', 'zh-TW'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** The localStorage key an override is persisted under (spec §18.2). */
export const LOCALE_STORAGE_KEY = 'camera-coverage-sample-app.locale';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: commonEn,
        camera: cameraEn,
        scene: sceneEn,
        optimize: optimizeEn,
        placement: placementEn,
        sections: sectionsEn,
        volumes: volumesEn,
      },
      'zh-TW': {
        common: commonZhTW,
        camera: cameraZhTW,
        scene: sceneZhTW,
        optimize: optimizeZhTW,
        placement: placementZhTW,
        sections: sectionsZhTW,
        volumes: volumesZhTW,
      },
    },
    ns: NAMESPACES,
    defaultNS: 'common',
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LOCALES,
    nonExplicitSupportedLngs: false,
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    react: { useSuspense: false },
  });

// Keeps <html lang> in sync with the active locale (spec §18.2), including the
// initial resolution from detection above.
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
document.documentElement.lang = i18n.resolvedLanguage ?? 'en';

export default i18n;
