import { describe, expect, it } from 'vitest';

import { createI18n, detectLanguage } from '../src/i18n/index.js';
import { LANGUAGES, NAMESPACES, RESOURCES } from '../src/i18n/resources.js';

/** Dotted key paths of a nested message object. */
function keys(messages: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? keys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('i18n resources (spec 09 §1)', () => {
  it('loads common plus one namespace per feature folder', () => {
    expect(NAMESPACES).toContain('common');
    expect(NAMESPACES).toContain('home');
  });

  it.each(Object.keys(RESOURCES.en))(
    'namespace %s has the same keys in every language',
    (namespace) => {
      const reference = keys(RESOURCES.en[namespace] ?? {}).sort();
      expect(reference.length).toBeGreaterThan(0);
      for (const lang of LANGUAGES) {
        expect({ lang, keys: keys(RESOURCES[lang][namespace] ?? {}).sort() }).toEqual({
          lang,
          keys: reference,
        });
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
