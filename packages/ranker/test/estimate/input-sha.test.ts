import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ESTIMATE_OPTIONS,
  estimateInputSha,
  type EstimateSample,
} from '../../src/index.js';

function sample(id: string, rating: 1 | -1, at: number, extra: Partial<EstimateSample> = {}) {
  return {
    articleId: id,
    rating,
    ratedAt: new Date(at),
    title: `Title ${id}`,
    excerpt: `Excerpt ${id}`,
    feedId: '7',
    ...extra,
  } satisfies EstimateSample;
}

const base = [sample('1', 1, 1_000), sample('2', -1, 2_000), sample('10', 1, 3_000)];

describe('estimateInputSha', () => {
  it('is a sha256 in hex', () => {
    expect(estimateInputSha(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order of the samples', () => {
    expect(estimateInputSha([...base].reverse())).toBe(estimateInputSha(base));
    expect(estimateInputSha([base[1]!, base[2]!, base[0]!])).toBe(estimateInputSha(base));
  });

  it('is the hash of the default options when none are given', () => {
    expect(estimateInputSha(base)).toBe(estimateInputSha(base, { ...DEFAULT_ESTIMATE_OPTIONS }));
  });

  it.each([
    ['a rating', [sample('1', -1, 1_000), base[1]!, base[2]!]],
    ['a rating time', [sample('1', 1, 1_001), base[1]!, base[2]!]],
    ['a title', [sample('1', 1, 1_000, { title: 'Other' }), base[1]!, base[2]!]],
    ['an excerpt', [sample('1', 1, 1_000, { excerpt: null }), base[1]!, base[2]!]],
    ['a carrier feed', [sample('1', 1, 1_000, { feedId: '8' }), base[1]!, base[2]!]],
    ['an article', [sample('3', 1, 1_000), base[1]!, base[2]!]],
    ['a missing sample', [base[0]!, base[1]!]],
  ])('changes with %s', (_name, samples) => {
    expect(estimateInputSha(samples)).not.toBe(estimateInputSha(base));
  });

  it.each([
    ['the gate', { minRatings: 11 }],
    ['the epochs', { epochs: 9 }],
    ['the seed', { seed: 'other' }],
  ])('changes with %s', (_name, options) => {
    expect(estimateInputSha(base, options)).not.toBe(estimateInputSha(base));
  });
});
