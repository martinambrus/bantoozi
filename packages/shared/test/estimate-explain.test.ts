import { describe, expect, it } from 'vitest';

import { ExplainSchema, ScoreSourceSchema } from '../src/index.js';

const word = (n: number) => ({
  feature: `t:word${n}`,
  label: `word ${n}`,
  contribution: 0.5 - n / 10,
});

const explain = (estimate: unknown = { version: 3, top: [word(0), word(1)] }) => ({
  v: 1,
  inputs: {
    contentRevision: '3',
    mediaRevision: '1',
    rankRevision: '12',
    contextSha: 'a'.repeat(64),
  },
  source: 'estimate',
  p: 0.42,
  lane: 'new',
  tier: 2,
  cards: [],
  rules: [{ code: 'estimate' }],
  estimate,
});

describe('score source estimate', () => {
  it('is one of the score sources', () => {
    expect(ScoreSourceSchema.parse('estimate')).toBe('estimate');
    expect(ScoreSourceSchema.options).toContain('estimate');
    expect(() => ScoreSourceSchema.parse('words')).toThrow();
  });
});

describe('Explain estimate block', () => {
  it('accepts an explanation of source estimate with its words', () => {
    const value = explain();
    expect(ExplainSchema.parse(value)).toEqual(value);
  });

  it('accepts no words and exactly ten words', () => {
    expect(ExplainSchema.parse(explain({ version: 1, top: [] })).estimate?.top).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, i) => word(i));
    expect(ExplainSchema.parse(explain({ version: 1, top: ten })).estimate?.top).toHaveLength(10);
  });

  it('is optional, so other sources parse without it', () => {
    const { estimate: _estimate, ...rest } = explain();
    expect(
      ExplainSchema.parse({ ...rest, source: 'none', p: null, tier: null }).estimate,
    ).toBeUndefined();
  });

  it('rejects an extra key in the block or in a word', () => {
    expect(() => ExplainSchema.parse(explain({ version: 3, top: [], extra: 1 }))).toThrow();
    expect(() =>
      ExplainSchema.parse(explain({ version: 3, top: [{ ...word(0), extra: 1 }] })),
    ).toThrow();
  });

  it('rejects more than ten words', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => word(i));
    expect(() => ExplainSchema.parse(explain({ version: 3, top: eleven }))).toThrow();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '0.5'],
  ])('rejects a contribution that is %s', (_name, contribution) => {
    expect(() =>
      ExplainSchema.parse(explain({ version: 3, top: [{ ...word(0), contribution }] })),
    ).toThrow();
  });

  it('rejects a word without a feature or without a label', () => {
    const { feature: _f, ...noFeature } = word(0);
    const { label: _l, ...noLabel } = word(0);
    expect(() => ExplainSchema.parse(explain({ version: 3, top: [noFeature] }))).toThrow();
    expect(() => ExplainSchema.parse(explain({ version: 3, top: [noLabel] }))).toThrow();
  });

  it('rejects a feature or a label longer than 200 characters', () => {
    expect(() =>
      ExplainSchema.parse(explain({ version: 3, top: [{ ...word(0), feature: 'x'.repeat(201) }] })),
    ).toThrow();
    expect(() =>
      ExplainSchema.parse(explain({ version: 3, top: [{ ...word(0), label: 'x'.repeat(201) }] })),
    ).toThrow();
    expect(
      ExplainSchema.parse(explain({ version: 3, top: [{ ...word(0), label: 'x'.repeat(200) }] }))
        .estimate?.top,
    ).toHaveLength(1);
  });

  it.each([0, -1, 1.5, '3'])('rejects a version of %s', (version) => {
    expect(() => ExplainSchema.parse(explain({ version, top: [] }))).toThrow();
  });
});
