import { describe, expect, it } from 'vitest';

import {
  languageQuotas,
  planAssignments,
  raterSeed,
  seededShuffle,
} from '../src/rating-server/assignments.js';

/** M3a-T3 (spec 10 §2.2): the pure assignment algorithm. */

const pool = (lang: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ articleId: String(from + i), lang }));

const countBy = (picks: ReadonlyArray<{ lang: string }>) => {
  const out: Record<string, number> = {};
  for (const p of picks) out[p.lang] = (out[p.lang] ?? 0) + 1;
  return out;
};

describe('languageQuotas', () => {
  it('splits the target equally, the remainder to the first languages', () => {
    expect(Object.fromEntries(languageQuotas(['sk', 'en'], 300))).toEqual({ sk: 150, en: 150 });
    expect(Object.fromEntries(languageQuotas(['en', 'sk', 'cs'], 300))).toEqual({
      en: 100,
      sk: 100,
      cs: 100,
    });
    expect(Object.fromEntries(languageQuotas(['en', 'sk', 'cs'], 10))).toEqual({
      en: 4,
      sk: 3,
      cs: 3,
    });
  });
});

describe('planAssignments', () => {
  it('assigns 300 split equally across the rater languages', () => {
    const plan = planAssignments({
      seed: raterSeed('1'),
      langs: ['sk', 'en'],
      target: 300,
      existing: [],
      pools: [[...pool('sk', 1, 400), ...pool('en', 1000, 400), ...pool('cs', 2000, 400)]],
    });
    expect(plan.picks).toHaveLength(300);
    expect(countBy(plan.picks)).toEqual({ sk: 150, en: 150 });
    expect(plan.shortfall).toBe(0);
    expect(new Set(plan.picks.map((p) => p.articleId)).size).toBe(300);
  });

  it('tops a short language up from the others', () => {
    const plan = planAssignments({
      seed: raterSeed('1'),
      langs: ['sk', 'en'],
      target: 300,
      existing: [],
      pools: [[...pool('sk', 1, 40), ...pool('en', 1000, 400)]],
    });
    expect(countBy(plan.picks)).toEqual({ sk: 40, en: 260 });
  });

  it('assigns the whole sample before any top-up article, and tops up per language', () => {
    const plan = planAssignments({
      seed: raterSeed('7'),
      langs: ['sk', 'en'],
      target: 100,
      existing: [],
      pools: [
        [...pool('sk', 1, 20), ...pool('en', 1000, 30)],
        [...pool('sk', 5000, 100), ...pool('en', 6000, 100)],
      ],
    });
    expect(plan.picks).toHaveLength(100);
    const fromSample = plan.picks.filter((p) => p.pool === 0);
    const fromTopUp = plan.picks.filter((p) => p.pool === 1);
    expect(fromSample).toHaveLength(50);
    expect(countBy(fromTopUp)).toEqual({ sk: 30, en: 20 });
    expect(countBy(plan.picks)).toEqual({ sk: 50, en: 50 });
  });

  it('reports the shortfall when every pool is exhausted', () => {
    const plan = planAssignments({
      seed: 's',
      langs: ['en'],
      target: 300,
      existing: [],
      pools: [pool('en', 1, 120), pool('en', 500, 30)],
    });
    expect(plan.picks).toHaveLength(150);
    expect(plan.shortfall).toBe(150);
  });

  it('never reassigns existing articles and counts them toward their language share', () => {
    const existing = pool('sk', 1, 150).map((c) => ({ ...c }));
    const plan = planAssignments({
      seed: 's',
      langs: ['sk', 'en'],
      target: 300,
      existing,
      pools: [[...pool('sk', 1, 300), ...pool('en', 1000, 300)]],
    });
    expect(plan.picks).toHaveLength(150);
    expect(countBy(plan.picks)).toEqual({ en: 150 });
    expect(plan.picks.some((p) => Number(p.articleId) <= 150)).toBe(false);
  });

  it('is deterministic for a rater and differs between raters (seeded shuffle)', () => {
    const input = (raterId: string) => ({
      seed: raterSeed(raterId),
      langs: ['en', 'sk'],
      target: 60,
      existing: [],
      pools: [[...pool('en', 1, 100), ...pool('sk', 1000, 100)]],
    });
    const a = planAssignments(input('1')).picks.map((p) => p.articleId);
    const again = planAssignments({
      ...input('1'),
      // Candidate order does not matter.
      pools: [[...pool('sk', 1000, 100), ...pool('en', 1, 100)].reverse()],
    }).picks.map((p) => p.articleId);
    const b = planAssignments(input('2')).picks.map((p) => p.articleId);
    expect(again).toEqual(a);
    expect(b).not.toEqual(a);
    // The queue mixes languages rather than listing one language after the other.
    const firstTen = planAssignments(input('1')).picks.slice(0, 10);
    expect(new Set(firstTen.map((p) => p.lang)).size).toBe(2);
  });

  it('seededShuffle is a permutation and stable', () => {
    const ids = ['1', '2', '3', '4', '5', '6'];
    const shuffled = seededShuffle(ids, 'seed', 'x');
    expect([...shuffled].sort()).toEqual(ids);
    expect(seededShuffle([...ids].reverse(), 'seed', 'x')).toEqual(shuffled);
  });
});
