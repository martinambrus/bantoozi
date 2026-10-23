import { describe, expect, it } from 'vitest';

import { countExtracted, isExtracted } from '../../e2e/support/pipeline.js';

const state = (pipelineState: string) => ({ pipelineState });

describe('isExtracted', () => {
  it.each([
    ['ingested', false],
    ['stale', false],
    ['extracted', true],
    ['translated', true],
    ['enriched', true],
    ['matched', true],
    ['degraded', true],
    ['failed', false],
  ])('%s -> %s', (name, expected) => {
    expect(isExtracted(state(name))).toBe(expected);
  });
});

describe('countExtracted', () => {
  it('counts every extracted-or-later article of a mixed feed', () => {
    const states = [
      'matched',
      'enriched',
      'extracted',
      'stale',
      'failed',
      'ingested',
      'degraded',
      'translated',
    ].map(state);
    expect(countExtracted(states)).toBe(5);
  });

  it('never drops when an article moves from extracted to matched', () => {
    const before = ['extracted', 'extracted', 'stale'].map(state);
    const after = ['matched', 'extracted', 'stale'].map(state);
    expect(countExtracted(after)).toBeGreaterThanOrEqual(countExtracted(before));
  });
});
