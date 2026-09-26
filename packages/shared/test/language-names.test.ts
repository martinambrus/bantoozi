import { describe, expect, it } from 'vitest';

import { languageName, normalizeLanguageHint } from '../src/server/index.js';

describe('languageName', () => {
  it('names the beta languages in English', () => {
    expect(languageName('sk')).toBe('Slovak');
    expect(languageName('cs')).toBe('Czech');
    expect(languageName('en')).toBe('English');
    expect(languageName('de')).toBe('German');
    expect(languageName('uk')).toBe('Ukrainian');
  });

  it('reduces a BCP 47 tag to its base language', () => {
    expect(languageName('sk-SK')).toBe('Slovak');
    expect(languageName('CS_cz')).toBe('Czech');
  });

  it('has no name for und, invalid codes or nothing', () => {
    expect(languageName('und')).toBeUndefined();
    expect(languageName('xx')).toBeUndefined();
    expect(languageName('')).toBeUndefined();
    expect(languageName(null)).toBeUndefined();
    expect(languageName(undefined)).toBeUndefined();
  });

  it('names every ISO 639-1 code that normalizeLanguageHint accepts', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let accepted = 0;
    for (const a of letters) {
      for (const b of letters) {
        const code = `${a}${b}`;
        if (normalizeLanguageHint(code) === undefined) continue;
        accepted += 1;
        expect(languageName(code), code).toMatch(/^\p{Lu}[\p{L} -]+$/u);
      }
    }
    expect(accepted).toBe(184);
  });
});
