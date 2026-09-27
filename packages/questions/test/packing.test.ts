import { conservativeRequestTokens } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PACK_LIMITS,
  PackOverflowError,
  buildArticleState,
  cardKey,
  cardQuestion,
  l2Key,
  l2Question,
  labelQuestion,
  packRequests,
  questionTokens,
  stateRequestTokens,
  type Pack,
  type PackItem,
  type PackLimits,
} from '../src/index.js';

const STATE = buildArticleState(
  {
    title: 'Toyota starts a solid-state battery pilot line',
    author: 'A. Writer',
    categories: ['Cars', 'Batteries'],
    excerpt: 'Toyota said its pilot line reached 1,000 cycles. '.repeat(12),
    bodyLead: 'The company announced a pilot line for solid-state cells. '.repeat(25),
    wordCount: 900,
    lang: 'en',
    feed: { title: 'Auto News', site: 'example.com' },
  },
  'native',
  { call: 'match' },
);

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32; no Math.random in tests). */
function seededRandom(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function item(overrides: Partial<PackItem> & { key: string }): PackItem {
  return {
    question: cardQuestion({ interest: `Interest for ${overrides.key}` }, 'as_written'),
    owner: null,
    kind: 'card',
    interactive: false,
    queuedAt: 0,
    ...overrides,
  };
}

/** Checks every §5.2 invariant of a packing result. */
function expectValidPacks(state: unknown, items: PackItem[], packs: Pack[], limits: PackLimits) {
  const base = stateRequestTokens(state);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const seen: string[] = [];
  for (const pack of packs) {
    expect(pack.keys.length).toBeGreaterThan(0);
    expect(pack.keys.length).toBeLessThanOrEqual(limits.maxQuestions);
    expect(Object.keys(pack.questions)).toEqual(pack.keys);
    const tokens = pack.keys.map((key) => questionTokens(key, pack.questions[key]!));
    expect(pack.estimatedTokens).toBe(base + tokens.reduce((a, b) => a + b, 0));
    expect(pack.estimatedTokens).toBeLessThanOrEqual(limits.maxRequestTokens);
    expect(base + Math.max(...tokens)).toBeLessThanOrEqual(limits.maxStatePlusQuestionTokens);
    // The packing estimate is never below the admission estimate of the same request.
    expect(pack.estimatedTokens).toBeGreaterThanOrEqual(
      conservativeRequestTokens(state, pack.questions),
    );
    for (const key of pack.keys) {
      const source = byKey.get(key)!;
      expect(source.owner).toBe(pack.owner);
      if (source.kind === 'l2') expect(pack.owner).toBeNull();
      seen.push(key);
    }
  }
  expect(seen.sort()).toEqual(items.map((i) => i.key).sort());
}

describe('packRequests (spec 05 §5.2)', () => {
  it('packs 500 synthetic cards within both token limits and the count limit', () => {
    const random = seededRandom(42);
    const owners = ['user-a', 'user-b', 'user-c'];
    const items: PackItem[] = Array.from({ length: 500 }, (_, i) => {
      const id = String(1000 + i);
      const privateOwner = i % 7 === 0 ? owners[i % 3]! : null;
      const size = Math.floor(random() * 1200);
      const body = {
        interest: `Synthetic interest ${id}: ${'topic words '.repeat(Math.floor(size / 12))}`.slice(
          0,
          300,
        ),
        not_for: i % 3 === 0 ? 'Unrelated coverage' : null,
        examples_yes: Array.from(
          { length: i % 6 },
          (_, j) => `Example ${j} ${'x'.repeat(size % 180)}`,
        ),
      };
      return {
        key: cardKey(id),
        question:
          i % 25 === 0
            ? labelQuestion({ title: `Label ${id}`, body }, 'as_written')
            : cardQuestion(body, 'as_written'),
        owner: privateOwner,
        kind: i % 25 === 0 ? 'label' : 'card',
        interactive: i % 11 === 0,
        queuedAt: Math.floor(random() * 1000),
        cardId: id,
      } satisfies PackItem;
    });
    items.push(
      {
        key: l2Key('transport'),
        question: l2Question('transport'),
        owner: null,
        kind: 'l2',
        interactive: false,
        queuedAt: 5,
      },
      {
        key: l2Key('science'),
        question: l2Question('science'),
        owner: null,
        kind: 'l2',
        interactive: false,
        queuedAt: 5,
      },
    );

    const packs = packRequests(STATE, items);
    expectValidPacks(STATE, items, packs, DEFAULT_PACK_LIMITS);
    expect(packs.length).toBeGreaterThan(3);
    const owners_ = new Set(packs.map((pack) => pack.owner));
    expect(owners_).toEqual(new Set([null, ...owners]));
    // Deterministic: the same input packs the same way whatever its order.
    expect(packRequests(STATE, [...items].reverse())).toEqual(packs);
  });

  it('splits by count: 450 tiny questions → 200, 200, 50', () => {
    const items = Array.from({ length: 450 }, (_, i) =>
      item({ key: `c${i + 1}`, cardId: String(i + 1) }),
    );
    const packs = packRequests(STATE, items);
    expect(packs.map((pack) => pack.keys.length)).toEqual([200, 200, 50]);
    expect(packs[0]?.keys.slice(0, 3)).toEqual(['c1', 'c2', 'c3']);
    expectValidPacks(STATE, items, packs, DEFAULT_PACK_LIMITS);
  });

  it('splits by total tokens and by state + largest question', () => {
    const big = (key: string, chars: number) =>
      item({ key, question: cardQuestion({ interest: 'x'.repeat(chars) }, 'as_written') });
    // ~5k-token questions: the total limit (48,000) binds before the count limit.
    const items = Array.from({ length: 20 }, (_, i) => big(`c${i + 1}`, 13_000));
    const packs = packRequests(STATE, items);
    expect(packs.length).toBeGreaterThan(1);
    expectValidPacks(STATE, items, packs, DEFAULT_PACK_LIMITS);

    // A ~10.7k-token state with two ~16k-token questions: state + largest ≤ 28,000 holds for each,
    // and both fit into 48,000 together; with a 30,000-token request limit they are split.
    const heavyState = { article: { title: 'y'.repeat(30_000) } };
    const heavy = [big('c1', 45_000), big('c2', 45_000)];
    const heavyPacks = packRequests(heavyState, heavy);
    expectValidPacks(heavyState, heavy, heavyPacks, DEFAULT_PACK_LIMITS);
    expect(heavyPacks.map((pack) => pack.keys)).toEqual([['c1', 'c2']]);
    const limits = { ...DEFAULT_PACK_LIMITS, maxRequestTokens: 30_000 };
    expect(packRequests(heavyState, heavy, limits).map((pack) => pack.keys)).toEqual([
      ['c1'],
      ['c2'],
    ]);
  });

  it('never mixes owners and keeps level-2 questions shared', () => {
    const items = [
      item({ key: 'c1', owner: 'alice', cardId: '1' }),
      item({ key: 'c2', owner: 'bob', cardId: '2' }),
      item({ key: 'c3', cardId: '3' }),
      item({ key: 't2_science', kind: 'l2', question: l2Question('science') }),
      item({ key: 'c4', owner: 'alice', cardId: '4' }),
    ];
    const packs = packRequests(STATE, items);
    expect(packs.map((pack) => [pack.owner, pack.keys])).toEqual([
      [null, ['t2_science', 'c3']],
      ['alice', ['c1', 'c4']],
      ['bob', ['c2']],
    ]);
    expect(() =>
      packRequests(STATE, [item({ key: 't2_science', kind: 'l2', owner: 'alice' })]),
    ).toThrow(/must be shared/);
  });

  it('orders labels, then interactive questions, then the rest; ties by queue time, card id, key', () => {
    const items = [
      item({ key: 'c30', cardId: '30', queuedAt: 1 }),
      item({ key: 'c9', cardId: '9', queuedAt: 1 }),
      item({ key: 'c100', cardId: '100', queuedAt: 1 }),
      item({ key: 'c5', cardId: '5', queuedAt: 0, interactive: true }),
      item({ key: 'c7', cardId: '7', queuedAt: 9, kind: 'label' }),
      item({ key: 'c6', cardId: '6', queuedAt: 3, kind: 'label', interactive: true }),
      item({ key: 't2_health', kind: 'l2', queuedAt: 1 }),
      item({ key: 'c2', cardId: '2', queuedAt: 0 }),
    ];
    expect(packRequests(STATE, items).map((pack) => pack.keys)).toEqual([
      ['c6', 'c7', 'c5', 'c2', 't2_health', 'c9', 'c30', 'c100'],
    ]);
  });

  it('returns a typed overflow error instead of an empty pack or a silent omission', () => {
    const huge = item({
      key: 'c77',
      question: cardQuestion({ interest: 'z'.repeat(120_000) }, 'as_written'),
    });
    let error: unknown;
    try {
      packRequests(STATE, [item({ key: 'c1' }), huge]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PackOverflowError);
    expect(error).toMatchObject({ name: 'PackOverflowError', key: 'c77', limit: 28_000 });
    expect((error as PackOverflowError).tokens).toBeGreaterThan(28_000);

    const hugeState = { article: { title: 'q'.repeat(100_000) } };
    expect(() => packRequests(hugeState, [item({ key: 'c1' })])).toThrow(PackOverflowError);
    try {
      packRequests(hugeState, [item({ key: 'c1' })]);
    } catch (caught) {
      expect(caught).toMatchObject({ key: null });
      expect(String(caught)).toMatch(/the state alone/);
    }
    expect(packRequests(hugeState, [])).toEqual([]);
    expect(packRequests(STATE, [])).toEqual([]);
  });

  it('repacks for a fallback engine with smaller limits', () => {
    const limits: PackLimits = {
      maxRequestTokens: stateRequestTokens(STATE) + 400,
      maxStatePlusQuestionTokens: stateRequestTokens(STATE) + 200,
      maxQuestions: 3,
    };
    const items = Array.from({ length: 12 }, (_, i) =>
      item({ key: `c${i + 1}`, cardId: String(i + 1) }),
    );
    const packs = packRequests(STATE, items, limits);
    expect(packs.length).toBeGreaterThanOrEqual(4);
    expectValidPacks(STATE, items, packs, limits);
    expect(() => packRequests(STATE, items, { ...limits, maxQuestions: 0 })).toThrow(RangeError);
  });

  it('rejects duplicate and invalid keys', () => {
    expect(() => packRequests(STATE, [item({ key: 'c1' }), item({ key: 'c1' })])).toThrow(
      /duplicate/,
    );
    expect(() => packRequests(STATE, [item({ key: 'user@example.com' })])).toThrow(/invalid/);
  });
});
