import { describe, expect, it } from 'vitest';

import { createI18n, detectLanguage } from '../src/i18n/index.js';
import { LANGUAGES, NAMESPACES, RESOURCES, type Language } from '../src/i18n/resources.js';

/** Dotted key paths of a nested message object. */
function keys(messages: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? keys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

// i18next plural keys end in the Intl.PluralRules category: English has one/other, Slovak
// one/few/many/other, so a plural message legitimately has different keys per language.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function messagesOf(lang: Language, namespace: string): Record<string, unknown> {
  return RESOURCES[lang][namespace] ?? {};
}

describe('i18n resources (spec 09 §1)', () => {
  it('loads common plus one namespace per feature folder', () => {
    expect(NAMESPACES).toContain('common');
    expect(NAMESPACES).toContain('reader');
  });

  it.each(Object.keys(RESOURCES.en))(
    'namespace %s has the same messages in every language',
    (namespace) => {
      const base = (lang: Language) =>
        [
          ...new Set(keys(messagesOf(lang, namespace)).map((k) => k.replace(PLURAL_SUFFIX, ''))),
        ].sort();
      const reference = base('en');
      expect(reference.length).toBeGreaterThan(0);
      for (const lang of LANGUAGES) {
        expect({ lang, keys: base(lang) }).toEqual({ lang, keys: reference });
      }
    },
  );

  it.each(Object.keys(RESOURCES.en))(
    'plural messages of namespace %s have every plural form of each language',
    (namespace) => {
      const plurals = new Set(
        LANGUAGES.flatMap((lang) =>
          keys(messagesOf(lang, namespace))
            .filter((k) => PLURAL_SUFFIX.test(k))
            .map((k) => k.replace(PLURAL_SUFFIX, '')),
        ),
      );
      for (const lang of LANGUAGES) {
        const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
        const present = keys(messagesOf(lang, namespace));
        for (const key of plurals) {
          const forms = present
            .filter((k) => k.replace(PLURAL_SUFFIX, '') === key && PLURAL_SUFFIX.test(k))
            .map((k) => PLURAL_SUFFIX.exec(k)?.[1])
            .sort();
          expect({ lang, key, forms }).toEqual({ lang, key, forms: [...categories].sort() });
        }
      }
    },
  );

  it('translates synchronously in both languages', () => {
    expect(createI18n('sk').t('common:language')).toBe('Jazyk');
    expect(createI18n('en').t('common:language')).toBe('Language');
  });

  it('picks the first supported browser language, else English', () => {
    expect(detectLanguage(['sk-SK', 'en-US'])).toBe('sk');
    expect(detectLanguage(['de-DE', 'en-GB'])).toBe('en');
    expect(detectLanguage(['fr'])).toBe('en');
  });
});
