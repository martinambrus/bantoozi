import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_EXCERPT_TOKENS,
  estimateFeatures,
  similarityTokens,
  stemToken,
} from '../../src/index.js';

const art = (
  title: string | null,
  excerpt: string | null = null,
  feedId: string | null = null,
) => ({
  title,
  excerpt,
  feedId,
});

describe('estimateFeatures', () => {
  it('uses the similarity tokens of the title, price segment stripped', () => {
    const f = estimateFeatures(art('Škoda Felícia 1.3 MPI: 900'));
    const tokens = similarityTokens('Škoda Felícia 1.3 MPI: 900');
    for (const t of tokens) expect(f).toContain(`t:${t}`);
    expect(f.some((x) => x.includes('900'))).toBe(false);
  });

  it('adds adjacent title pairs', () => {
    const f = estimateFeatures(art('red green blue'));
    expect(f).toEqual(['t:red', 't:green', 't:blue', 'b:red_green', 'b:green_blue']);
  });

  it('stems long excerpt tokens and caps at the excerpt limit', () => {
    const words = Array.from(
      { length: ESTIMATE_EXCERPT_TOKENS + 5 },
      (_, i) =>
        `w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
    );
    const f = estimateFeatures(art(null, words.join(' ')));
    expect(f).toHaveLength(ESTIMATE_EXCERPT_TOKENS);
    expect(f.every((x) => x.startsWith('e:'))).toBe(true);
    expect(estimateFeatures(art(null, 'cryptocurrency'))).toEqual([
      `e:${stemToken('cryptocurrency')}`,
    ]);
  });

  it('dedupes and keeps first-seen order, feed last', () => {
    expect(estimateFeatures(art('cat cat', 'cat dog', '7'))).toEqual([
      't:cat',
      'b:cat_cat',
      'e:cat',
      'e:dog',
      'f:7',
    ]);
  });

  it('handles null title, excerpt and feed', () => {
    expect(estimateFeatures(art(null, null, null))).toEqual([]);
    expect(estimateFeatures(art(null, null, 'x'))).toEqual(['f:x']);
  });

  it('folds diacritics through tokenize', () => {
    expect(estimateFeatures(art('Čaj', 'čaj'))).toEqual(estimateFeatures(art('Caj', 'caj')));
  });
});

describe('stemToken', () => {
  it('cuts tokens of six or more characters to five', () => {
    expect(stemToken('abcde')).toBe('abcde');
    expect(stemToken('abcdef')).toBe('abcde');
  });
});
