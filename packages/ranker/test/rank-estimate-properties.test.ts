import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type ActiveEstimate,
  type AnswerEngine,
  type CardAnswers,
  DEFAULT_RANKER_CONFIG,
  type ModelEngine,
  mergeRankerConfig,
  type PositiveStrength,
  type RankCard,
  type RankItem,
  rankArticle,
  type ReadonlyRankerConfig,
  tierFromP,
  type UserRankContext,
} from '../src/index.js';
import { context, item, NOW, PLAIN_FACETS, rule } from './rank-support.js';
import { card } from './support.js';

const PARAMS = { seed: 42, numRuns: 500 } as const;
const FEEDS = ['1', '2'] as const;
const OVERRIDE = mergeRankerConfig({
  lanes: { forYou: 0.8, maybe: 0.2 },
  tiers: [0.1, 0.3, 0.5, 0.9],
});
const CONFIGS: ReadonlyRankerConfig[] = [DEFAULT_RANKER_CONFIG, OVERRIDE];

const BOOST = rule('boost_feed', '1', { id: '900' });
const BLOCK = rule('block_domain', 'example.com', { id: '901' });

const unit = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

interface Scenario {
  cards: RankCard[];
  answers: CardAnswers;
  inferenceFeedIds: string[];
  engine: ModelEngine;
}

/** Held cards of every strength with optional answers of every engine, as in rank-properties. */
const scenario: fc.Arbitrary<Scenario> = (() => {
  const scope = fc.option(fc.constantFrom(...FEEDS), { nil: undefined });
  const other = fc.record({
    strength: fc.constantFrom<RankCard['strength']>('must', 'love', 'like', 'never'),
    scopeFeedId: scope,
    answer: fc.option(
      fc.record({
        p: unit,
        engine: fc.constantFrom<AnswerEngine>('typesafe', 'llm', 'laya', 'prefilter'),
      }),
      { nil: undefined },
    ),
  });
  return fc
    .record({
      ids: fc.uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 7 }),
      others: fc.array(other, { minLength: 6, maxLength: 6 }),
      targetStrength: fc.constantFrom<PositiveStrength>('must', 'love', 'like'),
      targetScope: scope,
      targetAnswer: fc.option(
        fc.record({ p: unit, engine: fc.constantFrom<AnswerEngine>('typesafe', 'llm', 'laya') }),
        { nil: undefined },
      ),
      engine: fc.constantFrom<ModelEngine>('typesafe', 'llm', 'laya'),
      inferenceFeedIds: fc.subarray([...FEEDS], { minLength: 1 }),
    })
    .map(({ ids, others, targetStrength, targetScope, targetAnswer, engine, inferenceFeedIds }) => {
      const [targetId, ...rest] = ids.map(String) as [string, ...string[]];
      const cards: RankCard[] = [card(targetId, targetStrength, { scopeFeedId: targetScope })];
      const answers: Record<string, { p: number; engine: AnswerEngine }> = {};
      if (targetAnswer !== undefined) answers[targetId] = targetAnswer;
      rest.forEach((id, i) => {
        const spec = others[i];
        if (spec === undefined) return;
        cards.push(card(id, spec.strength, { scopeFeedId: spec.scopeFeedId }));
        if (spec.answer !== undefined) answers[id] = spec.answer;
      });
      return { cards, answers, inferenceFeedIds, engine };
    });
})();

interface Modifiers {
  config: ReadonlyRankerConfig;
  clickbaitDemotion: boolean;
  boost: boolean;
  coverage: RankItem['matchCoverage'];
  seenStory: boolean;
  withModel: boolean;
  modelP: number;
}

const modifiers: fc.Arbitrary<Modifiers> = fc.record({
  config: fc.constantFrom(...CONFIGS),
  clickbaitDemotion: fc.boolean(),
  boost: fc.boolean(),
  coverage: fc.constantFrom<RankItem['matchCoverage']>('complete', 'pending', 'unavailable'),
  seenStory: fc.boolean(),
  withModel: fc.boolean(),
  modelP: unit,
});

function build(
  s: Scenario,
  m: Modifiers,
  estimate: ActiveEstimate | undefined,
): { ctx: UserRankContext; the: RankItem } {
  const ctx = context({
    config: m.config,
    cards: s.cards,
    demote: {
      clickbait: m.clickbaitDemotion ? 'on' : 'off',
      promotional: 'auto',
      shallow: 'auto',
      stale: 'auto',
    },
    rules: m.boost ? [BOOST] : [],
    readClusterIds: m.seenStory ? new Map([['44', NOW]]) : new Map(),
    ...(m.withModel ? { model: { version: 1, score: () => ({ p: m.modelP, top: [] }) } } : {}),
    estimate,
  });
  const the = item({
    title: 'Battery prices fall again',
    cardAnswers: s.answers,
    inferenceFeedIds: s.inferenceFeedIds,
    matchCoverage: m.coverage,
    clusterId: '44',
    facets: m.clickbaitDemotion ? { ...PLAIN_FACETS, clickbait: 0.9 } : PLAIN_FACETS,
  });
  return { ctx, the };
}

const stub = (p: number): ActiveEstimate => ({ version: 5, score: () => ({ p, top: [] }) });

describe('an estimate never changes an analysed row (T7)', () => {
  it('gives the same result with and without an estimate whenever the plain source is not none', () => {
    let analysed = 0;
    fc.assert(
      fc.property(scenario, modifiers, unit, (s, m, p) => {
        const plainBuild = build(s, m, undefined);
        const plain = rankArticle(plainBuild.ctx, plainBuild.the, NOW);
        fc.pre(plain.scoreSource !== 'none');
        analysed += 1;
        const withEstimate = build(s, m, stub(p));
        expect(rankArticle(withEstimate.ctx, withEstimate.the, NOW)).toEqual(plain);
      }),
      PARAMS,
    );
    expect(analysed).toBeGreaterThan(0);
  });

  it('covers cards, model and degraded sources in the generated rows', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(scenario, modifiers, (s, m) => {
        const b = build(s, m, undefined);
        seen.add(rankArticle(b.ctx, b.the, NOW).scoreSource);
      }),
      PARAMS,
    );
    expect(seen.has('cards')).toBe(true);
    expect(seen.has('model')).toBe(true);
    expect(seen.has('none')).toBe(true);
  });

  it('gives the same result for a row that the plain run hides', () => {
    fc.assert(
      fc.property(scenario, modifiers, unit, (s, m, p) => {
        const plainBuild = build(s, m, undefined);
        const hiddenCtx = { ...plainBuild.ctx, rules: [BLOCK] };
        const plain = rankArticle(hiddenCtx, plainBuild.the, NOW);
        expect(plain.lane).toBe('hidden');
        expect(rankArticle({ ...hiddenCtx, estimate: stub(p) }, plainBuild.the, NOW)).toEqual(
          plain,
        );
      }),
      PARAMS,
    );
  });
});

type Exit = 'no_carrier' | 'stale' | 'no_cards';

const exitItem = (exit: Exit, over: Partial<RankItem>): RankItem =>
  item({
    title: 'Battery prices fall again',
    ...(exit === 'no_carrier' ? { inferenceEligible: false, inferenceFeedIds: [] } : {}),
    ...(exit === 'stale' ? { pipelineState: 'stale' as const } : {}),
    ...over,
  });

describe('estimated rows (T10)', () => {
  const exits = fc.constantFrom<Exit>('no_carrier', 'stale', 'no_cards');
  const configs = fc.constantFrom(...CONFIGS);

  it('are always in lane new with the tier of their P', () => {
    fc.assert(
      fc.property(exits, configs, unit, fc.boolean(), (exit, config, p, boost) => {
        const ctx = context({
          config,
          cards: exit === 'stale' ? [card('10', 'must')] : [],
          rules: boost ? [BOOST] : [],
          estimate: stub(p),
        });
        const result = rankArticle(ctx, exitItem(exit, {}), NOW);
        expect(result.scoreSource).toBe('estimate');
        expect(result.lane).toBe('new');
        expect(result.pLike).toBe(p);
        expect(result.tier).toBe(tierFromP(p, config));
        expect(result.explain.estimate?.version).toBe(5);
      }),
      PARAMS,
    );
  });

  it('with a P that grows with the item never get a lower tier', () => {
    const monotone: ActiveEstimate = {
      version: 5,
      score: (the) => ({ p: Math.min(1, (the.wordCount ?? 0) / 1000), top: [] }),
    };
    fc.assert(
      fc.property(
        exits,
        configs,
        fc.integer({ min: 0, max: 1200 }),
        fc.integer({ min: 0, max: 1200 }),
        (exit, config, a, b) => {
          const ctx = context({ config, estimate: monotone });
          const low = rankArticle(ctx, exitItem(exit, { wordCount: Math.min(a, b) }), NOW);
          const high = rankArticle(ctx, exitItem(exit, { wordCount: Math.max(a, b) }), NOW);
          expect(low.scoreSource).toBe('estimate');
          expect(high.scoreSource).toBe('estimate');
          expect(high.pLike as number).toBeGreaterThanOrEqual(low.pLike as number);
          expect(high.tier as number).toBeGreaterThanOrEqual(low.tier as number);
        },
      ),
      PARAMS,
    );
  });
});
