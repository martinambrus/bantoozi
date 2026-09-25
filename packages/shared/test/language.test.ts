import { francAll } from 'franc-all';
import { describe, expect, it } from 'vitest';

import { detectLanguage, normalizeLanguageHint } from '../src/server/index.js';
import { LANGUAGE_SAMPLES } from './fixtures/language-samples.js';

const WHITELIST = [
  'eng',
  'slk',
  'ces',
  'deu',
  'pol',
  'hun',
  'fra',
  'spa',
  'ita',
  'por',
  'nld',
  'ukr',
  'rus',
];

describe('detectLanguage (spec 03 §8.3)', () => {
  it('has at least 10 labelled samples each for en, sk and cs', () => {
    for (const lang of ['en', 'sk', 'cs'] as const) {
      expect(LANGUAGE_SAMPLES.filter((s) => s.lang === lang).length).toBeGreaterThanOrEqual(10);
    }
  });

  it('reaches ≥ 90 % accuracy on the labelled samples without hints', () => {
    const misses = LANGUAGE_SAMPLES.filter((s) => detectLanguage(s.text).lang !== s.lang);
    const accuracy = (LANGUAGE_SAMPLES.length - misses.length) / LANGUAGE_SAMPLES.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('breaks a Slovak/Czech tie with an sk/cs hint', () => {
    const text = 'Hokejisté vyhráli zápas proti Kanadě po nájazdech.';
    // Precondition: the top two are {ces, slk} with a separation in [0.05, 0.15).
    const [top, second] = francAll(text, { only: WHITELIST, minLength: 20 });
    expect(new Set([top?.[0], second?.[0]])).toEqual(new Set(['ces', 'slk']));
    const separation = (top?.[1] ?? 0) - (second?.[1] ?? 0);
    expect(separation).toBeGreaterThanOrEqual(0.05);
    expect(separation).toBeLessThan(0.15);

    expect(detectLanguage(text).lang).toBe('cs');
    expect(detectLanguage(text, { hint: 'sk' }).lang).toBe('sk');
    expect(detectLanguage(text, { hint: 'sk-SK' }).lang).toBe('sk');
    expect(detectLanguage(text, { hint: 'cs_CZ' }).lang).toBe('cs');
    // A non-sk/cs whitelisted hint does not override a separation above 0.05.
    expect(detectLanguage(text, { hint: 'en' }).lang).toBe('cs');
  });

  it('uses the hint when the detector separation is below 0.05', () => {
    const text = 'Hokejisti vyhrali zápas proti Kanade po nájazdoch.';
    const result = detectLanguage(text, { hint: 'sk' });
    expect(result.confidence).toBeLessThan(0.05);
    expect(result.lang).toBe('sk');
  });

  it('returns the hint (or und) with confidence 0 for short texts; card texts use minLength 10', () => {
    expect(detectLanguage('AI čipy', { hint: 'sk', minLength: 10 })).toEqual({
      lang: 'sk',
      confidence: 0,
    });
    expect(detectLanguage('AI čipy', { minLength: 10 })).toEqual({ lang: 'und', confidence: 0 });
    // A 12-character card text is long enough for minLength 10 but not for the default 40.
    const card = 'Nové batérie';
    expect(detectLanguage(card, { hint: 'sk' }).confidence).toBe(0);
    expect(detectLanguage(card, { hint: 'en', minLength: 10 }).lang).not.toBe('und');
  });

  it('keeps a valid publisher hint outside the whitelist over a confident detector result', () => {
    const english = LANGUAGE_SAMPLES.find((s) => s.lang === 'en')?.text ?? '';
    expect(detectLanguage(english).lang).toBe('en');
    expect(detectLanguage(english, { hint: 'sv' })).toEqual({ lang: 'sv', confidence: 0 });
    expect(detectLanguage(english, { hint: 'sv-SE' })).toEqual({ lang: 'sv', confidence: 0 });
  });

  it('ignores hints that are not ISO 639-1 codes', () => {
    expect(normalizeLanguageHint('english')).toBeUndefined();
    expect(normalizeLanguageHint('xx')).toBeUndefined();
    expect(normalizeLanguageHint('SK')).toBe('sk');
    expect(normalizeLanguageHint(null)).toBeUndefined();
    const english = LANGUAGE_SAMPLES.find((s) => s.lang === 'en')?.text ?? '';
    expect(detectLanguage(english, { hint: 'english' }).lang).toBe('en');
  });

  it('reports a relative separation score in [0, 1]', () => {
    for (const s of LANGUAGE_SAMPLES) {
      const { confidence } = detectLanguage(s.text);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });
});
