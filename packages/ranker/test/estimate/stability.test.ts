import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANKER_CONFIG,
  estimateFeatures,
  scoreEstimate,
  tierFromP,
  trainEstimateModel,
  type EstimateArticle,
  type EstimateModel,
  type EstimateSample,
} from '../../src/index.js';
import { seededRandom } from '../../src/learn/random.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const VOCAB = 300;
const FEEDS = ['f1', 'f2', 'f3', 'f4'];

function makeWorld(seed: string) {
  const rnd = seededRandom(seed);
  const cumulative: number[] = [];
  let total = 0;
  for (let i = 0; i < VOCAB; i += 1) {
    total += 1 / (i + 1);
    cumulative.push(total);
  }
  const word = () => {
    const x = rnd() * total;
    let lo = 0;
    let hi = VOCAB - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    return `w${lo}`;
  };
  const taste = new Map<string, number>();
  const tasteOf = (w: string) => {
    let t = taste.get(w);
    if (t === undefined) {
      t = (rnd() - 0.5) * 2;
      taste.set(w, t);
    }
    return t;
  };
  const article = (): EstimateArticle & { liked: boolean } => {
    const title = Array.from({ length: 6 }, word);
    const excerpt = Array.from({ length: 20 }, word);
    let score = 0;
    for (const w of [...title, ...excerpt]) score += tasteOf(w);
    return {
      title: title.join(' '),
      excerpt: excerpt.join(' '),
      feedId: FEEDS[Math.floor(rnd() * FEEDS.length)] as string,
      liked: score > 0,
    };
  };
  const samples = (n: number): EstimateSample[] =>
    Array.from({ length: n }, (_, i) => {
      const { liked, ...rest } = article();
      const flip = rnd() < 0.2;
      return {
        ...rest,
        articleId: `a${String(i).padStart(5, '0')}`,
        rating: (liked !== flip ? 1 : -1) as 1 | -1,
        ratedAt: new Date(T0 + i * 60_000),
      };
    });
  const probes = (n: number): EstimateArticle[] =>
    Array.from({ length: n }, () => {
      const { liked: _liked, ...rest } = article();
      return rest;
    });
  return { samples, probes };
}

const world = makeWorld('stability');
const base = world.samples(1_500);
const probes = world.probes(300);

function model(samples: EstimateSample[], options = {}): EstimateModel {
  const r = trainEstimateModel(samples, options);
  if (!r.ok) throw new Error('expected a model');
  return r.model;
}

function moved(a: EstimateModel, b: EstimateModel) {
  let p = 0;
  let tier = 0;
  for (const probe of probes) {
    const features = estimateFeatures(probe);
    const pa = scoreEstimate(a, features)?.p as number;
    const pb = scoreEstimate(b, features)?.p as number;
    if (Math.abs(pa - pb) >= 0.01) p += 1;
    if (tierFromP(pa, DEFAULT_RANKER_CONFIG) !== tierFromP(pb, DEFAULT_RANKER_CONFIG)) tier += 1;
  }
  return { p: p / probes.length, tier: tier / probes.length };
}

const distinct = new Set(base.flatMap((s) => estimateFeatures(s))).size;
const extra = world
  .samples(1_501)
  .slice(1_500)
  .map((s) => ({
    ...s,
    articleId: 'a99999',
    ratedAt: new Date(T0 + 1_500 * 60_000),
  }));

const cases: [string, EstimateSample[]][] = [
  ['adding the newest rating', [...base, ...extra]],
  ['removing a middle rating', base.filter((_, i) => i !== 700)],
  ['removing the oldest rating', base.slice(1)],
];
const variants: [string, object][] = [
  ['default options', {}],
  ['pruned weights', { maxWeights: Math.floor(distinct / 3) }],
];

describe('estimate stability under one rating more or less', () => {
  const unpruned = model(base);
  for (const [variant, options] of variants) {
    const reference = variant === 'default options' ? unpruned : model(base, options);
    if (variant === 'pruned weights') {
      it('keeps broadly supported words at the pruning cut (D-301)', () => {
        const support = new Map<string, number>();
        for (const sample of base) {
          for (const feature of new Set(estimateFeatures(sample))) {
            support.set(feature, (support.get(feature) ?? 0) + 1);
          }
        }
        const weights = Object.entries(unpruned.weights);
        const keep = Math.floor(distinct / 3);
        const impact = ([name, weight]: [string, number]) =>
          Math.abs(weight) * Math.sqrt(support.get(name)!);
        const expected = [...weights]
          .sort((a, b) => impact(b) - impact(a) || (a[0] < b[0] ? -1 : 1))
          .slice(0, keep)
          .map(([name]) => name)
          .sort();
        const byMagnitude = [...weights]
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1))
          .slice(0, keep)
          .map(([name]) => name)
          .sort();
        // Guard the corpus: it must distinguish support-aware pruning from |w| alone.
        expect(expected).not.toEqual(byMagnitude);
        expect(Object.keys(reference.weights)).toEqual(expected);
      });
    }
    for (const [name, samples] of cases) {
      it(`${name} moves few probes (${variant})`, () => {
        const share = moved(reference, model(samples, options));
        expect(share.p).toBeLessThanOrEqual(0.1);
        expect(share.tier).toBeLessThanOrEqual(0.03);
      });
    }
  }
});
