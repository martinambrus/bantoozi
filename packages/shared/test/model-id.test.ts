import { describe, expect, it } from 'vitest';

import {
  isConcreteJevModel,
  isModelAlias,
  isModelUnavailableDetail,
  isPinnedModel,
  JEV_LATEST_ALIAS,
  MODEL_ID_PATTERN,
  MODEL_UNAVAILABLE_DETAIL,
  modelFamily,
  sameModelFamily,
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

describe('JEV-4 modelFamily', () => {
  it.each([
    ['jev-1.13.0', 'jev-1'],
    ['jev-1.14.0', 'jev-1'],
    ['jev-1.14.0-rc1', 'jev-1'],
    ['jev-1.0.0+build', 'jev-1'],
    ['jev-2.0.0', 'jev-2'],
    ['jev-10.2.3', 'jev-10'],
  ])('F1 %s is in family %s', (id, family) => {
    expect(modelFamily(id)).toBe(family);
  });

  it.each([
    'jev-latest',
    'jev-1',
    'jev-1.13',
    'Jev-1.13.0',
    'jev-fake',
    'gpt-4-1.0.0',
    'foo-1.2.3',
    '',
  ])('F2 %j is its own family', (id) => {
    expect(modelFamily(id)).toBe(id);
  });

  it('F3 answers long crafted ids in linear time (CodeQL js/polynomial-redos)', () => {
    for (const crafted of [`a${'-0.0.0'.repeat(20_000)}!`, `jev-1.0.0-${'a.'.repeat(20_000)}!`]) {
      const started = performance.now();
      expect(modelFamily(crafted)).toBe(crafted);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

describe('JEV-4 sameModelFamily', () => {
  it.each([
    ['jev-1.13.0', 'jev-1.14.0'],
    ['jev-1.14.0-rc1', 'jev-1.9.9'],
    ['jev-2.0.0', 'jev-2.7.1'],
    ['jev-latest', 'jev-latest'],
    ['jev-test-1', 'jev-test-1'],
    ['foo-1.2.3', 'foo-1.2.3'],
  ])('S1 %s and %s are one family', (a, b) => {
    expect(sameModelFamily(a, b)).toBe(true);
    expect(sameModelFamily(b, a)).toBe(true);
  });

  it.each([
    ['jev-1.13.0', 'jev-2.0.0'],
    ['jev-1', 'jev-1.13.0'],
    ['jev-latest', 'jev-1.14.0'],
    ['jev-test-1', 'jev-test-2'],
    ['foo-1.2.3', 'foo-1.3.0'],
    ['foo-1.2.3', 'jev-1.2.3'],
    ['', 'jev-1.13.0'],
  ])(
    'S2 %s and %s are different families (an own-family id never merges with a release family)',
    (a, b) => {
      expect(sameModelFamily(a, b)).toBe(false);
      expect(sameModelFamily(b, a)).toBe(false);
    },
  );
});
