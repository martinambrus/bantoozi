import { describe, expect, it } from 'vitest';

import {
  isConcreteJevModel,
  isModelAlias,
  isModelUnavailableDetail,
  isPinnedModel,
  JEV_LATEST_ALIAS,
  MODEL_ID_PATTERN,
  MODEL_UNAVAILABLE_DETAIL,
} from '../src/index.js';

describe('Jev model ids', () => {
  it('M1a constants', () => {
    expect(JEV_LATEST_ALIAS).toBe('jev-latest');
    expect(MODEL_UNAVAILABLE_DETAIL).toBe('model_unavailable');
  });

  it('M1b isModelAlias is exact', () => {
    expect(isModelAlias('jev-latest')).toBe(true);
    expect(isModelAlias('jev-latest ')).toBe(false);
    expect(isModelAlias('JEV-LATEST')).toBe(false);
    expect(isModelAlias('latest')).toBe(false);
    expect(isModelAlias('jev-1.13.0')).toBe(false);
  });

  it('M1c isPinnedModel accepts any lowercase prefix with a version', () => {
    expect(isPinnedModel('jev-1.13.0')).toBe(true);
    expect(isPinnedModel('jev-1.14.0-rc1')).toBe(true);
    expect(isPinnedModel('foo-1.2.3')).toBe(true);
    expect(isPinnedModel('gpt-oss-1.2.3')).toBe(true);
    expect(isPinnedModel('jev-latest')).toBe(false);
    expect(isPinnedModel('jev-beta')).toBe(false);
    expect(isPinnedModel('latest')).toBe(false);
    expect(isPinnedModel('jev-1.13')).toBe(false);
    expect(isPinnedModel('Jev-1.13.0')).toBe(false);
  });

  it('M1c2 isPinnedModel answers a long crafted id in linear time (CodeQL js/polynomial-redos)', () => {
    // Quadratic under the former prefix `[a-z0-9.-]*` (8,000 repeats took 286 ms, 20,000 about 1.8 s).
    const crafted = `a${'-0.0.0'.repeat(20_000)}!`;
    const started = performance.now();
    expect(isPinnedModel(crafted)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('M1d isConcreteJevModel accepts only jev- releases', () => {
    expect(isConcreteJevModel('jev-1.13.0')).toBe(true);
    expect(isConcreteJevModel('jev-1.14.0-rc1')).toBe(true);
    expect(isConcreteJevModel('foo-1.2.3')).toBe(false);
    expect(isConcreteJevModel('gpt-4-1.0.0')).toBe(false);
    expect(isConcreteJevModel('jev-fake')).toBe(false);
    expect(isConcreteJevModel('jev-latest')).toBe(false);
  });

  it('M1e isModelUnavailableDetail', () => {
    expect(isModelUnavailableDetail('model_unavailable')).toBe(true);
    expect(isModelUnavailableDetail('model_unavailable:http_404')).toBe(true);
    expect(isModelUnavailableDetail('typesafe:error:model_unavailable:http_404')).toBe(true);
    expect(isModelUnavailableDetail('http_404')).toBe(false);
    expect(isModelUnavailableDetail('model_unavailable_x')).toBe(false);
    expect(isModelUnavailableDetail(undefined)).toBe(false);
  });

  it('M1f MODEL_ID_PATTERN', () => {
    expect(MODEL_ID_PATTERN.test('jev-latest')).toBe(true);
    expect(MODEL_ID_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(MODEL_ID_PATTERN.test('')).toBe(false);
    expect(MODEL_ID_PATTERN.test('a b')).toBe(false);
    expect(MODEL_ID_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});
