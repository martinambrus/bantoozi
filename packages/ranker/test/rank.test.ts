import { ExplainSchema } from '@bantoozi/shared';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildBm25Corpus,
  mergeRankerConfig,
  projectRankForView,
  rankArticle,
  type ActiveModel,
  type RankItem,
  type RankResult,
  type UserRankContext,
} from '../src/index.js';
import { HOUR, NOW, CONTEXT_SHA, DEGRADED_SHA, context, item, rule } from './rank-support.js';
import { answers, card } from './support.js';

/** Every rule code any test produced; the last test checks spec 06 §3.2 is covered. */
const produced = new Set<string>();

function rank(ctx: UserRankContext, it: RankItem, now: Date = NOW): RankResult {
  const result = rankArticle(ctx, it, now);
  // Every exit returns a valid explanation (spec 06 §2, §6.2).
  expect(ExplainSchema.parse(result.explain)).toEqual(result.explain);
  expect(result.explain.lane).toBe(result.lane);
  expect(result.explain.p).toBe(result.pLike);
  expect(result.explain.tier).toBe(result.tier);
  expect(result.rulesFired).toEqual(result.explain.rules.map((r) => r.code));
  for (const code of result.rulesFired) produced.add(code.replace(/:\d+$/, ':<id>'));
  return result;
}

const love = card('10', 'love');
const like = card('11', 'like');
const must = card('12', 'must');
const never = card('13', 'never');

describe('rankArticle step 1: explicit hide and mute rules (spec 06 §3.1)', () => {
  it('mute_keyword matches a whole-word sequence in the original or translated text', () => {
    const ctx = context({
      cards: [love],
      rules: [rule('mute_keyword', 'Prices Fall', { id: '5' })],
    });
    const hidden = rank(ctx, item({ cardAnswers: answers({ 10: 0.9 }) }));
    expect(hidden).toMatchObject({ lane: 'hidden', pLike: null, tier: null, scoreSource: 'none' });
    expect(hidden.explain.rules).toEqual([{ code: 'mute_keyword:Prices Fall', ruleId: '5' }]);

    const translated = context({ rules: [rule('mute_keyword', 'účet')] });
    expect(
      rank(translated, item({ translatedTitleNorm: 'the ucet is closed', titleNorm: 'x' })).lane,
    ).toBe('hidden');
    // Partial words never match.
    const partial = context({ rules: [rule('mute_keyword', 'price')] });
    expect(rank(partial, item()).lane).not.toBe('hidden');
    const empty = context({ rules: [rule('mute_keyword', ' !! ')] });
    expect(rank(empty, item()).lane).not.toBe('hidden');
  });

  it('mute_story hides the muted cluster only', () => {
    const ctx = context({ rules: [rule('mute_story', '44', { id: '6' })] });
    expect(rank(ctx, item({ clusterId: '44', clusterSize: 3 })).explain.rules).toEqual([
      { code: 'mute_story', ruleId: '6' },
    ]);
    expect(rank(ctx, item({ clusterId: '45', clusterSize: 2 })).lane).toBe('new');
    expect(rank(ctx, item()).lane).toBe('new');
  });

  it('block_feed needs every subscribed carrier blocked', () => {
    const one = context({ rules: [rule('block_feed', '1', { id: '7' })] });
    expect(rank(one, item({ feedIds: ['1'] })).explain.rules).toEqual([
      { code: 'block_feed', ruleId: '7' },
    ]);
    expect(rank(one, item({ feedIds: ['1', '2'] })).lane).toBe('new');
    const both = context({
      rules: [rule('block_feed', '2', { id: '9' }), rule('block_feed', '1', { id: '8' })],
    });
    expect(rank(both, item({ feedIds: ['1', '2'] })).explain.rules).toEqual([
      { code: 'block_feed', ruleId: '8' },
    ]);
    expect(rank(both, item({ feedIds: [] })).lane).toBe('new');
  });

  it('block_domain and block_author compare case- and diacritic-insensitively', () => {
    const domain = context({ rules: [rule('block_domain', 'Example.com')] });
    expect(rank(domain, item()).rulesFired).toEqual(['block_domain']);
    const author = context({ rules: [rule('block_author', 'jana novakova')] });
    expect(rank(author, item()).rulesFired).toEqual(['block_author']);
    expect(rank(author, item({ author: null })).lane).toBe('new');
  });

  it('reports one rule: kinds in table order, then the lowest rule id', () => {
    const ctx = context({
      rules: [
        rule('block_domain', 'example.com', { id: '30' }),
        rule('mute_keyword', 'lithium', { id: '31' }),
        rule('mute_keyword', 'battery', { id: '29' }),
      ],
    });
    expect(rank(ctx, item()).explain.rules).toEqual([
      { code: 'mute_keyword:battery', ruleId: '29' },
    ]);
  });

  it('applies to off items too, firing only the rule, not inference_not_requested', () => {
    const ctx = context({ rules: [rule('block_domain', 'example.com')] });
    const off = rank(ctx, item({ inferenceFeedIds: [], inferenceEligible: false }));
    expect(off).toMatchObject({
      lane: 'hidden',
      rulesFired: ['block_domain'],
      labelSuggestions: [],
    });
    expect(off.explain.cards).toEqual([]);
  });

  it('a hide rule hides a stale item (the hide check runs first)', () => {
    const ctx = context({ rules: [rule('mute_keyword', 'battery')] });
    expect(rank(ctx, item({ pipelineState: 'stale' })).lane).toBe('hidden');
  });

  it('the earliest expiry of the hiding rules is the next rank time', () => {
    const expires = new Date(NOW.getTime() + 3 * HOUR);
    const ctx = context({ rules: [rule('mute_story', '44', { expiresAt: expires })] });
    expect(rank(ctx, item({ clusterId: '44' })).nextRankAt).toEqual(expires);
  });
});

describe('rankArticle step 1b: inference admission', () => {
  it('an off or unselected item is neutral even when shared answers exist', () => {
    const ctx = context({
      cards: [love, never],
      labels: [{ cardId: '20', name: 'Read later' }],
      rules: [rule('boost_feed', '1')],
    });
    const result = rank(
      ctx,
      item({
        inferenceFeedIds: [],
        inferenceEligible: false,
        cardAnswers: answers({ 10: 0.95, 13: 0.9, 20: 0.99 }),
      }),
    );
    expect(result).toMatchObject({
      lane: 'new',
      pLike: null,
      tier: null,
      scoreSource: 'none',
      rulesFired: ['inference_not_requested'],
      labelSuggestions: [],
    });
    expect(result.explain.cards).toEqual([]);
    expect(result.explain.facets).toBeUndefined();
  });
});

describe('rankArticle step 2: stale articles', () => {
  const ctx = context({ cards: [love] });
  const answered = answers({ 10: 0.9 });

  it('a stale item stays new without a current explicit selection', () => {
    const result = rank(ctx, item({ pipelineState: 'stale', cardAnswers: answered }));
    expect(result).toMatchObject({ lane: 'new', pLike: null, scoreSource: 'none', rulesFired: [] });
  });

  it('a current explicit selection ranks a stale item from its completed answers', () => {
    const result = rank(
      ctx,
      item({ pipelineState: 'stale', explicitSelection: true, cardAnswers: answered }),
    );
    expect(result).toMatchObject({ lane: 'for_you', pLike: 0.9, scoreSource: 'cards' });
  });
});

describe('rankArticle step 3: never-cards', () => {
  it('a confident never-card hides with never:<id>, whatever the positive score', () => {
    const ctx = context({ cards: [love, never] });
    const result = rank(ctx, item({ cardAnswers: answers({ 10: 0.99, 13: 0.7 }) }));
    expect(result).toMatchObject({ lane: 'hidden', pLike: null, rulesFired: ['never:13'] });
    expect(result.explain.rules).toEqual([{ code: 'never:13', cardId: '13' }]);
  });

  it('prefilter markers and scope-excluded never-cards never hide', () => {
    const scoped = card('14', 'never', { scopeFeedId: '9' });
    const ctx = context({ cards: [love, never, scoped] });
    const result = rank(
      ctx,
      item({
        cardAnswers: answers({ 10: 0.9, 13: { p: 0, engine: 'prefilter' }, 14: 0.99 }),
      }),
    );
    expect(result.lane).toBe('for_you');
    expect(result.explain.cards.map((c) => c.id)).toEqual(['10']);
  });
});

describe('rankArticle step 4: the base probability', () => {
  const model: ActiveModel = {
    version: 4,
    score: () => ({
      p: 0.8,
      top: [
        { feature: 'best.love', label: 'your Love interests', contribution: 1.2 },
        { feature: 'ct.news', label: 'News', contribution: -0.4 },
        { feature: 'feed.h3', label: 'Source group', contribution: 0.9 },
        { feature: 'len.long', label: 'Long read', contribution: 0.1 },
      ],
    }),
  };

  it('4a: a compatible model scores eligible items and explains its top three inputs', () => {
    const ctx = context({ cards: [love, never], model });
    const result = rank(
      ctx,
      item({ cardAnswers: answers({ 10: 0.2, 13: { p: 0.1, engine: 'prefilter' } }) }),
    );
    expect(result).toMatchObject({ scoreSource: 'model', pLike: 0.8, lane: 'for_you', tier: 4 });
    expect(result.explain.model).toEqual({
      version: 4,
      top: [
        { feature: 'best.love', label: 'your Love interests', contribution: 1.2 },
        { feature: 'feed.h3', label: 'Source group', contribution: 0.9 },
        { feature: 'ct.news', label: 'News', contribution: -0.4 },
      ],
    });
    // Published two hours ago: the age moves into the next freshness bin at 6 h.
    expect(result.nextRankAt).toEqual(new Date(NOW.getTime() + 4 * HOUR));
  });

  it.each<[string, Partial<RankItem>]>([
    ['incomplete coverage', { matchCoverage: 'pending' }],
    ['missing facets', { facets: undefined }],
    ['a degraded article', { pipelineState: 'degraded' }],
    ['a failed article', { pipelineState: 'failed' }],
    ['LLM facets', { facetsEngine: 'llm' }],
    ['Laya facets', { facetsEngine: 'laya' }],
    ['an LLM interest answer', { cardAnswers: answers({ 10: { p: 0.9, engine: 'llm' } }) }],
  ])('4a is skipped for %s: the cards path decides', (_name, overrides) => {
    const ctx = context({ cards: [love], model });
    const result = rank(ctx, item({ cardAnswers: answers({ 10: 0.9 }), ...overrides }));
    expect(result.scoreSource).toBe('cards');
  });

  it('4b: the card score is the best weighted positive answer; the deciding card is explained', () => {
    const ctx = context({ cards: [like, love, never] });
    const result = rank(ctx, item({ cardAnswers: answers({ 10: 0.5, 11: 0.75, 13: 0.2 }) }));
    expect(result).toMatchObject({ scoreSource: 'cards', lane: 'maybe', tier: 3 });
    expect(result.pLike).toBeCloseTo(0.6);
    expect(result.explain.decidingCardId).toBe('11');
    expect(result.explain.cards.map((c) => [c.id, c.p])).toEqual([
      ['11', 0.75],
      ['10', 0.5],
      ['13', 0.2],
    ]);
  });

  it('4c: unavailable coverage without answers falls back to BM25 in Maybe', () => {
    const battery = card('10', 'love', { interest: 'battery prices' });
    const corpus = buildBm25Corpus([
      { titleNorm: 'battery prices fall again', excerptNorm: 'lithium cells' },
      { titleNorm: 'football results', excerptNorm: 'the league' },
      { titleNorm: 'election day', excerptNorm: 'voters' },
    ]);
    const ctx = context({ cards: [battery], bm25: corpus });
    const result = rank(ctx, item({ matchCoverage: 'unavailable', pipelineState: 'degraded' }));
    expect(result).toMatchObject({
      scoreSource: 'degraded',
      lane: 'maybe',
      rulesFired: ['degraded'],
    });
    expect(result.pLike).toBeGreaterThan(0);
    expect(result.explain.inputs.contextSha).toBe(DEGRADED_SHA);
  });

  it('4d: no usable positive answer leaves the item new, still with label suggestions', () => {
    const ctx = context({
      cards: [love],
      labels: [{ cardId: '20', name: 'Batteries' }],
    });
    const pending = rank(
      ctx,
      item({
        matchCoverage: 'pending',
        cardAnswers: answers({ 20: 0.9, 10: { p: 0, engine: 'prefilter' } }),
      }),
    );
    expect(pending).toMatchObject({
      lane: 'new',
      pLike: null,
      scoreSource: 'none',
      labelSuggestions: ['20'],
    });
    const noCards = rank(context(), item());
    expect(noCards).toMatchObject({ lane: 'new', rulesFired: [] });
  });

  it('4d: with P null no floor or cap applies', () => {
    const ctx = context({ cards: [must, never], rules: [rule('boost_feed', '1')] });
    const result = rank(ctx, item({ matchCoverage: 'pending', cardAnswers: answers({ 13: 0.6 }) }));
    expect(result).toMatchObject({ lane: 'new', pLike: null, tier: null, rulesFired: [] });
  });
});

describe('rankArticle step 4b: quality demotions (spec 06 §5)', () => {
  const ctx = (overrides: Partial<UserRankContext> = {}) =>
    context({ cards: [love], ...overrides });
  const facets = (extra: Record<string, number>) => ({
    ...item().facets,
    ...extra,
  });

  it('each active and triggered flag multiplies P by 0.6 and fires demote:<flag>', () => {
    const result = rank(
      ctx({ demote: { clickbait: 'on', promotional: 'on', shallow: 'on', stale: 'on' } }),
      item({
        cardAnswers: answers({ 10: 1 }),
        facets: facets({ clickbait: 0.8, promotional: 0.9, depth: 0.25, time_sensitive: 0.7 }),
        firstSeenAt: new Date(NOW.getTime() - 73 * HOUR),
        publishedAt: undefined,
      }),
    );
    expect(result.rulesFired).toEqual([
      'demote:clickbait',
      'demote:promotional',
      'demote:shallow',
      'demote:stale',
    ]);
    expect(result.pLike).toBeCloseTo(0.6 ** 4);
  });

  it('auto activates after three dislikes with the matching reason; off never applies', () => {
    const triggered = item({ cardAnswers: answers({ 10: 1 }), facets: facets({ clickbait: 0.9 }) });
    expect(rank(ctx({ reasonCounts90d: { clickbait: 2 } }), triggered).rulesFired).toEqual([]);
    expect(rank(ctx({ reasonCounts90d: { clickbait: 3 } }), triggered).rulesFired).toEqual([
      'demote:clickbait',
    ]);
    expect(
      rank(
        ctx({
          reasonCounts90d: { clickbait: 9 },
          demote: { clickbait: 'off', promotional: 'auto', shallow: 'auto', stale: 'auto' },
        }),
        triggered,
      ).rulesFired,
    ).toEqual([]);
  });

  it('missing facets never trigger a flag', () => {
    const on = ctx({ demote: { clickbait: 'on', promotional: 'on', shallow: 'on', stale: 'on' } });
    expect(rank(on, item({ cardAnswers: answers({ 10: 0.9 }), facets: undefined })).pLike).toBe(
      0.9,
    );
  });

  it('applies only to the card score, never to the model or BM25', () => {
    const on = ctx({
      demote: { clickbait: 'on', promotional: 'on', shallow: 'on', stale: 'on' },
      model: { version: 1, score: () => ({ p: 0.9, top: [] }) },
    });
    const result = rank(
      on,
      item({ cardAnswers: answers({ 10: 0.9 }), facets: facets({ clickbait: 0.95 }) }),
    );
    expect(result).toMatchObject({ scoreSource: 'model', pLike: 0.9, rulesFired: [] });
  });

  it('a time-sensitive item becomes stale after 72 h: the next rank time is that boundary', () => {
    const on = ctx({
      demote: { clickbait: 'auto', promotional: 'auto', shallow: 'auto', stale: 'on' },
    });
    const young = item({
      cardAnswers: answers({ 10: 0.9 }),
      facets: facets({ time_sensitive: 0.8 }),
      firstSeenAt: new Date(NOW.getTime() - 70 * HOUR),
      publishedAt: undefined,
    });
    const result = rank(on, young);
    expect(result.rulesFired).toEqual([]);
    expect(result.nextRankAt).toEqual(new Date(NOW.getTime() + 2 * HOUR + 1));
    const later = rank(on, young, new Date(NOW.getTime() + 2 * HOUR + 1));
    expect(later.rulesFired).toEqual(['demote:stale']);
  });

  it('an auto flag whose dislikes leave the window re-ranks at that time', () => {
    const deadline = new Date(NOW.getTime() + 10 * HOUR);
    const result = rank(
      ctx({ reasonCounts90d: { promo: 3 }, demotionDeadlines: { promotional: deadline } }),
      item({ cardAnswers: answers({ 10: 0.9 }), facets: facets({ promotional: 0.9 }) }),
    );
    expect(result.rulesFired).toEqual(['demote:promotional']);
    expect(result.nextRankAt).toEqual(deadline);
  });
});

describe('rankArticle steps 5–7: lane modifiers', () => {
  it('seen_story caps a read story at Everything without rewriting P', () => {
    const ctx = context({ cards: [love], readClusterIds: new Set(['44']) });
    const result = rank(
      ctx,
      item({ clusterId: '44', clusterSize: 3, cardAnswers: answers({ 10: 0.9 }) }),
    );
    expect(result).toMatchObject({
      lane: 'everything',
      pLike: 0.9,
      tier: 5,
      rulesFired: ['seen_story'],
    });
  });

  it('seen_story beats a floor', () => {
    const ctx = context({
      cards: [must],
      rules: [rule('boost_domain', 'example.com')],
      readClusterIds: new Set(['44']),
    });
    const result = rank(ctx, item({ clusterId: '44', cardAnswers: answers({ 12: 0.6 }) }));
    expect(result).toMatchObject({ lane: 'everything', pLike: 0.6, rulesFired: ['seen_story'] });
  });

  it('seen_story keeps a degraded item in Everything (the degraded Maybe lane does not override it)', () => {
    const ctx = context({
      cards: [card('10', 'love', { interest: 'battery' })],
      readClusterIds: new Set(['44']),
      bm25: buildBm25Corpus([item(), { titleNorm: 'other news', excerptNorm: 'nothing' }]),
    });
    const result = rank(ctx, item({ clusterId: '44', matchCoverage: 'unavailable' }));
    expect(result).toMatchObject({
      lane: 'everything',
      scoreSource: 'degraded',
      rulesFired: ['seen_story', 'degraded'],
    });
  });

  it('degraded ignores floors and caps', () => {
    const ctx = context({
      cards: [card('12', 'must', { interest: 'football' }), never],
      rules: [rule('boost_feed', '1')],
      bm25: buildBm25Corpus([item()]),
    });
    const result = rank(
      ctx,
      item({ matchCoverage: 'unavailable', cardAnswers: answers({ 13: 0.6 }) }),
    );
    expect(result).toMatchObject({ lane: 'maybe', rulesFired: ['degraded'] });
  });

  it('a must floor beats a never_soft cap and raises P to lanes.forYou', () => {
    const ctx = context({ cards: [love, must, never] });
    const result = rank(ctx, item({ cardAnswers: answers({ 10: 0.2, 12: 0.55, 13: 0.6 }) }));
    expect(result).toMatchObject({
      lane: 'for_you',
      pLike: 0.65,
      tier: 4,
      rulesFired: ['must:12'],
    });
    expect(result.explain.rules).toEqual([{ code: 'must:12', cardId: '12' }]);
  });

  it('boost_feed and boost_domain floors carry their rule ids and expiries', () => {
    const expires = new Date(NOW.getTime() + 24 * HOUR);
    const ctx = context({
      cards: [love],
      rules: [
        rule('boost_feed', '1', { id: '40', expiresAt: expires }),
        rule('boost_domain', 'example.com', { id: '41' }),
      ],
    });
    const result = rank(ctx, item({ cardAnswers: answers({ 10: 0.1 }) }));
    expect(result).toMatchObject({ lane: 'for_you', pLike: 0.65 });
    expect(result.explain.rules).toEqual([
      { code: 'boost_feed', ruleId: '40' },
      { code: 'boost_domain', ruleId: '41' },
    ]);
    expect(result.nextRankAt).toEqual(expires);
  });

  it('a never-card in the soft band caps the lane at Maybe', () => {
    const ctx = context({ cards: [love, never] });
    const result = rank(ctx, item({ cardAnswers: answers({ 10: 0.9, 13: 0.55 }) }));
    expect(result).toMatchObject({ lane: 'maybe', pLike: 0.9, rulesFired: ['never_soft:13'] });
  });

  it('an LLM deciding answer below llmForYouMin caps at Maybe and always fires llm_answer', () => {
    const ctx = context({ cards: [love] });
    const capped = rank(ctx, item({ cardAnswers: answers({ 10: { p: 0.8, engine: 'llm' } }) }));
    expect(capped).toMatchObject({ lane: 'maybe', rulesFired: ['llm_answer'] });
    const high = rank(ctx, item({ cardAnswers: answers({ 10: { p: 0.9, engine: 'llm' } }) }));
    expect(high).toMatchObject({ lane: 'for_you', rulesFired: ['llm_answer'] });
  });

  it('pending_cards moves an Everything item with incomplete coverage to Maybe', () => {
    const ctx = context({ cards: [love, like] });
    const result = rank(ctx, item({ matchCoverage: 'pending', cardAnswers: answers({ 10: 0.1 }) }));
    expect(result).toMatchObject({
      lane: 'maybe',
      pLike: 0.1,
      tier: 1,
      rulesFired: ['pending_cards'],
    });
  });

  it('lists the codes in the normative order', () => {
    const ctx = context({
      cards: [love, must, never],
      demote: { clickbait: 'on', promotional: 'auto', shallow: 'auto', stale: 'auto' },
    });
    const result = rank(
      ctx,
      item({
        cardAnswers: answers({ 10: { p: 0.9, engine: 'llm' }, 12: 0.5 }),
        facets: { ...item().facets, clickbait: 0.9 },
      }),
    );
    expect(result.rulesFired).toEqual(['demote:clickbait', 'must:12', 'llm_answer']);
  });
});

describe('rankArticle step 8: tiers, label suggestions and thresholds from the config', () => {
  it('suggests held labels answered at p ≥ 0.8 that are not assigned yet', () => {
    const ctx = context({
      cards: [love],
      labels: [
        { cardId: '22', name: 'Later' },
        { cardId: '20', name: 'EV' },
        { cardId: '21', name: 'Kept' },
      ],
    });
    const result = rank(
      ctx,
      item({
        labelIds: ['21'],
        cardAnswers: answers({ 10: 0.9, 20: 0.8, 21: 0.99, 22: 0.79 }),
      }),
    );
    expect(result.labelSuggestions).toEqual(['20']);
    // Hidden items keep their suggestions too.
    const hidden = rank(
      context({ ...ctx, rules: [rule('block_domain', 'example.com')] }),
      item({ cardAnswers: answers({ 20: 0.9 }) }),
    );
    expect(hidden.labelSuggestions).toEqual(['20']);
  });

  it('reads every threshold from the config', () => {
    const config = mergeRankerConfig({ lanes: { forYou: 0.95 }, tiers: [0.1, 0.2, 0.3, 0.95] });
    const result = rank(
      context({ cards: [love], config }),
      item({ cardAnswers: answers({ 10: 0.9 }) }),
    );
    expect(result).toMatchObject({ lane: 'maybe', tier: 4 });
  });
});

describe('view-scoped projection of a ranked row (spec 06 §6.4)', () => {
  it('a feed view that keeps one of two authorized carriers shows the cached global score', () => {
    const scoped = card('10', 'love', { scopeFeedId: 'B' });
    const ranked = rank(
      context({ cards: [scoped] }),
      item({
        feedIds: ['A', 'B'],
        inferenceFeedIds: ['A', 'B'],
        cardAnswers: answers({ 10: 0.9 }),
      }),
    );
    expect(ranked).toMatchObject({ lane: 'for_you', pLike: 0.9 });
    const cached = {
      lane: ranked.lane,
      tier: ranked.tier,
      pLike: ranked.pLike,
      scoreSource: ranked.scoreSource,
      rulesFired: ranked.rulesFired,
      explain: ranked.explain,
      labelSuggestions: ranked.labelSuggestions,
    };
    const viewA = projectRankForView({
      inferenceFeedIds: ['A', 'B'],
      viewFeedIds: ['A'],
      cached,
      hideRule: null,
    });
    expect(viewA).toEqual({ inference: 'shown', rank: cached });
    const offView = projectRankForView({
      inferenceFeedIds: ['B'],
      viewFeedIds: ['A'],
      cached,
      hideRule: null,
    });
    expect(offView.rank).toMatchObject({
      lane: 'new',
      pLike: null,
      rulesFired: ['inference_not_requested'],
    });
  });
});

describe('Explain snapshots (spec 06 §6.2)', () => {
  it('cards source', () => {
    const ctx = context({
      cards: [love, card('15', 'like', { title: 'Electric cars' }), never],
      rules: [rule('boost_domain', 'example.com', { id: '77' })],
    });
    const result = rank(
      ctx,
      item({
        clusterId: '44',
        clusterSize: 3,
        translation: { engine: 'libretranslate', quality: 'ok' },
        cardAnswers: answers({ 10: 0.4, 15: 0.3, 13: 0.55 }),
      }),
    );
    expect(result).toMatchSnapshot();
  });

  it('degraded source', () => {
    const ctx = context({
      cards: [card('10', 'love', { interest: 'battery prices', title: 'Batteries' })],
      bm25: buildBm25Corpus([item(), { titleNorm: 'other news', excerptNorm: 'nothing' }]),
    });
    const result = rank(
      ctx,
      item({ matchCoverage: 'unavailable', pipelineState: 'degraded', facets: undefined }),
    );
    expect(result).toMatchSnapshot();
  });

  it('none source (inference not requested, and a hide rule with its rule id)', () => {
    expect(
      rank(context(), item({ inferenceEligible: false, inferenceFeedIds: [] })),
    ).toMatchSnapshot();
    expect(
      rank(context({ rules: [rule('mute_keyword', 'lithium', { id: '88' })] }), item()),
    ).toMatchSnapshot();
  });

  it('records the input revisions and the context sha', () => {
    const result = rank(context({ cards: [love] }), item({ cardAnswers: answers({ 10: 0.9 }) }));
    expect(result.explain.inputs).toEqual({
      contentRevision: '3',
      mediaRevision: '1',
      rankRevision: '7',
      contextSha: CONTEXT_SHA,
    });
  });
});

afterAll(() => {
  // Every rule code of spec 06 §3.2 is produced by at least one test above.
  expect([...produced].sort()).toEqual(
    [
      'block_author',
      'block_domain',
      'block_feed',
      'boost_domain',
      'boost_feed',
      'degraded',
      'demote:clickbait',
      'demote:promotional',
      'demote:shallow',
      'demote:stale',
      'inference_not_requested',
      'llm_answer',
      'must:<id>',
      'mute_keyword:Prices Fall',
      'mute_keyword:battery',
      'mute_keyword:lithium',
      'mute_keyword:účet',
      'mute_story',
      'never:<id>',
      'never_soft:<id>',
      'pending_cards',
      'seen_story',
    ].sort(),
  );
});
