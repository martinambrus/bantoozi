import { ExplainSchema } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  isInferenceVisibleInView,
  projectRankForView,
  type StoredRank,
  UNRANKED,
} from '../src/index.js';
import { cardsExplain } from './support.js';

// One article carried by off feed A ('1') and active feed B ('2'): only B is an authorized carrier.
const FEED_A = '1';
const FEED_B = '2';
const authorized = [FEED_B];

const cached: StoredRank = {
  lane: 'for_you',
  tier: 5,
  pLike: 0.91,
  scoreSource: 'cards',
  rulesFired: ['must:5'],
  explain: cardsExplain(),
  labelSuggestions: ['77'],
};

describe('projectRankForView (spec 06 §6.4)', () => {
  it('keeps an off view neutral while another carrier supplied the stored score', () => {
    const projection = projectRankForView({
      inferenceFeedIds: authorized,
      viewFeedIds: [FEED_A],
      cached,
      hideRule: null,
    });
    expect(projection.inference).toBe('not_requested');
    expect(projection.rank).toEqual({
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
    expect(ExplainSchema.parse(projection.rank.explain)).toEqual(projection.rank.explain);
  });

  it('shows the cached global score in any view with an authorized carrier', () => {
    for (const viewFeedIds of [[FEED_B], new Set([FEED_A, FEED_B]), null]) {
      const projection = projectRankForView({
        inferenceFeedIds: authorized,
        viewFeedIds,
        cached,
        hideRule: null,
      });
      expect(projection).toEqual({ inference: 'shown', rank: cached });
      expect(projection.rank).toBe(cached);
    }
  });

  it('lets the view decide only visibility, not which authorized evidence counts', () => {
    // Card 5 is scoped to authorized feed C ('3'); the article is listed under authorized feed B.
    const scopedToC = { ...cached, explain: cardsExplain({ decidingCardId: '5' }) };
    const projection = projectRankForView({
      inferenceFeedIds: [FEED_B, '3'],
      viewFeedIds: [FEED_B],
      cached: scopedToC,
      hideRule: null,
    });
    expect(projection.rank.explain?.decidingCardId).toBe('5');
    expect(projection.rank.pLike).toBe(0.91);
  });

  it('still applies an explicit hide rule in the neutral projection', () => {
    const projection = projectRankForView({
      inferenceFeedIds: authorized,
      viewFeedIds: [FEED_A],
      cached,
      hideRule: { code: 'mute_keyword:crypto', ruleId: '42', detail: 'crypto' },
    });
    expect(projection.inference).toBe('not_requested');
    expect(projection.rank).toMatchObject({
      lane: 'hidden',
      tier: null,
      pLike: null,
      scoreSource: 'none',
      rulesFired: ['mute_keyword:crypto'],
      labelSuggestions: [],
    });
    expect(projection.rank.explain?.rules).toEqual([
      { code: 'mute_keyword:crypto', ruleId: '42', detail: 'crypto' },
    ]);
    const bare = projectRankForView({
      inferenceFeedIds: authorized,
      viewFeedIds: [FEED_A],
      cached,
      hideRule: { code: 'block_domain' },
    });
    expect(bare.rank.explain?.rules).toEqual([{ code: 'block_domain' }]);
  });

  it('drops an inferred hide of the cached result, such as a never-card', () => {
    const neverHidden: StoredRank = {
      ...UNRANKED,
      lane: 'hidden',
      rulesFired: ['never:9'],
      explain: cardsExplain({ source: 'cards', lane: 'hidden', p: null, tier: null }),
    };
    const offView = projectRankForView({
      inferenceFeedIds: authorized,
      viewFeedIds: [FEED_A],
      cached: neverHidden,
      hideRule: null,
    });
    expect(offView.rank.lane).toBe('new');
    expect(offView.rank.rulesFired).toEqual(['inference_not_requested']);
  });

  it('keeps a row without authorized carriers neutral in every view, the global one too', () => {
    for (const viewFeedIds of [null, [FEED_A, FEED_B]]) {
      const projection = projectRankForView({
        inferenceFeedIds: [],
        viewFeedIds,
        cached,
        hideRule: null,
      });
      expect(projection.inference).toBe('not_requested');
      expect(projection.rank.lane).toBe('new');
    }
  });

  it('treats a row that was never ranked as the column defaults', () => {
    expect(
      projectRankForView({
        inferenceFeedIds: authorized,
        viewFeedIds: null,
        cached: null,
        hideRule: null,
      }),
    ).toEqual({ inference: 'shown', rank: UNRANKED });
    const neutral = projectRankForView({
      inferenceFeedIds: authorized,
      viewFeedIds: [FEED_A],
      cached: null,
      hideRule: null,
    });
    expect(neutral.rank).toMatchObject({ lane: 'new', explain: null });
  });

  it('never mutates the cached result', () => {
    const snapshot = structuredClone(cached);
    projectRankForView({
      inferenceFeedIds: authorized,
      viewFeedIds: [FEED_A],
      cached,
      hideRule: null,
    });
    expect(cached).toEqual(snapshot);
  });
});

describe('isInferenceVisibleInView (spec 06 §6.4)', () => {
  it('needs an authorized carrier inside the view', () => {
    expect(isInferenceVisibleInView(['2'], ['1'])).toBe(false);
    expect(isInferenceVisibleInView(['2'], new Set(['1', '2']))).toBe(true);
    expect(isInferenceVisibleInView(['2'], [])).toBe(false);
    expect(isInferenceVisibleInView(['2'], null)).toBe(true);
    expect(isInferenceVisibleInView([], null)).toBe(false);
  });
});
