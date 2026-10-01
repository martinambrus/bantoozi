import { describe, expect, it } from 'vitest';

import {
  assessGateRuns,
  buildG1,
  composedCostPerArticle,
  confirmOnTest,
  developmentInput,
  gateLangs,
  gateReadiness,
  selectOnDevelopment,
} from '../src/report/gate.js';
import { G1Schema, g1ConfigSha } from '../src/report/g1-schema.js';
import { onSplit, runScore } from '../src/report/items.js';
import { buildReportModel, latestRuns, type ReportModel } from '../src/report/model.js';
import type { RunData } from '../src/report/run-data.js';
import {
  buildFixture,
  DATASET,
  makeRun,
  standardRuns,
  type Fixture,
  type RunSpec,
} from './gate-fixtures.js';

/** M3a-T7: the gate over synthetic runs (pure: no database). */

const settings = { seed: 'gate-test', resamples: 50 };

function setup(fixture: Fixture, runs: RunData[]) {
  const model = buildReportModel({ datasetVersion: DATASET.version, runs, sample: fixture.sample });
  const chosen = latestRuns(runs);
  const assessments = assessGateRuns(model, chosen, DATASET);
  return { model, assessments };
}

function select(
  model: ReportModel,
  assessments: ReturnType<typeof assessGateRuns>,
  profile = 'owner_pilot' as const,
) {
  return selectOnDevelopment(developmentInput(model, assessments, profile, DATASET, 1000));
}

describe('gate readiness', () => {
  it('counts one owner with two contexts as one participant and is ready for owner_pilot', () => {
    const fixture = buildFixture();
    const { model } = setup(fixture, standardRuns(fixture));
    const readiness = gateReadiness(model, 'owner_pilot');
    expect(readiness.participants).toBe(1);
    expect(readiness.perParticipant[0]).toMatchObject({ contexts: 2, distinctRated: 400 });
    expect(readiness.ready).toBe(true);
    expect(readiness.measuredLangs).toEqual(['en', 'sk']);
  });

  it('never lets personas satisfy multi_person_beta', () => {
    const fixture = buildFixture();
    const { model } = setup(fixture, standardRuns(fixture));
    const readiness = gateReadiness(model, 'multi_person_beta');
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons[0]).toMatch(/≥3 actual participants, found 1/);
  });

  it('is not ready below 250 distinct ratings or 60 held-out articles', () => {
    const fixture = buildFixture({ perLang: 60 });
    const { model } = setup(fixture, standardRuns(fixture));
    const readiness = gateReadiness(model, 'owner_pilot');
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons.join(' ')).toMatch(/120 distinct rated articles < 250/);
  });

  it('marks a language without a supported test cell unmeasured', () => {
    const fixture = buildFixture({
      raters: [
        {
          raterId: '1',
          participantKey: 'owner',
          contextName: 'web',
          langs: ['en'],
          cardLang: 'en',
        },
      ],
      langs: ['en', 'cs'],
      perLang: 300,
    });
    const { model } = setup(fixture, standardRuns(fixture));
    const readiness = gateReadiness(model, 'owner_pilot');
    expect(readiness.measuredLangs).toEqual(['en']);
    expect(readiness.unmeasuredLangs).toEqual(['cs']);
  });
});

describe('development selection and test confirmation', () => {
  it('selects E*, the baseline and the composition, then passes on test', () => {
    const fixture = buildFixture();
    const { model, assessments } = setup(fixture, standardRuns(fixture));
    expect([...assessments.values()].filter((a) => a.run !== null).every((a) => a.eligible)).toBe(
      true,
    );
    const selection = select(model, assessments);
    expect(selection.status).toBe('selected');
    expect(selection.baseline).toMatch(/^B1/);
    expect(selection.core).toMatch(/^E/);
    expect(Object.keys(selection.composition)).toEqual(['en', 'sk']);
    expect(selection.languageModes['en']).toBe('native');
    const confirmation = confirmOnTest(model, assessments, selection, settings);
    expect(confirmation.decision.status).toBe('pass');
    expect(confirmation.macro! - confirmation.baselineMacro!).toBeGreaterThan(0.05);
    const g1 = G1Schema.parse(
      buildG1({
        selection,
        status: confirmation.decision.status,
        participants: 1,
        lockedAt: new Date('2026-10-01T00:00:00Z'),
        reportSha: 'd'.repeat(64),
        notes: '',
        dryRun: false,
      }),
    );
    expect(g1.selection.configSha).toBe(g1ConfigSha({ ...g1, profile: g1.gate.profile }));
    expect(g1.runs['E1']).toBe('14');
  });

  it('isolates the split: flipping every test label changes nothing in the selection', () => {
    const fixture = buildFixture();
    const flipped: Fixture = {
      ...fixture,
      ratings: fixture.ratings.map((r) =>
        fixture.sample.get(r.articleId)?.split === 'test'
          ? { ...r, rating: r.rating === 1 ? -1 : 1 }
          : r,
      ),
    };
    const a = setup(fixture, standardRuns(fixture));
    const b = setup(flipped, standardRuns(flipped));
    const selA = select(a.model, a.assessments);
    const selB = select(b.model, b.assessments);
    expect(selB).toEqual(selA);
    // The test outcome does see the flipped labels.
    const confA = confirmOnTest(a.model, a.assessments, selA, settings);
    const confB = confirmOnTest(b.model, b.assessments, selB, settings);
    expect(confB.macro).not.toEqual(confA.macro);
    // Test items handed to the selection are ignored.
    const input = developmentInput(a.model, a.assessments, 'owner_pilot', DATASET, 1000);
    const leaky = selectOnDevelopment({
      ...input,
      devItems: [...input.devItems, ...onSplit(b.model.items, 'test')],
    });
    expect(leaky).toEqual(selA);
  });

  it('composes per language and pools the composed scores for the global thresholds', () => {
    const fixture = buildFixture();
    const runs = standardRuns(fixture, {
      E1: { signal: (lang) => (lang === 'sk' ? 0.3 : 0.9) },
      E2: { signal: () => 0.2 },
      E3: { signal: () => 0.95 },
      E3b: { signal: () => 0.2 },
    });
    const { model, assessments } = setup(fixture, runs);
    const selection = select(model, assessments);
    expect(selection.cardMode.mode).toBe('as_written');
    expect(selection.languages.find((l) => l.lang === 'sk')?.mode).toBe('translate');
    expect(selection.composition).toEqual({ en: 'E1', sk: 'E3' });
    const confirmation = confirmOnTest(model, assessments, selection, settings);
    const e3 = runs.find((r) => r.experiment === 'E3')!;
    const e1 = runs.find((r) => r.experiment === 'E1')!;
    const sk = model.items.find((i) => i.lang === 'sk')!;
    const en = model.items.find((i) => i.lang === 'en')!;
    expect(confirmation.composedView.score(sk)).toBe(runScore(e3, sk));
    expect(confirmation.composedView.score(en)).toBe(runScore(e1, en));
    // The pooled For You rows count development items of both languages.
    const devItems = onSplit(model.items, 'dev').length;
    expect(selection.forYou.rows[0]!.coverage).toBeGreaterThan(0);
    expect(devItems).toBeGreaterThan(200);
  });

  it('chooses English card text when it helps non-English-card contexts, and E4 sets the tier-2 cap', () => {
    const fixture = buildFixture();
    const runs = standardRuns(fixture, {
      E1: { signal: () => 0.4 },
      E2: { signal: () => 0.95 },
      E3: { signal: () => 0.4 },
      E3b: { signal: () => 0.6 },
      E4: { cards: 'english', signal: (lang) => (lang === 'sk' ? 0.99 : 0.6) },
    });
    const { model, assessments } = setup(fixture, runs);
    const selection = select(model, assessments);
    expect(selection.core).toBe('E2');
    expect(selection.cardMode).toMatchObject({ mode: 'english', status: 'measured' });
    expect(selection.composition['en']).toBe('E2');
    expect(selection.tier2.cap).toBe(1000);
    // An E4 run in the other card mode is not comparable: the cap stays 300, unmeasured.
    const other = standardRuns(fixture, {
      E1: { signal: () => 0.4 },
      E2: { signal: () => 0.95 },
      E4: { cards: 'as_written', signal: () => 0.99 },
    });
    const b = setup(fixture, other);
    expect(select(b.model, b.assessments).tier2).toMatchObject({ cap: 300, status: 'unmeasured' });
  });

  it('is needs_more_data when a composition run has <95 % coverage (inconclusive, never an easy-items pass)', () => {
    const fixture = buildFixture();
    const runs = standardRuns(fixture, { E1: { missing: (lang) => (lang === 'sk' ? 0.2 : 0) } });
    const { model, assessments } = setup(fixture, runs);
    expect(assessments.get('E1')?.eligible).toBe(false);
    expect(assessments.get('E1')?.reasons.join(' ')).toMatch(/coverage .* for language sk/);
    const selection = select(model, assessments);
    // E1 is not eligible; another core candidate is selected, but a composition needing E1 cannot pass.
    if (Object.values(selection.composition).includes('E1')) {
      expect(selection.status).toBe('needs_more_data');
      expect(confirmOnTest(model, assessments, selection, settings).decision.status).toBe(
        'needs_more_data',
      );
    } else {
      expect(selection.core).not.toBe('E1');
    }
  });

  it('refuses runs with another ground truth, cohort, dataset or a fallback engine', () => {
    const fixture = buildFixture();
    const patched: Partial<Record<string, Partial<RunSpec>>> = {
      E2: { ratings: fixture.ratings.slice(1) },
      E3: { cohortSha: 'x' },
      E3b: { snapshotSha: 'e'.repeat(64) },
      E4: { engine: 'llm' },
      B1: { status: 'partial' },
    };
    const { assessments } = setup(fixture, standardRuns(fixture, patched));
    expect(assessments.get('E2')?.reasons).toContain('ratings differ from the reference run');
    expect(assessments.get('E3')?.reasons).toContain('cohort differs from the reference run');
    expect(assessments.get('E3b')?.reasons).toContain('dataset or split hash mismatch');
    expect(assessments.get('E4')?.reasons.join(' ')).toMatch(/engine other than the pinned one/);
    expect(assessments.get('B1')?.reasons).toContain('status partial');
    expect(assessments.get('E5')?.reasons).toEqual(['no run']);
  });

  it('fails when the composition does not beat the baseline by 0.05', () => {
    const fixture = buildFixture();
    const runs = standardRuns(fixture, {
      B1: { signal: () => 0.85 },
      'B1-T': { signal: () => 0.85 },
    });
    const { model, assessments } = setup(fixture, runs);
    const selection = select(model, assessments);
    const confirmation = confirmOnTest(model, assessments, selection, settings);
    expect(confirmation.decision.status).toBe('fail');
  });
});

describe('gate languages', () => {
  it('keeps dataset languages a --langs subset run did not serve', () => {
    const model = { langs: ['cs', 'en', 'sk'], reference: { config: { langs: ['en'] } } };
    expect(gateLangs(model as unknown as ReportModel)).toEqual(['cs', 'en', 'sk']);
  });
});

describe('budget over a mixed composition', () => {
  // EN = E1 (native), SK = E3 (translate). E3's translation spend falls on SK articles only.
  const fixture = buildFixture();
  const articleLang = new Map([...fixture.sample.values()].map((i) => [i.articleId, i.lang]));
  const devArticles = new Map<string, string[]>();
  for (const info of fixture.sample.values()) {
    if (info.split === 'dev')
      devArticles.set(info.lang, [...(devArticles.get(info.lang) ?? []), info.articleId]);
  }
  const count = (lang: string) => [...articleLang.values()].filter((l) => l === lang).length;
  const nEn = count('en');
  const nSk = count('sk');
  const devTotal = (devArticles.get('en')?.length ?? 0) + (devArticles.get('sk')?.length ?? 0);
  const wEn = (devArticles.get('en')?.length ?? 0) / devTotal;
  const wSk = 1 - wEn;
  type Cost = { billedUsd: number; cacheSavingsUsd: number };
  const withCost = (run: RunData, total: Cost, byLang?: Record<string, Cost>): RunData => ({
    ...run,
    results: {
      ...run.results!,
      cost: { ...run.results!.cost, ...total, ...(byLang === undefined ? {} : { byLang }) },
    },
  });
  // E1: $0.40 billed + $0.10 saved per language. E3: $0.50 on EN, $2.00 on SK (translation).
  const e1Lang = {
    en: { billedUsd: 0.4, cacheSavingsUsd: 0.1 },
    sk: { billedUsd: 0.4, cacheSavingsUsd: 0.1 },
  };
  const e3Lang = {
    en: { billedUsd: 0.5, cacheSavingsUsd: 0 },
    sk: { billedUsd: 1.5, cacheSavingsUsd: 0.5 },
  };
  const e1 = makeRun(fixture, { id: '14', experiment: 'E1', signal: () => 0.9 });
  const e3 = makeRun(fixture, { id: '16', experiment: 'E3', state: 'lt', signal: () => 0.9 });
  const trueCost = wEn * (0.5 / nEn) + wSk * (2.0 / nSk);
  const dilutedCost = wEn * (1.0 / (nEn + nSk)) + wSk * (2.5 / (nEn + nSk));

  it("uses each language's own cost when the runs record a per-language split", () => {
    const result = composedCostPerArticle(
      {
        en: withCost(e1, { billedUsd: 0.8, cacheSavingsUsd: 0.2 }, e1Lang),
        sk: withCost(e3, { billedUsd: 2.0, cacheSavingsUsd: 0.5 }, e3Lang),
      },
      devArticles,
      articleLang,
    );
    expect(result.basis).toBe('per_language');
    expect(result.usdPerArticle).toBeCloseTo(trueCost, 12);
    // The whole-run average would understate it (the P1 regression).
    expect(dilutedCost).toBeLessThan(trueCost);
  });

  it("charges a run's whole cost to its languages without a split (never below the true cost)", () => {
    const result = composedCostPerArticle(
      {
        en: withCost(e1, { billedUsd: 0.8, cacheSavingsUsd: 0.2 }),
        sk: withCost(e3, { billedUsd: 2.0, cacheSavingsUsd: 0.5 }),
      },
      devArticles,
      articleLang,
    );
    expect(result.basis).toBe('run_total');
    // EN: E1's $1.00 over EN articles only; SK: E3's $2.50 over SK articles only.
    expect(result.usdPerArticle).toBeCloseTo(wEn * (1.0 / nEn) + wSk * (2.5 / nSk), 12);
    expect(result.usdPerArticle!).toBeGreaterThanOrEqual(trueCost);
  });

  it("shares a run serving several languages over those languages' articles", () => {
    const run = withCost(e1, { billedUsd: 0.8, cacheSavingsUsd: 0.2 });
    const result = composedCostPerArticle({ en: run, sk: run }, devArticles, articleLang);
    expect(result.usdPerArticle).toBeCloseTo(1.0 / (nEn + nSk), 12);
  });

  it('is unmeasured when a run cost accounting is incomplete (a lower bound)', () => {
    const incomplete = (run: RunData, byLang: Record<string, Cost>): RunData => {
      const withSplit = withCost(run, { billedUsd: 0.8, cacheSavingsUsd: 0.2 }, byLang);
      return {
        ...withSplit,
        results: { ...withSplit.results!, cost: { ...withSplit.results!.cost, incomplete: true } },
      };
    };
    const result = composedCostPerArticle(
      {
        en: withCost(e1, { billedUsd: 0.8, cacheSavingsUsd: 0.2 }, e1Lang),
        sk: incomplete(e3, e3Lang),
      },
      devArticles,
      articleLang,
    );
    expect(result.usdPerArticle).toBeNull();
  });

  it('is unmeasured when a development language is missing from the composition', () => {
    const run = withCost(e1, { billedUsd: 0.8, cacheSavingsUsd: 0.2 }, e1Lang);
    expect(composedCostPerArticle({ en: run }, devArticles, articleLang).usdPerArticle).toBeNull();
  });

  it('is unmeasured when a composed run processed none of a language', () => {
    const enOnly: RunData = {
      ...withCost(e1, { billedUsd: 0.8, cacheSavingsUsd: 0.2 }),
      enrich: new Map([...e1.enrich].filter(([id]) => articleLang.get(id) === 'en')),
      cards: new Map([...e1.cards].filter(([id]) => articleLang.get(id) === 'en')),
      scores: new Map(
        [...e1.scores].map(([r, m]) => [
          r,
          new Map([...m].filter(([id]) => articleLang.get(id) === 'en')),
        ]),
      ),
      extra: new Map(),
    };
    expect(
      composedCostPerArticle({ en: enOnly, sk: enOnly }, devArticles, articleLang).usdPerArticle,
    ).toBeNull();
  });

  it('is unmeasured when a composed language has no run or no cost', () => {
    expect(
      composedCostPerArticle({ en: e1, sk: null }, devArticles, articleLang).usdPerArticle,
    ).toBeNull();
    const noCost: RunData = { ...e3, results: { ...e3.results!, cost: null } };
    expect(
      composedCostPerArticle({ en: e1, sk: noCost }, devArticles, articleLang).usdPerArticle,
    ).toBeNull();
  });
});
