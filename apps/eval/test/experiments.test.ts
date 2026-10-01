import { describe, expect, it } from 'vitest';

import {
  EXPERIMENT_IDS,
  EXPERIMENTS,
  isExperimentId,
  REPLAYABLE_EXPERIMENTS,
} from '../src/experiments/definitions.js';
import { EXAMPLE_MAX_CHARS, isOffTopic, planE6 } from '../src/experiments/e6.js';
import { pairedAuc, rocAuc, seededRandom } from '../src/experiments/paired-auc.js';
import {
  cardBodyOf,
  computeConfigSha,
  parseRunConfig,
  withConfigSha,
  type RunCard,
  type RunConfig,
  type RunRating,
} from '../src/experiments/run-config.js';
import { latencySummary, mapPool } from '../src/experiments/util.js';

/** M3a-T6: experiments as config objects (spec 10 §3) and the pure run helpers. */

describe('experiment definitions', () => {
  it('defines every spec 10 §3 experiment as a config object', () => {
    expect([...EXPERIMENT_IDS]).toEqual([
      'B0',
      'B1',
      'B1-T',
      'E1',
      'E2',
      'E3',
      'E3b',
      'E4',
      'E5',
      'E6',
      'E7',
    ]);
    for (const id of EXPERIMENT_IDS) {
      expect(EXPERIMENTS[id].id).toBe(id);
      expect(isExperimentId(id)).toBe(true);
    }
    expect(isExperimentId('E8')).toBe(false);
    expect(Object.isFrozen(EXPERIMENTS)).toBe(true);
  });

  it('maps each experiment to its state, card text, engine and translation', () => {
    const summary = Object.fromEntries(
      EXPERIMENT_IDS.map((id) => {
        const d = EXPERIMENTS[id];
        return [
          id,
          [
            d.score,
            d.variant.state,
            d.variant.cards,
            d.engine,
            d.translation.articles,
            d.translation.cards,
          ],
        ];
      }),
    );
    expect(summary).toEqual({
      B0: ['chrono', 'none', 'as_written', null, null, null],
      B1: ['bm25', 'native', 'as_written', null, null, null],
      'B1-T': ['bm25', 'lt', 'english', null, 'libretranslate', 'libretranslate'],
      E1: ['cards', 'native', 'as_written', 'typesafe', null, null],
      E2: ['cards', 'native', 'english', 'typesafe', null, 'libretranslate'],
      E3: ['cards', 'lt', 'as_written', 'typesafe', 'libretranslate', null],
      E3b: ['cards', 'lt', 'english', 'typesafe', 'libretranslate', 'libretranslate'],
      E4: ['cards', 'glm', 'selected', 'typesafe', 'ollama', 'libretranslate'],
      E5: ['cards', 'native', 'as_written', 'laya', null, null],
      E6: ['cards', 'native', 'as_written', 'typesafe', null, null],
      E7: ['cards', 'native', 'as_written', 'typesafe', null, null],
    });
    expect(EXPERIMENTS.E4.defaultLangs).toEqual(['sk', 'cs']);
    expect(EXPERIMENTS.E5.skipReason).toMatch(/laya/);
    for (const id of ['E6', 'E7'] as const) {
      expect(EXPERIMENTS[id]).toMatchObject({
        developmentOnly: true,
        gateInput: false,
        baseExperiment: 'E1',
      });
    }
    expect(EXPERIMENT_IDS.filter((id) => EXPERIMENTS[id].gateInput)).toEqual([
      'B0',
      'B1',
      'B1-T',
      'E1',
      'E2',
      'E3',
      'E3b',
    ]);
    expect(REPLAYABLE_EXPERIMENTS).toEqual(['E1', 'E2', 'E3', 'E3b', 'E4']);
  });
});

function card(overrides: Partial<RunCard> = {}): RunCard {
  return {
    raterId: '1',
    cardId: '10',
    strength: 'like',
    kind: 'interest',
    title: 'Batteries',
    interest: 'batérie do elektromobilov',
    notFor: 'reklama',
    interestEn: 'electric vehicle batteries',
    notForEn: 'advertising',
    lang: 'sk',
    examplesYes: [],
    examplesNo: [],
    visibility: 'shared',
    ownerUserId: null,
    textStatus: 'ok',
    ...overrides,
  };
}

function config(): Omit<RunConfig, 'configSha'> {
  return {
    experiment: 'E1',
    variant: { state: 'native', cards: 'as_written' },
    datasetVersion: 'golden-v1',
    snapshotSha: 's',
    splitSha: 't',
    seed: 'seed-1',
    engine: null,
    questionSets: null,
    translation: { articles: null, cards: null },
    langs: ['en'],
    developmentOnly: false,
    raters: [],
    cohort: { articleIds: [], sha: 'x' },
    assignments: {},
    ratings: [],
    cards: [card()],
    facetLabels: [],
    maxUsd: 10,
    runtime: {},
  };
}

describe('run config', () => {
  it('hashes every field into configSha and parses back', () => {
    const full = withConfigSha(config());
    expect(full.configSha).toBe(computeConfigSha(config()));
    expect(parseRunConfig(JSON.parse(JSON.stringify(full)))).toEqual(full);
    expect(computeConfigSha({ ...config(), seed: 'seed-2' })).not.toBe(full.configSha);
    expect(() => parseRunConfig({ ...full, ratings: [{ raterId: 'x' }] })).toThrow();
  });

  it('uses the English card pair only in english mode', () => {
    expect(cardBodyOf(card(), 'as_written')).toMatchObject({
      interest: 'batérie do elektromobilov',
      interest_en: null,
      not_for_en: null,
    });
    expect(cardBodyOf(card(), 'english')).toMatchObject({
      interest_en: 'electric vehicle batteries',
      not_for_en: 'advertising',
    });
  });
});

describe('planE6', () => {
  const rating = (articleId: string, value: 1 | -1, minute: number, reason: string | null = null) =>
    ({
      raterId: '1',
      articleId,
      rating: value,
      reason,
      createdAt: `2026-09-20T10:${String(minute).padStart(2, '0')}:00.000Z`,
    }) satisfies RunRating;

  it('splits by story group in rating order and adds examples from the earlier half only', () => {
    const cards = [card({ cardId: '10' }), card({ cardId: '11', strength: 'never' })];
    const ratings = [
      rating('100', -1, 1, 'Off-topic'), // early, p 0.9 ≥ maybe → no example
      rating('101', 1, 2), // early, p 0.5 in [maybe, forYou) → yes example
      rating('102', 1, 3), // early, p 0.9 ≥ forYou → nothing
      rating('103', -1, 4, 'too_long'), // early, not off topic → nothing
      rating('104', 1, 5), // later (shares a group with 105)
      rating('105', -1, 6, 'off_topic'),
      rating('106', 1, 7),
      rating('107', 1, 8),
      rating('108', 1, 9),
    ];
    const articles = new Map(
      ratings.map((r) => [
        r.articleId,
        {
          storyGroupId: r.articleId === '105' ? 'g104' : `g${r.articleId}`,
          title: `Title ${r.articleId} ${'long '.repeat(r.articleId === '101' ? 60 : 1)}`,
        },
      ]),
    );
    const p = { '100': 0.9, '101': 0.5, '102': 0.9, '103': 0.9, '105': 0.9 } as Record<
      string,
      number
    >;
    const answers = new Map(
      Object.entries(p).map(([articleId, value]) => [
        articleId,
        new Map([
          ['10', { p: value, engine: 'typesafe' }],
          ['11', { p: 0.99, engine: 'typesafe' }],
        ]),
      ]),
    );
    const plan = planE6({ cards, ratings, articles, answers });
    // 8 groups → the first 4 (100–103) are the earlier half.
    expect(plan.earlierArticleIds).toEqual(['100', '101', '102', '103']);
    expect(plan.laterArticleIds).toEqual(['104', '105', '106', '107', '108']);
    expect(plan.laterByRater.get('1')).toEqual(['104', '105', '106', '107', '108']);
    expect(plan.examplesAdded).toEqual({ '10': { yes: 1, no: 1 } });
    const updated = plan.cardsByRater.get('1')?.find((c) => c.cardId === '10');
    expect(updated?.examplesNo).toEqual(['Title 100 long']);
    expect(updated?.examplesYes).toHaveLength(1);
    expect([...(updated?.examplesYes[0] ?? '')].length).toBeLessThanOrEqual(EXAMPLE_MAX_CHARS);
    // The input cards are not mutated.
    expect(cards[0]?.examplesYes).toEqual([]);
  });

  it('ignores non-typesafe answers and keeps the newest five examples per side', () => {
    const existing = ['a', 'b', 'c', 'd', 'e'];
    const cards = [card({ cardId: '10', examplesNo: existing })];
    const ratings = Array.from({ length: 4 }, (_, i) =>
      rating(String(200 + i), -1, i, 'off_topic'),
    );
    const articles = new Map(
      ratings.map((r) => [
        r.articleId,
        { storyGroupId: `g${r.articleId}`, title: `T${r.articleId}` },
      ]),
    );
    const answers = new Map([
      ['200', new Map([['10', { p: 0.9, engine: 'typesafe' }]])],
      ['201', new Map([['10', { p: 0.9, engine: 'llm' }]])],
    ]);
    const plan = planE6({ cards, ratings, articles, answers });
    expect(plan.cardsByRater.get('1')?.[0]?.examplesNo).toEqual(['b', 'c', 'd', 'e', 'T200']);
    expect(plan.examplesAdded).toEqual({ '10': { yes: 0, no: 1 } });
    expect(isOffTopic(' Off Topic ')).toBe(true);
    expect(isOffTopic(null)).toBe(false);
  });
});

describe('paired AUC', () => {
  it('computes Mann–Whitney AUC with ties as ½ and null for one class', () => {
    expect(rocAuc([0.9, 0.8, 0.1, 0.2], [1, 1, 0, 0])).toBe(1);
    expect(rocAuc([0.5, 0.5], [1, 0])).toBe(0.5);
    expect(rocAuc([0.1, 0.9, 0.2, 0.8], [1, 1, 0, 0])).toBe(0.5);
    expect(rocAuc([0.4, 0.6], [1, 1])).toBeNull();
  });

  it('bootstraps a paired interval by story group, deterministically', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      label: (i % 2) as 0 | 1,
      base: (i % 2) * 0.5 + (i % 7) / 20,
      replay: (i % 2) * 0.7 + (i % 5) / 20,
      group: `g${Math.floor(i / 2)}`,
    }));
    const a = pairedAuc(items, { seed: 'x', resamples: 200 });
    expect(a).toEqual(pairedAuc(items, { seed: 'x', resamples: 200 }));
    expect(a.n).toBe(40);
    expect(a.positives).toBe(20);
    expect(a.delta).toBeCloseTo((a.replay ?? 0) - (a.base ?? 0), 12);
    expect(a.ci).not.toBeNull();
    const [lo, hi] = a.ci ?? [0, 0];
    expect(lo).toBeLessThanOrEqual(a.delta ?? 0);
    expect(hi).toBeGreaterThanOrEqual(a.delta ?? 0);
    const r = seededRandom('s');
    const v = r();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

describe('util', () => {
  it('nearest-rank latency percentiles', () => {
    expect(latencySummary([])).toEqual({ p50: 0, p95: 0, n: 0 });
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(latencySummary(samples)).toEqual({ p50: 50, p95: 95, n: 100 });
  });

  it('mapPool keeps order and bounds concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});
