import { normalizeText } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  bm25DocumentTokens,
  buildBm25Corpus,
  hasTranslation,
  STOP_WORDS,
  STOP_WORDS_CS,
  STOP_WORDS_EN,
  STOP_WORDS_SK,
  tokenize,
} from '../src/index.js';

describe('tokenize (spec 06 §9)', () => {
  it('normalizes the text, strips diacritics and splits on non-alphanumerics', () => {
    expect(tokenize('Batérie: solid-state LFP!')).toEqual(['baterie', 'solid', 'state', 'lfp']);
    expect(tokenize('Toyota’s pilot line hits 1,000 cycles')).toEqual([
      'toyota',
      'pilot',
      'line',
      'hits',
      '000',
      'cycles',
    ]);
  });

  it('drops tokens shorter than two characters', () => {
    expect(tokenize('a b c EV x5 7')).toEqual(['ev', 'x5']);
  });

  it('counts characters, not UTF-16 units, for the length rule', () => {
    expect(tokenize('𠀀')).toEqual([]);
    expect(tokenize('𠀀𠀁')).toEqual(['𠀀𠀁']);
  });

  it('drops English, Slovak and Czech stop-words', () => {
    expect(tokenize('The battery of the future is here')).toEqual(['battery', 'future']);
    expect(tokenize('Nová batéria pre elektromobily je už tu, ale')).toEqual([
      'nova',
      'bateria',
      'elektromobily',
    ]);
    expect(tokenize('Baterie pro elektromobily, které jsou také levnější')).toEqual([
      'baterie',
      'elektromobily',
      'levnejsi',
    ]);
  });

  it('keeps content words that a stop-word of another language would shadow', () => {
    expect(tokenize('most US tech byt vice tým')).toEqual([
      'most',
      'us',
      'tech',
      'byt',
      'vice',
      'tym',
    ]);
  });

  it('keeps repeated tokens, which are term frequencies', () => {
    expect(tokenize('EV, ev and EV')).toEqual(['ev', 'ev', 'ev']);
  });

  it('returns nothing for empty or punctuation-only text', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' — !? … ')).toEqual([]);
  });
});

describe('stop-word lists (spec 06 §9)', () => {
  it.each([
    ['EN', STOP_WORDS_EN],
    ['SK', STOP_WORDS_SK],
    ['CZ', STOP_WORDS_CS],
  ] as const)(
    'the %s list has about 150 words, each one token of two or more characters',
    (_, list) => {
      expect(list.length).toBeGreaterThanOrEqual(140);
      expect(list.length).toBeLessThanOrEqual(160);
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) {
        const normalized = normalizeText(word);
        expect(normalized).toMatch(/^[\p{L}\p{N}]{2,}$/u);
        expect(STOP_WORDS.has(normalized)).toBe(true);
      }
    },
  );
});

describe('bm25DocumentTokens (spec 06 §9)', () => {
  it('repeats the title, then adds the excerpt', () => {
    expect(
      bm25DocumentTokens({ titleNorm: 'solid state battery', excerptNorm: 'new cells' }),
    ).toEqual({
      original: ['solid', 'state', 'battery', 'solid', 'state', 'battery', 'new', 'cells'],
      translated: null,
    });
  });

  it('builds the translated document from the translation', () => {
    const text = {
      titleNorm: 'nova bateria',
      excerptNorm: 'pre elektromobily',
      translatedTitleNorm: 'new battery',
      translatedExcerptNorm: 'for electric cars',
    };
    expect(hasTranslation(text)).toBe(true);
    expect(bm25DocumentTokens(text)).toEqual({
      original: ['nova', 'bateria', 'nova', 'bateria', 'elektromobily'],
      translated: ['new', 'battery', 'new', 'battery', 'electric', 'cars'],
    });
    const titleOnly = { titleNorm: 'nova', excerptNorm: 'text', translatedTitleNorm: 'news' };
    expect(bm25DocumentTokens(titleOnly).translated).toEqual(['news', 'news']);
    const excerptOnly = { titleNorm: 'nova', excerptNorm: 'text', translatedExcerptNorm: 'body' };
    expect(bm25DocumentTokens(excerptOnly).translated).toEqual(['body']);
  });
});

describe('buildBm25Corpus (spec 06 §9)', () => {
  it('counts document frequencies and the mean length over every window document', () => {
    const corpus = buildBm25Corpus([
      { titleNorm: 'battery news', excerptNorm: '' },
      { titleNorm: 'market news', excerptNorm: 'market close' },
      { titleNorm: 'weather', excerptNorm: '' },
    ]);
    expect(corpus.preferred).toBe(corpus.original);
    expect(corpus.preferred.documents).toBe(3);
    expect(corpus.preferred.avgLength).toBeCloseTo((4 + 6 + 2) / 3, 12);
    expect(Object.fromEntries(corpus.preferred.df)).toEqual({
      battery: 1,
      news: 2,
      market: 1,
      close: 1,
      weather: 1,
    });
  });

  it('keeps original-text statistics beside the preferred ones when translations exist', () => {
    const corpus = buildBm25Corpus([
      { titleNorm: 'bateria', excerptNorm: '', translatedTitleNorm: 'battery' },
      { titleNorm: 'battery', excerptNorm: '' },
    ]);
    expect(corpus.preferred).not.toBe(corpus.original);
    expect(corpus.preferred.df.get('battery')).toBe(2);
    expect(corpus.preferred.df.get('bateria')).toBeUndefined();
    expect(corpus.original.df.get('battery')).toBe(1);
    expect(corpus.original.df.get('bateria')).toBe(1);
    expect(corpus.original.documents).toBe(2);
  });

  it('is empty without documents', () => {
    const corpus = buildBm25Corpus([]);
    expect(corpus.preferred).toEqual({ documents: 0, avgLength: 0, df: new Map() });
  });
});
