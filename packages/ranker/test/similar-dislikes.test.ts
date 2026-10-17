import { describe, expect, it } from 'vitest';

import {
  dislikePatternOffer,
  SIMILAR_DISLIKES,
  similarDislikes,
  similarityTokens,
  type LabelledArticle,
} from '../src/index.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

function item(id: string, rating: 1 | -1, title: string, days: number): LabelledArticle {
  return { articleId: id, rating, ratedAt: daysAgo(days), tokens: similarityTokens(title) };
}

const OLD_TITLES = [
  'Skoda 100 L originál: 450',
  'Škoda Felícia 1.3 MPI nové STK: 900',
  'Zdvihák škoda 100: 10',
  'Škoda 120 L garáž: 600',
  'Škoda Favorit 136 LX: 1 200',
  'Škoda 105 S pôvodný stav: Dohodou',
];
const MODERN_TITLES = [
  'Škoda Fabia III 1.4TDI 105k JOY+: 9 290',
  'Škoda Octavia Combi 2.0 TDI DSG Style: 14 500',
  'Škoda Superb 2.0 TSI 4x4 Laurin: 21 900',
  'Škoda Kodiaq 2.0 TDI Sportline: 28 000',
  'Škoda Karoq 1.5 TSI Ambition: 19 800',
  'Škoda Scala 1.0 TSI Monte Carlo: 17 300',
  'Škoda Kamiq 1.0 TSI Style: 16 900',
  'Škoda Enyaq iV 80 Loft: 33 000',
];

function fixture(): LabelledArticle[] {
  return [
    ...OLD_TITLES.map((t, i) => item(`d${i}`, -1, t, 2 + i)),
    ...MODERN_TITLES.map((t, i) => item(`l${i}`, 1, t, 1 + i)),
  ];
}

const target = (id: string, title: string) => ({ articleId: id, tokens: similarityTokens(title) });

describe('similarityTokens', () => {
  it('strips a numeric price segment', () => {
    expect(similarityTokens('Škoda Fabia: 9 290')).toEqual(similarityTokens('Škoda Fabia'));
    expect(similarityTokens('Škoda Fabia: 9 290 €')).toEqual(similarityTokens('Škoda Fabia'));
    expect(similarityTokens('Škoda Fabia: 9.290,-')).toEqual(similarityTokens('Škoda Fabia'));
    expect(similarityTokens('Škoda Fabia: 500 Kč')).toEqual(similarityTokens('Škoda Fabia'));
  });

  it('strips the named price phrases', () => {
    for (const phrase of ['Dohodou', 'Cena dohodou', 'V texte', 'Info v texte', 'Zadarmo']) {
      expect(similarityTokens(`Škoda Fabia: ${phrase}`)).toEqual(similarityTokens('Škoda Fabia'));
    }
  });

  it('keeps any other segment whole', () => {
    expect(similarityTokens('Review: iPhone 17')).toEqual(['revie', 'iphon', '17']);
  });

  it('only strips after the last ": "', () => {
    expect(similarityTokens('Auto: Škoda Fabia: 100')).toEqual(
      similarityTokens('Auto: Škoda Fabia'),
    );
  });

  it('stems tokens of six characters or more to five and keeps short ones', () => {
    const [a] = similarityTokens('Felicia');
    expect(a).toBe('felic');
    expect(similarityTokens('Felicie')).toEqual([a]);
    expect(similarityTokens('Felicii')).toEqual([a]);
    expect(similarityTokens('Škoda 100 L')).toEqual(['skoda'.slice(0, 5), '100']);
    expect(similarityTokens('tabor')).toEqual(['tabor']);
  });

  it('returns an empty list for null', () => {
    expect(similarityTokens(null)).toEqual([]);
  });
});

describe('similarDislikes', () => {
  it('lowers an old-Škoda target and ranks the most similar dislikes first', () => {
    const result = similarDislikes(target('t', 'Škoda 100 L zachovalá: 700'), fixture(), NOW);
    expect(result.lowered).toBe(true);
    expect(result.similar.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.similar.length; i += 1) {
      expect(result.similar[i - 1]!.similarity).toBeGreaterThanOrEqual(
        result.similar[i]!.similarity,
      );
    }
    expect(result.similar.every((s) => s.articleId.startsWith('d'))).toBe(true);
  });

  it('does not lower a modern-Škoda target (negative control)', () => {
    const result = similarDislikes(
      target('t', 'Škoda Octavia Combi 2.0 TDI Style: 15 100'),
      fixture(),
      NOW,
    );
    expect(result.lowered).toBe(false);
  });

  it('needs k qualifying dislikes', () => {
    const one = [item('d', -1, 'Škoda 100 L originál: 450', 1)];
    const result = similarDislikes(target('t', 'Škoda 100 L originál'), one, NOW);
    expect(result.similar).toHaveLength(1);
    expect(result.lowered).toBe(false);
    const two = [...one, item('d2', -1, 'Škoda 100 L originál: 450', 2)];
    expect(similarDislikes(target('t', 'Škoda 100 L originál'), two, NOW).lowered).toBe(true);
  });

  it('needs the dislikes to beat the likes by the margin', () => {
    const labelled = [
      item('d1', -1, 'Škoda 100 L originál', 1),
      item('d2', -1, 'Škoda 100 L originál', 2),
      item('l1', 1, 'Škoda 100 L originál', 3),
      item('l2', 1, 'Škoda 100 L originál', 4),
    ];
    const result = similarDislikes(target('t', 'Škoda 100 L originál'), labelled, NOW);
    expect(result.similar).toHaveLength(2);
    expect(result.lowered).toBe(false);
    const weakLikes = [labelled[0]!, labelled[1]!, item('l1', 1, 'Škoda 100 zdvihák', 3)];
    const weak = similarDislikes(target('t', 'Škoda 100 L originál'), weakLikes, NOW);
    expect(weak.lowered).toBe(true);
  });

  it('gives an empty vector similarity 0', () => {
    const result = similarDislikes({ articleId: 't', tokens: [] }, fixture(), NOW);
    expect(result.lowered).toBe(false);
    expect(result.similar).toEqual([]);
  });

  it('excludes the target own rating', () => {
    const labelled = fixture();
    const own = item('t', -1, 'Škoda 100 L zachovalá', 1);
    const result = similarDislikes(target('t', 'Škoda 100 L zachovalá'), [...labelled, own], NOW);
    expect(result.similar.map((s) => s.articleId)).not.toContain('t');
  });

  it('ignores ratings outside the window and future ratings', () => {
    const labelled = [
      item('d1', -1, 'Škoda 100 L originál', SIMILAR_DISLIKES.windowDays),
      item('d2', -1, 'Škoda 100 L originál', SIMILAR_DISLIKES.windowDays + 5),
      item('d3', -1, 'Škoda 100 L originál', -1),
      item('d4', -1, 'Škoda 100 L originál', 0),
    ];
    const result = similarDislikes(target('t', 'Škoda 100 L originál'), labelled, NOW);
    expect(result.similar.map((s) => s.articleId)).toEqual(['d4']);
  });

  it('keeps only the newest poolSize ratings', () => {
    const labelled: LabelledArticle[] = [];
    for (let i = 0; i < SIMILAR_DISLIKES.poolSize; i += 1) {
      labelled.push(item(`n${i}`, 1, 'Zdvihák náradie dielňa', 1 + i / 1000));
    }
    labelled.push(item('old1', -1, 'Škoda 100 L originál', 10));
    labelled.push(item('old2', -1, 'Škoda 100 L originál', 11));
    const result = similarDislikes(target('t', 'Škoda 100 L originál'), labelled, NOW);
    expect(result.similar).toEqual([]);
    const fewer = labelled.slice(1);
    expect(similarDislikes(target('t', 'Škoda 100 L originál'), fewer, NOW).similar).toHaveLength(
      1,
    );
    const fit = labelled.slice(2);
    expect(similarDislikes(target('t', 'Škoda 100 L originál'), fit, NOW).similar).toHaveLength(2);
  });

  it('sets nextChangeAt to the earliest expiry among the relevant ratings', () => {
    const labelled = [
      item('d1', -1, 'Škoda 100 L originál', 5),
      item('d2', -1, 'Škoda 100 L originál', 9),
      item('l1', 1, 'Fabia moderná výbava', 3),
    ];
    const result = similarDislikes(target('t', 'Škoda 100 L originál'), labelled, NOW);
    expect(result.lowered).toBe(true);
    expect(result.nextChangeAt).toEqual(new Date(daysAgo(9).getTime() + 30 * DAY));
  });

  it('has no nextChangeAt for an empty pool', () => {
    const result = similarDislikes(target('t', 'Škoda 100 L originál'), [], NOW);
    expect(result).toEqual({ lowered: false, similar: [], nextChangeAt: null });
  });

  it('does not depend on the input order', () => {
    const labelled = fixture();
    const a = similarDislikes(target('t', 'Škoda 100 L zachovalá: 700'), labelled, NOW);
    const b = similarDislikes(
      target('t', 'Škoda 100 L zachovalá: 700'),
      [...labelled].reverse(),
      NOW,
    );
    expect(b).toEqual(a);
  });

  it('breaks similarity ties newer first, then by article id', () => {
    const labelled = [
      item('b', -1, 'Škoda 100 L originál', 4),
      item('a', -1, 'Škoda 100 L originál', 4),
      item('c', -1, 'Škoda 100 L originál', 2),
    ];
    const result = similarDislikes(target('t', 'Škoda 100 L originál'), labelled, NOW);
    expect(result.similar.map((s) => s.articleId)).toEqual(['c', 'a', 'b']);
  });
});

describe('dislikePatternOffer', () => {
  it('offers the target and its most similar dislikes', () => {
    const offer = dislikePatternOffer(target('t', 'Škoda 100 L zachovalá: 700'), fixture(), NOW);
    expect(offer).toHaveLength(SIMILAR_DISLIKES.offerArticles);
    expect(offer![0]).toBe('t');
    expect(offer!.slice(1).every((id) => id.startsWith('d'))).toBe(true);
  });

  it('is null below offerMin', () => {
    const one = [item('d1', -1, 'Škoda 100 L originál', 1)];
    expect(dislikePatternOffer(target('t', 'Škoda 100 L originál'), one, NOW)).toBeNull();
    const two = [...one, item('d2', -1, 'Škoda 100 L originál', 2)];
    expect(dislikePatternOffer(target('t', 'Škoda 100 L originál'), two, NOW)).toEqual([
      't',
      'd1',
      'd2',
    ]);
  });

  it('is null when the target is not lowered', () => {
    const offer = dislikePatternOffer(
      target('t', 'Škoda Octavia Combi 2.0 TDI Style: 15 100'),
      fixture(),
      NOW,
    );
    expect(offer).toBeNull();
  });
});
