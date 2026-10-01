import { STATE_LIMITS, type ArticleState } from '@bantoozi/questions';
import { describe, expect, it } from 'vitest';

import { e7Rater, planE7 } from '../src/experiments/e7.js';
import type { RunCard } from '../src/experiments/run-config.js';
import {
  buildState,
  E7_GENERIC_SENTENCE,
  e7TargetedSentence,
  steeredInput,
  type ModelInput,
} from '../src/experiments/states.js';

/**
 * M3a-T6 "E7 unit test shows the variants differ from the E1 state only in the excerpt, which stays
 * ≤ 600 characters" (spec 10 §3, spec 05 §3.1), and the deterministic E7 item plan.
 */

const codePoints = (text: string | null) => (text === null ? 0 : [...text].length);

function e1Input(excerpt: string | null): ModelInput {
  return {
    variant: 'native',
    input: {
      title: 'Battery makers cut prices for electric vehicles',
      author: 'Jana Nováková',
      categories: ['Business', 'Energy'],
      excerpt,
      bodyLead: 'Lead paragraph about the battery market. '.repeat(40),
      wordCount: 820,
      lang: 'en',
      feed: { title: 'Energy News', site: 'energy.example' },
    },
  };
}

function withoutExcerpt(state: ArticleState) {
  const { excerpt: _excerpt, ...rest } = state.article;
  return rest;
}

const sentences = [
  ['targeted', e7TargetedSentence('electric vehicle batteries')],
  ['generic', E7_GENERIC_SENTENCE],
] as const;

describe('E7 steered states', () => {
  for (const call of ['match', 'enrich'] as const) {
    for (const [name, sentence] of sentences) {
      it(`${name} (${call}): only the excerpt differs from the E1 state and stays ≤ 600 characters`, () => {
        const longExcerpt = `${'Prices fell again this quarter as supply grew. '.repeat(30)}END`;
        for (const excerpt of ['Short excerpt about cell chemistry.', longExcerpt, null, '   ']) {
          const base = buildState(e1Input(excerpt), call);
          const steered = buildState(steeredInput(e1Input(excerpt), sentence), call);
          expect(withoutExcerpt(steered.state)).toEqual(withoutExcerpt(base.state));
          expect(steered.variant).toBe(base.variant);
          const text = steered.state.article.excerpt;
          expect(text).not.toBeNull();
          expect(text?.startsWith(sentence)).toBe(true);
          expect(codePoints(text)).toBeLessThanOrEqual(STATE_LIMITS.excerpt);
          expect(codePoints(text)).toBeLessThanOrEqual(600);
          if (excerpt === null || excerpt.trim() === '') expect(text).toBe(sentence);
          expect(steered.sha256).not.toBe(base.sha256);
        }
      });
    }
  }

  it('cuts the long steered excerpt at the production limit (the original end is lost)', () => {
    const longExcerpt = `${'x'.repeat(590)} TAIL`;
    const steered = buildState(steeredInput(e1Input(longExcerpt), E7_GENERIC_SENTENCE), 'match');
    expect(steered.state.article.excerpt?.includes('TAIL')).toBe(false);
  });

  it('the targeted sentence names the interest', () => {
    expect(e7TargetedSentence('football transfers')).toBe(
      'This article is about football transfers.',
    );
  });
});

function card(raterId: string, cardId: string, strength: RunCard['strength']): RunCard {
  return {
    raterId,
    cardId,
    strength,
    kind: 'interest',
    title: `Card ${cardId}`,
    interest: `interest ${cardId}`,
    notFor: null,
    interestEn: null,
    notForEn: null,
    lang: 'en',
    examplesYes: [],
    examplesNo: [],
    visibility: 'shared',
    ownerUserId: null,
    textStatus: null,
  };
}

describe('planE7', () => {
  const cardsByRater = new Map([
    ['1', [card('1', '10', 'like'), card('1', '11', 'love'), card('1', '12', 'never')]],
    ['2', [card('2', '20', 'like')]],
  ]);

  it("keeps an article whose shared answers failed when the chosen rater's own copy answered", () => {
    const own = new Map([['10', 0.4]]);
    const plan = (answersOf?: (raterId: string, articleId: string) => Map<string, number>) =>
      planE7({
        seed: 's',
        candidates: [{ articleId: '100', lang: 'en', raterIds: ['1'] }],
        cardsByRater,
        // No shared `card` answer for article 100 (every shared request failed).
        answers: new Map(),
        ...(answersOf === undefined ? {} : { answersOf }),
      });
    expect(plan()).toEqual([]);
    expect(plan(() => own).map((item) => [item.articleId, item.targetedCardId])).toEqual([
      ['100', '10'],
    ]);
  });

  it("targets with the chosen rater's own answers when they differ from the shared ones", () => {
    const answers = new Map([
      [
        '100',
        new Map([
          ['10', 0.2],
          ['11', 0.6],
        ]),
      ],
    ]);
    const items = planE7({
      seed: 's',
      candidates: [{ articleId: '100', lang: 'en', raterIds: ['1'] }],
      cardsByRater,
      answers,
      // Rater 1's own copy of card 10 answered 0.9: card 11 is now the lowest.
      answersOf: () =>
        new Map([
          ['10', 0.9],
          ['11', 0.6],
        ]),
    });
    expect(items.map((item) => item.targetedCardId)).toEqual(['11']);
  });

  it('targets the answered positive card with the lowest p and skips items without one', () => {
    const answers = new Map([
      [
        '100',
        new Map([
          ['10', 0.8],
          ['11', 0.2],
          ['12', 0.01],
          ['20', 0.5],
        ]),
      ],
      ['101', new Map([['12', 0.3]])],
    ]);
    const items = planE7({
      seed: 's',
      candidates: [
        { articleId: '100', lang: 'en', raterIds: ['1'] },
        { articleId: '101', lang: 'en', raterIds: ['1'] },
        { articleId: '102', lang: 'en', raterIds: ['1'] },
      ],
      cardsByRater,
      answers,
    });
    // 101 has only a never-card answer; 102 has no E1 answer at all.
    expect(items).toEqual([
      {
        articleId: '100',
        lang: 'en',
        raterId: '1',
        targetedCardId: '11',
        targetedInterest: 'interest 11',
      },
    ]);
  });

  it('caps each language, is deterministic and picks the rater by the article id', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      articleId: String(200 + i),
      lang: i % 2 === 0 ? 'en' : 'sk',
      raterIds: ['2', '1'],
    }));
    const answers = new Map(
      candidates.map((c) => [
        c.articleId,
        new Map([
          ['10', 0.4],
          ['11', 0.6],
          ['20', 0.7],
        ]),
      ]),
    );
    const a = planE7({ seed: 'seed-1', candidates, cardsByRater, answers, perLang: 5 });
    const b = planE7({ seed: 'seed-1', candidates, cardsByRater, answers, perLang: 5 });
    expect(a).toEqual(b);
    expect(a.filter((i) => i.lang === 'en')).toHaveLength(5);
    expect(a.filter((i) => i.lang === 'sk')).toHaveLength(5);
    for (const item of a) {
      expect(item.raterId).toBe(e7Rater(item.articleId, ['1', '2']));
      expect(item.targetedCardId).toBe(item.raterId === '1' ? '10' : '20');
    }
    const other = planE7({ seed: 'seed-2', candidates, cardsByRater, answers, perLang: 5 });
    expect(other.map((i) => i.articleId)).not.toEqual(a.map((i) => i.articleId));
    expect(e7Rater('1', [])).toBeNull();
  });
});
