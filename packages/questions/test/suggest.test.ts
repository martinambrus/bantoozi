import { describe, expect, it } from 'vitest';

import {
  SUGGEST_QUESTION_KEY,
  likesForBranch,
  planSuggestion,
  suggestBranch,
  suggestOptions,
  suggestQuestion,
  suggestResults,
  unexplainedLikes,
  type SuggestLibraryCard,
  type SuggestLike,
} from '../src/index.js';

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

function like(id: string, overrides: Partial<SuggestLike> = {}): SuggestLike {
  return {
    articleId: id,
    likedAt: day(Number(id)),
    title: `Liked article ${id}`,
    excerpt: `Excerpt ${id}`,
    t1: { technology: 0.7, science: 0.2 },
    cardP: [0.1, 0.05],
    ...overrides,
  };
}

const CARDS: SuggestLibraryCard[] = [
  {
    id: '12',
    interest: 'Rust programming',
    notFor: 'Rust the game',
    topicIds: ['technology.software_dev'],
  },
  { id: '3', interest: 'Space launches', notFor: null, topicIds: ['science.space'] },
  {
    id: '7',
    interest: 'Home automation',
    notFor: null,
    topicIds: ['diy.electronics_diy', 'technology.hardware_gadgets'],
  },
  { id: '100', interest: 'AI research', notFor: null, topicIds: ['technology.ai_ml'] },
  { id: '5', interest: 'Tech policy', notFor: null, topicIds: ['technology'] },
];

describe('suggestion candidate selection (spec 05 §7)', () => {
  it('step 1: keeps only likes every applicable positive card leaves unexplained', () => {
    const likes = [
      like('1'),
      like('2', { cardP: [0.1, 0.3] }),
      like('3', { cardP: [0.1, null] }),
      like('4', { cardP: [] }),
      like('5', { t1: null }),
      like('6', { cardP: [0.29] }),
      like('7', { cardP: [Number.NaN] }),
    ];
    expect(unexplainedLikes(likes).map((l) => l.articleId)).toEqual(['1', '4', '6']);
  });

  it('step 2: picks the level-1 topic with the highest summed t1, excluding other, ties by id', () => {
    expect(
      suggestBranch([
        like('1', { t1: { technology: 0.4, science: 0.5, other: 0.9 } }),
        like('2', { t1: { technology: 0.4, science: 0.2 } }),
      ]),
    ).toBe('technology');
    expect(suggestBranch([like('1', { t1: { science: 0.5, business: 0.5 } })])).toBe('business');
    expect(suggestBranch([like('1', { t1: { other: 1 } })])).toBeNull();
    expect(suggestBranch([])).toBeNull();
  });

  it('step 2: chooses up to five likes relevant to the branch, most recent first', () => {
    const likes = [
      ...Array.from({ length: 7 }, (_, i) => like(String(i + 1))),
      like('20', { t1: { science: 0.9, technology: 0.1 } }),
    ];
    expect(likesForBranch(likes, 'technology').map((l) => l.articleId)).toEqual([
      '7',
      '6',
      '5',
      '4',
      '3',
    ]);
    expect(likesForBranch(likes, 'science').map((l) => l.articleId)).toEqual([
      '20',
      '7',
      '6',
      '5',
      '4',
    ]);
    const sameTime = [like('8', { likedAt: day(1) }), like('9', { likedAt: day(1) })];
    expect(likesForBranch(sameTime, 'technology').map((l) => l.articleId)).toEqual(['9', '8']);
  });

  it('step 3: offers branch cards the user neither holds nor recently dismissed, at most 60', () => {
    expect(suggestOptions(CARDS, 'technology', new Set(['7'])).map((c) => c.id)).toEqual([
      '5',
      '12',
      '100',
    ]);
    const many = Array.from({ length: 70 }, (_, i) => ({
      id: String(i + 1),
      interest: `Interest ${i}`,
      notFor: null,
      topicIds: ['sports.football'],
    }));
    const options = suggestOptions(many, 'sports', new Set());
    expect(options).toHaveLength(60);
    expect(options.at(-1)?.id).toBe('60');
  });

  it('step 5: asks one Choice over the cards plus none', () => {
    expect(suggestQuestion(CARDS.slice(0, 2))).toEqual({
      type: 'choice',
      instructions: {
        question: 'Which interest best describes what `liked_articles` have in common?',
      },
      criteria: {
        c12: { what: 'Rust programming', not_for: 'Rust the game' },
        c3: { what: 'Space launches' },
        none: 'None of these describe what the articles have in common',
      },
    });
  });

  it('plans a call only with enough unexplained likes and at least one candidate', () => {
    const likes = [like('1'), like('2'), like('3'), like('4', { cardP: [0.9] })];
    const input = {
      positiveCardCount: 2,
      likes,
      libraryCards: CARDS,
      excludedCardIds: new Set<string>(),
    };
    expect(planSuggestion({ ...input, positiveCardCount: 0 })).toEqual({
      ask: false,
      reason: 'no_positive_cards',
    });
    expect(planSuggestion({ ...input, likes: likes.slice(2) })).toEqual({
      ask: false,
      reason: 'too_few_unexplained_likes',
    });
    expect(
      planSuggestion({ ...input, likes: likes.map((l) => ({ ...l, t1: { other: 1 } })) }),
    ).toEqual({ ask: false, reason: 'no_branch' });
    expect(planSuggestion({ ...input, libraryCards: [CARDS[1]!] })).toEqual({
      ask: false,
      reason: 'no_candidates',
    });

    const plan = planSuggestion(input);
    expect(plan).toMatchObject({
      ask: true,
      l1: 'technology',
      articleIds: ['3', '2', '1'],
      cardIds: ['5', '7', '12', '100'],
      state: {
        liked_articles: [
          { title: 'Liked article 3', excerpt: 'Excerpt 3' },
          { title: 'Liked article 2', excerpt: 'Excerpt 2' },
          { title: 'Liked article 1', excerpt: 'Excerpt 1' },
        ],
      },
    });
    if (!plan.ask) throw new Error('expected a plan');
    expect(Object.keys(plan.questions)).toEqual([SUGGEST_QUESTION_KEY]);
    expect(Object.keys(plan.questions[SUGGEST_QUESTION_KEY]!.criteria)).toEqual([
      'c5',
      'c7',
      'c12',
      'c100',
      'none',
    ]);
  });

  it('step 6: stores up to three cards with p ≥ 0.15, nothing when none wins', () => {
    const answer = (choice: string, probabilities: Record<string, number>) => ({
      type: 'choice' as const,
      choice,
      probabilities,
      confidence: 0.4,
    });
    expect(suggestResults(answer('none', { none: 0.5, c1: 0.3, c2: 0.2 }))).toEqual([]);
    expect(
      suggestResults(
        answer('c9', { c9: 0.3, c10: 0.2, c2: 0.2, c4: 0.16, c5: 0.149, none: 0.1, x: 0.9 }),
      ),
    ).toEqual([
      { cardId: '9', score: 0.3 },
      { cardId: '2', score: 0.2 },
      { cardId: '10', score: 0.2 },
    ]);
    expect(suggestResults(answer('c1', { c1: 0.14, none: 0.86 }))).toEqual([]);
  });
});
