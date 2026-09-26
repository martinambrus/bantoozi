import { describe, expect, it } from 'vitest';

import {
  bm25,
  bm25DocumentTokens,
  bm25Idf,
  bm25P,
  bm25Pairing,
  buildBm25Corpus,
  DEFAULT_RANKER_CONFIG,
  degradedScore,
  tokenize,
  type Bm25Text,
} from '../src/index.js';
import { card } from './support.js';

const config = DEFAULT_RANKER_CONFIG;

const doc = (titleNorm: string, excerptNorm = ''): Bm25Text => ({ titleNorm, excerptNorm });

/**
 * A hand-made window: `market` is in five of seven documents, `battery` in one. Documents a and b
 * have the same length and term frequencies, so only the window-level IDF separates them.
 */
const WINDOW = {
  a: doc('battery news'),
  b: doc('market news'),
  c: doc('market report'),
  d: doc('market today'),
  e: doc('market close'),
  f: doc('market watch'),
  g: doc('weather forecast'),
};

function score(query: string, text: Bm25Text, window: readonly Bm25Text[]): number {
  const corpus = buildBm25Corpus(window);
  return bm25(tokenize(query), bm25DocumentTokens(text).original, corpus.preferred, config);
}

describe('bm25Idf (spec 06 §9)', () => {
  it('is ln(1 + (N − df + 0.5) / (df + 0.5))', () => {
    expect(bm25Idf(1, 10)).toBeCloseTo(Math.log(1 + 9.5 / 1.5), 12);
    expect(bm25Idf(10, 10)).toBeCloseTo(Math.log(1 + 0.5 / 10.5), 12);
    expect(bm25Idf(0, 10)).toBeCloseTo(Math.log(1 + 10.5 / 0.5), 12);
  });

  it('clamps df into [0, N], so the IDF is always positive and finite', () => {
    expect(bm25Idf(12, 10)).toBe(bm25Idf(10, 10));
    expect(bm25Idf(-1, 10)).toBe(bm25Idf(0, 10));
    expect(bm25Idf(0, 0)).toBeCloseTo(Math.log(2), 12);
    expect(bm25Idf(10, 10)).toBeGreaterThan(0);
  });
});

describe('bm25 (spec 06 §9)', () => {
  it('computes the exact term contributions', () => {
    // N = 3; lengths 8, 4, 4 (avg 16/3); df(solid) = 1, df(battery) = 2; k1 = 1.2, b = 0.75.
    const window = [
      doc('solid state battery', 'battery cells'),
      doc('battery prices'),
      doc('election', 'results today'),
    ];
    const lengthNorm = 1.2 * (1 - 0.75 + (0.75 * 8) / (16 / 3));
    const solid = (Math.log(1 + 2.5 / 1.5) * 2 * 2.2) / (2 + lengthNorm);
    const battery = (Math.log(1 + 1.5 / 2.5) * 3 * 2.2) / (3 + lengthNorm);
    const s = score('solid battery', window[0] as Bm25Text, window);
    expect(s).toBeCloseTo(solid + battery, 12);
    expect(s).toBeCloseTo(1.8494714358609334, 12);
  });

  it('ranks a term that is rare in the window above one that is frequent there', () => {
    const window = Object.values(WINDOW);
    const rare = score('battery market', WINDOW.a, window);
    const frequent = score('battery market', WINDOW.b, window);
    expect(rare).toBeGreaterThan(frequent);
    expect(frequent).toBeGreaterThan(0);
  });

  it('uses the whole window’s statistics, not only the documents being scored', () => {
    const dirtyOnly = [WINDOW.a, WINDOW.b];
    // Scored against the two dirty documents alone, both terms look equally rare.
    expect(score('battery market', WINDOW.a, dirtyOnly)).toBeCloseTo(
      score('battery market', WINDOW.b, dirtyOnly),
      12,
    );
    const window = Object.values(WINDOW);
    expect(score('battery market', WINDOW.a, window)).not.toBeCloseTo(
      score('battery market', WINDOW.b, window),
      3,
    );
  });

  it('sums unique query terms only', () => {
    const window = Object.values(WINDOW);
    expect(score('battery battery battery', WINDOW.a, window)).toBe(
      score('battery', WINDOW.a, window),
    );
  });

  it('normalizes by document length with b from the config', () => {
    const window = [doc('battery'), doc('battery', 'cells cells cells cells'), doc('weather')];
    const corpus = buildBm25Corpus(window);
    const run = (text: Bm25Text, b: number) =>
      bm25(['battery'], bm25DocumentTokens(text).original, corpus.preferred, {
        bm25: { k1: 1.2, b, scale: 3 },
      });
    expect(run(window[0] as Bm25Text, 0.75)).toBeGreaterThan(run(window[1] as Bm25Text, 0.75));
    expect(run(window[0] as Bm25Text, 0)).toBeCloseTo(run(window[1] as Bm25Text, 0), 12);
  });

  it('scores 0, never NaN, for an empty corpus, document or query or a zero mean length', () => {
    const window = Object.values(WINDOW);
    const corpus = buildBm25Corpus(window);
    const tokens = bm25DocumentTokens(WINDOW.a).original;
    expect(bm25(['battery'], tokens, buildBm25Corpus([]).preferred, config)).toBe(0);
    expect(bm25(['battery'], [], corpus.preferred, config)).toBe(0);
    expect(bm25([], tokens, corpus.preferred, config)).toBe(0);
    const stopWordsOnly = buildBm25Corpus([doc('the', 'a'), doc('of')]);
    expect(stopWordsOnly.preferred.avgLength).toBe(0);
    expect(bm25(['battery'], tokens, stopWordsOnly.preferred, config)).toBe(0);
    expect(score('the of and', WINDOW.a, window)).toBe(0);
  });
});

describe('bm25P (spec 06 §9)', () => {
  it('is 1 − exp(−s / 3) with the default scale', () => {
    expect(bm25P(3, config)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(bm25P(3 * Math.log(2), config)).toBeCloseTo(0.5, 12);
    expect(bm25P(1.8494714358609334, config)).toBeCloseTo(
      1 - Math.exp(-1.8494714358609334 / 3),
      12,
    );
    expect(bm25P(0, config)).toBe(0);
  });

  it('uses the configured scale', () => {
    expect(bm25P(1, { bm25: { k1: 1.2, b: 0.75, scale: 1 } })).toBeCloseTo(1 - Math.exp(-1), 12);
  });

  it('stays in [0, 1] for any score', () => {
    expect(bm25P(-2, config)).toBe(0);
    expect(bm25P(Number.NaN, config)).toBe(0);
    expect(bm25P(Number.POSITIVE_INFINITY, config)).toBe(1);
    expect(bm25P(1e6, config)).toBe(1);
  });
});

describe('bm25Pairing (spec 06 §9)', () => {
  const translatedSk = {
    lang: 'sk',
    titleNorm: 'bateria',
    excerptNorm: '',
    translatedTitleNorm: 'battery',
  };
  const englishArticle = { lang: 'en', titleNorm: 'battery', excerptNorm: '' };
  const slovakArticle = { lang: 'sk', titleNorm: 'bateria', excerptNorm: '' };

  it('pairs a translated (English) article with interest_en', () => {
    expect(bm25Pairing({ interestEn: 'batteries', lang: 'sk' }, translatedSk)).toEqual({
      document: 'translated',
      query: 'interest_en',
      untranslatedQuery: false,
    });
  });

  it('pairs a translated article with a card written in English', () => {
    expect(bm25Pairing({ lang: 'en' }, translatedSk)).toEqual({
      document: 'translated',
      query: 'interest',
      untranslatedQuery: false,
    });
  });

  it('never pairs a translated article with an untranslated Slovak/Czech query', () => {
    for (const lang of ['sk', 'cs', undefined]) {
      expect(
        bm25Pairing({ lang, interestEn: lang === 'sk' ? '  ' : undefined }, translatedSk),
      ).toEqual({
        document: 'original',
        query: 'interest',
        untranslatedQuery: true,
      });
    }
  });

  it('uses interest_en only with an English document', () => {
    expect(bm25Pairing({ interestEn: 'batteries', lang: 'sk' }, englishArticle)).toEqual({
      document: 'original',
      query: 'interest_en',
      untranslatedQuery: false,
    });
    expect(bm25Pairing({ interestEn: 'batteries', lang: 'sk' }, slovakArticle)).toEqual({
      document: 'original',
      query: 'interest',
      untranslatedQuery: false,
    });
  });

  it('flags an English article against a card without English text', () => {
    expect(bm25Pairing({ lang: 'sk' }, englishArticle).untranslatedQuery).toBe(true);
    expect(bm25Pairing({ lang: 'en' }, englishArticle).untranslatedQuery).toBe(false);
    expect(bm25Pairing({ lang: 'en' }, slovakArticle).untranslatedQuery).toBe(false);
  });
});

describe('degradedScore (spec 06 §9)', () => {
  const window = Object.values(WINDOW);
  const corpus = buildBm25Corpus(window);
  const item = { ...WINDOW.a, lang: 'en', inferenceFeedIds: ['1'] };

  it('takes the maximum over the applicable positive cards, P = 1 − exp(−s / 3)', () => {
    const cards = [
      card('1', 'like', { interest: 'stock market', lang: 'en' }),
      card('2', 'love', { interest: 'battery chemistry', lang: 'en' }),
      card('3', 'must', { interest: 'gardening', lang: 'en' }),
    ];
    const result = degradedScore(cards, item, corpus, config);
    const battery = score('battery chemistry', WINDOW.a, window);
    expect(result).toMatchObject({ s: battery, bestCardId: '2' });
    expect(result?.p).toBeCloseTo(1 - Math.exp(-battery / 3), 12);
    expect(result?.cards.map((c) => [c.cardId, c.s])).toEqual([
      ['1', 0],
      ['2', battery],
      ['3', 0],
    ]);
  });

  it('ignores never-cards and cards scoped to other feeds', () => {
    const cards = [
      card('1', 'never', { interest: 'battery', lang: 'en' }),
      card('2', 'love', { interest: 'battery', lang: 'en', scopeFeedId: '9' }),
      card('3', 'like', { interest: 'weather', lang: 'en' }),
    ];
    expect(degradedScore(cards, item, corpus, config)).toMatchObject({
      s: 0,
      p: 0,
      bestCardId: '3',
    });
    expect(
      degradedScore(cards, { ...item, inferenceFeedIds: ['1', '9'] }, corpus, config)?.bestCardId,
    ).toBe('2');
    expect(degradedScore(cards.slice(0, 1), item, corpus, config)).toBeNull();
    expect(degradedScore([], item, corpus, config)).toBeNull();
  });

  it('breaks ties by the lowest numeric card id', () => {
    const cards = [
      card('10', 'love', { interest: 'battery' }),
      card('9', 'like', { interest: 'battery' }),
    ];
    expect(degradedScore(cards, item, corpus, config)?.bestCardId).toBe('9');
  });

  it('scores a translated article with English queries and falls back to the original pair', () => {
    const translated = {
      titleNorm: 'recyklacia baterii',
      excerptNorm: 'nove zavody',
      translatedTitleNorm: 'battery recycling',
      translatedExcerptNorm: 'new plants',
      lang: 'sk',
      inferenceFeedIds: ['1'],
    };
    const mixed = buildBm25Corpus([translated, doc('recyklacia odpadu'), doc('battery prices')]);
    const tokens = bm25DocumentTokens(translated);
    const cards = [
      card('1', 'love', {
        interest: 'Recyklácia batérií',
        interestEn: 'battery recycling',
        lang: 'sk',
      }),
      card('2', 'like', { interest: 'battery recycling', lang: 'en' }),
      card('3', 'love', { interest: 'Recyklácia batérií', lang: 'sk' }),
    ];
    const result = degradedScore(cards, translated, mixed, config);
    const english = bm25(
      tokenize('battery recycling'),
      tokens.translated ?? [],
      mixed.preferred,
      config,
    );
    const original = bm25(tokenize('Recyklácia batérií'), tokens.original, mixed.original, config);
    expect(result?.cards).toEqual([
      {
        cardId: '1',
        s: english,
        pairing: { document: 'translated', query: 'interest_en', untranslatedQuery: false },
      },
      {
        cardId: '2',
        s: english,
        pairing: { document: 'translated', query: 'interest', untranslatedQuery: false },
      },
      {
        cardId: '3',
        s: original,
        pairing: { document: 'original', query: 'interest', untranslatedQuery: true },
      },
    ]);
    expect(english).toBeGreaterThan(0);
    expect(original).toBeGreaterThan(0);
    expect(original).not.toBeCloseTo(
      bm25(tokenize('Recyklácia batérií'), tokens.original, mixed.preferred, config),
      6,
    );
  });

  it('scores an empty article 0', () => {
    const empty = { titleNorm: '', excerptNorm: '', lang: 'en', inferenceFeedIds: ['1'] };
    expect(
      degradedScore([card('1', 'love', { interest: 'battery' })], empty, corpus, config),
    ).toMatchObject({
      s: 0,
      p: 0,
    });
  });
});
