import { ExplainSchema } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  type ActiveEstimate,
  activeEstimate,
  DEFAULT_RANKER_CONFIG,
  ESTIMATE_SPEC,
  type EstimateModel,
  estimateFeatures,
  explainEstimate,
  mergeRankerConfig,
  RANKER_VERSION,
  type RankerConfig,
  type RankItem,
  type RankResult,
  rankArticle,
  type ReadonlyRankerConfig,
  scoreEstimate,
  scoreVersion,
  tierFromP,
  type UserRankContext,
} from '../src/index.js';
import { CONTEXT_SHA, context, DEGRADED_SHA, item, NOW, rule } from './rank-support.js';
import { answers, card } from './support.js';

const OVERRIDE: RankerConfig = mergeRankerConfig({
  lanes: { forYou: 0.8, maybe: 0.2 },
  tiers: [0.1, 0.3, 0.5, 0.9],
  demotion: { autoMinDislikes: 5, clickbait: 0.6, shallowDepth: 0.4, staleAgeHours: 24 },
});
const CONFIGS: [string, ReadonlyRankerConfig][] = [
  ['the defaults', DEFAULT_RANKER_CONFIG],
  ['a merged override', OVERRIDE],
];

const VERSION = 3;
const TITLE = 'Battery lithium cells cheaper solar panels wind turbines hydrogen storage grid';
const below = (t: number) => t - 1e-9;

const stub = (p: number): ActiveEstimate => ({ version: VERSION, score: () => ({ p, top: [] }) });

/** 12 matching features: 7 positive and 5 negative, so the explanation is cut to 5 + 5. */
const WEIGHTS: Record<string, number> = {
  't:solar': 3,
  't:batte': 2,
  'b:batte_lithi': 1,
  't:lithi': 1,
  't:cells': 0.5,
  't:wind': 0.25,
  't:grid': 0.1,
  't:turbi': -4,
  't:cheap': -1.5,
  't:hydro': -0.5,
  't:panel': -0.5,
  't:stora': -0.1,
};
const MODEL: EstimateModel = {
  spec: ESTIMATE_SPEC,
  intercept: 0.3,
  weights: WEIGHTS,
  platt: { a: 1, b: 0 },
  metrics: { n: 12, nPos: 6, nNeg: 6, folds: 0, auc: null, feeds: {} },
};

const love = card('10', 'love');
const never = card('13', 'never');

interface ExitCase {
  name: string;
  /** The rules the exit fires with an estimate. */
  rules: string[];
  ctx: (overrides?: Partial<UserRankContext>) => UserRankContext;
  item: () => RankItem;
}

const EXITS: ExitCase[] = [
  {
    name: 'exit 1b (no authorized carrier)',
    rules: ['inference_not_requested', 'estimate'],
    ctx: (o) => context({ cards: [love], labels: [{ cardId: '20', name: 'Batteries' }], ...o }),
    item: () =>
      item({
        title: TITLE,
        inferenceEligible: false,
        inferenceFeedIds: [],
        cardAnswers: answers({ 10: 0.95, 20: 0.99 }),
      }),
  },
  {
    name: 'exit 2 (stale, not selected)',
    rules: ['estimate'],
    ctx: (o) => context({ cards: [love], labels: [{ cardId: '20', name: 'Batteries' }], ...o }),
    item: () =>
      item({
        title: TITLE,
        pipelineState: 'stale',
        explicitSelection: false,
        cardAnswers: answers({ 10: 0.9, 20: 0.9 }),
      }),
  },
  {
    name: 'exit 4d (pending coverage)',
    rules: ['estimate'],
    ctx: (o) => context({ cards: [love], labels: [{ cardId: '20', name: 'Batteries' }], ...o }),
    item: () =>
      item({
        title: TITLE,
        matchCoverage: 'pending',
        cardAnswers: answers({ 20: 0.9, 10: { p: 0, engine: 'prefilter' } }),
      }),
  },
  {
    name: 'exit 4d (no cards at all)',
    rules: ['estimate'],
    ctx: (o) => context(o),
    item: () => item({ title: TITLE }),
  },
];

function expectEstimated(
  result: RankResult,
  ctx: UserRankContext,
  expected: { p: number; top: unknown; rules: string[] },
): void {
  expect(result.lane).toBe('new');
  expect(result.scoreSource).toBe('estimate');
  expect(result.pLike).toBe(expected.p);
  expect(result.tier).toBe(tierFromP(expected.p, ctx.config));
  expect(result.rulesFired).toEqual(expected.rules);
  expect(result.nextRankAt).toBeNull();
  const explain = ExplainSchema.parse(result.explain);
  expect(explain.source).toBe('estimate');
  expect(explain.p).toBe(result.pLike);
  expect(explain.lane).toBe(result.lane);
  expect(explain.tier).toBe(result.tier);
  expect(explain.estimate).toEqual({ version: VERSION, top: expected.top });
  expect(explain.inputs.contextSha).toBe(ctx.contextSha);
  expect(explain.inputs.contextSha).not.toBe(DEGRADED_SHA);
  expect(explain.rules.map((r) => r.code)).toEqual(expected.rules);
  expect(explain.model).toBeUndefined();
  expect(explain.decidingCardId).toBeUndefined();
}

describe.each(CONFIGS)('estimate at the unscored exits with %s (T1-T4)', (_, config) => {
  describe.each(EXITS)('$name', (exit) => {
    it('ranks a word estimate in lane new with its tier, rules and words', () => {
      const real = activeEstimate({ version: VERSION, model: MODEL }) as ActiveEstimate;
      const ctx = exit.ctx({ config, estimate: real });
      const it1 = exit.item();
      const explained = explainEstimate(MODEL, {
        title: TITLE,
        excerpt: it1.excerptNorm,
        feedId: it1.feedIds[0] ?? null,
      });
      const result = rankArticle(ctx, it1, NOW);
      expect(explained?.top).toHaveLength(10);
      expectEstimated(result, ctx, {
        p: explained?.p as number,
        top: explained?.top,
        rules: exit.rules,
      });
      expect(result.explain.estimate?.top.slice(0, 5).every((w) => w.contribution > 0)).toBe(true);
      expect(result.explain.estimate?.top.slice(5).every((w) => w.contribution < 0)).toBe(true);
    });

    it('keeps the cards, facets and label suggestions of the same exit without an estimate', () => {
      const plain = rankArticle(exit.ctx({ config }), exit.item(), NOW);
      expect(plain.scoreSource).toBe('none');
      const result = rankArticle(exit.ctx({ config, estimate: stub(0.6) }), exit.item(), NOW);
      expect(result.scoreSource).toBe('estimate');
      expect(result.explain.cards).toEqual(plain.explain.cards);
      expect(result.explain.facets).toEqual(plain.explain.facets);
      expect(result.labelSuggestions).toEqual(plain.labelSuggestions);
      expect(result.explain.translation).toEqual(plain.explain.translation);
    });

    it('passes the words of the estimate through unchanged', () => {
      const top = [{ feature: 't:batte', label: 'battery', contribution: 1.25 }];
      const estimate: ActiveEstimate = { version: VERSION, score: () => ({ p: 0.4, top }) };
      const ctx = exit.ctx({ config, estimate });
      expectEstimated(rankArticle(ctx, exit.item(), NOW), ctx, { p: 0.4, top, rules: exit.rules });
    });

    it('gives exactly today result when the context has no estimate (T8)', () => {
      const plain = rankArticle(exit.ctx({ config }), exit.item(), NOW);
      const explicitlyUndefined = rankArticle(
        exit.ctx({ config, estimate: undefined }),
        exit.item(),
        NOW,
      );
      expect(explicitlyUndefined).toEqual(plain);
      expect(plain).toMatchObject({ lane: 'new', pLike: null, tier: null, scoreSource: 'none' });
      expect(plain.rulesFired).toEqual(exit.rules.filter((code) => code !== 'estimate'));
      expect(plain.explain.estimate).toBeUndefined();
    });

    it.each([
      ['null', null],
      ['NaN', Number.NaN],
      ['-0.1', -0.1],
      ['1.1', 1.1],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('gives today result when the estimate cannot score (%s) (T9)', (_n, bad) => {
      const estimate: ActiveEstimate = {
        version: VERSION,
        score: () => (bad === null ? null : { p: bad, top: [] }),
      };
      const plain = rankArticle(exit.ctx({ config }), exit.item(), NOW);
      expect(rankArticle(exit.ctx({ config, estimate }), exit.item(), NOW)).toEqual(plain);
    });

    it('does not lift an estimated row by a matching boost_feed rule or a must card (T11)', () => {
      const ctx = exit.ctx({
        config,
        cards: [card('10', 'must')],
        rules: [rule('boost_feed', '1')],
        estimate: stub(0.05),
      });
      const result = rankArticle(ctx, exit.item(), NOW);
      expect(result.lane).toBe('new');
      expect(result.pLike).toBe(0.05);
      expect(result.tier).toBe(tierFromP(0.05, config));
      expect(result.rulesFired.filter((code) => code.startsWith('boost_'))).toEqual([]);
      expect(result.rulesFired.filter((code) => code.startsWith('must:'))).toEqual([]);
      expect(result.scoreSource).toBe('estimate');
    });
  });
});

/** Each tier boundary at and just below it, plus the lane thresholds and both ends. */
function pRows(config: ReadonlyRankerConfig): number[] {
  const { forYou, maybe } = config.lanes;
  return [
    ...new Set([
      0,
      1,
      ...config.tiers.flatMap((t) => [t, below(t)]),
      forYou,
      below(forYou),
      maybe,
      below(maybe),
      0.999,
      Math.min(1, forYou + 0.05),
    ]),
  ];
}

describe.each(CONFIGS)('tier boundaries of an estimate with %s (T10)', (_, config) => {
  describe.each(EXITS)('$name', (exit) => {
    it.each(pRows(config).map((p) => [p]))('P %s gets tierFromP and stays in lane new', (p) => {
      const ctx = exit.ctx({ config, estimate: stub(p) });
      const result = rankArticle(ctx, exit.item(), NOW);
      expect(result).toMatchObject({
        lane: 'new',
        pLike: p,
        tier: tierFromP(p, config),
        scoreSource: 'estimate',
      });
      expect(ExplainSchema.parse(result.explain)).toMatchObject({ lane: 'new', p });
    });
  });

  it('a P at or above lanes.forYou is still lane new', () => {
    const ctx = context({ config, estimate: stub(config.lanes.forYou) });
    const result = rankArticle(ctx, item({ title: TITLE }), NOW);
    expect(result).toMatchObject({
      lane: 'new',
      scoreSource: 'estimate',
      pLike: config.lanes.forYou,
    });
  });
});

describe.each(CONFIGS)('hidden exits never take an estimate with %s (T5, T6)', (_, config) => {
  const hideCases: [string, Partial<UserRankContext>, Partial<RankItem>][] = [
    ['mute_keyword', { rules: [rule('mute_keyword', 'battery')] }, {}],
    [
      'mute_keyword in the translated text',
      { rules: [rule('mute_keyword', 'účet')] },
      { translatedTitleNorm: 'the ucet is closed', titleNorm: 'x' },
    ],
    ['mute_story', { rules: [rule('mute_story', '44')] }, { clusterId: '44', clusterSize: 3 }],
    ['block_feed', { rules: [rule('block_feed', '1')] }, { feedIds: ['1'] }],
    ['block_domain', { rules: [rule('block_domain', 'example.com')] }, {}],
    ['block_author', { rules: [rule('block_author', 'jana novakova')] }, {}],
    [
      'block_domain on an item without a carrier',
      { rules: [rule('block_domain', 'example.com')] },
      { inferenceEligible: false, inferenceFeedIds: [] },
    ],
    [
      'mute_keyword on a stale item',
      { rules: [rule('mute_keyword', 'battery')] },
      { pipelineState: 'stale' },
    ],
  ];

  it.each(hideCases)('%s hides with only its own code', (_name, ctxOver, itemOver) => {
    const plainCtx = context({ config, ...ctxOver });
    const the = item({ title: TITLE, ...itemOver });
    const plain = rankArticle(plainCtx, the, NOW);
    expect(plain.lane).toBe('hidden');
    const result = rankArticle({ ...plainCtx, estimate: stub(0.9) }, the, NOW);
    expect(result).toEqual(plain);
    expect(result.pLike).toBeNull();
    expect(result.tier).toBeNull();
    expect(result.scoreSource).toBe('none');
    expect(result.rulesFired).toHaveLength(1);
    expect(result.explain.estimate).toBeUndefined();
  });

  it('a confident never-card hides without an estimate (T6)', () => {
    const base = context({ config, cards: [love, never] });
    const the = item({ title: TITLE, cardAnswers: answers({ 10: 0.99, 13: 0.7 }) });
    const plain = rankArticle(base, the, NOW);
    expect(plain).toMatchObject({ lane: 'hidden', rulesFired: ['never:13'] });
    const result = rankArticle({ ...base, estimate: stub(0.9) }, the, NOW);
    expect(result).toEqual(plain);
    expect(result.explain.estimate).toBeUndefined();
  });
});

describe('an item without a title (T14)', () => {
  it('is scored from the excerpt and feed alone, without a crash', () => {
    const m: EstimateModel = {
      ...MODEL,
      weights: { 't:batte': 3, 'e:lithi': 1, 'f:1': -0.5 },
    };
    const the = item({ inferenceEligible: false, inferenceFeedIds: [] });
    expect(the.title).toBeUndefined();
    const ctx = context({
      estimate: activeEstimate({ version: VERSION, model: m }) as ActiveEstimate,
    });
    const result = rankArticle(ctx, the, NOW);
    const expected = scoreEstimate(
      m,
      estimateFeatures({ title: null, excerpt: the.excerptNorm, feedId: '1' }),
    );
    expect(result.scoreSource).toBe('estimate');
    expect(result.pLike).toBe(expected?.p);
    expect(result.explain.estimate?.top.map((w) => w.feature)).toEqual(['e:lithi']);
  });
});

describe('ranker version (T13)', () => {
  it('is 4, so every stored row is re-ranked once', () => {
    expect(RANKER_VERSION).toBe('4');
    expect(scoreVersion(0)).toBe('4:0');
  });
});

describe('the context sha of an estimated row', () => {
  it('is the ordinary context sha, whatever the coverage', () => {
    const ctx = context({ estimate: stub(0.5) });
    const result = rankArticle(
      ctx,
      item({
        title: TITLE,
        matchCoverage: 'unavailable',
        inferenceFeedIds: [],
        inferenceEligible: false,
      }),
      NOW,
    );
    expect(result.scoreSource).toBe('estimate');
    expect(result.explain.inputs.contextSha).toBe(CONTEXT_SHA);
  });
});
