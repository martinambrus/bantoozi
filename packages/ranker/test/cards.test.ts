import { describe, expect, it } from 'vitest';

import {
  type CardAnswer,
  cardScore,
  DEFAULT_RANKER_CONFIG,
  evaluateNeverCards,
  isCardApplicable,
  mustFloorCard,
  type RankCard,
  usableAnswer,
} from '../src/index.js';
import { answers, card, evidence, seededRandom } from './support.js';

const config = DEFAULT_RANKER_CONFIG;

describe('cardScore (spec 06 §4.1)', () => {
  it('weights must and love by 1.0 and like by 0.8, and takes the maximum', () => {
    const cards = [card('1', 'must'), card('2', 'love'), card('3', 'like')];
    expect(cardScore(cards, evidence(answers({ '1': 0.5, '2': 0.7, '3': 1 })), config)).toEqual({
      score: 0.8,
      decidingCardId: '3',
      decidingAnswer: { p: 1, engine: 'typesafe' },
    });
    expect(cardScore(cards, evidence(answers({ '1': 0.9, '3': 1 })), config)?.decidingCardId).toBe(
      '1',
    );
    expect(cardScore([card('3', 'like')], evidence(answers({ '3': 0.5 })), config)?.score).toBe(
      0.4,
    );
  });

  it('uses the configured strength weights', () => {
    const weights = { strengthWeights: { must: 1, love: 0.9, like: 0.5 } };
    const cards = [card('2', 'love'), card('3', 'like')];
    const result = cardScore(cards, evidence(answers({ '2': 0.5, '3': 1 })), weights);
    expect(result).toMatchObject({ score: 0.5, decidingCardId: '3' });
    expect(cardScore(cards, evidence(answers({ '2': 0.6, '3': 1 })), weights)?.decidingCardId).toBe(
      '2',
    );
  });

  it('ignores a missing answer instead of treating it as zero', () => {
    const cards = [card('1', 'love'), card('2', 'love')];
    expect(cardScore(cards, evidence(answers({ '2': 0.3 })), config)).toMatchObject({
      score: 0.3,
      decidingCardId: '2',
    });
  });

  it('ignores prefilter markers, invalid probabilities, unknown engines and malformed answers', () => {
    const cards = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((id) => card(id, 'love'));
    const unusable = evidence({
      '1': { p: 0, engine: 'prefilter' },
      '2': { p: 0.95, engine: 'prefilter' },
      '3': { p: Number.NaN, engine: 'typesafe' },
      '4': { p: 1.5, engine: 'typesafe' },
      '5': { p: -0.1, engine: 'llm' },
      '6': { p: 0.9, engine: 'gpt' as 'llm' },
      // Malformed rows that slipped past validation are unknown too.
      '7': null as unknown as CardAnswer,
      '8': 0.9 as unknown as CardAnswer,
      '9': { p: '0.9', engine: 'typesafe' } as unknown as CardAnswer,
    });
    expect(cardScore(cards, unusable, config)).toBeNull();
    expect(usableAnswer(unusable.cardAnswers, '2')).toBeUndefined();
    expect(usableAnswer(unusable.cardAnswers, 'constructor')).toBeUndefined();
    expect(usableAnswer(answers({ '1': { p: 0.4, engine: 'laya' } }), '1')).toEqual({
      p: 0.4,
      engine: 'laya',
    });
  });

  it('does not count never-cards', () => {
    const cards = [card('1', 'never'), card('2', 'like')];
    expect(cardScore(cards, evidence(answers({ '1': 0.99, '2': 0.25 })), config)).toMatchObject({
      score: 0.2,
      decidingCardId: '2',
    });
    expect(cardScore([card('1', 'never')], evidence(answers({ '1': 0.99 })), config)).toBeNull();
  });

  it('applies a scoped card only when its feed is one of the authorized carriers', () => {
    const scoped = [card('1', 'love', { scopeFeedId: '7' }), card('2', 'like')];
    const cardAnswers = answers({ '1': 0.9, '2': 0.5 });
    expect(cardScore(scoped, evidence(cardAnswers, ['3']), config)?.decidingCardId).toBe('2');
    expect(cardScore(scoped, evidence(cardAnswers, ['3', '7']), config)?.decidingCardId).toBe('1');
    expect(cardScore(scoped, evidence(cardAnswers, []), config)?.decidingCardId).toBe('2');
    expect(isCardApplicable({ scopeFeedId: undefined }, [])).toBe(true);
  });

  it('breaks ties by the lowest numeric card id, not by text order', () => {
    const tied = [card('10', 'love'), card('9', 'love')];
    expect(
      cardScore(tied, evidence(answers({ '10': 0.8, '9': 0.8 })), config)?.decidingCardId,
    ).toBe('9');
    // love 0.8 × 1.0 and like 1.0 × 0.8 tie at 0.8.
    const mixed = [card('12', 'love'), card('5', 'like')];
    expect(cardScore(mixed, evidence(answers({ '12': 0.8, '5': 1 })), config)?.decidingCardId).toBe(
      '5',
    );
  });

  it('returns null while no positive card has a usable answer', () => {
    expect(cardScore([card('1', 'love')], evidence({}), config)).toBeNull();
    expect(cardScore([], evidence(answers({ '1': 0.9 })), config)).toBeNull();
  });

  it('reports the deciding answer’s engine', () => {
    const result = cardScore(
      [card('1', 'love'), card('2', 'love')],
      evidence(answers({ '1': { p: 0.9, engine: 'llm' }, '2': 0.4 })),
      config,
    );
    expect(result?.decidingAnswer).toEqual({ p: 0.9, engine: 'llm' });
  });

  it('never lowers the score when one positive card’s p rises (seeded property)', () => {
    const random = seededRandom(20260926);
    const strengths = ['must', 'love', 'like', 'never'] as const;
    for (let run = 0; run < 500; run += 1) {
      const cards: RankCard[] = [];
      const entries: Record<string, number> = {};
      const count = 1 + Math.floor(random() * 6);
      for (let i = 1; i <= count; i += 1) {
        const id = String(i * 3);
        cards.push(
          card(id, strengths[Math.floor(random() * 4)] ?? 'like', {
            ...(random() < 0.2 ? { scopeFeedId: random() < 0.5 ? '1' : '2' } : {}),
          }),
        );
        if (random() < 0.8) entries[id] = Math.round(random() * 100) / 100;
      }
      const target = cards[Math.floor(random() * cards.length)];
      if (target === undefined || entries[target.cardId] === undefined) continue;
      const before = cardScore(cards, evidence(answers(entries)), config)?.score ?? 0;
      const raised = {
        ...entries,
        [target.cardId]: Math.min(1, (entries[target.cardId] ?? 0) + random()),
      };
      const after = cardScore(cards, evidence(answers(raised)), config)?.score ?? 0;
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });
});

describe('evaluateNeverCards (spec 06 §4.2)', () => {
  it.each([
    [0.7, 'hide'],
    [0.95, 'hide'],
    [0.6999, 'soft_cap'],
    [0.5, 'soft_cap'],
    [0.4999, 'none'],
    [0, 'none'],
  ] as const)('a never-card answer p = %s has the effect %s', (p, effect) => {
    expect(evaluateNeverCards([card('4', 'never')], evidence(answers({ '4': p })), config)).toEqual(
      effect === 'none'
        ? { effect }
        : { effect, cardId: '4', p, code: effect === 'hide' ? 'never:4' : 'never_soft:4' },
    );
  });

  it('names the strongest never-card, ties to the lowest numeric id', () => {
    const cards = [card('20', 'never'), card('3', 'never')];
    expect(
      evaluateNeverCards(cards, evidence(answers({ '20': 0.8, '3': 0.75 })), config),
    ).toMatchObject({ effect: 'hide', cardId: '20', code: 'never:20' });
    expect(
      evaluateNeverCards(cards, evidence(answers({ '20': 0.8, '3': 0.8 })), config),
    ).toMatchObject({ effect: 'hide', cardId: '3' });
    expect(
      evaluateNeverCards(cards, evidence(answers({ '20': 0.6, '3': 0.2 })), config),
    ).toMatchObject({ effect: 'soft_cap', cardId: '20', code: 'never_soft:20' });
  });

  it('never hides on a missing answer or a prefilter marker', () => {
    const cards = [card('4', 'never'), card('5', 'never')];
    const unknown = evidence({ '4': { p: 0.99, engine: 'prefilter' } });
    expect(evaluateNeverCards(cards, unknown, config)).toEqual({ effect: 'none' });
  });

  it('applies scope to never-cards', () => {
    const cards = [card('4', 'never', { scopeFeedId: '9' })];
    const cardAnswers = answers({ '4': 0.99 });
    expect(evaluateNeverCards(cards, evidence(cardAnswers, ['1']), config)).toEqual({
      effect: 'none',
    });
    expect(evaluateNeverCards(cards, evidence(cardAnswers, ['1', '9']), config).effect).toBe(
      'hide',
    );
  });

  it('uses the configured thresholds and ignores positive cards', () => {
    const strict = { never: { hide: 0.9, soft: 0.8 } };
    const cards = [card('4', 'never'), card('5', 'must')];
    expect(evaluateNeverCards(cards, evidence(answers({ '4': 0.85, '5': 1 })), strict).effect).toBe(
      'soft_cap',
    );
    expect(evaluateNeverCards(cards, evidence(answers({ '4': 0.79, '5': 1 })), strict).effect).toBe(
      'none',
    );
  });
});

describe('mustFloorCard (spec 06 §2 step 6iii)', () => {
  it('fires for an applicable must card with p ≥ mustFloor', () => {
    const cards = [card('6', 'must')];
    expect(mustFloorCard(cards, evidence(answers({ '6': 0.5 })), config)).toEqual({
      cardId: '6',
      p: 0.5,
      engine: 'typesafe',
      code: 'must:6',
    });
    expect(mustFloorCard(cards, evidence(answers({ '6': 0.4999 })), config)).toBeNull();
    expect(mustFloorCard(cards, evidence(answers({ '6': 0.4 })), { mustFloor: 0.3 })?.cardId).toBe(
      '6',
    );
  });

  it('ignores other strengths, prefilter markers and out-of-scope must cards', () => {
    const cards = [card('1', 'love'), card('2', 'must'), card('3', 'must', { scopeFeedId: '9' })];
    const cardAnswers = answers({ '1': 1, '2': { p: 0.9, engine: 'prefilter' }, '3': 0.9 });
    expect(mustFloorCard(cards, evidence(cardAnswers, ['1']), config)).toBeNull();
    expect(mustFloorCard(cards, evidence(cardAnswers, ['9']), config)?.cardId).toBe('3');
  });

  it('names the must card with the highest p, ties to the lowest numeric id', () => {
    const cards = [card('30', 'must'), card('4', 'must')];
    expect(mustFloorCard(cards, evidence(answers({ '30': 0.9, '4': 0.6 })), config)?.cardId).toBe(
      '30',
    );
    expect(mustFloorCard(cards, evidence(answers({ '30': 0.9, '4': 0.9 })), config)?.cardId).toBe(
      '4',
    );
  });
});
