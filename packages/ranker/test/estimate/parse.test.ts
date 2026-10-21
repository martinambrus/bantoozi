import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_SPEC,
  type EstimateModel,
  type EstimateSample,
  parseEstimateModel,
  trainEstimateModel,
} from '../../src/index.js';

const model: EstimateModel = {
  spec: ESTIMATE_SPEC,
  intercept: -0.25,
  weights: { 't:batte': 1.5, 'b:batte_lithi': -0.5, 'f:9': 0.125 },
  platt: { a: 0.8, b: 0.05 },
  metrics: {
    n: 12,
    nPos: 6,
    nNeg: 6,
    folds: 5,
    auc: 0.81,
    feeds: { '9': { n: 10, nPos: 5, nNeg: 5, auc: null } },
  },
};

/** A row as the database returns it: the JSON columns have been through serialization. */
const row = (over: Record<string, unknown> = {}) => ({
  spec: model.spec,
  intercept: model.intercept,
  weights: JSON.parse(JSON.stringify(model.weights)) as unknown,
  platt: JSON.parse(JSON.stringify(model.platt)) as unknown,
  metrics: JSON.parse(JSON.stringify(model.metrics)) as unknown,
  ...over,
});

describe('parseEstimateModel', () => {
  it('accepts a model that has been through JSON', () => {
    expect(parseEstimateModel(row())).toEqual(model);
  });

  it('accepts a trained model round-tripped through JSON', () => {
    const likes = ['garden', 'recipe', 'cooking'];
    const dislikes = ['crypto', 'gossip', 'lottery'];
    const samples: EstimateSample[] = Array.from({ length: 20 }, (_, i) => ({
      articleId: `a${i}`,
      rating: i % 2 === 0 ? 1 : -1,
      ratedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      title: `${(i % 2 === 0 ? likes : dislikes)[i % 3] as string} today`,
      excerpt: null,
      feedId: 'fa',
    }));
    const trained = trainEstimateModel(samples);
    if (!trained.ok) throw new Error('expected a model');
    const stored = JSON.parse(JSON.stringify(trained.model)) as EstimateModel;
    expect(parseEstimateModel(stored)).toEqual(trained.model);
  });

  it('does not compare the spec', () => {
    expect(parseEstimateModel(row({ spec: 'estimate-v0:0000' }))?.spec).toBe('estimate-v0:0000');
  });

  it('accepts empty weights', () => {
    expect(parseEstimateModel(row({ weights: {} }))?.weights).toEqual({});
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1.5'],
    ['null', null],
  ])('rejects a weight that is %s', (_name, value) => {
    expect(parseEstimateModel(row({ weights: { 't:batte': value } }))).toBeNull();
  });

  it.each([
    ['an array', [1, 2]],
    ['null', null],
    ['a string', 'weights'],
    ['undefined', undefined],
  ])('rejects weights that are %s', (_name, weights) => {
    expect(parseEstimateModel(row({ weights }))).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['without b', { a: 1 }],
    ['without a', { b: 0 }],
    ['with a non-finite a', { a: Number.NaN, b: 0 }],
    ['with a string b', { a: 1, b: '0' }],
    ['an array', [1, 0]],
  ])('rejects platt %s', (_name, platt) => {
    expect(parseEstimateModel(row({ platt }))).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '0'],
  ])('rejects an intercept that is %s', (_name, intercept) => {
    expect(parseEstimateModel(row({ intercept }))).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'metrics'],
    ['undefined', undefined],
  ])('rejects metrics that are %s', (_name, metrics) => {
    expect(parseEstimateModel(row({ metrics }))).toBeNull();
  });
});
