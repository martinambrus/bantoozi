import { canonicalSha256 } from '@bantoozi/shared/server';
import { describe, expect, it } from 'vitest';

import {
  assessGateRuns,
  buildG1,
  commonDevMacros,
  composedCostPerArticle,
  foreignEngineAnswers,
  confirmOnTest,
  developmentInput,
  gateLangs,
  gateReadiness,
  pairedDevMacros,
  selectOnDevelopment,
} from '../src/report/gate.js';
import { chooseCardMode, chooseLanguageMode, selectCore } from '../src/report/decision.js';
import { G1Schema, g1ConfigSha } from '../src/report/g1-schema.js';
import { onSplit, runScore, type RatedItem } from '../src/report/items.js';
import { buildReportModel, latestRuns, type ReportModel } from '../src/report/model.js';
import { buildCells, macroAuc } from '../src/report/ranking.js';
import { parseRunData, type RawAnswer, type RunData } from '../src/report/run-data.js';
import {
  buildFixture,
  DATASET,
  makeRawRun,
  makeRun,
  standardRuns,
  standardSpecs,
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
    // Selection keeps the default (native) for it and writes that mode explicitly, so applying G1
    // deploys the composition the gate scored and budgeted, not a stored `translate`.
    const { assessments } = setup(fixture, standardRuns(fixture));
    const selection = select(model, assessments);
    expect(selection.languages.find((l) => l.lang === 'cs')?.mode).toBeNull();
    expect(selection.composition['cs']).toMatch(/^E[12]$/);
    expect(selection.languageModes['cs']).toBe('native');
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

  it('pools only supported development contexts for the thresholds', () => {
    const fixture = buildFixture();
    const runs = standardRuns(fixture);
    const { model, assessments } = setup(fixture, runs);
    const before = select(model, assessments);
    // A one-participant context with three liked development items (below the support rule) would
    // otherwise carry a third of the participant's weight in the pool.
    const tiny = onSplit(model.items, 'dev')
      .filter((i) => i.raterId === '1')
      .slice(0, 3)
      .map((i) => ({ ...i, key: `tiny:${i.articleId}`, contextId: 'tiny', liked: true }));
    const after = select({ ...model, items: [...model.items, ...tiny] }, assessments);
    expect(after.thresholds).toEqual(before.thresholds);
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

  it('compares a language-subset run (E4 on SK only) with the reference restricted to it', () => {
    const fixture = buildFixture();
    const isSk = (id: string) => fixture.sample.get(id)?.lang === 'sk';
    const e4 = (scoped: boolean) => {
      const spec = standardSpecs().find((x) => x.experiment === 'E4')!;
      const raw = makeRawRun(fixture, spec);
      const config = raw.run.config as {
        langs: string[];
        cohort: { articleIds: string[]; sha: string };
        ratings: { articleId: string }[];
      };
      config.langs = ['sk'];
      if (scoped) {
        const articleIds = config.cohort.articleIds.filter(isSk);
        config.cohort = { articleIds, sha: canonicalSha256(articleIds) };
        config.ratings = config.ratings.filter((r) => isSk(r.articleId));
        // An SK run has no English answers and records no English coverage.
        const results = raw.run.results as { coverage: { byLang: Record<string, unknown> } };
        delete results.coverage.byLang['en'];
        return parseRunData(
          raw.run,
          raw.answers.filter((a) => isSk(a.articleId)),
        );
      }
      return parseRunData(raw.run, raw.answers);
    };
    const withE4 = (run: RunData) =>
      standardRuns(fixture).map((r) => (r.experiment === 'E4' ? run : r));
    const scoped = setup(fixture, withE4(e4(true))).assessments.get('E4')!;
    expect(scoped.reasons).not.toContain('cohort differs from the reference run');
    expect(scoped.reasons).not.toContain('ratings differ from the reference run');
    expect(scoped.reasons.join(' ')).not.toMatch(/coverage/);
    // An SK run that still carries the English cohort and ratings is not that subset.
    const unscoped = setup(fixture, withE4(e4(false))).assessments.get('E4')!;
    expect(unscoped.reasons).toContain('cohort differs from the reference run');
    expect(unscoped.reasons).toContain('ratings differ from the reference run');
  });

  it('checks E6 against the development pairs of its base run for its raters', () => {
    const fixture = buildFixture();
    const rater = fixture.raters[0]!.raterId;
    const e6 = (scoped: boolean) => {
      const raw = makeRawRun(fixture, { id: '19', experiment: 'E6', signal: () => 0.85 });
      const config = raw.run.config as {
        baseRunId?: string;
        raters: { raterId: string }[];
        cohort: { articleIds: string[]; sha: string };
        ratings: { raterId: string; articleId: string }[];
      };
      config.baseRunId = '14';
      if (scoped) {
        const isDev = (id: string) => fixture.sample.get(id)?.split === 'dev';
        config.raters = config.raters.filter((r) => r.raterId === rater);
        config.ratings = config.ratings.filter((r) => r.raterId === rater && isDev(r.articleId));
        const articleIds = [...new Set(config.ratings.map((r) => r.articleId))].sort(
          (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
        );
        config.cohort = { articleIds, sha: canonicalSha256(articleIds) };
      }
      return parseRunData(raw.run, raw.answers);
    };
    const scoped = setup(fixture, [...standardRuns(fixture), e6(true)]).assessments.get('E6')!;
    expect(scoped.reasons).not.toContain('cohort differs from the reference run');
    expect(scoped.reasons).not.toContain('ratings differ from the reference run');
    // The full reference cohort is not what an E6 run on rater A's development pairs carries.
    const full = setup(fixture, [...standardRuns(fixture), e6(false)]).assessments.get('E6')!;
    expect(full.reasons).toContain('cohort differs from the reference run');
  });

  it('audits Call A answers and per-rater card answers for the pinned engine', () => {
    const fixture = buildFixture();
    const rating = fixture.ratings[0]!;
    const withRows = (experiment: string, rows: RawAnswer[]) => {
      const spec = standardSpecs().find((x) => x.experiment === experiment)!;
      const raw = makeRawRun(fixture, spec);
      return parseRunData(raw.run, [...raw.answers, ...rows]);
    };
    const runs = standardRuns(fixture).map((run) => {
      // E1: one Call A answer (it feeds the demotion cutoffs) came from the LLM fallback.
      if (run.experiment === 'E1') {
        return withRows('E1', [
          {
            articleId: rating.articleId,
            cardId: null,
            questionKey: 'enrich.clickbait',
            answer: { ok: true, answer: { type: 'noul', p: 0.4 }, engine: 'llm' },
          },
        ]);
      }
      // E2: one rater's own copy of a shared card (`card.r<raterId>`) came from the LLM fallback.
      if (run.experiment === 'E2') {
        return withRows('E2', [
          {
            articleId: rating.articleId,
            cardId: fixture.cardIdOf(rating.raterId),
            questionKey: `card.r${rating.raterId}`,
            answer: { ok: true, p: 0.4, engine: 'llm' },
          },
        ]);
      }
      return run;
    });
    const { assessments } = setup(fixture, runs);
    expect(assessments.get('E1')?.eligible).toBe(false);
    expect(assessments.get('E1')?.reasons).toContain(
      '1 answers from an engine other than the pinned one',
    );
    expect(assessments.get('E2')?.eligible).toBe(false);
    expect(assessments.get('E2')?.reasons).toContain(
      '1 answers from an engine other than the pinned one',
    );
    // TypeSafe answers everywhere else: the other core candidates stay eligible.
    expect(assessments.get('E3')?.eligible).toBe(true);
    expect(foreignEngineAnswers(assessments.get('E3')!.run!)).toBe(0);
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
  it('confirms on the test items both sides scored, so missing hard items cannot make a pass', () => {
    const fixture = buildFixture();
    const weak = { signal: () => 0.2 };
    const runs = standardRuns(fixture, { E1: weak, E2: weak, E3: weak, E3b: weak, E4: weak });
    const { model, assessments } = setup(fixture, runs);
    const selection = select(model, assessments);
    expect(selection.status).toBe('selected');
    const composed = (lang: string) => assessments.get(selection.composition[lang]!)!.run!;
    const baseline = assessments.get(selection.baseline!)!.run!;
    // The baseline scores every item exactly like the composition: no real gain on any item.
    baseline.scores.clear();
    for (const item of model.items) {
      const score = runScore(composed(item.lang), item);
      let inner = baseline.scores.get(item.raterId);
      if (inner === undefined) baseline.scores.set(item.raterId, (inner = new Map()));
      inner.set(item.articleId, score);
    }
    // The composition loses its worst-ranked liked test items (within the 5% coverage allowance).
    const test = onSplit(model.items, 'test');
    for (const lang of ['en', 'sk']) {
      const all = model.items.filter((i) => i.lang === lang).length;
      const hard = test
        .filter((i) => i.lang === lang && i.liked && runScore(composed(lang), i) !== null)
        .sort((x, y) => runScore(composed(lang), x)! - runScore(composed(lang), y)!)
        .slice(0, Math.floor(all * 0.04));
      for (const item of hard) composed(lang).scores.get(item.raterId)!.set(item.articleId, null);
    }
    // Unpaired, each side on its own scored items, the composition would clear +0.05 and win.
    const cells = buildCells(test, 'context');
    const view = (item: RatedItem) => runScore(composed(item.lang), item);
    const alone = macroAuc(cells, view).value!;
    const base = macroAuc(cells, (item) => runScore(baseline, item)).value!;
    expect(alone - base).toBeGreaterThanOrEqual(0.05);
    // Paired, both sides are the same scores on the same items: no gain, no participant win.
    const confirmation = confirmOnTest(model, assessments, selection, settings);
    expect(confirmation.macro).toBeCloseTo(confirmation.baselineMacro!, 10);
    expect(confirmation.decision.status).toBe('fail');
    expect(confirmation.decision.reasons.join(' ')).toMatch(/does not beat the baseline/);
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

describe('paired development gains', () => {
  // One supported context: 10 liked and 10 disliked articles. Both runs rank every like above
  // every dislike except one hard disliked case (article 20), which both score above all likes.
  const items: RatedItem[] = Array.from({ length: 20 }, (_, i) => {
    const articleId = String(i + 1);
    return {
      key: `1:${articleId}`,
      raterId: '1',
      contextId: '1',
      participantKey: 'owner',
      articleId,
      lang: 'sk',
      split: 'dev',
      groupId: `g${articleId}`,
      firstSeenAt: i,
      liked: i < 10,
      title: null,
    };
  });
  const cells = buildCells(items, 'context');
  const scored = (id: string, missing: readonly string[]): RunData =>
    ({
      id,
      scores: new Map([
        [
          '1',
          new Map(
            items.map((item, i) => [
              item.articleId,
              missing.includes(item.articleId) ? null : item.articleId === '20' ? 2 : 1 - i / 20,
            ]),
          ),
        ],
      ]),
    }) as unknown as RunData;

  it('ranks a candidate set on the items every candidate scored, so missing a hard case wins nothing', () => {
    // E1 scores everything, including the hard case it ranks on top (0.9 alone, 1.0 without it).
    const e1 = scored('e1', []);
    // E2 misses the hard case and swaps one like below one dislike (89/90 on what it scored).
    const e2 = scored('e2', ['20']);
    e2.scores.get('1')!.set('10', 0.48);
    const choose = (macros: Record<string, number | null>) =>
      selectCore(
        (['E1', 'E2', 'E3', 'E3b'] as const).map((experiment) => ({
          experiment,
          eligible: macros[experiment] !== null && macros[experiment] !== undefined,
          devMacroAuc: macros[experiment] ?? null,
        })),
      );
    const alone = {
      E1: pairedDevMacros(cells, e1, null).a,
      E2: pairedDevMacros(cells, e2, null).a,
    };
    expect(alone.E1).toBeCloseTo(0.9, 10);
    expect(alone.E2).toBeCloseTo(89 / 90, 10);
    expect(choose(alone)).toBe('E2');
    const common = commonDevMacros(cells, { E1: e1, E2: e2, E3: null, E3b: null });
    expect(common.E1).toBe(1);
    expect(common.E2).toBeCloseTo(89 / 90, 10);
    expect(common.E3).toBeNull();
    expect(choose(common)).toBe('E1');
  });

  it('compares two runs on the items both scored, so a one-sided missing hard case cannot flip a decision', () => {
    const full = scored('a', []);
    const lacksHardCase = scored('b', ['20']); // 1 of 20 missing: within the 5% coverage allowance
    // Each side alone (no partner run): the run that skipped the hard case looks 0.1 better.
    const alone = {
      a: pairedDevMacros(cells, full, null).a,
      b: pairedDevMacros(cells, lacksHardCase, null).a,
    };
    expect(alone.a).toBeCloseTo(0.9, 10);
    expect(alone.b).toBe(1);
    expect(chooseCardMode({ asWritten: alone.a, english: alone.b }).mode).toBe('english');
    const paired = pairedDevMacros(cells, full, lacksHardCase);
    expect(paired).toEqual({ a: 1, b: 1 });
    expect(chooseCardMode({ asWritten: paired.a, english: paired.b })).toMatchObject({
      mode: 'as_written',
      gain: 0,
    });
    // Language mode: the translated run missing the hard case no longer earns `translate`.
    const lang = pairedDevMacros(cells, full, lacksHardCase);
    expect(
      chooseLanguageMode({
        lang: 'sk',
        native: lang.a,
        translated: lang.b,
        bilingual: { native: null, english: null },
      }),
    ).toMatchObject({ mode: 'native', translationGain: 0 });
    expect(pairedDevMacros(cells, lacksHardCase, null)).toEqual({ a: 1, b: null });
  });
});
