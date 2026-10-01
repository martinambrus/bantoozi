import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type AnswerEngine,
  type CardAnswers,
  cardScore,
  compareLanes,
  DEFAULT_RANKER_CONFIG,
  type ModelEngine,
  type OrderedLane,
  type PositiveStrength,
  type RankCard,
  rankArticle,
} from '../src/index.js';
import { context, item, NOW, PLAIN_FACETS } from './rank-support.js';
import { card } from './support.js';

const PARAMS = { seed: 42, numRuns: 500 } as const;
const FEEDS = ['1', '2'] as const;

const unit = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

interface Scenario {
  cards: RankCard[];
  answers: Record<string, { p: number; engine: AnswerEngine }>;
  inferenceFeedIds: string[];
  target: string;
  engine: ModelEngine;
  lo: number;
  hi: number;
}

/**
 * Some held cards with optional answers (missing, `prefilter` or measured), plus one positive target
 * card whose p is raised from `lo` to `hi` with everything else fixed.
 */
function scenario(options: {
  strengths: readonly RankCard['strength'][];
  targetStrengths: readonly PositiveStrength[];
  engines: readonly AnswerEngine[];
  targetEngines: readonly ModelEngine[];
  scopedTarget: boolean;
}): fc.Arbitrary<Scenario> {
  const scope = fc.option(fc.constantFrom(...FEEDS), { nil: undefined });
  const other = fc.record({
    strength: fc.constantFrom(...options.strengths),
    scopeFeedId: scope,
    answer: fc.option(fc.record({ p: unit, engine: fc.constantFrom(...options.engines) }), {
      nil: undefined,
    }),
  });
  return fc
    .record({
      ids: fc.uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 7 }),
      others: fc.array(other, { minLength: 6, maxLength: 6 }),
      targetStrength: fc.constantFrom(...options.targetStrengths),
      targetScope: options.scopedTarget ? scope : fc.constant(undefined),
      engine: fc.constantFrom(...options.targetEngines),
      inferenceFeedIds: fc.subarray([...FEEDS], { minLength: 1 }),
      a: unit,
      b: unit,
    })
    .map(({ ids, others, targetStrength, targetScope, engine, inferenceFeedIds, a, b }) => {
      const [targetId, ...rest] = ids.map(String) as [string, ...string[]];
      const cards: RankCard[] = [card(targetId, targetStrength, { scopeFeedId: targetScope })];
      const answers: Scenario['answers'] = {};
      rest.forEach((id, i) => {
        const spec = others[i];
        if (spec === undefined) return;
        cards.push(card(id, spec.strength, { scopeFeedId: spec.scopeFeedId }));
        if (spec.answer !== undefined) answers[id] = spec.answer;
      });
      return {
        cards,
        answers,
        inferenceFeedIds,
        target: targetId,
        engine,
        lo: Math.min(a, b),
        hi: Math.max(a, b),
      };
    });
}

function withTarget(s: Scenario, p: number | undefined): CardAnswers {
  return p === undefined ? s.answers : { ...s.answers, [s.target]: { p, engine: s.engine } };
}

const weights = fc.record({ must: unit, love: unit, like: unit });

describe('cardScore monotonicity (spec 06 §4.1, §12)', () => {
  const anyCards = scenario({
    strengths: ['must', 'love', 'like', 'never'],
    targetStrengths: ['must', 'love', 'like'],
    engines: ['typesafe', 'llm', 'laya', 'prefilter'],
    targetEngines: ['typesafe', 'llm', 'laya'],
    scopedTarget: true,
  });

  it("raising a positive card's p never lowers the card score", () => {
    fc.assert(
      fc.property(anyCards, weights, (s, strengthWeights) => {
        const score = (p: number) =>
          cardScore(
            s.cards,
            { cardAnswers: withTarget(s, p), inferenceFeedIds: s.inferenceFeedIds },
            { strengthWeights },
          )?.score ?? Number.NEGATIVE_INFINITY;
        expect(score(s.hi)).toBeGreaterThanOrEqual(score(s.lo));
      }),
      PARAMS,
    );
  });

  it('turning an unknown answer into any p never lowers the card score', () => {
    fc.assert(
      fc.property(anyCards, (s) => {
        const score = (p: number | undefined) =>
          cardScore(
            s.cards,
            { cardAnswers: withTarget(s, p), inferenceFeedIds: s.inferenceFeedIds },
            DEFAULT_RANKER_CONFIG,
          )?.score ?? Number.NEGATIVE_INFINITY;
        expect(score(s.lo)).toBeGreaterThanOrEqual(score(undefined));
      }),
      PARAMS,
    );
  });
});

describe('rankArticle P monotonicity for source cards (spec 06 §2 step 4b, §12)', () => {
  // No must cards (floors), never cards, boost rules or model; demotions are fixed per run.
  const rank = (s: Scenario, p: number, demoteClickbait: boolean) =>
    rankArticle(
      context({
        cards: s.cards,
        demote: {
          clickbait: demoteClickbait ? 'on' : 'off',
          promotional: 'auto',
          shallow: 'auto',
          stale: 'auto',
        },
      }),
      item({
        cardAnswers: withTarget(s, p),
        inferenceFeedIds: s.inferenceFeedIds,
        facets: demoteClickbait ? { ...PLAIN_FACETS, clickbait: 0.9 } : PLAIN_FACETS,
      }),
      NOW,
    );

  it("raising a positive card's p never lowers P", () => {
    const cards = scenario({
      strengths: ['love', 'like'],
      targetStrengths: ['love', 'like'],
      engines: ['typesafe', 'llm', 'laya', 'prefilter'],
      targetEngines: ['typesafe', 'llm', 'laya'],
      scopedTarget: false,
    });
    fc.assert(
      fc.property(cards, fc.boolean(), (s, demote) => {
        const low = rank(s, s.lo, demote);
        const high = rank(s, s.hi, demote);
        expect(low.scoreSource).toBe('cards');
        expect(high.scoreSource).toBe('cards');
        expect(high.pLike as number).toBeGreaterThanOrEqual(low.pLike as number);
        expect(high.tier as number).toBeGreaterThanOrEqual(low.tier as number);
        expect(high.rulesFired.includes('demote:clickbait')).toBe(demote);
        expect(low.rulesFired.includes('demote:clickbait')).toBe(demote);
      }),
      PARAMS,
    );
  });

  it('without llm answers (no deciding-engine cap) the lane never drops either', () => {
    const cards = scenario({
      strengths: ['love', 'like'],
      targetStrengths: ['love', 'like'],
      engines: ['typesafe', 'laya', 'prefilter'],
      targetEngines: ['typesafe', 'laya'],
      scopedTarget: false,
    });
    fc.assert(
      fc.property(cards, fc.boolean(), (s, demote) => {
        const low = rank(s, s.lo, demote).lane as OrderedLane;
        const high = rank(s, s.hi, demote).lane as OrderedLane;
        expect(compareLanes(high, low)).toBeGreaterThanOrEqual(0);
      }),
      PARAMS,
    );
  });
});
