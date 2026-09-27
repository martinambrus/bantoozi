import type { Explain, Strength } from '@bantoozi/shared';

import type { AnswerEngine, CardAnswers, RankCard } from '../src/index.js';

/** A held interest card with a readable default text. */
export function card(
  cardId: string,
  strength: Strength,
  extra: Partial<Omit<RankCard, 'cardId' | 'strength'>> = {},
): RankCard {
  return { cardId, title: `Card ${cardId}`, strength, interest: `interest ${cardId}`, ...extra };
}

/** Answers keyed by card id; a bare number is a `typesafe` answer. */
export function answers(
  entries: Record<string, number | { p: number; engine: AnswerEngine }>,
): CardAnswers {
  return Object.fromEntries(
    Object.entries(entries).map(([id, a]) => [
      id,
      typeof a === 'number' ? { p: a, engine: 'typesafe' } : a,
    ]),
  );
}

/** The card evidence of one item: its answers and its authorized carriers. */
export function evidence(
  cardAnswers: CardAnswers,
  inferenceFeedIds: readonly string[] = ['1'],
): { cardAnswers: CardAnswers; inferenceFeedIds: readonly string[] } {
  return { cardAnswers, inferenceFeedIds };
}

/** A valid version-1 explanation of a card-scored item. */
export function cardsExplain(overrides: Partial<Explain> = {}): Explain {
  return {
    v: 1,
    inputs: {
      contentRevision: '3',
      mediaRevision: '1',
      rankRevision: '12',
      contextSha: 'a'.repeat(64),
    },
    source: 'cards',
    p: 0.91,
    lane: 'for_you',
    tier: 5,
    decidingCardId: '5',
    cards: [{ id: '5', title: 'EV batteries', strength: 'love', p: 0.91, engine: 'typesafe' }],
    facets: {
      contentType: { choice: 'news', p: 0.8 },
      topic: { l1: 'science', p: 0.7, l2: 'science.energy' },
      depth: 0.6,
      clickbait: 0.1,
      promotional: 0.05,
      timeSensitive: 0.3,
      evergreen: 0.4,
    },
    rules: [{ code: 'must:5', cardId: '5' }],
    translation: { engine: 'libretranslate', quality: 'ok' },
    cluster: { id: '44', size: 3 },
    ...overrides,
  };
}

/** Mulberry32: a small seeded PRNG, so property-style tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
