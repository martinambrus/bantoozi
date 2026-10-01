import { describe, expect, it } from 'vitest';

import { assignSplits, type SplitItem } from '../src/dataset/split.js';

const count = (splits: Map<string, string>, side: string) =>
  [...splits.values()].filter((value) => value === side).length;

describe('assignSplits', () => {
  it('balances articles, not story groups, when one story has many copies', () => {
    const items: SplitItem[] = [];
    for (let i = 0; i < 30; i += 1)
      items.push({ articleId: `${100 + i}`, lang: 'en', storyGroupId: 'big' });
    for (let i = 0; i < 70; i += 1)
      items.push({ articleId: `${200 + i}`, lang: 'en', storyGroupId: `s${i}` });
    for (const seed of ['a', 'b', 'c', 'd']) {
      const splits = assignSplits(items, seed);
      expect(count(splits, 'dev')).toBe(70);
      expect(count(splits, 'test')).toBe(30);
      const bigSides = new Set(
        items.filter((i) => i.storyGroupId === 'big').map((i) => splits.get(i.articleId)),
      );
      expect(bigSides.size).toBe(1);
    }
  });

  it('is deterministic and keeps known groups on their side, counting their articles', () => {
    const items: SplitItem[] = Array.from({ length: 20 }, (_, i) => ({
      articleId: `${300 + i}`,
      lang: 'sk',
      storyGroupId: `g${i}`,
    }));
    const known = new Map([['g0', 'test' as const]]);
    const knownCounts = new Map([['sk', { dev: 0, test: 10 }]]);
    const first = assignSplits(items, 'seed', known, knownCounts);
    expect(assignSplits(items, 'seed', known, knownCounts)).toEqual(first);
    expect(first.get('300')).toBe('test');
    // 10 known test articles + 20 new (one joins the known test group): 70 % of 30 is 21, so all
    // 19 fresh groups go to development.
    expect(count(first, 'dev')).toBe(19);
  });
});
