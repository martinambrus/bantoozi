import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANKER_CONFIG,
  mergeRankerConfig,
  suggestExample,
  type SuggestExampleInput,
  type SuggestionCard,
} from '../src/index.js';
import { cardsExplain } from './support.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const held = (cardId: string, extra: Partial<SuggestionCard> = {}): SuggestionCard => ({
  cardId,
  strength: 'love',
  isPrivateFork: false,
  examplesYes: [],
  examplesNo: [],
  ...extra,
});

/** A like on card 5 answered 0.5 (Maybe band) at revision 3, with every limit clear. */
function input(overrides: Partial<SuggestExampleInput> = {}): SuggestExampleInput {
  return {
    trigger: 'rating',
    rating: 1,
    reason: null,
    ratedContentRevision: '3',
    explain: cardsExplain({
      p: 0.5,
      cards: [{ id: '5', title: 'EV batteries', strength: 'love', p: 0.5, engine: 'typesafe' }],
    }),
    cards: [held('5')],
    exampleText: 'Solid-state pilot line hits 1,000 cycles',
    enabled: true,
    forkCount: 0,
    maxForks: 20,
    recent: [],
    now: NOW,
    config: DEFAULT_RANKER_CONFIG,
    ...overrides,
  };
}

const withP = (p: number, strength: 'love' | 'never' = 'love') =>
  cardsExplain({ p, cards: [{ id: '5', title: 'C', strength, p, engine: 'typesafe' }] });

describe('suggestExample (spec 06 §10)', () => {
  it.each`
    rating  | reason         | p       | expected
    ${1}    | ${null}        | ${0.35} | ${'yes'}
    ${1}    | ${null}        | ${0.5}  | ${'yes'}
    ${1}    | ${null}        | ${0.64} | ${'yes'}
    ${1}    | ${null}        | ${0.65} | ${null}
    ${1}    | ${null}        | ${0.9}  | ${null}
    ${1}    | ${null}        | ${0.34} | ${null}
    ${-1}   | ${'off_topic'} | ${0.35} | ${'no'}
    ${-1}   | ${'off_topic'} | ${0.95} | ${'no'}
    ${-1}   | ${'off_topic'} | ${0.34} | ${null}
    ${-1}   | ${'clickbait'} | ${0.9}  | ${null}
    ${-1}   | ${'seen'}      | ${0.9}  | ${null}
    ${-1}   | ${'shallow'}   | ${0.9}  | ${null}
    ${-1}   | ${'promo'}     | ${0.9}  | ${null}
    ${-1}   | ${'other'}     | ${0.9}  | ${null}
    ${-1}   | ${null}        | ${0.9}  | ${null}
    ${null} | ${null}        | ${0.5}  | ${null}
  `('rating $rating, reason $reason, p $p → $expected', ({ rating, reason, p, expected }) => {
    const result = suggestExample(input({ rating, reason, explain: withP(p as number) }));
    expect(result).toEqual(expected === null ? null : { cardId: '5', side: expected });
  });

  it('uses the configured lane thresholds, not literals', () => {
    const config = mergeRankerConfig({ lanes: { forYou: 0.8, maybe: 0.4 } });
    expect(suggestExample(input({ explain: withP(0.7), config }))).toEqual({
      cardId: '5',
      side: 'yes',
    });
    expect(suggestExample(input({ explain: withP(0.38), config }))).toBeNull();
  });

  it.each(['bulk_rating', 'prompt_answer', 'bookmark', 'implicit'] as const)(
    'never suggests for a %s',
    (trigger) => {
      expect(suggestExample(input({ trigger }))).toBeNull();
    },
  );

  it('needs an explanation of the rated revision from the cards or the model', () => {
    expect(suggestExample(input({ explain: null }))).toBeNull();
    expect(suggestExample(input({ ratedContentRevision: '4' }))).toBeNull();
    const base = withP(0.5);
    expect(suggestExample(input({ explain: { ...base, source: 'model' } }))).not.toBeNull();
    expect(suggestExample(input({ explain: { ...base, source: 'degraded' } }))).toBeNull();
    expect(suggestExample(input({ explain: { ...base, source: 'none' } }))).toBeNull();
  });

  it('never suggests a never-card, by its stored or its current strength', () => {
    expect(suggestExample(input({ explain: withP(0.5, 'never') }))).toBeNull();
    expect(suggestExample(input({ cards: [held('5', { strength: 'never' })] }))).toBeNull();
  });

  it('considers only typesafe answers of cards the user still holds', () => {
    const explain = cardsExplain({
      cards: [
        { id: '9', title: 'Gone', strength: 'love', p: 0.6, engine: 'typesafe' },
        { id: '7', title: 'LLM', strength: 'like', p: 0.55, engine: 'llm' },
        { id: '5', title: 'EV', strength: 'like', p: 0.4, engine: 'typesafe' },
      ],
    });
    expect(suggestExample(input({ explain, cards: [held('5'), held('7')] }))).toEqual({
      cardId: '5',
      side: 'yes',
    });
    expect(suggestExample(input({ explain, cards: [held('7')] }))).toBeNull();
  });

  it('takes the highest p, ties to the lowest numeric id', () => {
    const explain = cardsExplain({
      cards: [
        { id: '12', title: 'A', strength: 'love', p: 0.6, engine: 'typesafe' },
        { id: '9', title: 'B', strength: 'like', p: 0.6, engine: 'typesafe' },
        { id: '3', title: 'C', strength: 'must', p: 0.5, engine: 'typesafe' },
      ],
    });
    const cards = [held('12'), held('9'), held('3')];
    expect(suggestExample(input({ explain, cards }))).toEqual({ cardId: '9', side: 'yes' });
    // The best card decides alone: above the band it suggests nothing, even if another would fit.
    const high = cardsExplain({
      cards: [
        { id: '12', title: 'A', strength: 'love', p: 0.9, engine: 'typesafe' },
        { id: '9', title: 'B', strength: 'like', p: 0.5, engine: 'typesafe' },
      ],
    });
    expect(suggestExample(input({ explain: high, cards }))).toBeNull();
  });

  it('respects the preference and an unusable title', () => {
    expect(suggestExample(input({ enabled: false }))).toBeNull();
    expect(suggestExample(input({ exampleText: null }))).toBeNull();
  });

  it('skips a title that is already an example on that side (normalized)', () => {
    const cards = [held('5', { examplesYes: ['solid-state PILOT line hits 1 000 cycles'] })];
    expect(suggestExample(input({ cards }))).toBeNull();
    // The other side does not block it.
    const other = [held('5', { examplesNo: ['Solid-state pilot line hits 1,000 cycles'] })];
    expect(suggestExample(input({ cards: other }))).toEqual({ cardId: '5', side: 'yes' });
    const dislike = input({
      rating: -1,
      reason: 'off_topic',
      cards: other,
      explain: withP(0.7),
    });
    expect(suggestExample(dislike)).toBeNull();
  });

  it('needs a free fork slot unless the card is already a private fork', () => {
    expect(suggestExample(input({ forkCount: 20, maxForks: 20 }))).toBeNull();
    expect(suggestExample(input({ forkCount: 19, maxForks: 20 }))).not.toBeNull();
    const fork = [held('5', { isPrivateFork: true })];
    expect(suggestExample(input({ forkCount: 20, maxForks: 20, cards: fork }))).toEqual({
      cardId: '5',
      side: 'yes',
    });
  });

  it('does not suggest the same card again within 7 days', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(suggestExample(input({ recent: [{ cardId: '5', at: at(7 * DAY - 1) }] }))).toBeNull();
    expect(suggestExample(input({ recent: [{ cardId: '5', at: at(7 * DAY) }] }))).not.toBeNull();
    expect(suggestExample(input({ recent: [{ cardId: '6', at: at(HOUR) }] }))).not.toBeNull();
  });

  it('makes at most 3 suggestions in 24 hours', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    const three = ['6', '7', '8'].map((cardId, i) => ({ cardId, at: at((i + 1) * HOUR) }));
    expect(suggestExample(input({ recent: three }))).toBeNull();
    expect(suggestExample(input({ recent: three.slice(0, 2) }))).not.toBeNull();
    const old = three.map((s) => ({ ...s, at: at(DAY) }));
    expect(suggestExample(input({ recent: old }))).not.toBeNull();
  });
});
