import { describe, expect, it } from 'vitest';

import {
  assertQuestionKey,
  choice,
  noul,
  questionLimitProblems,
  score,
  type OptionCriteria,
} from '../src/index.js';

describe('question builders', () => {
  it('builds a Noul with optional sides', () => {
    expect(noul('Is it?')).toEqual({ type: 'noul', instructions: 'Is it?' });
    expect(
      noul({ question: 'Is it?', focus: 'Main subject' }, { true: 'Yes', false: null }),
    ).toEqual({
      type: 'noul',
      instructions: { question: 'Is it?', focus: 'Main subject' },
      criteria: { true: 'Yes', false: null },
    });
    expect(noul('Is it?', { true: { what: 'Yes', examples: ['a'] } })).toEqual({
      type: 'noul',
      instructions: 'Is it?',
      criteria: { true: { what: 'Yes', examples: ['a'] } },
    });
  });

  it('builds a Choice keeping the option order', () => {
    const q = choice('Which?', { b: null, a: 'Option A', c: { what: 'C', includes: ['x'] } });
    expect(q).toEqual({
      type: 'choice',
      instructions: 'Which?',
      criteria: { b: null, a: 'Option A', c: { what: 'C', includes: ['x'] } },
    });
    expect(Object.keys(q.criteria)).toEqual(['b', 'a', 'c']);
  });

  it('builds a Score from its levels, lowest first', () => {
    expect(score('How much?', ['none', 'some', { what: 'lots' }])).toEqual({
      type: 'score',
      instructions: 'How much?',
      criteria: ['none', 'some', { what: 'lots' }],
    });
  });

  it('copies its inputs, so a built question never aliases a caller array', () => {
    const examples = ['one'];
    const q = noul('Is it?', { true: { what: 'Yes', examples } });
    examples.push('two');
    expect(q.criteria?.true).toEqual({ what: 'Yes', examples: ['one'] });
  });

  it('drops undefined properties and rejects non-finite numbers', () => {
    const optional: { readonly [key: string]: OptionCriteria } = { what: 'A' };
    expect(choice('Which?', { a: { ...optional }, b: null }).criteria['a']).toEqual({ what: 'A' });
    const withUndefined = { what: 'B', note: undefined } as unknown as OptionCriteria;
    expect(choice('Which?', { a: withUndefined, b: null }).criteria['a']).toEqual({ what: 'B' });
    expect(() => choice('Which?', { a: { n: Number.NaN }, b: null })).toThrow(RangeError);
    expect(() => score('How?', [{ n: Infinity }, 'b'])).toThrow(/non-finite/);
  });

  it('enforces the TypeSafe limits at build time', () => {
    expect(() => choice('Which?', { only: null })).toThrow(/2\.\.255 options/);
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    expect(() => choice('Which?', many)).toThrow(/got 256/);
    const max = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, null]));
    expect(Object.keys(choice('Which?', max).criteria)).toHaveLength(255);
    expect(() => choice('Which?', { '': null, b: null })).toThrow(/must not be empty/);
    const holey = { a: undefined, b: null } as unknown as Record<string, OptionCriteria>;
    expect(() => choice('Which?', holey)).toThrow(/undefined/);

    expect(() => score('How?', ['one'])).toThrow(/2\.\.10 levels/);
    expect(() =>
      score(
        'How?',
        Array.from({ length: 11 }, (_, i) => `l${i}`),
      ),
    ).toThrow(/got 11/);
    expect(
      score(
        'How?',
        Array.from({ length: 10 }, (_, i) => `l${i}`),
      ).criteria,
    ).toHaveLength(10);
  });

  it('requires non-empty instructions', () => {
    expect(() => noul('  ')).toThrow(/must not be empty/);
    expect(() => noul({ question: ' ' })).toThrow(/non-empty question/);
    expect(() => noul({ focus: 'x' } as unknown as { question: string })).toThrow(/question/);
  });

  it('checks question keys', () => {
    expect(() => assertQuestionKey('c123')).not.toThrow();
    expect(() => assertQuestionKey('t2_technology')).not.toThrow();
    expect(() => assertQuestionKey('a.b-c_D9')).not.toThrow();
    expect(() => assertQuestionKey('')).toThrow(RangeError);
    expect(() => assertQuestionKey('has space')).toThrow(RangeError);
    expect(() => assertQuestionKey('x'.repeat(65))).toThrow(RangeError);
    expect(() => assertQuestionKey('x'.repeat(64))).not.toThrow();
  });

  it('lists every limit a question record breaks', () => {
    expect(questionLimitProblems({})).toEqual(['no questions']);
    expect(questionLimitProblems({ ok: noul('Is it?'), 'bad key': noul('Is it?') })).toEqual([
      'bad key: invalid question key',
    ]);
    const broken = {
      c: { type: 'choice', instructions: 'Which?', criteria: { a: null } },
      s: { type: 'score', instructions: null, criteria: Array.from({ length: 11 }, () => null) },
      n: { type: 'noul', instructions: ' ' },
    } as const;
    expect(questionLimitProblems(broken as never)).toEqual([
      'c: 1 choice options (allowed 2..255)',
      's: empty instructions',
      's: 11 score levels (allowed 2..10)',
      'n: empty instructions',
    ]);
    expect(questionLimitProblems({ m: undefined } as never)).toEqual(['m: missing question']);
  });
});
