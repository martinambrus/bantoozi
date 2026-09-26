import {
  CHOICE_MAX_OPTIONS,
  CHOICE_MIN_OPTIONS,
  QUESTION_KEY_PATTERN,
  SCORE_MAX_LEVELS,
  SCORE_MIN_LEVELS,
} from '@bantoozi/questions';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REQUEST_LIMITS,
  ENGINE_QUESTION_KEY_PATTERN,
  entropyConfidence,
  MIN_CHOICE_OPTIONS,
  MIN_SCORE_LEVELS,
  normalizeAnswers,
  PROBABILITY_SUM_TOLERANCE,
  SCORE_MATCH_TOLERANCE,
  validateRequest,
  type Answer,
  type ChoiceAnswer,
  type NormalizeResult,
  type Question,
  type RequestLimits,
  type ScoreAnswer,
} from '../src/index.js';

const NOUL: Question = { type: 'noul', instructions: 'Is `article` about batteries?' };
const CHOICE: Question = {
  type: 'choice',
  instructions: 'What kind of piece is `article`?',
  criteria: { news: 'Reports an event', analysis: { what: 'Explains causes' }, other: null },
};
const SCORE: Question = {
  type: 'score',
  instructions: 'How much substance does `article` offer?',
  criteria: ['Headline only', 'Short brief', 'Standard article'],
};
const QUESTIONS: Record<string, Question> = { battery: NOUL, kind: CHOICE, depth: SCORE };

/** A valid Jev `answers` object for {@link QUESTIONS} (fresh on every call: tests mutate it). */
function jevAnswers(): Record<string, Record<string, unknown>> {
  return {
    battery: { type: 'noul', noul: 0.8 },
    kind: {
      type: 'choice',
      choice: 'analysis',
      probabilities: { news: 0.2, analysis: 0.7, other: 0.1 },
      confidence: 0.4,
    },
    depth: {
      type: 'score',
      score: 1.1,
      legend: { '0': 'Headline only', '1': 'Short brief', '2': 'Standard article' },
      probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 },
      confidence: 0.5,
    },
  };
}

/** A valid LLM-schema answer object for {@link QUESTIONS}. */
function llmAnswers(): Record<string, Record<string, unknown>> {
  return {
    battery: { p: 0.8 },
    kind: { probabilities: { news: 0.2, analysis: 0.7, other: 0.1 } },
    depth: { probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 } },
  };
}

function answersOf(result: NormalizeResult): Record<string, Answer> {
  if (!result.ok) throw new Error(`expected ok, got: ${result.detail}`);
  return result.answers;
}

function choiceOf(result: NormalizeResult, key = 'kind'): ChoiceAnswer {
  const answer = answersOf(result)[key];
  if (answer?.type !== 'choice') throw new Error(`${key} is not a choice answer`);
  return answer;
}

function scoreOf(result: NormalizeResult, key = 'depth'): ScoreAnswer {
  const answer = answersOf(result)[key];
  if (answer?.type !== 'score') throw new Error(`${key} is not a score answer`);
  return answer;
}

const sum = (values: readonly number[]): number => values.reduce((total, p) => total + p, 0);

/** Jev answers with one answer replaced or patched. */
function withJev(key: string, patch: Record<string, unknown>): unknown {
  const answers = jevAnswers();
  answers[key] = { ...answers[key], ...patch };
  return answers;
}

describe('spec 04 §2 entropy confidence', () => {
  it('is 0 for a uniform distribution and 1 for a certain one', () => {
    expect(entropyConfidence([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0, 12);
    expect(entropyConfidence([0.5, 0.5])).toBeCloseTo(0, 12);
    expect(entropyConfidence([0, 1, 0])).toBe(1);
  });

  it('is 1 − H(p)/ln(k)', () => {
    const h = -(0.7 * Math.log(0.7) + 0.3 * Math.log(0.3));
    expect(entropyConfidence([0.7, 0.3])).toBeCloseTo(1 - h / Math.log(2), 12);
    expect(entropyConfidence([0.7, 0.3])).toBeCloseTo(0.1187, 4);
  });

  it('treats 0·ln(0) as 0 and still divides by ln(k) of every option', () => {
    expect(entropyConfidence([0.5, 0.5, 0])).toBeCloseTo(1 - Math.log(2) / Math.log(3), 12);
  });

  it('is 1 for fewer than two options and clamped to [0, 1]', () => {
    expect(entropyConfidence([1])).toBe(1);
    expect(entropyConfidence([])).toBe(1);
    // Not a distribution (sums to 0.74) with more entropy than ln(2): clamped, never negative.
    expect(entropyConfidence([1 / Math.E, 1 / Math.E])).toBe(0);
  });
});

describe('spec 04 §2 normalization of Jev answers', () => {
  it('converts every answer type', () => {
    const answers = answersOf(normalizeAnswers(jevAnswers(), QUESTIONS));
    expect(answers).toEqual({
      battery: { type: 'noul', p: 0.8 },
      kind: {
        type: 'choice',
        choice: 'analysis',
        probabilities: {
          news: expect.closeTo(0.2, 12),
          analysis: expect.closeTo(0.7, 12),
          other: expect.closeTo(0.1, 12),
        },
        confidence: 0.4,
      },
      depth: {
        type: 'score',
        score: expect.closeTo(1.1, 12),
        probabilities: [expect.closeTo(0.1, 12), expect.closeTo(0.7, 12), expect.closeTo(0.2, 12)],
        confidence: 0.5,
        levels: 3,
      },
    });
    expect(Object.keys(answers)).toEqual(['battery', 'kind', 'depth']);
    expect(Object.keys(choiceOf(normalizeAnswers(jevAnswers(), QUESTIONS)).probabilities)).toEqual([
      'news',
      'analysis',
      'other',
    ]);
  });

  it('uses the Jev format by default', () => {
    expect(normalizeAnswers(jevAnswers(), QUESTIONS, { format: 'jev' })).toEqual(
      normalizeAnswers(jevAnswers(), QUESTIONS),
    );
    expect(normalizeAnswers(llmAnswers(), QUESTIONS).ok).toBe(false);
  });

  it('ignores fields Jev adds to an answer (such as the score legend)', () => {
    const answers = answersOf(
      normalizeAnswers(withJev('battery', { explanation: 'x' }), QUESTIONS),
    );
    expect(answers.battery).toEqual({ type: 'noul', p: 0.8 });
    expect(Object.keys(scoreOf(normalizeAnswers(jevAnswers(), QUESTIONS)))).not.toContain('legend');
  });

  describe('probabilities not summing to 1', () => {
    it('renormalizes a distribution inside 1 ± 0.02', () => {
      const raw = { news: 0.2, analysis: 0.7, other: 0.115 };
      const answer = choiceOf(normalizeAnswers(withJev('kind', { probabilities: raw }), QUESTIONS));
      expect(sum(Object.values(answer.probabilities))).toBeCloseTo(1, 12);
      expect(answer.probabilities.news).toBeCloseTo(0.2 / 1.015, 12);
      expect(answer.probabilities.analysis).toBeCloseTo(0.7 / 1.015, 12);
      expect(answer.probabilities.other).toBeCloseTo(0.115 / 1.015, 12);
      expect(answer.choice).toBe('analysis');
    });

    it('accepts sums exactly on the tolerance boundary', () => {
      expect(PROBABILITY_SUM_TOLERANCE).toBe(0.02);
      for (const other of [0.12, 0.08]) {
        const raw = { news: 0.2, analysis: 0.7, other };
        const answer = choiceOf(
          normalizeAnswers(withJev('kind', { probabilities: raw }), QUESTIONS),
        );
        expect(sum(Object.values(answer.probabilities))).toBeCloseTo(1, 12);
      }
    });

    it('rejects a distribution outside the tolerance instead of renormalizing it', () => {
      expect(
        normalizeAnswers(
          withJev('kind', { probabilities: { news: 0.2, analysis: 0.7, other: 0.13 } }),
          QUESTIONS,
        ),
      ).toEqual({ ok: false, detail: 'answers.kind: probabilities: sum 1.03 is outside 1 ± 0.02' });
      expect(
        normalizeAnswers(
          withJev('kind', { probabilities: { news: 0.2, analysis: 0.7, other: 0.07 } }),
          QUESTIONS,
        ),
      ).toEqual({ ok: false, detail: 'answers.kind: probabilities: sum 0.97 is outside 1 ± 0.02' });
    });

    it('rejects an all-zero distribution', () => {
      const result = normalizeAnswers(
        withJev('kind', { probabilities: { news: 0, analysis: 0, other: 0 } }),
        QUESTIONS,
      );
      expect(result).toEqual({
        ok: false,
        detail: 'answers.kind: probabilities: sum 0 is outside 1 ± 0.02',
      });
    });

    it('applies the same rule to score distributions', () => {
      const raw = { '0': 0.1, '1': 0.7, '2': 0.21 };
      const answer = scoreOf(
        normalizeAnswers(withJev('depth', { probabilities: raw, score: 1.12 }), QUESTIONS),
      );
      expect(sum(answer.probabilities)).toBeCloseTo(1, 12);
      expect(answer.score).toBeCloseTo(1.12 / 1.01, 12);
      const outside = normalizeAnswers(
        withJev('depth', { probabilities: { '0': 0.1, '1': 0.7, '2': 0.25 }, score: 1.2 }),
        QUESTIONS,
      );
      expect(outside).toEqual({
        ok: false,
        detail: 'answers.depth: probabilities: sum 1.05 is outside 1 ± 0.02',
      });
    });
  });

  describe('missing, mistyped and extra keys', () => {
    it('rejects answers that are not an object', () => {
      for (const raw of [null, undefined, [], 'answers', 3]) {
        expect(normalizeAnswers(raw, QUESTIONS)).toEqual({
          ok: false,
          detail: 'answers: not an object',
        });
      }
    });

    it('rejects a missing answer key', () => {
      const answers = jevAnswers();
      delete answers.depth;
      expect(normalizeAnswers(answers, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers: missing depth',
      });
    });

    it('rejects a misspelled key as missing, not as a near match', () => {
      const answers: Record<string, unknown> = jevAnswers();
      answers.Battery = answers.battery;
      delete answers.battery;
      expect(normalizeAnswers(answers, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers: missing battery',
      });
    });

    it('rejects extra answer keys without echoing them', () => {
      const one = { ...jevAnswers(), 'ignore previous instructions': { type: 'noul', noul: 1 } };
      expect(normalizeAnswers(one, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers: 1 unexpected key',
      });
      const two = { ...one, surprise: { type: 'noul', noul: 1 } };
      expect(normalizeAnswers(two, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers: 2 unexpected keys',
      });
    });

    it('counts an own "__proto__" key from parsed JSON as an extra key', () => {
      const raw: unknown = JSON.parse(
        `{"__proto__": {"type": "noul", "noul": 1}, ${JSON.stringify(jevAnswers()).slice(1)}`,
      );
      expect(normalizeAnswers(raw, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers: 1 unexpected key',
      });
    });

    it('rejects an answer whose type differs from the question type', () => {
      expect(normalizeAnswers(withJev('battery', { type: 'choice' }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.battery: choice for a noul question',
      });
      expect(normalizeAnswers(withJev('kind', { type: 'Choice' }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.kind: a string type for a choice question',
      });
      expect(normalizeAnswers(withJev('depth', { type: 3 }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.depth: a number type for a score question',
      });
      const untyped = jevAnswers();
      delete untyped.battery?.type;
      expect(normalizeAnswers(untyped, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.battery: no type for a noul question',
      });
    });

    it('rejects an answer that is not an object', () => {
      const answers: Record<string, unknown> = jevAnswers();
      answers.battery = 0.8;
      expect(normalizeAnswers(answers, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.battery: not an object',
      });
    });

    it('rejects missing, extra and mistyped probability keys', () => {
      expect(
        normalizeAnswers(
          withJev('kind', { probabilities: { news: 0.3, analysis: 0.7 } }),
          QUESTIONS,
        ),
      ).toEqual({ ok: false, detail: 'answers.kind: probabilities: missing other' });
      expect(
        normalizeAnswers(
          withJev('kind', { probabilities: { news: 0.2, analysis: 0.7, other: 0.1, sport: 0 } }),
          QUESTIONS,
        ),
      ).toEqual({ ok: false, detail: 'answers.kind: probabilities: unexpected keys' });
      expect(
        normalizeAnswers(
          withJev('kind', { probabilities: { news: '0.2', analysis: 0.7, other: 0.1 } }),
          QUESTIONS,
        ),
      ).toEqual({
        ok: false,
        detail: 'answers.kind: probabilities.news: not a finite number in [0, 1]',
      });
      expect(
        normalizeAnswers(withJev('kind', { probabilities: [0.2, 0.7, 0.1] }), QUESTIONS),
      ).toEqual({ ok: false, detail: 'answers.kind: probabilities: not an object' });
      expect(normalizeAnswers(withJev('kind', { probabilities: null }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.kind: probabilities: not an object',
      });
    });

    it('requires score probabilities keyed by level index "0".."n-1"', () => {
      expect(
        normalizeAnswers(
          withJev('depth', { probabilities: { '00': 0.1, '1': 0.7, '2': 0.2 } }),
          QUESTIONS,
        ),
      ).toEqual({ ok: false, detail: 'answers.depth: probabilities: missing 0' });
      expect(
        normalizeAnswers(withJev('depth', { probabilities: [0.1, 0.7, 0.2] }), QUESTIONS),
      ).toEqual({ ok: false, detail: 'answers.depth: probabilities: not an object' });
      expect(
        normalizeAnswers(
          withJev('depth', { probabilities: { '0': 0.1, '1': 0.7, '2': 0.2, '3': 0 } }),
          QUESTIONS,
        ),
      ).toEqual({ ok: false, detail: 'answers.depth: probabilities: unexpected keys' });
    });

    it('reads own data properties only: never inherited ones, never getters', () => {
      const question: Question = {
        type: 'choice',
        instructions: 'Which?',
        criteria: { constructor: 'the first', toString: 'the second' },
      };
      // `constructor` is inherited by every object: it must still count as missing.
      const missing = normalizeAnswers(
        { q: { type: 'choice', probabilities: { toString: 1 } } },
        { q: question },
      );
      expect(missing).toEqual({
        ok: false,
        detail: 'answers.q: probabilities: missing constructor',
      });

      const parsed: unknown = JSON.parse(
        '{"q": {"type": "choice", "probabilities": {"constructor": 0.6, "toString": 0.4}}}',
      );
      const answer = choiceOf(normalizeAnswers(parsed, { q: question }), 'q');
      expect(Object.hasOwn(answer.probabilities, 'constructor')).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(answer.probabilities, 'constructor')?.value,
      ).toBeCloseTo(0.6, 12);
      expect(answer.choice).toBe('constructor');

      let reads = 0;
      const noul: Record<string, unknown> = { type: 'noul' };
      Object.defineProperty(noul, 'noul', {
        enumerable: true,
        get() {
          reads += 1;
          return 0.5;
        },
      });
      expect(normalizeAnswers({ ...jevAnswers(), battery: noul }, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.battery: noul: not a finite number in [0, 1]',
      });
      expect(reads).toBe(0);
    });

    it('caps long option keys in details', () => {
      const long = `option_${'x'.repeat(100)}`;
      const question: Question = {
        type: 'choice',
        instructions: 'x',
        criteria: { [long]: null, b: null },
      };
      expect(
        normalizeAnswers({ q: { type: 'choice', probabilities: { b: 1 } } }, { q: question }),
      ).toEqual({ ok: false, detail: `answers.q: probabilities: missing ${long.slice(0, 61)}...` });
    });

    it('rejects objects with a foreign prototype', () => {
      const answers: Record<string, unknown> = jevAnswers();
      answers.battery = Object.assign(Object.create({ noul: 0.8 }) as object, { type: 'noul' });
      expect(normalizeAnswers(answers, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.battery: not an object',
      });
      expect(normalizeAnswers(new Map(), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers: not an object',
      });
    });

    it('accepts null-prototype objects', () => {
      const answers = Object.assign(Object.create(null) as object, jevAnswers());
      expect(normalizeAnswers(answers, QUESTIONS).ok).toBe(true);
    });
  });

  describe('non-finite and out-of-range values', () => {
    it.each([
      ['a string', '0.8'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['above 1', 1.2],
      ['negative', -0.1],
      ['null', null],
    ])('rejects a noul probability that is %s', (_, value) => {
      expect(normalizeAnswers(withJev('battery', { noul: value }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.battery: noul: not a finite number in [0, 1]',
      });
    });

    it('accepts the bounds 0 and 1', () => {
      for (const p of [0, 1]) {
        expect(
          answersOf(normalizeAnswers(withJev('battery', { noul: p }), QUESTIONS)).battery,
        ).toEqual({ type: 'noul', p });
      }
    });

    it('never clamps an out-of-range probability', () => {
      const raw = { news: -0.05, analysis: 0.95, other: 0.1 };
      expect(normalizeAnswers(withJev('kind', { probabilities: raw }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.kind: probabilities.news: not a finite number in [0, 1]',
      });
      const nan = { '0': Number.NaN, '1': 0.7, '2': 0.3 };
      expect(normalizeAnswers(withJev('depth', { probabilities: nan }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.depth: probabilities.0: not a finite number in [0, 1]',
      });
    });

    it('rejects a non-finite or non-numeric score', () => {
      for (const score of [Number.NaN, Number.POSITIVE_INFINITY, '1.1', null]) {
        expect(normalizeAnswers(withJev('depth', { score }), QUESTIONS)).toEqual({
          ok: false,
          detail: 'answers.depth: score: not a finite number',
        });
      }
      const answers = jevAnswers();
      delete answers.depth?.score;
      expect(normalizeAnswers(answers, QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.depth: score: not a finite number',
      });
    });
  });

  describe('choice', () => {
    it('is the argmax, whatever choice the engine reported', () => {
      const answer = choiceOf(normalizeAnswers(withJev('kind', { choice: 'news' }), QUESTIONS));
      expect(answer.choice).toBe('analysis');
      const absent = jevAnswers();
      delete absent.kind?.choice;
      expect(choiceOf(normalizeAnswers(absent, QUESTIONS)).choice).toBe('analysis');
    });

    it('breaks ties by the option order of the request', () => {
      const tie = { news: 0.45, analysis: 0.45, other: 0.1 };
      expect(
        choiceOf(normalizeAnswers(withJev('kind', { probabilities: tie }), QUESTIONS)).choice,
      ).toBe('news');
      const reversed: Question = {
        type: 'choice',
        instructions: 'Which?',
        criteria: { b: 'B', a: 'A' },
      };
      const answer = choiceOf(
        normalizeAnswers(
          { q: { type: 'choice', probabilities: { a: 0.5, b: 0.5 } } },
          { q: reversed },
        ),
        'q',
      );
      expect(answer.choice).toBe('b');
    });

    it('rejects a reported choice that is not one of the options', () => {
      for (const choice of ['sport', 3, null]) {
        expect(normalizeAnswers(withJev('kind', { choice }), QUESTIONS)).toEqual({
          ok: false,
          detail: 'answers.kind: choice: not one of the options',
        });
      }
    });
  });

  describe('confidence', () => {
    it("keeps the engine's own confidence", () => {
      expect(choiceOf(normalizeAnswers(jevAnswers(), QUESTIONS)).confidence).toBe(0.4);
      expect(scoreOf(normalizeAnswers(jevAnswers(), QUESTIONS)).confidence).toBe(0.5);
    });

    it('falls back to the entropy proxy when the engine reports none', () => {
      const absent = jevAnswers();
      delete absent.kind?.confidence;
      const answer = choiceOf(normalizeAnswers(absent, QUESTIONS));
      expect(answer.confidence).toBeCloseTo(entropyConfidence([0.2, 0.7, 0.1]), 12);
      expect(answer.confidence).toBeCloseTo(0.2702, 4);
      const score = scoreOf(normalizeAnswers(withJev('depth', { confidence: null }), QUESTIONS));
      expect(score.confidence).toBeCloseTo(entropyConfidence([0.1, 0.7, 0.2]), 12);
    });

    it('rejects a confidence outside [0, 1]', () => {
      for (const confidence of [1.5, -0.1, '0.4', Number.NaN]) {
        expect(normalizeAnswers(withJev('kind', { confidence }), QUESTIONS)).toEqual({
          ok: false,
          detail: 'answers.kind: confidence: not a finite number in [0, 1]',
        });
      }
      expect(normalizeAnswers(withJev('depth', { confidence: 2 }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.depth: confidence: not a finite number in [0, 1]',
      });
    });
  });

  describe('score', () => {
    it('recomputes the score as Σ i·p_i over levels 0..n−1', () => {
      const raw = { '0': 0.0, '1': 0.25, '2': 0.75 };
      const answer = scoreOf(
        normalizeAnswers(withJev('depth', { probabilities: raw, score: 1.74 }), QUESTIONS),
      );
      expect(answer.score).toBeCloseTo(1.75, 12);
      expect(answer.probabilities).toEqual([0, 0.25, 0.75]);
      expect(answer.levels).toBe(3);
    });

    it('accepts a reported score within 0.02 of Σ i·p_i', () => {
      expect(SCORE_MATCH_TOLERANCE).toBe(0.02);
      expect(
        scoreOf(normalizeAnswers(withJev('depth', { score: 1.115 }), QUESTIONS)).score,
      ).toBeCloseTo(1.1, 12);
      expect(
        scoreOf(normalizeAnswers(withJev('depth', { score: 1.12 }), QUESTIONS)).score,
      ).toBeCloseTo(1.1, 12);
    });

    it('accepts a score computed before or after the engine renormalized', () => {
      const raw = { '0': 0.1, '1': 0.7, '2': 0.21 };
      // Σ i·p over the raw values is 1.12; over the renormalized ones 1.12 / 1.01 ≈ 1.1089.
      for (const score of [1.12, 1.1089]) {
        expect(
          normalizeAnswers(withJev('depth', { probabilities: raw, score }), QUESTIONS).ok,
        ).toBe(true);
      }
    });

    it('rejects a reported score that does not match', () => {
      expect(normalizeAnswers(withJev('depth', { score: 1.5 }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.depth: score: 1.5 does not match Σ i·p_i = 1.1',
      });
      // Reversed level order is the typical garbling this catches.
      expect(normalizeAnswers(withJev('depth', { score: 0.9 }), QUESTIONS)).toEqual({
        ok: false,
        detail: 'answers.depth: score: 0.9 does not match Σ i·p_i = 1.1',
      });
    });
  });
});

describe('spec 04 §8 normalization of LLM answers', () => {
  const llm = (raw: unknown): NormalizeResult =>
    normalizeAnswers(raw, QUESTIONS, { format: 'llm' });

  it('converts {p} and {probabilities} answers with entropy confidence', () => {
    const answers = answersOf(llm(llmAnswers()));
    expect(answers.battery).toEqual({ type: 'noul', p: 0.8 });
    const choice = choiceOf(llm(llmAnswers()));
    expect(choice.choice).toBe('analysis');
    expect(choice.confidence).toBeCloseTo(entropyConfidence([0.2, 0.7, 0.1]), 12);
    const score = scoreOf(llm(llmAnswers()));
    expect(score.score).toBeCloseTo(1.1, 12);
    expect(score.levels).toBe(3);
    expect(score.confidence).toBeCloseTo(entropyConfidence([0.1, 0.7, 0.2]), 12);
  });

  it('renormalizes inside the tolerance and rejects outside it', () => {
    const inside = llmAnswers();
    inside.kind = { probabilities: { news: 0.2, analysis: 0.7, other: 0.11 } };
    expect(sum(Object.values(choiceOf(llm(inside)).probabilities))).toBeCloseTo(1, 12);
    const outside = llmAnswers();
    outside.depth = { probabilities: { '0': 0.3, '1': 0.3, '2': 0.3 } };
    expect(llm(outside)).toEqual({
      ok: false,
      detail: 'answers.depth: probabilities: sum 0.9 is outside 1 ± 0.02',
    });
  });

  it('requires exactly the schema fields', () => {
    const typed = llmAnswers();
    typed.battery = { type: 'noul', p: 0.8 };
    expect(llm(typed)).toEqual({ ok: false, detail: 'answers.battery: unexpected fields' });
    const scored = llmAnswers();
    scored.depth = { ...scored.depth, score: 1.1 };
    expect(llm(scored)).toEqual({ ok: false, detail: 'answers.depth: unexpected fields' });
    const noP = llmAnswers();
    noP.battery = { probability: 0.8 };
    expect(llm(noP)).toEqual({ ok: false, detail: 'answers.battery: missing p' });
    const noProbabilities = llmAnswers();
    noProbabilities.kind = { choice: 'news' };
    expect(llm(noProbabilities)).toEqual({
      ok: false,
      detail: 'answers.kind: missing probabilities',
    });
    const scalar: Record<string, unknown> = llmAnswers();
    scalar.battery = 0.8;
    expect(llm(scalar)).toEqual({ ok: false, detail: 'answers.battery: not an object' });
  });

  it('rejects out-of-range and non-numeric values', () => {
    for (const p of [1.01, -0.01, '0.8', null]) {
      const answers = llmAnswers();
      answers.battery = { p };
      expect(llm(answers)).toEqual({
        ok: false,
        detail: 'answers.battery: p: not a finite number in [0, 1]',
      });
    }
    const answers = llmAnswers();
    answers.kind = { probabilities: { news: 0.2, analysis: 0.8 } };
    expect(llm(answers)).toEqual({
      ok: false,
      detail: 'answers.kind: probabilities: missing other',
    });
  });

  it('rejects missing and extra top-level keys', () => {
    const missing = llmAnswers();
    delete missing.kind;
    expect(llm(missing)).toEqual({ ok: false, detail: 'answers: missing kind' });
    expect(llm({ ...llmAnswers(), extra: { p: 1 } })).toEqual({
      ok: false,
      detail: 'answers: 1 unexpected key',
    });
  });
});

describe('spec 04 §2 outbound request validation', () => {
  const valid = { state: { article: { title: 'Battery news' } }, questions: QUESTIONS };

  it('accepts a valid request and reports its serialized size', () => {
    expect(validateRequest(valid)).toEqual({
      ok: true,
      bytes: Buffer.byteLength(JSON.stringify(valid), 'utf8'),
      questionCount: 3,
    });
  });

  it('measures UTF-8 bytes, not characters', () => {
    const state = { title: 'Přílišný žluťoučký kůň' };
    const serialized = JSON.stringify({ state, questions: { battery: NOUL } });
    const result = validateRequest({ state, questions: { battery: NOUL } });
    if (!result.ok) throw new Error(result.detail);
    expect(result.bytes).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(result.bytes).toBeGreaterThan(serialized.length);
  });

  it('matches the question limits of @bantoozi/questions', () => {
    expect(ENGINE_QUESTION_KEY_PATTERN.source).toBe(QUESTION_KEY_PATTERN.source);
    expect(ENGINE_QUESTION_KEY_PATTERN.flags).toBe(QUESTION_KEY_PATTERN.flags);
    expect(MIN_CHOICE_OPTIONS).toBe(CHOICE_MIN_OPTIONS);
    expect(DEFAULT_REQUEST_LIMITS.maxChoiceOptions).toBe(CHOICE_MAX_OPTIONS);
    expect(MIN_SCORE_LEVELS).toBe(SCORE_MIN_LEVELS);
    expect(DEFAULT_REQUEST_LIMITS.maxScoreLevels).toBe(SCORE_MAX_LEVELS);
    expect(DEFAULT_REQUEST_LIMITS.maxQuestions).toBe(200);
    expect(Object.isFrozen(DEFAULT_REQUEST_LIMITS)).toBe(true);
  });

  describe('question sets', () => {
    it('rejects a missing, empty or oversized set', () => {
      expect(
        validateRequest({ state: {}, questions: null as unknown as Record<string, Question> }),
      ).toEqual({ ok: false, detail: 'questions: not an object' });
      expect(
        validateRequest({ state: {}, questions: [NOUL] as unknown as Record<string, Question> }),
      ).toEqual({ ok: false, detail: 'questions: not an object' });
      expect(validateRequest({ state: {}, questions: {} })).toEqual({
        ok: false,
        detail: 'questions: empty',
      });
      const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`q${i}`, NOUL]));
      expect(validateRequest({ state: {}, questions: many })).toEqual({
        ok: false,
        detail: 'questions: 201 exceed the limit of 200',
      });
      expect(validateRequest({ state: {}, questions: QUESTIONS }, { maxQuestions: 2 })).toEqual({
        ok: false,
        detail: 'questions: 3 exceed the limit of 2',
      });
    });

    it('rejects keys outside [a-zA-Z0-9_.-]{1,64}', () => {
      for (const key of ['has space', 'a'.repeat(65), '', 'ä', 'x/y']) {
        expect(validateRequest({ state: {}, questions: { [key]: NOUL } })).toEqual({
          ok: false,
          detail: 'questions: an invalid key',
        });
      }
      expect(validateRequest({ state: {}, questions: { ['a'.repeat(64)]: NOUL } }).ok).toBe(true);
      expect(validateRequest({ state: {}, questions: { 'card.c1_v2-x': NOUL } }).ok).toBe(true);
    });

    it('rejects an own "__proto__" question key', () => {
      const questions = JSON.parse(`{"__proto__": ${JSON.stringify(NOUL)}}`) as Record<
        string,
        Question
      >;
      expect(validateRequest({ state: {}, questions })).toEqual({
        ok: false,
        detail: 'questions: an invalid key',
      });
    });
  });

  describe('questions', () => {
    const check = (
      question: unknown,
      limits: Partial<RequestLimits> = {},
    ): ReturnType<typeof validateRequest> =>
      validateRequest({ state: {}, questions: { q: question as Question } }, limits);

    it('rejects malformed question objects', () => {
      expect(check(null)).toEqual({ ok: false, detail: 'questions.q: not an object' });
      expect(check({ ...NOUL, weight: 2 })).toEqual({
        ok: false,
        detail: 'questions.q: an unexpected field',
      });
      expect(check({ ...NOUL, type: 'boolean' })).toEqual({
        ok: false,
        detail: 'questions.q: an unknown type',
      });
    });

    it('requires instructions that are a string, JSON object, array or null', () => {
      expect(check({ type: 'noul' })).toEqual({
        ok: false,
        detail: 'questions.q: instructions: missing',
      });
      expect(check({ type: 'noul', instructions: 7 })).toEqual({
        ok: false,
        detail: 'questions.q: instructions: a bare number',
      });
      expect(check({ type: 'noul', instructions: true })).toEqual({
        ok: false,
        detail: 'questions.q: instructions: a bare boolean',
      });
      expect(check({ type: 'noul', instructions: { weight: Number.NaN } })).toEqual({
        ok: false,
        detail: 'questions.q: instructions: a non-finite number',
      });
      for (const instructions of ['text', { a: [1, 'b', null] }, ['x'], null]) {
        expect(check({ type: 'noul', instructions }).ok).toBe(true);
      }
    });

    it('allows noul criteria with only true/false entries', () => {
      expect(check({ ...NOUL, criteria: { true: 'yes', false: { what: 'no' } } }).ok).toBe(true);
      expect(check({ ...NOUL, criteria: { true: 'yes', false: undefined } }).ok).toBe(true);
      expect(check({ ...NOUL, criteria: { true: 'yes', maybe: 'x' } })).toEqual({
        ok: false,
        detail: 'questions.q: criteria has a key other than true/false',
      });
      expect(check({ ...NOUL, criteria: 'yes' })).toEqual({
        ok: false,
        detail: 'questions.q: criteria is not an object',
      });
      expect(check({ ...NOUL, criteria: { true: 1 } })).toEqual({
        ok: false,
        detail: 'questions.q: criteria.true: a bare number',
      });
    });

    it('allows 2..255 choice options with valid criteria', () => {
      const options = (n: number): Record<string, string> =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `option ${i}`]));
      expect(check({ ...CHOICE, criteria: options(2) }).ok).toBe(true);
      expect(check({ ...CHOICE, criteria: options(255) }).ok).toBe(true);
      expect(check({ ...CHOICE, criteria: options(1) })).toEqual({
        ok: false,
        detail: 'questions.q: 1 options (allowed 2..255)',
      });
      expect(check({ ...CHOICE, criteria: options(256) })).toEqual({
        ok: false,
        detail: 'questions.q: 256 options (allowed 2..255)',
      });
      expect(check({ ...CHOICE, criteria: options(4) }, { maxChoiceOptions: 3 })).toEqual({
        ok: false,
        detail: 'questions.q: 4 options (allowed 2..3)',
      });
      expect(check({ ...CHOICE, criteria: ['a', 'b'] })).toEqual({
        ok: false,
        detail: 'questions.q: criteria is not an object',
      });
      expect(check({ ...CHOICE, criteria: { a: 'A', '': 'empty' } })).toEqual({
        ok: false,
        detail: 'questions.q: an invalid option key',
      });
      expect(check({ ...CHOICE, criteria: { a: 'A', b: 2 } })).toEqual({
        ok: false,
        detail: 'questions.q: option b: a bare number',
      });
      expect(check({ ...CHOICE, criteria: { a: 'A', b: undefined } })).toEqual({
        ok: false,
        detail: 'questions.q: option b: missing',
      });
      const proto = JSON.parse('{"a": "A", "__proto__": "B"}') as Record<string, string>;
      expect(check({ ...CHOICE, criteria: proto })).toEqual({
        ok: false,
        detail: 'questions.q: an invalid option key',
      });
    });

    it('allows 2..10 score levels with valid criteria', () => {
      const levels = (n: number): string[] => Array.from({ length: n }, (_, i) => `level ${i}`);
      expect(check({ ...SCORE, criteria: levels(2) }).ok).toBe(true);
      expect(check({ ...SCORE, criteria: levels(10) }).ok).toBe(true);
      expect(check({ ...SCORE, criteria: levels(1) })).toEqual({
        ok: false,
        detail: 'questions.q: 1 levels (allowed 2..10)',
      });
      expect(check({ ...SCORE, criteria: levels(11) })).toEqual({
        ok: false,
        detail: 'questions.q: 11 levels (allowed 2..10)',
      });
      expect(check({ ...SCORE, criteria: { a: 'x', b: 'y' } })).toEqual({
        ok: false,
        detail: 'questions.q: criteria is not an array',
      });
      // eslint-disable-next-line no-sparse-arrays -- the hole is the point
      expect(check({ ...SCORE, criteria: ['low', , 'high'] })).toEqual({
        ok: false,
        detail: 'questions.q: level 1: missing',
      });
      expect(check({ ...SCORE, criteria: [0, 1, 2] })).toEqual({
        ok: false,
        detail: 'questions.q: level 0: a bare number',
      });
    });
  });

  describe('state', () => {
    const check = (state: unknown): ReturnType<typeof validateRequest> =>
      validateRequest({ state: state as never, questions: { battery: NOUL } });

    it('requires a finite, plain JSON state', () => {
      expect(check(undefined)).toEqual({ ok: false, detail: 'state: missing' });
      expect(check({ article: { words: Number.NaN } })).toEqual({
        ok: false,
        detail: 'state: a non-finite number',
      });
      expect(check([1, Number.NEGATIVE_INFINITY])).toEqual({
        ok: false,
        detail: 'state: a non-finite number',
      });
      expect(check({ at: new Date(0) })).toEqual({
        ok: false,
        detail: 'state: a non-plain object',
      });
      expect(check({ run: () => 1 })).toEqual({ ok: false, detail: 'state: a function' });
      expect(check({ id: 1n })).toEqual({ ok: false, detail: 'state: a bigint' });
      expect(check({ tag: Symbol('x') })).toEqual({ ok: false, detail: 'state: a symbol' });
      expect(check([undefined])).toEqual({ ok: false, detail: 'state: an undefined value' });
      // eslint-disable-next-line no-sparse-arrays -- the hole is the point
      expect(check(['a', , 'c'])).toEqual({ ok: false, detail: 'state: an array hole' });
    });

    it('allows JSON scalars, null and undefined object properties', () => {
      for (const state of [
        'text',
        0,
        false,
        null,
        { a: undefined, b: [1, 'x', null, { c: true }] },
      ]) {
        expect(check(state).ok).toBe(true);
      }
    });

    it('never runs a getter in the state', () => {
      let reads = 0;
      const state = {};
      Object.defineProperty(state, 'secret', {
        enumerable: true,
        get() {
          reads += 1;
          return 'x';
        },
      });
      expect(check(state)).toEqual({ ok: false, detail: 'state: an accessor property' });
      expect(reads).toBe(0);
    });

    it('rejects nesting deeper than 64 levels', () => {
      const nest = (levels: number): unknown => {
        let value: unknown = 'leaf';
        for (let i = 0; i < levels; i += 1) value = { next: value };
        return value;
      };
      expect(check(nest(64)).ok).toBe(true);
      expect(check(nest(65))).toEqual({
        ok: false,
        detail: 'state: nesting deeper than 64 levels',
      });
    });

    it('never echoes state text in the detail', () => {
      const result = check({ 'private reading list': { custody: Number.NaN } });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/private|custody/);
    });
  });

  it('rejects a request above the byte limit', () => {
    const state = { text: 'x'.repeat(200) };
    const bytes = Buffer.byteLength(
      JSON.stringify({ state, questions: { battery: NOUL } }),
      'utf8',
    );
    expect(
      validateRequest({ state, questions: { battery: NOUL } }, { maxRequestBytes: 100 }),
    ).toEqual({ ok: false, detail: `request: ${bytes} bytes exceed the limit of 100` });
    expect(
      validateRequest({ state, questions: { battery: NOUL } }, { maxRequestBytes: bytes }).ok,
    ).toBe(true);
    const huge = { text: 'x'.repeat(DEFAULT_REQUEST_LIMITS.maxRequestBytes) };
    expect(validateRequest({ state: huge, questions: { battery: NOUL } }).ok).toBe(false);
  });
});
