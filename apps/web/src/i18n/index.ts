import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { DEFAULT_LANGUAGE, LANGUAGES, NAMESPACES, RESOURCES, type Language } from './resources.js';

export { DEFAULT_LANGUAGE, LANGUAGES, type Language } from './resources.js';

/** A ready i18next instance (resources are bundled, so initialization is synchronous). */
export function createI18n(language: Language = DEFAULT_LANGUAGE): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources: RESOURCES,
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...LANGUAGES],
    ns: NAMESPACES,
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}

/** The browser's preferred supported language (the account locale overrides it after login). */
export function detectLanguage(languages: readonly string[]): Language {
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if ((LANGUAGES as readonly string[]).includes(base ?? '')) return base as Language;
  }
  return DEFAULT_LANGUAGE;
}
