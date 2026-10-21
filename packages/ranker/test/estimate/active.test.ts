import { normalizeText } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  activeEstimate,
  ESTIMATE_SPEC,
  type EstimateModel,
  estimateFeatures,
  explainEstimate,
  scoreEstimate,
} from '../../src/index.js';
import { item } from '../rank-support.js';

const base = (
  weights: Record<string, number>,
  over: Partial<EstimateModel> = {},
): EstimateModel => ({
  spec: ESTIMATE_SPEC,
  intercept: -0.2,
  weights,
  platt: { a: 0.9, b: 0.1 },
  metrics: { n: 12, nPos: 6, nNeg: 6, folds: 0, auc: null, feeds: {} },
  ...over,
});

/** A model with a distinct weight for every feature of the given articles. */
function modelFor(...articles: Parameters<typeof estimateFeatures>[0][]): EstimateModel {
  const weights: Record<string, number> = {};
  for (const article of articles) {
    for (const feature of estimateFeatures(article)) {
      weights[feature] = ((Object.keys(weights).length % 7) - 3) * 0.37;
    }
  }
  return base(weights);
}

describe('activeEstimate', () => {
  it('is null for a model of another spec', () => {
    expect(
      activeEstimate({ version: 2, model: base({}, { spec: 'estimate-v0:0000' }) }),
    ).toBeNull();
  });

  it('carries the stored version', () => {
    expect(activeEstimate({ version: 7, model: base({}) })?.version).toBe(7);
  });

  it('scores the raw title, the normalized excerpt and the first carrier feed', () => {
    const m = base({ 't:batte': 1, 'e:lithi': 0.5, 'f:7': 2, 'f:3': -2 });
    const active = activeEstimate({ version: 1, model: m });
    const scored = active?.score(
      item({
        title: 'Battery prices fall again',
        excerptNorm: 'lithium cells are cheaper than ever',
        feedIds: ['7', '3'],
      }),
    );
    const expected = scoreEstimate(
      m,
      estimateFeatures({
        title: 'Battery prices fall again',
        excerpt: 'lithium cells are cheaper than ever',
        feedId: '7',
      }),
    );
    expect(scored?.p).toBe(expected?.p);
    expect(scored?.top.map((w) => w.feature)).toEqual(['t:batte', 'e:lithi']);
  });

  it('adds no feed feature for an item without carrier feeds', () => {
    const m = base({ 'f:7': 5, 't:batte': 1 });
    const scored = activeEstimate({ version: 1, model: m })?.score(
      item({ title: 'Battery', feedIds: [] }),
    );
    expect(scored?.p).toBe(
      scoreEstimate(
        m,
        estimateFeatures({
          title: 'Battery',
          excerpt: 'lithium cells are cheaper than ever',
          feedId: null,
        }),
      )?.p,
    );
  });

  it('scores an item without a title from the excerpt and feed alone', () => {
    const m = base({ 't:batte': 3, 'e:lithi': 1, 'f:1': 0.5 });
    const noTitle = item({ feedIds: ['1'] });
    expect(noTitle.title).toBeUndefined();
    const scored = activeEstimate({ version: 1, model: m })?.score(noTitle);
    const expected = scoreEstimate(
      m,
      estimateFeatures({ title: null, excerpt: noTitle.excerptNorm, feedId: '1' }),
    );
    expect(scored?.p).toBe(expected?.p);
    expect(scored?.top.map((w) => w.feature)).toEqual(['e:lithi']);
  });

  it('treats a null title like a missing one', () => {
    const m = base({ 't:batte': 3, 'e:lithi': 1 });
    const active = activeEstimate({ version: 1, model: m });
    expect(active?.score(item({ title: null }))?.p).toBe(active?.score(item())?.p);
  });

  it('returns the words explainEstimate gives for the same article', () => {
    const m = base({ 't:batte': 2, 'e:lithi': -1, 'f:1': 1 });
    const scored = activeEstimate({ version: 1, model: m })?.score(item({ title: 'Battery news' }));
    const explained = explainEstimate(m, {
      title: 'Battery news',
      excerpt: 'lithium cells are cheaper than ever',
      feedId: '1',
    });
    expect(scored?.top).toEqual(explained?.top);
    expect(scored?.p).toBe(explained?.p);
  });
});

describe('activeEstimate parity with scoreEstimate (T15)', () => {
  const RAWS: (string | null)[] = [
    'Příliš žluťoučký kůň úpěl ďábelské ódy',
    'Battery prices fall again: 500 EUR',
    'Rocket 🚀 launch 🔥 tonight',
    'Ľudia a ženy na Slovensku',
    '',
    null,
    'a b c',
    'Lithium batteries: cheaper than ever, say analysts of the world energy market',
  ];

  it.each(RAWS.map((raw, i) => [String(raw), raw, i] as const))(
    'matches for the title and excerpt %j',
    (_name, raw, i) => {
      const feedId = i % 2 === 0 ? String(i + 1) : null;
      const article = { title: raw, excerpt: raw, feedId };
      const m = modelFor(article, { title: 'Battery prices fall again', excerpt: null, feedId });
      const scored = activeEstimate({ version: 1, model: m })?.score(
        item({
          title: raw,
          excerptNorm: raw === null ? '' : normalizeText(raw),
          feedIds: feedId === null ? [] : [feedId],
        }),
      );
      const expected = scoreEstimate(m, estimateFeatures(article));
      expect(scored).not.toBeNull();
      expect(scored?.p).toBe(expected?.p);
    },
  );
});
