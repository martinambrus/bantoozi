import { describe, expect, it } from 'vitest';

import { applyLanePolicy, DEFAULT_RANKER_CONFIG, type LanePolicyInput } from '../src/index.js';

const config = DEFAULT_RANKER_CONFIG;
const cards = (p: number, extra: Partial<LanePolicyInput> = {}): LanePolicyInput => ({
  p,
  source: 'cards',
  coverage: 'complete',
  ...extra,
});

describe('applyLanePolicy (spec 06 §2 steps 5–8, bootstrap subset)', () => {
  it('maps P to its lane and tier when no modifier applies', () => {
    expect(applyLanePolicy(cards(0.9), config)).toEqual({
      lane: 'for_you',
      p: 0.9,
      tier: 5,
      rules: [],
    });
    expect(applyLanePolicy(cards(0.5), config)).toEqual({
      lane: 'maybe',
      p: 0.5,
      tier: 3,
      rules: [],
    });
    expect(applyLanePolicy(cards(0.2, { source: 'model' }), config)).toEqual({
      lane: 'everything',
      p: 0.2,
      tier: 1,
      rules: [],
    });
  });

  it('caps a read story at Everything without rewriting its score', () => {
    expect(applyLanePolicy(cards(0.9, { seenStory: true }), config)).toEqual({
      lane: 'everything',
      p: 0.9,
      tier: 5,
      rules: [{ code: 'seen_story' }],
    });
  });

  it('keeps a degraded (BM25) item of a read story in Everything', () => {
    const result = applyLanePolicy(cards(0.6, { source: 'degraded', seenStory: true }), config);
    expect(result).toMatchObject({ lane: 'everything', tier: 3 });
    expect(result.rules).toEqual([{ code: 'seen_story' }, { code: 'degraded' }]);
  });

  it('puts every other degraded item in Maybe, ignoring floors and caps', () => {
    for (const p of [0, 0.2, 0.5, 0.9, 1]) {
      const result = applyLanePolicy(
        cards(p, {
          source: 'degraded',
          coverage: 'unavailable',
          floors: [{ kind: 'must', cardId: '5' }],
          neverSoftCardId: '4',
        }),
        config,
      );
      expect(result).toMatchObject({ lane: 'maybe', p });
      expect(result.rules).toEqual([{ code: 'degraded' }]);
    }
  });

  it('raises a floored item to For you and P to lanes.forYou, so the tier matches', () => {
    expect(
      applyLanePolicy(cards(0.2, { floors: [{ kind: 'must', cardId: '5' }] }), config),
    ).toEqual({
      lane: 'for_you',
      p: 0.65,
      tier: 4,
      rules: [{ code: 'must:5', cardId: '5' }],
    });
    const high = applyLanePolicy(cards(0.9, { floors: [{ kind: 'must', cardId: '5' }] }), config);
    expect(high).toMatchObject({ lane: 'for_you', p: 0.9, tier: 5 });
  });

  it('fires boost rules as floors with their rule ids', () => {
    const result = applyLanePolicy(
      cards(0.1, { floors: [{ kind: 'boost_feed', ruleId: '11' }, { kind: 'boost_domain' }] }),
      config,
    );
    expect(result.lane).toBe('for_you');
    expect(result.rules).toEqual([{ code: 'boost_feed', ruleId: '11' }, { code: 'boost_domain' }]);
  });

  it('lets a floor preempt both caps', () => {
    const result = applyLanePolicy(
      cards(0.7, {
        floors: [{ kind: 'must', cardId: '5' }],
        neverSoftCardId: '4',
        decidingEngine: 'llm',
      }),
      config,
    );
    expect(result.lane).toBe('for_you');
    expect(result.rules).toEqual([{ code: 'must:5', cardId: '5' }, { code: 'llm_answer' }]);
  });

  it('caps at Maybe for a never-card in the soft band', () => {
    expect(applyLanePolicy(cards(0.9, { neverSoftCardId: '4' }), config)).toEqual({
      lane: 'maybe',
      p: 0.9,
      tier: 5,
      rules: [{ code: 'never_soft:4', cardId: '4' }],
    });
    expect(applyLanePolicy(cards(0.2, { neverSoftCardId: '4' }), config).lane).toBe('everything');
  });

  it('caps an LLM-decided item below llmForYouMin, and fires llm_answer even without a cap', () => {
    const llm = (p: number) => applyLanePolicy(cards(p, { decidingEngine: 'llm' }), config);
    expect(llm(0.8)).toMatchObject({ lane: 'maybe', rules: [{ code: 'llm_answer' }] });
    expect(llm(0.85)).toMatchObject({ lane: 'for_you', rules: [{ code: 'llm_answer' }] });
    expect(llm(0.5)).toMatchObject({ lane: 'maybe', rules: [{ code: 'llm_answer' }] });
    expect(applyLanePolicy(cards(0.8, { decidingEngine: 'typesafe' }), config).lane).toBe(
      'for_you',
    );
  });

  it('applies both caps together', () => {
    const result = applyLanePolicy(
      cards(0.8, { neverSoftCardId: '4', decidingEngine: 'llm' }),
      config,
    );
    expect(result.lane).toBe('maybe');
    expect(result.rules).toEqual([{ code: 'never_soft:4', cardId: '4' }, { code: 'llm_answer' }]);
  });

  it('never leaves an item with incomplete coverage in Everything', () => {
    for (const coverage of ['pending', 'unavailable'] as const) {
      expect(applyLanePolicy(cards(0.2, { coverage }), config)).toEqual({
        lane: 'maybe',
        p: 0.2,
        tier: 1,
        rules: [{ code: 'pending_cards' }],
      });
    }
    expect(applyLanePolicy(cards(0.2), config).lane).toBe('everything');
    expect(applyLanePolicy(cards(0.9, { coverage: 'pending' }), config).rules).toEqual([]);
  });

  it('keeps a read story in Everything despite incomplete coverage', () => {
    expect(applyLanePolicy(cards(0.2, { coverage: 'pending', seenStory: true }), config)).toEqual({
      lane: 'everything',
      p: 0.2,
      tier: 1,
      rules: [{ code: 'seen_story' }],
    });
  });

  it('lets seen_story preempt floors and caps', () => {
    const result = applyLanePolicy(
      cards(0.9, {
        seenStory: true,
        floors: [{ kind: 'must', cardId: '5' }],
        neverSoftCardId: '4',
        decidingEngine: 'llm',
      }),
      config,
    );
    expect(result).toMatchObject({ lane: 'everything', p: 0.9 });
    expect(result.rules).toEqual([{ code: 'seen_story' }, { code: 'llm_answer' }]);
  });

  it('fires a modifier only when it changes the lane or P', () => {
    const rulesOf = (input: LanePolicyInput) => applyLanePolicy(input, config).rules;
    // A read story whose item is in Everything anyway, with nothing else pending.
    expect(rulesOf(cards(0.2, { seenStory: true }))).toEqual([]);
    // A floor on an item already in For you with P ≥ lanes.forYou, and no cap to skip.
    expect(rulesOf(cards(0.9, { floors: [{ kind: 'must', cardId: '5' }] }))).toEqual([]);
    expect(rulesOf(cards(0.65, { floors: [{ kind: 'boost_feed', ruleId: '3' }] }))).toEqual([]);
    expect(
      rulesOf(cards(0.9, { floors: [{ kind: 'must', cardId: '5' }], decidingEngine: 'llm' })),
    ).toEqual([{ code: 'llm_answer' }]);
    // A never-card in the soft band on an item already at or below Maybe.
    expect(rulesOf(cards(0.5, { neverSoftCardId: '4' }))).toEqual([]);
    expect(rulesOf(cards(0.2, { neverSoftCardId: '4', coverage: 'pending' }))).toEqual([
      { code: 'pending_cards' },
    ]);
  });

  it('fires a modifier that changes the outcome only by skipping a later one', () => {
    // The floor changes nothing itself but keeps the soft cap from moving the item to Maybe.
    const floored = applyLanePolicy(
      cards(0.9, { floors: [{ kind: 'must', cardId: '5' }], neverSoftCardId: '4' }),
      config,
    );
    expect(floored).toMatchObject({ lane: 'for_you', rules: [{ code: 'must:5', cardId: '5' }] });
    // The read story changes nothing itself but keeps the floor from raising the item.
    const read = applyLanePolicy(
      cards(0.2, { seenStory: true, floors: [{ kind: 'boost_domain' }] }),
      config,
    );
    expect(read).toMatchObject({ lane: 'everything', p: 0.2, rules: [{ code: 'seen_story' }] });
  });

  it('takes every boundary from the config', () => {
    const custom = {
      lanes: { forYou: 0.8, maybe: 0.5 },
      tiers: [0.2, 0.4, 0.6, 0.8] as const,
      llmForYouMin: 0.95,
    };
    expect(applyLanePolicy(cards(0.7), custom)).toMatchObject({ lane: 'maybe', tier: 4 });
    expect(applyLanePolicy(cards(0.9, { decidingEngine: 'llm' }), custom).lane).toBe('maybe');
    expect(
      applyLanePolicy(cards(0.1, { floors: [{ kind: 'boost_domain' }] }), custom),
    ).toMatchObject({
      lane: 'for_you',
      p: 0.8,
      tier: 5,
    });
  });

  it('rejects an invalid P', () => {
    expect(() => applyLanePolicy(cards(Number.NaN), config)).toThrow(RangeError);
    expect(() => applyLanePolicy(cards(1.2), config)).toThrow(RangeError);
  });
});
