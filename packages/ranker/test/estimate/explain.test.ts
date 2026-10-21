import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_SPEC,
  type EstimateArticle,
  type EstimateModel,
  estimateFeatures,
  explainEstimate,
  scoreEstimate,
} from '../../src/index.js';

const model = (
  weights: Record<string, number>,
  over: Partial<EstimateModel> = {},
): EstimateModel => ({
  spec: ESTIMATE_SPEC,
  intercept: 0.3,
  weights,
  platt: { a: 1, b: 0 },
  metrics: { n: 12, nPos: 6, nNeg: 6, folds: 0, auc: null, feeds: {} },
  ...over,
});

const ARTICLE: EstimateArticle = {
  title: 'Battery lithium cells cheaper solar panels wind turbines hydrogen storage grid fusion',
  excerpt: null,
  feedId: '9',
};

/** 7 positive, 5 negative, a zero weight, a feed weight and a weight of an absent word. */
const WEIGHTS: Record<string, number> = {
  't:solar': 3,
  't:batte': 2,
  'b:batte_lithi': 1,
  't:lithi': 1,
  't:cells': 0.5,
  't:wind': 0.25,
  't:grid': 0.1,
  't:turbi': -4,
  't:cheap': -1.5,
  't:hydro': -0.5,
  't:panel': -0.5,
  't:stora': -0.1,
  't:fusio': 0,
  'f:9': 5,
  't:absent': 9,
};

const EXPECTED_TOP = [
  { feature: 't:solar', label: 'solar', contribution: 3 },
  { feature: 't:batte', label: 'battery', contribution: 2 },
  { feature: 'b:batte_lithi', label: 'battery lithium', contribution: 1 },
  { feature: 't:lithi', label: 'lithium', contribution: 1 },
  { feature: 't:cells', label: 'cells', contribution: 0.5 },
  { feature: 't:turbi', label: 'turbines', contribution: -4 },
  { feature: 't:cheap', label: 'cheaper', contribution: -1.5 },
  { feature: 't:hydro', label: 'hydrogen', contribution: -0.5 },
  { feature: 't:panel', label: 'panels', contribution: -0.5 },
  { feature: 't:stora', label: 'storage', contribution: -0.1 },
];

describe('explainEstimate (T12)', () => {
  it('lists five positive words then five negative ones, strongest first, ties by feature name', () => {
    expect(explainEstimate(model(WEIGHTS), ARTICLE)?.top).toEqual(EXPECTED_TOP);
  });

  it('leaves out zero weights, the feed feature and weights of words the article lacks', () => {
    const features = (explainEstimate(model(WEIGHTS), ARTICLE)?.top ?? []).map((w) => w.feature);
    expect(features).not.toContain('t:fusio');
    expect(features).not.toContain('f:9');
    expect(features).not.toContain('t:absent');
    expect(features).not.toContain('t:wind');
    expect(features).not.toContain('t:grid');
  });

  it('gives the same words when the weights are stored in another key order', () => {
    const reversed = Object.fromEntries(Object.entries(WEIGHTS).reverse());
    const sorted = Object.fromEntries(
      Object.entries(WEIGHTS).sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(explainEstimate(model(reversed), ARTICLE)?.top).toEqual(EXPECTED_TOP);
    expect(explainEstimate(model(sorted), ARTICLE)?.top).toEqual(EXPECTED_TOP);
  });

  it('shows the full word of the title for a five-letter stem, and both words of a pair', () => {
    const top = explainEstimate(model({ 't:batte': 1, 'b:batte_lithi': 0.5 }), ARTICLE)?.top ?? [];
    expect(top.map((w) => w.label)).toEqual(['battery', 'battery lithium']);
  });

  it('honours perSign for each sign separately', () => {
    const top = explainEstimate(model(WEIGHTS), ARTICLE, 2)?.top;
    expect(top?.map((w) => w.feature)).toEqual(['t:solar', 't:batte', 't:turbi', 't:cheap']);
    expect(explainEstimate(model(WEIGHTS), ARTICLE, 0)?.top).toEqual([]);
  });

  it('lists fewer words when fewer features match', () => {
    const top = explainEstimate(model({ 't:solar': 1, 't:turbi': -1 }), ARTICLE)?.top;
    expect(top).toEqual([
      { feature: 't:solar', label: 'solar', contribution: 1 },
      { feature: 't:turbi', label: 'turbines', contribution: -1 },
    ]);
    expect(explainEstimate(model({}), ARTICLE)?.top).toEqual([]);
  });

  it('labels an excerpt word with the excerpt own word', () => {
    const article = {
      title: null,
      excerpt: 'Fusion reactors promise limitless energy',
      feedId: null,
    };
    const top = explainEstimate(model({ 'e:react': 1, 'e:limit': -1 }), article)?.top;
    expect(top).toEqual([
      { feature: 'e:react', label: 'reactors', contribution: 1 },
      { feature: 'e:limit', label: 'limitless', contribution: -1 },
    ]);
  });

  it('adds a title feature and an excerpt feature of one word into a single entry', () => {
    const article = { title: 'Lithium prices', excerpt: 'Lithium rises again', feedId: null };
    const top = explainEstimate(
      model({ 't:lithi': 1, 'e:lithi': 0.5, 't:price': -1 }),
      article,
    )?.top;
    expect(top?.filter((w) => w.label === 'lithium')).toHaveLength(1);
    expect(top?.find((w) => w.label === 'lithium')?.contribution).toBeCloseTo(1.5);
    expect(['t:lithi', 'e:lithi']).toContain(top?.find((w) => w.label === 'lithium')?.feature);
    expect(top?.map((w) => w.label)).toEqual(['lithium', 'prices']);
  });

  it('does not count a stripped price tail', () => {
    const article = { title: 'Battery pack: 500 EUR', excerpt: null, feedId: null };
    const top = explainEstimate(model({ 't:batte': 1, 't:500': 7, 't:eur': 7 }), article)?.top;
    expect(top).toEqual([{ feature: 't:batte', label: 'battery', contribution: 1 }]);
  });

  it('cuts a very long label to 200 characters', () => {
    const word = 'x'.repeat(250);
    const top = explainEstimate(model({ 't:xxxxx': 1 }), {
      title: word,
      excerpt: null,
      feedId: null,
    })?.top;
    expect(top).toHaveLength(1);
    expect(top?.[0]?.label).toBe('x'.repeat(200));
    expect(top?.[0]?.feature.length).toBeLessThanOrEqual(200);
  });

  it('returns the same logit and p as scoreEstimate over the article features', () => {
    const m = model(WEIGHTS, { platt: { a: 0.7, b: -0.2 } });
    const expected = scoreEstimate(m, estimateFeatures(ARTICLE));
    const explained = explainEstimate(m, ARTICLE);
    expect(expected).not.toBeNull();
    expect(explained?.logit).toBe(expected?.logit);
    expect(explained?.p).toBe(expected?.p);
  });

  it('returns null for a model of another spec', () => {
    expect(explainEstimate(model(WEIGHTS, { spec: 'estimate-v0:0000' }), ARTICLE)).toBeNull();
  });
});
