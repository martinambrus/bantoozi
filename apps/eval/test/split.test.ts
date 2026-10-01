import { describe, expect, it } from 'vitest';

import { assignSplits, chooseDevGroups, type SplitItem } from '../src/dataset/split.js';

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

  it("charges a new copy of a known story to the group's original language", () => {
    // A Czech copy of an English story already on the test side, and 10 fresh Czech stories.
    const items: SplitItem[] = [
      { articleId: '900', lang: 'cs', storyGroupId: 'k' },
      ...Array.from({ length: 10 }, (_, i) => ({
        articleId: `${910 + i}`,
        lang: 'cs',
        storyGroupId: `c${i}`,
      })),
    ];
    const known = new Map([['k', 'test' as const]]);
    const knownCounts = new Map([
      ['cs', { dev: 7, test: 3 }],
      ['en', { dev: 0, test: 5 }],
    ]);
    const splits = assignSplits(items, 'seed', known, knownCounts, new Map([['k', 'en']]));
    expect(splits.get('900')).toBe('test');
    // Czech: 7 + 3 known + 10 fresh = 20, so 14 development: 7 of the fresh. Charging the copy to
    // Czech instead would make it 21 and 15.
    expect(count(splits, 'dev')).toBe(7);
  });

  it('picks the whole-group subset nearest the target, not a greedy prefix', () => {
    const sizes = new Map([
      ['a', 1],
      ['b', 39],
      ['c', 92],
    ]);
    const size = (id: string) => sizes.get(id) ?? 0;
    // Greedy in this order would take all three (91 → 52 → 40 from the target of 92).
    expect(chooseDevGroups(['a', 'b', 'c'], size, 92)).toEqual(['c']);
    expect(chooseDevGroups(['a', 'b', 'c'], size, 0)).toEqual([]);
    expect(chooseDevGroups(['a', 'b', 'c'], size, 40).sort()).toEqual(['a', 'b']);
    const items: SplitItem[] = [...sizes].flatMap(([group, n], g) =>
      Array.from({ length: n }, (_, i) => ({
        articleId: `${(g + 1) * 1000 + i}`,
        lang: 'en',
        storyGroupId: group,
      })),
    );
    for (const seed of ['a', 'b', 'c', 'd']) {
      const splits = assignSplits(items, seed);
      expect(count(splits, 'dev')).toBe(92);
      expect(count(splits, 'test')).toBe(40);
    }
  });
});
