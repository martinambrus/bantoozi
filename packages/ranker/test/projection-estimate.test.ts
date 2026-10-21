import { ExplainSchema, type Explain } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { projectRankForView, RULE_CODES, type StoredRank } from '../src/index.js';
import { cardsExplain } from './support.js';

// One article carried by off feed A ('1') and active feed B ('2'): only B is an authorized carrier.
const FEED_A = '1';
const FEED_B = '2';
const authorized = [FEED_B];
const offView = { inferenceFeedIds: authorized, viewFeedIds: [FEED_A] };

const estimateBlock = {
  version: 1,
  top: [
    { feature: 't:battery', label: 'battery', contribution: 0.84 },
    { feature: 'b:solar power', label: 'solar power', contribution: -0.31 },
  ],
};

function estimateExplain(overrides: Partial<Explain> = {}): Explain {
  return {
    v: 1,
    inputs: {
      contentRevision: '3',
      mediaRevision: '1',
      rankRevision: '12',
      contextSha: 'b'.repeat(64),
    },
    source: 'estimate',
    p: 0.74,
    lane: 'new',
    tier: 4,
    cards: [],
    facets: {
      contentType: { choice: 'news', p: 0.8 },
      topic: { l1: 'science', p: 0.7 },
      depth: 0.6,
      clickbait: 0.1,
      promotional: 0.05,
      timeSensitive: 0.3,
      evergreen: 0.4,
    },
    model: { version: 2, top: [] },
    rules: [{ code: 'estimate' }],
    estimate: estimateBlock,
    ...overrides,
  } as Explain;
}

const cachedEstimate: StoredRank = {
  lane: 'new',
  tier: 4,
  pLike: 0.74,
  scoreSource: 'estimate',
  rulesFired: ['estimate'],
  explain: estimateExplain(),
  labelSuggestions: ['77'],
};

describe('projectRankForView with a cached estimate (visible-learning §4.4)', () => {
  it('keeps the estimate tier and P in a view without inference', () => {
    const projection = projectRankForView({ ...offView, cached: cachedEstimate, hideRule: null });
    expect(projection.inference).toBe('not_requested');
    expect(projection.rank).toMatchObject({
      lane: 'new',
      tier: 4,
      pLike: 0.74,
      scoreSource: 'estimate',
      labelSuggestions: [],
    });
  });

  it('fires inference_not_requested and then estimate', () => {
    const { rank } = projectRankForView({ ...offView, cached: cachedEstimate, hideRule: null });
    expect(rank.rulesFired).toEqual([RULE_CODES.inferenceNotRequested, RULE_CODES.estimate]);
    expect(rank.rulesFired).toEqual(['inference_not_requested', 'estimate']);
    expect(rank.explain?.rules).toEqual([
      { code: 'inference_not_requested' },
      { code: 'estimate' },
    ]);
  });

  it('applies when no carrier is authorized at all', () => {
    const projection = projectRankForView({
      inferenceFeedIds: [],
      viewFeedIds: null,
      cached: cachedEstimate,
      hideRule: null,
    });
    expect(projection.inference).toBe('not_requested');
    expect(projection.rank.scoreSource).toBe('estimate');
    expect(projection.rank.tier).toBe(4);
  });

  it('rebuilds the explanation from the stored one without cards, facets or model', () => {
    const { rank } = projectRankForView({ ...offView, cached: cachedEstimate, hideRule: null });
    const explain = ExplainSchema.parse(rank.explain);
    expect(explain).toEqual({
      v: 1,
      inputs: cachedEstimate.explain?.inputs,
      source: 'estimate',
      p: 0.74,
      lane: 'new',
      tier: 4,
      cards: [],
      rules: [{ code: 'inference_not_requested' }, { code: 'estimate' }],
      estimate: estimateBlock,
    });
    expect(explain.cards).toEqual([]);
    expect(explain.facets).toBeUndefined();
    expect(explain.model).toBeUndefined();
  });

  it('keeps the explanation without an estimate block when none was stored', () => {
    const { estimate: _dropped, ...withoutBlock } = estimateExplain();
    const { rank } = projectRankForView({
      ...offView,
      cached: { ...cachedEstimate, explain: withoutBlock as Explain },
      hideRule: null,
    });
    expect(rank.explain).not.toBeNull();
    expect(rank.explain).not.toHaveProperty('estimate');
    expect(rank.explain?.source).toBe('estimate');
    expect(ExplainSchema.safeParse(rank.explain).success).toBe(true);
  });

  it('gives no explanation when the stored one is missing', () => {
    const { rank } = projectRankForView({
      ...offView,
      cached: { ...cachedEstimate, explain: null },
      hideRule: null,
    });
    expect(rank.explain).toBeNull();
    expect(rank.scoreSource).toBe('estimate');
    expect(rank.pLike).toBe(0.74);
  });

  it('gives no explanation when the stored one has another source', () => {
    const { rank } = projectRankForView({
      ...offView,
      cached: { ...cachedEstimate, explain: cardsExplain({ lane: 'new' }) },
      hideRule: null,
    });
    expect(rank.explain).toBeNull();
    expect(rank.scoreSource).toBe('estimate');
    expect(rank.tier).toBe(4);
  });

  it('lets a hide rule win: hidden, no P and the hide rule only', () => {
    const { inference, rank } = projectRankForView({
      ...offView,
      cached: cachedEstimate,
      hideRule: { code: 'mute_keyword:crypto', ruleId: '42', detail: 'crypto' },
    });
    expect(inference).toBe('not_requested');
    expect(rank).toMatchObject({
      lane: 'hidden',
      tier: null,
      pLike: null,
      scoreSource: 'none',
      rulesFired: ['mute_keyword:crypto'],
      labelSuggestions: [],
    });
    expect(rank.explain?.source).toBe('none');
    expect(rank.explain?.p).toBeNull();
    expect(rank.explain?.rules).toEqual([
      { code: 'mute_keyword:crypto', ruleId: '42', detail: 'crypto' },
    ]);
    expect(rank.explain).not.toHaveProperty('estimate');
  });

  it.each(['cards', 'model', 'degraded', 'none'] as const)(
    'keeps a cached %s row neutral exactly as before',
    (scoreSource) => {
      const cached: StoredRank = {
        lane: 'for_you',
        tier: 5,
        pLike: 0.91,
        scoreSource,
        rulesFired: ['must:5'],
        explain: cardsExplain({ source: scoreSource }),
        labelSuggestions: ['77'],
      };
      const { rank } = projectRankForView({ ...offView, cached, hideRule: null });
      expect(rank).toEqual({
        lane: 'new',
        tier: null,
        pLike: null,
        scoreSource: 'none',
        rulesFired: ['inference_not_requested'],
        explain: {
          v: 1,
          inputs: cached.explain?.inputs,
          source: 'none',
          p: null,
          lane: 'new',
          tier: null,
          cards: [],
          rules: [{ code: 'inference_not_requested' }],
        },
        labelSuggestions: [],
      });
    },
  );

  it('keeps an estimate row without a tier or P neutral', () => {
    for (const partial of [{ tier: null }, { pLike: null }]) {
      const { rank } = projectRankForView({
        ...offView,
        cached: { ...cachedEstimate, ...partial },
        hideRule: null,
      });
      expect(rank.scoreSource).toBe('none');
      expect(rank.tier).toBeNull();
      expect(rank.pLike).toBeNull();
      expect(rank.rulesFired).toEqual(['inference_not_requested']);
    }
  });

  it('keeps a never-ranked row (cached null) neutral and unchanged', () => {
    const { inference, rank } = projectRankForView({ ...offView, cached: null, hideRule: null });
    expect(inference).toBe('not_requested');
    expect(rank).toMatchObject({
      lane: 'new',
      tier: null,
      pLike: null,
      scoreSource: 'none',
      rulesFired: ['inference_not_requested'],
      explain: null,
      labelSuggestions: [],
    });
  });

  it('returns the cached estimate rank itself in a view that shows inference', () => {
    for (const viewFeedIds of [[FEED_B], null]) {
      const projection = projectRankForView({
        inferenceFeedIds: authorized,
        viewFeedIds,
        cached: cachedEstimate,
        hideRule: null,
      });
      expect(projection.inference).toBe('shown');
      expect(projection.rank).toBe(cachedEstimate);
      expect(projection.rank.rulesFired).toEqual(['estimate']);
    }
  });

  it('never mutates the cached estimate row', () => {
    const snapshot = structuredClone(cachedEstimate);
    const { rank } = projectRankForView({ ...offView, cached: cachedEstimate, hideRule: null });
    expect(cachedEstimate).toEqual(snapshot);
    expect(rank.explain?.inputs).not.toBe(cachedEstimate.explain?.inputs);
    expect(rank.explain?.rules).not.toBe(cachedEstimate.explain?.rules);
  });
});
