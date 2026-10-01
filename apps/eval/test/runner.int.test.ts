import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadRunAnswers, openDatasetForCorrection, rateAssignment, tryLockRun } from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXPERIMENT_IDS } from '../src/experiments/definitions.js';
import { runExperiment } from '../src/experiments/runner.js';
import { composedCostPerArticle } from '../src/report/gate.js';
import { groundTruthSha } from '../src/report/items.js';
import { loadDataset } from '../src/report/load.js';
import { parseRunConfig, withConfigSha } from '../src/experiments/run-config.js';
import { parseRunData, raterCardResults, RunConfigSchema } from '../src/report/run-data.js';
import {
  answerCounts,
  runCli,
  runRow,
  runtime,
  seedGolden,
  setupRunnerTest,
  type GoldenFixture,
  type RunnerTestContext,
} from './runner-fixtures.js';

/**
 * M3a-T6 (spec 10 §3): `eval run` and `runExperiment` against fake TypeSafe, LibreTranslate and
 * Ollama. The estimate is printed before any model call; above $1 a confirmation (or `--yes`) is
 * required; the dataset is frozen before the first call; `eval.runs` gets the immutable config and
 * `eval.run_answers` resumable upserts; `--max-usd` aborts with partial answers; every experiment
 * of the matrix runs (E5 records `skipped`).
 */

let ctx: RunnerTestContext;
let golden: GoldenFixture;
const freshCache = () => mkdtemp(path.join(tmpdir(), 'bantoozi-eval-run-cache-'));

beforeAll(async () => {
  ctx = await setupRunnerTest();
  golden = await seedGolden(ctx);
});

afterAll(async () => {
  await ctx?.close();
});

async function frozen(): Promise<boolean> {
  const result = await ctx.owner.query<{ frozen: boolean }>(
    `SELECT frozen_at IS NOT NULL AS frozen FROM eval.datasets WHERE version = $1`,
    [golden.version],
  );
  return result.rows[0]!.frozen;
}

async function runCount(): Promise<number> {
  const result = await ctx.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM eval.runs');
  return result.rows[0]!.n;
}

describe('eval run (M3a-T6)', () => {
  let e1RunId = '';

  it('prints the estimate first and declines above $1 without --yes (nothing frozen, no run)', async () => {
    const before = ctx.typesafe.requestCount();
    const { rt, out } = runtime(ctx, {
      TYPESAFE_PRICE_PER_MTOK_USD: '5000',
      EVAL_CACHE_DIR: await freshCache(),
    });
    const asked: number[] = [];
    try {
      const result = await runExperiment(rt, {
        experiment: 'E1',
        gitSha: 'test',
        confirm: async (estimate) => {
          asked.push(estimate.estimatedUsd);
          return false;
        },
      });
      expect(result.status).toBe('declined');
      expect(result.runId).toBeNull();
      expect(result.estimate.estimatedUsd).toBeGreaterThan(1);
      expect(result.estimate.uncachedCalls).toBeGreaterThan(0);
      expect(asked).toEqual([result.estimate.estimatedUsd]);
    } finally {
      await rt.close();
    }
    expect(out()).toMatch(/E1 on golden-v1: estimated cost \$\d+\.\d{2} \(\d+ uncached request/);
    expect(ctx.typesafe.requestCount()).toBe(before);
    expect(await frozen()).toBe(false);
    expect(await runCount()).toBe(0);
  });

  it('the CLI refuses an estimate above $1 without --yes on a non-terminal', async () => {
    await expect(
      runCli(ctx, ['run', 'E1'], {
        TYPESAFE_PRICE_PER_MTOK_USD: '5000',
        EVAL_CACHE_DIR: await freshCache(),
      }),
    ).rejects.toMatchObject({ name: 'EvalCommandError', message: /above \$1; pass --yes/ });
    await expect(runCli(ctx, ['run', 'E9'])).rejects.toMatchObject({
      name: 'EvalCommandError',
      message: /name an experiment/,
    });
    expect(await runCount()).toBe(0);
  });

  it('runs E1: freezes first, immutable config, answers, scores and results through the eval router', async () => {
    const before = ctx.typesafe.requestCount();
    let countAtEstimate = -1;
    const { rt, out } = runtime(ctx, {}, (text) => {
      if (text.includes('estimated cost')) countAtEstimate = ctx.typesafe.requestCount();
    });
    let result;
    try {
      result = await runExperiment(rt, { experiment: 'E1', yes: true, gitSha: 'abc123' });
    } finally {
      await rt.close();
    }
    expect(countAtEstimate).toBe(before);
    expect(ctx.typesafe.requestCount()).toBeGreaterThan(before);
    expect(result.status).toBe('complete');
    e1RunId = result.runId!;
    expect(await frozen()).toBe(true);
    expect(out()).toContain(`run ${e1RunId} started`);

    const row = await runRow(ctx, e1RunId);
    expect(row.experiment).toBe('E1');
    expect(row.finished).toBe(true);
    expect(row.config).toMatchObject({
      experiment: 'E1',
      variant: { state: 'native', cards: 'as_written' },
      datasetVersion: 'golden-v1',
      seed: 'seed-1',
      engine: { provider: 'typesafe', model: 'jev-fake', requiredEngine: 'typesafe' },
      questionSets: { enrich: { version: 'enrich-v1' }, match: { version: 'match-v1' } },
      langs: ['en', 'sk'],
      maxUsd: 10,
    });
    expect(row.config['snapshotSha']).toMatch(/^[0-9a-f]{64}$/);
    expect(row.config['configSha']).toMatch(/^[0-9a-f]{64}$/);
    const config = row.config as {
      raters: unknown[];
      cards: Array<{ cardId: string }>;
      ratings: unknown[];
      facetLabels: unknown[];
      cohort: { articleIds: string[] };
    };
    expect(config.raters).toHaveLength(2);
    expect(config.cards.map((c) => c.cardId).sort()).toEqual(
      Object.values(golden.cards).sort((x, y) => Number(x) - Number(y)),
    );
    expect(config.ratings).toHaveLength(32 + 24);
    expect(config.facetLabels).toHaveLength(4);
    expect(config.cohort.articleIds).toHaveLength(32);

    // The config is immutable (database trigger).
    await expect(
      ctx.owner.query(`UPDATE eval.runs SET config = '{}'::jsonb WHERE id = $1`, [e1RunId]),
    ).rejects.toThrow();

    const counts = await answerCounts(ctx, e1RunId);
    expect(counts['score']).toBe(32 + 24);
    expect(counts['enrich']).toBeGreaterThan(0);
    // Rater A's 4 cards on 32 articles, rater B's card on 24.
    expect(counts['card']).toBe(32 * 4 + 24);

    const results = row.results as {
      status: string;
      coverage: { byLang: Record<string, unknown>; byRater: Record<string, unknown> };
      cost: { billedUsd: number; cacheMisses: number };
    };
    expect(results.status).toBe('complete');
    expect(results.coverage.byLang).toEqual({
      en: { expected: 48, valid: 48 },
      sk: { expected: 8, valid: 8 },
    });
    expect(results.coverage.byRater).toEqual({
      [golden.raters.a]: { expected: 32, valid: 32 },
      [golden.raters.b]: { expected: 24, valid: 24 },
    });
    expect(results.cost.billedUsd).toBeGreaterThan(0);
    expect(results.cost.cacheMisses).toBeGreaterThan(0);

    // Every call went through an eval router: kind 'eval' only, nothing else.
    const calls = await ctx.owner.query<{ kind: string; engine: string; n: number }>(
      `SELECT kind, engine, count(*)::int AS n FROM engine_calls GROUP BY 1, 2`,
    );
    expect(calls.rows).toEqual([
      { kind: 'eval', engine: 'typesafe', n: expect.any(Number) as number },
    ]);

    // A liked battery article scores above a disliked weather article for rater A.
    const scores = await ctx.owner.query<{ article_id: string; score: number }>(
      `SELECT article_id::text, (answer->>'score')::float8 AS score FROM eval.run_answers
        WHERE run_id = $1 AND question_key = $2`,
      [e1RunId, `score.r${golden.raters.a}`],
    );
    const byId = new Map(scores.rows.map((r) => [r.article_id, r.score]));
    expect(byId.get(golden.articleIds.en[0]!)).toBeGreaterThan(byId.get(golden.articleIds.en[5]!)!);
  });

  it('caps spend with --max-usd: aborted with partial answers, then resumed to complete', async () => {
    const cacheDir = await freshCache();
    const env = { TYPESAFE_PRICE_PER_MTOK_USD: '200', EVAL_CACHE_DIR: cacheDir };
    // The estimate of this price, then a cap of about a third of it.
    const probe = runtime(ctx, env);
    let estimate: number;
    try {
      const declined = await runExperiment(probe.rt, {
        experiment: 'E1',
        gitSha: 'test',
        confirm: async () => false,
      });
      estimate = declined.estimate.estimatedUsd;
    } finally {
      await probe.rt.close();
    }
    expect(estimate).toBeGreaterThan(1);
    const spentSoFar = async () =>
      (
        await ctx.owner.query<{ usd: number }>(
          `SELECT coalesce(sum(cost_usd), 0)::float8 AS usd FROM engine_calls`,
        )
      ).rows[0]!.usd;
    const s0 = await spentSoFar();
    const { rt } = runtime(ctx, env);
    let aborted;
    try {
      aborted = await runExperiment(rt, {
        experiment: 'E1',
        yes: true,
        maxUsd: estimate / 3,
        gitSha: 'test',
        concurrency: 1,
      });
    } finally {
      await rt.close();
    }
    expect(aborted.status).toBe('aborted');
    const abortedRow = await runRow(ctx, aborted.runId!);
    expect(abortedRow.finished).toBe(true);
    expect(abortedRow.results).toMatchObject({ status: 'aborted', reason: expect.any(String) });
    const partial = await answerCounts(ctx, aborted.runId!);
    expect((partial['card'] ?? 0) + (partial['enrich'] ?? 0)).toBeGreaterThan(0);
    const billed = (abortedRow.results as { cost: { billedUsd: number } }).cost.billedUsd;
    expect(billed).toBeLessThanOrEqual(estimate / 3 + 1e-9);
    expect(billed).toBeCloseTo((await spentSoFar()) - s0, 9);

    // The CLI exits 3 on an abort (cap 0 with an uncached run of the same price).
    await expect(
      runCli(ctx, ['run', 'E1', '--yes', '--max-usd', '0'], {
        ...env,
        EVAL_CACHE_DIR: await freshCache(),
      }),
    ).rejects.toMatchObject({ name: 'EvalCommandError', exitCode: 3 });

    type Cost = {
      billedUsd: number;
      estimatedUsd: number;
      cacheSavingsUsd: number;
      tokens: { input: number; output: number };
      byLang: Record<string, { billedUsd: number }>;
      invocations: number;
      incomplete?: boolean;
    };
    const abortedCost = (abortedRow.results as { cost: Cost }).cost;
    const s2 = await spentSoFar();
    const resumed = runtime(ctx, env);
    let done;
    try {
      done = await runExperiment(resumed.rt, {
        experiment: 'E1',
        yes: true,
        resumeRunId: aborted.runId!,
        gitSha: 'test',
      });
    } finally {
      await resumed.rt.close();
    }
    expect(done.runId).toBe(aborted.runId);
    expect(done.status).toBe('complete');
    expect(resumed.out()).toContain(`resuming run ${aborted.runId!}`);
    // Information only: `--max-usd` caps each invocation (spec 10 §3).
    expect(resumed.out()).toMatch(/earlier invocations billed \$[\d.]+\n/);
    // The final cost covers both invocations (D-110): billed = first + resumed invocation.
    const finalCost = ((await runRow(ctx, aborted.runId!)).results as { cost: Cost }).cost;
    const resumedSpend = (await spentSoFar()) - s2;
    expect(resumedSpend).toBeGreaterThan(0);
    expect(finalCost.billedUsd).toBeCloseTo(abortedCost.billedUsd + resumedSpend, 9);
    expect(finalCost.billedUsd).toBeCloseTo(
      Object.values(finalCost.byLang).reduce((sum, c) => sum + c.billedUsd, 0),
      9,
    );
    expect(finalCost.invocations).toBe(2);
    expect(finalCost.incomplete).toBeUndefined();
    expect(finalCost.estimatedUsd).toBeCloseTo(abortedCost.estimatedUsd, 9);
    expect(finalCost.cacheSavingsUsd).toBeGreaterThanOrEqual(abortedCost.cacheSavingsUsd);
    expect(finalCost.tokens.input).toBeGreaterThan(abortedCost.tokens.input);
    const full = await answerCounts(ctx, aborted.runId!);
    expect(full['card']).toBe(32 * 4 + 24);
    expect(full['score']).toBe(56);
    // Resuming a complete run is refused.
    const again = runtime(ctx, env);
    try {
      await expect(
        runExperiment(again.rt, { experiment: 'E1', yes: true, resumeRunId: aborted.runId! }),
      ).rejects.toMatchObject({ message: /is complete; nothing to resume/ });
    } finally {
      await again.rt.close();
    }
  });

  it('runs every experiment of the matrix (E5 skipped; E6/E7 on the E1 run, development only)', async () => {
    const statuses: Record<string, string> = {};
    const runIds: Record<string, string> = {};
    for (const experiment of EXPERIMENT_IDS) {
      if (experiment === 'E1') continue;
      const { rt } = runtime(ctx);
      try {
        const result = await runExperiment(rt, {
          experiment,
          yes: true,
          gitSha: 'test',
          ...(experiment === 'E6' || experiment === 'E7' ? { baseRunId: e1RunId } : {}),
        });
        statuses[experiment] = result.status;
        runIds[experiment] = result.runId!;
      } finally {
        await rt.close();
      }
    }
    expect(statuses).toEqual({
      B0: 'complete',
      B1: 'complete',
      'B1-T': 'complete',
      E2: 'complete',
      E3: 'complete',
      E3b: 'complete',
      E4: 'complete',
      E5: 'skipped',
      E6: 'complete',
      E7: 'complete',
    });

    // Gate inputs share one cohort (rated pairs plus facet-labelled articles, D-110).
    const cohortOf = async (runId: string) =>
      ((await runRow(ctx, runId)).config as { cohort: { sha: string } }).cohort.sha;
    const e1Cohort = await cohortOf(e1RunId);
    for (const id of ['B0', 'B1', 'B1-T', 'E2', 'E3', 'E3b'] as const) {
      expect(await cohortOf(runIds[id]!)).toBe(e1Cohort);
    }

    // Costs are split by article language; every total is the sum of its split.
    type Cost = {
      estimatedUsd: number;
      billedUsd: number;
      cacheSavingsUsd: number;
      byLang: Record<string, { estimatedUsd: number; billedUsd: number; cacheSavingsUsd: number }>;
    };
    const costOf = async (runId: string) =>
      ((await runRow(ctx, runId)).results as { cost: Cost }).cost;
    for (const id of [e1RunId, runIds['E3']!, runIds['E4']!, runIds['B0']!]) {
      const cost = await costOf(id);
      for (const field of ['estimatedUsd', 'billedUsd', 'cacheSavingsUsd'] as const) {
        const sum = Object.values(cost.byLang).reduce((s, c) => s + c[field], 0);
        expect(cost[field]).toBeCloseTo(sum, 12);
      }
      expect(Object.keys(cost.byLang).every((lang) => lang === 'en' || lang === 'sk')).toBe(true);
    }
    const e1Cost = await costOf(e1RunId);
    expect(e1Cost.byLang['en']!.billedUsd).toBeGreaterThan(0);
    expect(e1Cost.byLang['sk']!.billedUsd).toBeGreaterThan(0);
    // Only card-text translations (free LibreTranslate) carry no article; nothing billed lands
    // outside an article language, so no run records an 'und' bucket.
    const orphan = await ctx.owner.query<{ usd: number }>(
      `SELECT coalesce(sum(cost_usd), 0)::float8 AS usd FROM engine_calls WHERE article_id IS NULL`,
    );
    expect(orphan.rows[0]!.usd).toBe(0);
    // E4 is SK/CS only: its tier-2 (GLM) translation and engine costs all fall on sk.
    const e4Cost = await costOf(runIds['E4']!);
    expect(Object.keys(e4Cost.byLang)).toEqual(['sk']);
    expect(e4Cost.byLang['sk']!.billedUsd).toBeGreaterThan(0);
    const tier2 = await ctx.owner.query<{ lang: string; usd: number }>(
      `SELECT a.lang, sum(c.cost_usd)::float8 AS usd FROM engine_calls c JOIN articles a ON a.id = c.article_id
        WHERE c.engine = 'llm' GROUP BY a.lang`,
    );
    expect(tier2.rows.map((r) => r.lang)).toEqual(['sk']);
    expect(await costOf(runIds['B0']!)).toMatchObject({ billedUsd: 0, byLang: {} });

    // The G1 budget reads the runner's split directly (lane C's gate, costBasis 'per_language').
    const loaded = await loadDataset(ctx.db, 'golden-v1');
    const runById = (id: string) => loaded.runs.find((r) => r.id === id) ?? null;
    const articleLang = new Map([...loaded.sample].map(([id, info]) => [id, info.lang]));
    const devArticles = new Map<string, string[]>();
    for (const [id, info] of loaded.sample) {
      if (info.split !== 'dev') continue;
      devArticles.set(info.lang, [...(devArticles.get(info.lang) ?? []), id]);
    }
    const composed = composedCostPerArticle(
      { en: runById(e1RunId), sk: runById(runIds['E3']!) },
      devArticles,
      articleLang,
    );
    expect(composed.basis).toBe('per_language');
    expect(composed.usdPerArticle).toEqual(expect.any(Number));

    const e5 = await runRow(ctx, runIds['E5']!);
    expect(e5.results).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/laya/) });

    // B0/B1 make no calls and score every pair.
    for (const id of ['B0', 'B1'] as const) {
      expect(await answerCounts(ctx, runIds[id]!)).toEqual({ score: 56 });
    }
    // B1-T freezes LibreTranslate text of the Slovak articles.
    expect(await answerCounts(ctx, runIds['B1-T']!)).toEqual({ score: 56, translation: 8 });

    // E2 records the English card text it sent; the Slovak card is translated.
    const e2 = await runRow(ctx, runIds['E2']!);
    const e2Cards = (e2.config as { cards: Array<{ cardId: string }> }).cards;
    expect(e2Cards.find((c) => c.cardId === golden.cards.skBattery)).toMatchObject({
      lang: 'sk',
      textStatus: 'translated',
      interestEn: expect.any(String) as unknown,
    });
    expect(e2Cards.find((c) => c.cardId === golden.cards.battery)).toMatchObject({
      textStatus: 'english',
      interestEn: null,
    });
    expect(e2.config).toMatchObject({ variant: { cards: 'english' } });

    // E3 freezes the translations it used.
    expect((await answerCounts(ctx, runIds['E3']!))['translation']).toBe(8);

    // E4 is SK/CZ only with GLM (fake Ollama) translations.
    const e4 = await runRow(ctx, runIds['E4']!);
    expect(e4.config).toMatchObject({
      langs: ['cs', 'sk'],
      translation: { articles: 'ollama', model: 'glm-5.3-flash' },
      variant: { state: 'glm', cards: 'as_written' },
    });
    expect((e4.config as { cohort: { articleIds: string[] } }).cohort.articleIds).toHaveLength(8);
    const e4Translations = await ctx.owner.query<{ engine: string }>(
      `SELECT DISTINCT answer->>'engine' AS engine FROM eval.run_answers
        WHERE run_id = $1 AND question_key = 'translation'`,
      [runIds['E4']],
    );
    expect(e4Translations.rows).toEqual([{ engine: 'ollama' }]);

    // E6/E7 read only development articles and build on the E1 run.
    const devIds = new Set(
      (
        await ctx.owner.query<{ id: string }>(
          `SELECT article_id::text AS id FROM eval.sample WHERE dataset_version = 'golden-v1' AND split = 'dev'`,
        )
      ).rows.map((r) => r.id),
    );
    for (const id of ['E6', 'E7'] as const) {
      const row = await runRow(ctx, runIds[id]!);
      expect(row.config).toMatchObject({ baseRunId: e1RunId, developmentOnly: true });
      const used = await ctx.owner.query<{ id: string }>(
        `SELECT DISTINCT article_id::text AS id FROM eval.run_answers WHERE run_id = $1`,
        [runIds[id]],
      );
      expect(used.rows.length).toBeGreaterThan(0);
      for (const { id: articleId } of used.rows) expect(devIds.has(articleId)).toBe(true);
    }
    const e6 = await runRow(ctx, runIds['E6']!);
    expect(e6.results).toMatchObject({
      e6: { laterArticleIds: expect.any(Array) as unknown },
    });
    const e7 = await runRow(ctx, runIds['E7']!);
    const e7Items = (e7.results as { e7: { items: unknown[] } }).e7.items;
    expect(e7Items.length).toBeGreaterThan(0);
    const e7Counts = await answerCounts(ctx, runIds['E7']!);
    expect(e7Counts['e7.targeted']).toBe(e7Counts['e7.generic']);
  });

  it('E6 keeps each rater’s answers when two raters share one card id', async () => {
    // Rater B also holds A's battery card (cards are reused by text hash, D-100).
    await ctx.owner.query(
      `INSERT INTO eval.rater_cards (rater_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [golden.raters.b, golden.cards.battery],
    );
    // golden-v1 is frozen with its captured truth; the card reaches the next version.
    const opened = await ctx.db.transaction((tx) => openDatasetForCorrection(tx, 'assignments'));
    expect(opened).toMatchObject({ version: 'golden-v2', createdFrom: 'golden-v1' });
    const { rt } = runtime(ctx);
    let e6RunId: string;
    try {
      const e1 = await runExperiment(rt, { experiment: 'E1', yes: true, gitSha: 'test' });
      expect(e1.status).toBe('complete');
      // An unfinished base run is refused: its answers could still change between plans.
      const setStatus = (status: string) =>
        ctx.owner.query(
          `UPDATE eval.runs SET results = jsonb_set(results, '{status}', to_jsonb($2::text))
            WHERE id = $1`,
          [e1.runId, status],
        );
      await setStatus('running');
      await expect(
        runExperiment(rt, { experiment: 'E6', yes: true, gitSha: 'test', baseRunId: e1.runId! }),
      ).rejects.toMatchObject({ message: expect.stringContaining('is not finished (running)') });
      await setStatus('complete');
      // A base run being resumed (its exclusive claim) cannot be built on at the same time.
      const resuming = await tryLockRun(rt.config.databaseUrlWorker, e1.runId!);
      try {
        await expect(
          runExperiment(rt, { experiment: 'E6', yes: true, gitSha: 'test', baseRunId: e1.runId! }),
        ).rejects.toMatchObject({ message: /base run \d+ is being executed/ });
      } finally {
        await resuming?.release();
      }
      const e6 = await runExperiment(rt, {
        experiment: 'E6',
        yes: true,
        gitSha: 'test',
        baseRunId: e1.runId!,
      });
      expect(e6.status).toBe('complete');
      e6RunId = e6.runId!;
      // Once E6 is built on it, a partial base run is never resumed: its answers stay final.
      await setStatus('partial');
      await expect(
        runExperiment(rt, { experiment: 'E1', yes: true, gitSha: 'test', resumeRunId: e1.runId! }),
      ).rejects.toMatchObject({ message: /is the base of run \d+, so its answers are final/ });
      await setStatus('complete');
    } finally {
      await rt.close();
    }
    const rows = await ctx.owner.query<{ article_id: string; question_key: string }>(
      `SELECT article_id::text, question_key FROM eval.run_answers
        WHERE run_id = $1 AND card_id = $2`,
      [e6RunId, golden.cards.battery],
    );
    const keyA = `e6.r${golden.raters.a}`;
    const keyB = `e6.r${golden.raters.b}`;
    expect(new Set(rows.rows.map((r) => r.question_key))).toEqual(new Set([keyA, keyB]));
    const byArticle = new Map<string, Set<string>>();
    for (const row of rows.rows) {
      const keys = byArticle.get(row.article_id) ?? new Set<string>();
      keys.add(row.question_key);
      byArticle.set(row.article_id, keys);
    }
    // Articles in both raters' later halves keep both raters' answers for the shared card.
    const both = [...byArticle.values()].filter((keys) => keys.has(keyA) && keys.has(keyB));
    expect(both.length).toBeGreaterThan(0);
    // Every E6 rerun row is rater-keyed; no shared `card` key is written.
    const keys = await ctx.owner.query<{ question_key: string }>(
      `SELECT DISTINCT question_key FROM eval.run_answers WHERE run_id = $1 AND card_id IS NOT NULL`,
      [e6RunId],
    );
    expect(keys.rows.map((r) => r.question_key).sort()).toEqual([keyA, keyB].sort());
  });

  it('a failed article translation falls back to native text, marked degraded and not valid', async () => {
    // Record the LibreTranslate request of one Slovak article (B1-T makes no model calls).
    ctx.libretranslate.reset();
    const probe = runtime(ctx, { EVAL_CACHE_DIR: await freshCache() });
    try {
      await runExperiment(probe.rt, { experiment: 'B1-T', yes: true, gitSha: 'test' });
    } finally {
      await probe.rt.close();
    }
    const titles = await ctx.owner.query<{ id: string; title: string }>(
      `SELECT id::text, title FROM articles WHERE lang = 'sk' ORDER BY id`,
    );
    const sent = ctx.libretranslate.requests
      .filter((r) => r.path === '/translate')
      .map((r) => r.body as { q?: unknown; source?: unknown })
      .filter((b) => b.source === 'sk' && Array.isArray(b.q))
      .map((b) => b.q as string[]);
    const target = titles.rows.find((row) => sent.some((q) => q.includes(row.title)));
    expect(target).toBeDefined();
    const texts = sent.find((q) => q.includes(target!.title))!;
    // That article's translation comes back empty (unusable); every other one translates.
    ctx.libretranslate.reset({ translations: Object.fromEntries(texts.map((t) => [t, ''])) });

    const { rt } = runtime(ctx, { EVAL_CACHE_DIR: await freshCache() });
    let runId: string;
    try {
      const result = await runExperiment(rt, { experiment: 'E3', yes: true, gitSha: 'test' });
      expect(result.status).toBe('partial');
      runId = result.runId!;
    } finally {
      await rt.close();
      ctx.libretranslate.reset();
    }
    const row = await runRow(ctx, runId);
    const results = row.results as {
      coverage: { byLang: Record<string, { expected: number; valid: number }> };
      translationFallbacks: Record<string, number>;
    };
    expect(results.translationFallbacks).toEqual({ sk: 1 });
    const sk = results.coverage.byLang['sk']!;
    expect(sk.valid).toBeLessThan(sk.expected);
    const en = results.coverage.byLang['en']!;
    expect(en.valid).toBe(en.expected);
    const variants = await ctx.owner.query<{ article_id: string; variant: string; n: number }>(
      `SELECT article_id::text, answer->>'variant' AS variant, count(*)::int AS n
         FROM eval.run_answers
        WHERE run_id = $1 AND (question_key = 'card' OR question_key LIKE 'score.r%')
          AND article_id IN (SELECT id FROM articles WHERE lang = 'sk')
        GROUP BY 1, 2`,
      [runId],
    );
    expect(variants.rows.length).toBeGreaterThan(1);
    for (const v of variants.rows) {
      expect(v.variant).toBe(v.article_id === target!.id ? 'native' : 'translated');
    }
    // The gate's run check reads this as not eligible (status partial, sk coverage short).

    // B1-T scores by BM25 over each rater's whole corpus: the native document changes the corpus
    // statistics, so every score of a rater whose corpus holds it is invalid, not only its own.
    ctx.libretranslate.reset({ translations: Object.fromEntries(texts.map((t) => [t, ''])) });
    const b1t = runtime(ctx, { EVAL_CACHE_DIR: await freshCache() });
    let b1tRunId: string;
    try {
      const result = await runExperiment(b1t.rt, { experiment: 'B1-T', yes: true, gitSha: 'test' });
      expect(result.status).toBe('partial');
      b1tRunId = result.runId!;
    } finally {
      await b1t.rt.close();
      ctx.libretranslate.reset();
    }
    const b1tRow = await runRow(ctx, b1tRunId);
    const b1tConfig = b1tRow.config as { assignments: Record<string, string[]> };
    const holders = Object.entries(b1tConfig.assignments)
      .filter(([, ids]) => ids.includes(target!.id))
      .map(([raterId]) => raterId);
    expect(holders.length).toBeGreaterThan(0);
    const byRater = (
      b1tRow.results as {
        coverage: { byRater: Record<string, { expected: number; valid: number }> };
      }
    ).coverage.byRater;
    for (const raterId of holders) {
      expect(byRater[raterId]!.expected).toBeGreaterThan(1);
      expect(byRater[raterId]!.valid).toBe(0);
      const untagged = await ctx.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM eval.run_answers
          WHERE run_id = $1 AND question_key = $2
            AND coalesce((answer->>'corpusFallback')::boolean, false) = false`,
        [b1tRunId, `score.r${raterId}`],
      );
      expect(untagged.rows[0]!.n).toBe(0);
    }
  });

  it("an English-card run whose card translation failed counts that rater's pairs as missing", async () => {
    // Every LibreTranslate translation comes back empty: the Slovak card keeps its original text.
    ctx.libretranslate.reset({ mode: 'fail' });
    const { rt } = runtime(ctx, { EVAL_CACHE_DIR: await freshCache() });
    let runId: string;
    try {
      const result = await runExperiment(rt, { experiment: 'E2', yes: true, gitSha: 'test' });
      expect(result.status).toBe('partial');
      runId = result.runId!;
    } finally {
      await rt.close();
      ctx.libretranslate.reset();
    }
    const row = await runRow(ctx, runId);
    const config = row.config as {
      cards: Array<{ cardId: string; textStatus: string | null; interestEn: string | null }>;
    };
    expect(config.cards.find((c) => c.cardId === golden.cards.skBattery)).toMatchObject({
      textStatus: 'failed',
      interestEn: null,
    });
    const results = row.results as {
      coverage: { byRater: Record<string, { expected: number; valid: number }> };
      cardTextFallbacks: Record<string, number>;
    };
    expect(results.cardTextFallbacks).toEqual({ sk: 1 });
    // Rater A holds the Slovak card: none of A's pairs is valid; rater B is unaffected.
    const a = results.coverage.byRater[golden.raters.a]!;
    expect(a.expected).toBeGreaterThan(0);
    expect(a.valid).toBe(0);
    const b = results.coverage.byRater[golden.raters.b]!;
    expect(b.valid).toBe(b.expected);
    const tagged = await ctx.owner.query<{ key: string; tagged: boolean; n: number }>(
      `SELECT CASE WHEN question_key = 'card' THEN 'card' ELSE question_key END AS key,
              coalesce((answer->>'cardTextFallback')::boolean, false) AS tagged, count(*)::int AS n
         FROM eval.run_answers
        WHERE run_id = $1 AND (card_id = $2 OR question_key = $3)
        GROUP BY 1, 2`,
      [runId, golden.cards.skBattery, `score.r${golden.raters.a}`],
    );
    expect(tagged.rows.length).toBe(2);
    expect(tagged.rows.every((r) => r.tagged)).toBe(true);
  });

  it('`eval run B0 --yes` through the CLI', async () => {
    const out = await runCli(ctx, ['run', 'B0', '--yes', '--langs', 'en']);
    expect(out).toMatch(/B0 on golden-v2: estimated cost \$0\.0000/);
    expect(out).toMatch(/run \d+ complete: billed \$0\.0000/);
  });

  it('a run on a frozen version reads its captured truth, not a later correction', async () => {
    type Config = {
      ratings: Array<{ raterId: string; articleId: string; rating: number }>;
      assignments: Record<string, string[]>;
    };
    const runB0 = async (datasetVersion: string) => {
      const { rt } = runtime(ctx);
      try {
        const result = await runExperiment(rt, {
          experiment: 'B0',
          datasetVersion,
          yes: true,
          gitSha: 'test',
        });
        return (await runRow(ctx, result.runId!)).config as Config;
      } finally {
        await rt.close();
      }
    };
    const first = await ctx.owner.query<{ article_id: string; rating: number }>(
      `SELECT a.article_id::text, g.rating FROM eval.assignments a
         JOIN eval.ratings g ON g.rater_id = a.rater_id AND g.article_id = a.article_id
        WHERE a.rater_id = $1 AND a.position = 0`,
      [golden.raters.a],
    );
    const original = first.rows[0]!;
    // The rating app's correction: the head is frozen, so it branches the next version and
    // overwrites the one current rating row.
    const corrected = original.rating === 1 ? -1 : 1;
    const branched = await ctx.db.transaction(async (tx) => {
      const opened = await openDatasetForCorrection(tx);
      await rateAssignment(tx, {
        raterId: golden.raters.a,
        position: 0,
        rating: corrected,
        reason: corrected === -1 ? 'off_topic' : null,
        now: new Date(),
      });
      return opened;
    });
    expect(branched).not.toBeNull();
    const parent = branched!.createdFrom;
    // An assignment appended after branching (a global row) for an article of the frozen parent.
    const unassigned = await ctx.owner.query<{ article_id: string }>(
      `SELECT s.article_id::text FROM eval.sample s
        WHERE s.dataset_version = $2
          AND NOT EXISTS (SELECT 1 FROM eval.assignments a
                           WHERE a.rater_id = $1 AND a.article_id = s.article_id)
        ORDER BY s.article_id LIMIT 1`,
      [golden.raters.b, parent],
    );
    const extra = unassigned.rows[0]!.article_id;
    await ctx.owner.query(
      `INSERT INTO eval.assignments (rater_id, article_id, position, status)
       SELECT $1, $2, coalesce(max(position), -1) + 1, 'pending' FROM eval.assignments WHERE rater_id = $1`,
      [golden.raters.b, extra],
    );

    const onParent = await runB0(parent);
    const rated = (config: Config) =>
      config.ratings.find(
        (r) => r.raterId === golden.raters.a && r.articleId === original.article_id,
      )?.rating;
    expect(rated(onParent)).toBe(original.rating);
    expect(onParent.assignments[golden.raters.b]).not.toContain(extra);
    // The child version freezes with the correction and the new assignment.
    const onChild = await runB0(branched!.version);
    expect(rated(onChild)).toBe(corrected);
    expect(onChild.assignments[golden.raters.b]).toContain(extra);
  });

  it('freezes the dataset and reads the run config under one lock (no rating slips in between)', async () => {
    const before = await ctx.owner.query<{ rater_id: string; article_id: string; rating: number }>(
      `SELECT rater_id::text, article_id::text, rating FROM eval.ratings
        WHERE rater_id = $1 ORDER BY article_id LIMIT 1`,
      [golden.raters.a],
    );
    const target = before.rows[0]!;
    // An open version to freeze (the earlier ones are frozen with their truth captured).
    const opened = await ctx.db.transaction((tx) => openDatasetForCorrection(tx));
    expect(opened).not.toBeNull();
    // A rating write holding the lock every post-freeze correction takes, committed only after
    // the run has reached its freeze.
    const writer = await ctx.owner.connect();
    let runId: string | null;
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtext('eval.dataset.additions'))`);
      await writer.query(
        `UPDATE eval.ratings SET rating = $3 WHERE rater_id = $1 AND article_id = $2`,
        [target.rater_id, target.article_id, -target.rating],
      );
      const { rt } = runtime(ctx);
      const pending = runExperiment(rt, {
        experiment: 'B0',
        datasetVersion: opened!.version,
        yes: true,
        gitSha: 'test',
      }).finally(() => rt.close());
      await new Promise((resolve) => setTimeout(resolve, 500));
      await writer.query('COMMIT');
      runId = (await pending).runId;
      const config = (await runRow(ctx, runId!)).config as {
        ratings: Array<{ raterId: string; articleId: string; rating: number }>;
      };
      const recorded = config.ratings.find(
        (r) => r.raterId === target.rater_id && r.articleId === target.article_id,
      );
      expect(recorded?.rating).toBe(-target.rating);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      await ctx.owner.query(
        `UPDATE eval.ratings SET rating = $3 WHERE rater_id = $1 AND article_id = $2`,
        [target.rater_id, target.article_id, target.rating],
      );
    }
  });

  it('re-estimates and asks again when the frozen inputs differ from the estimated ones', async () => {
    const opened = await ctx.db.transaction((tx) => openDatasetForCorrection(tx));
    expect(opened).not.toBeNull();
    const asked: number[] = [];
    const requests = ctx.typesafe.requestCount();
    // A price that puts the estimate above the $1 confirmation threshold.
    const { rt, out } = runtime(ctx, {
      TYPESAFE_PRICE_PER_MTOK_USD: '200',
      EVAL_CACHE_DIR: await freshCache(),
    });
    let result;
    try {
      result = await runExperiment(rt, {
        experiment: 'E1',
        datasetVersion: opened!.version,
        gitSha: 'test',
        confirm: async (estimate) => {
          asked.push(estimate.estimatedUsd);
          if (asked.length === 1) {
            // A card lands while the first estimate is on screen: more Call B questions.
            await ctx.owner.query(
              `INSERT INTO eval.rater_cards (rater_id, card_id, strength) VALUES ($1, $2, 'like')`,
              [golden.raters.a, golden.cards.astronomy],
            );
            return true;
          }
          return false;
        },
      });
    } finally {
      await rt.close();
      await ctx.owner.query(`DELETE FROM eval.rater_cards WHERE rater_id = $1 AND card_id = $2`, [
        golden.raters.a,
        golden.cards.astronomy,
      ]);
    }
    expect(asked).toHaveLength(2);
    expect(asked[1]!).toBeGreaterThan(asked[0]!);
    expect(out()).toMatch(
      /revised estimate \(the frozen inputs or card text changed\) \$\d+\.\d{2}/,
    );
    expect(result).toMatchObject({ runId: null, status: 'declined' });
    expect(result.estimate.estimatedUsd).toBe(asked[1]);
    // Declined before the run row and before any model call.
    expect(ctx.typesafe.requestCount()).toBe(requests);
    const rows = await ctx.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM eval.runs WHERE dataset_version = $1`,
      [opened!.version],
    );
    expect(rows.rows[0]!.n).toBe(0);
    // Declined at the second prompt: the version is not frozen, so later ratings, cards and
    // top-ups still land in it (D-110 addendum).
    const frozenAt = async () =>
      (
        await ctx.owner.query<{ frozen: boolean }>(
          `SELECT frozen_at IS NOT NULL AS frozen FROM eval.datasets WHERE version = $1`,
          [opened!.version],
        )
      ).rows[0]!.frozen;
    expect(await frozenAt()).toBe(false);
    // Accepted, the same run freezes the version together with its run row.
    const accepted = runtime(ctx, {
      TYPESAFE_PRICE_PER_MTOK_USD: '200',
      EVAL_CACHE_DIR: await freshCache(),
    });
    try {
      const run = await runExperiment(accepted.rt, {
        experiment: 'E1',
        datasetVersion: opened!.version,
        gitSha: 'test',
        yes: true,
        maxUsd: 1000,
      });
      expect(run.status).toBe('complete');
    } finally {
      await accepted.rt.close();
    }
    expect(await frozenAt()).toBe(true);
  });

  it('estimates and confirms English-card runs on the translated card text', async () => {
    // The Slovak card translates to a longer English text: Call B questions grow after the
    // translation step, which runs after the first estimate.
    const skInterest = (
      await ctx.owner.query<{ interest: string }>(
        `SELECT body->>'interest' AS interest FROM interest_cards WHERE id = $1`,
        [golden.cards.skBattery],
      )
    ).rows[0]!.interest;
    ctx.libretranslate.reset({
      translations: {
        [skInterest]:
          'I am interested in batteries for electric cars, how and where they are charged, ' +
          'what the batteries and the charging cost, and the prices of electric cars in Slovakia',
      },
    });
    const e2 = async (price: string, confirm?: (usd: number) => boolean) => {
      const asked: number[] = [];
      const { rt, out } = runtime(ctx, {
        TYPESAFE_PRICE_PER_MTOK_USD: price,
        EVAL_CACHE_DIR: await freshCache(),
      });
      try {
        const result = await runExperiment(rt, {
          experiment: 'E2',
          gitSha: 'test',
          ...(confirm === undefined
            ? {}
            : {
                confirm: (estimate) => {
                  asked.push(estimate.estimatedUsd);
                  return Promise.resolve(confirm(estimate.estimatedUsd));
                },
              }),
        });
        return { result, asked, out: out() };
      } finally {
        await rt.close();
      }
    };
    const requests = ctx.typesafe.requestCount();
    try {
      // At a high price both estimates are above $1: the first prompt is accepted, the second
      // (on the translated text) shows the larger estimate.
      let prompts = 0;
      const probe = await e2('200', () => (prompts += 1) === 1);
      expect(probe.asked).toHaveLength(2);
      const [before, after] = probe.asked as [number, number];
      expect(after).toBeGreaterThan(before);
      expect(probe.result).toMatchObject({ runId: null, status: 'declined' });
      // A price where the untranslated estimate is below $1 and the translated one above:
      // without --yes and without a prompt, the run is declined before the run row.
      const price = (200 * 2) / (before + after);
      const runsBefore = (
        await ctx.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM eval.runs`)
      ).rows[0]!.n;
      const unattended = await e2(String(price));
      expect(unattended.out).toMatch(/estimated cost \$0\.\d{4}/);
      expect(unattended.out).toMatch(
        /revised estimate \(the frozen inputs or card text changed\) \$1\./,
      );
      expect(unattended.result).toMatchObject({ runId: null, status: 'declined' });
      expect(unattended.result.estimate.estimatedUsd).toBeGreaterThan(1);
      const runsAfter = (
        await ctx.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM eval.runs`)
      ).rows[0]!.n;
      expect(runsAfter).toBe(runsBefore);
      expect(ctx.typesafe.requestCount()).toBe(requests);
    } finally {
      ctx.libretranslate.reset();
    }
  });

  it("marks a resumed run's cost incomplete before any work and refuses a concurrent resume", async () => {
    const env = { TYPESAFE_PRICE_PER_MTOK_USD: '200', EVAL_CACHE_DIR: await freshCache() };
    const first = runtime(ctx, env);
    let runId: string;
    try {
      const aborted = await runExperiment(first.rt, {
        experiment: 'E1',
        yes: true,
        maxUsd: 1,
        gitSha: 'test',
        concurrency: 1,
      });
      expect(aborted.status).toBe('aborted');
      runId = aborted.runId!;
    } finally {
      await first.rt.close();
    }
    const recorded = ((await runRow(ctx, runId)).results as { cost: { billedUsd: number } }).cost;
    // Hold the resumed invocation's first engine request: the process could be killed now.
    let seen!: () => void;
    const firstRequest = new Promise<void>((resolve) => (seen = resolve));
    ctx.typesafe.setOptions({
      latencyMs: 1500,
      statusOverride: () => {
        seen();
        return undefined;
      },
    });
    const resumed = runtime(ctx, env);
    try {
      const pending = runExperiment(resumed.rt, {
        experiment: 'E1',
        yes: true,
        resumeRunId: runId,
        maxUsd: 1000,
        gitSha: 'test',
      });
      await firstRequest;
      const inFlight = (await runRow(ctx, runId)).results as {
        status: string;
        cost: { billedUsd: number; incomplete?: boolean };
      };
      expect(inFlight.status).toBe('running');
      expect(inFlight.cost.incomplete).toBe(true);
      expect(inFlight.cost.billedUsd).toBeCloseTo(recorded.billedUsd, 9);
      // A second resume of the same run while this one executes is refused before any work.
      const second = runtime(ctx, env);
      try {
        await expect(
          runExperiment(second.rt, {
            experiment: 'E1',
            yes: true,
            resumeRunId: runId,
            maxUsd: 1000,
            gitSha: 'test',
          }),
        ).rejects.toMatchObject({ message: /is being executed by another eval run invocation/ });
      } finally {
        await second.rt.close();
      }
      ctx.typesafe.setOptions({ latencyMs: 0, statusOverride: undefined });
      expect((await pending).status).toBe('complete');
    } finally {
      ctx.typesafe.setOptions({ latencyMs: 0, statusOverride: undefined });
      await resumed.rt.close();
    }
    // Finished normally, the merged cost is complete again.
    const final = ((await runRow(ctx, runId)).results as { cost: { incomplete?: boolean } }).cost;
    expect(final.incomplete).toBeUndefined();
  });

  it("builds a frozen version's rater set from its captured truth (a later rater never joins)", async () => {
    const b0 = async () => {
      const { rt } = runtime(ctx);
      try {
        const result = await runExperiment(rt, { experiment: 'B0', yes: true, gitSha: 'test' });
        const config = RunConfigSchema.parse((await runRow(ctx, result.runId!)).config);
        return { version: config.datasetVersion, config };
      } finally {
        await rt.close();
      }
    };
    const before = await b0();
    const added = await ctx.owner.query<{ id: string }>(
      `INSERT INTO eval.raters (name, participant_key, token_hash, token_expires_at, langs)
       VALUES ('Late rater', gen_random_uuid(), md5(random()::text), now() + interval '30 days', '{en}')
       RETURNING id::text AS id`,
    );
    const after = await b0();
    expect(after.version).toBe(before.version);
    expect(after.config.raters.map((r) => r.raterId)).not.toContain(added.rows[0]!.id);
    expect(after.config.raters).toEqual(before.config.raters);
    expect(groundTruthSha(after.config)).toBe(groundTruthSha(before.config));
  });

  it('a resumed E6 run reuses its persisted answers (cache cleared): no task is billed twice', async () => {
    const base = runtime(ctx);
    let e1Id: string;
    try {
      const e1 = await runExperiment(base.rt, { experiment: 'E1', yes: true, gitSha: 'test' });
      expect(e1.status).toBe('complete');
      e1Id = e1.runId!;
    } finally {
      await base.rt.close();
    }
    const e6 = async (
      overrides: Record<string, string>,
      options: { maxUsd?: number; resumeRunId?: string } = {},
    ) => {
      const { rt } = runtime(ctx, { TYPESAFE_PRICE_PER_MTOK_USD: '200', ...overrides });
      const before = ctx.typesafe.requestCount();
      try {
        const result = await runExperiment(rt, {
          experiment: 'E6',
          baseRunId: e1Id,
          gitSha: 'test',
          yes: true,
          ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
          ...(options.resumeRunId === undefined ? {} : { resumeRunId: options.resumeRunId }),
        });
        return { result, requests: ctx.typesafe.requestCount() - before };
      } finally {
        await rt.close();
      }
    };
    // A complete E6 from an empty cache: the requests one full run sends.
    const full = await e6({ EVAL_CACHE_DIR: await freshCache() }, { maxUsd: 1000 });
    expect(full.result.status).toBe('complete');
    expect(full.requests).toBeGreaterThan(0);
    // Aborted part-way by the cap, then resumed with a cleared cache (another host).
    const aborted = await e6(
      { EVAL_CACHE_DIR: await freshCache() },
      { maxUsd: full.result.estimate.estimatedUsd / 3 },
    );
    expect(aborted.result.status).toBe('aborted');
    expect(aborted.requests).toBeGreaterThan(0);
    const persisted = await answerCounts(ctx, aborted.result.runId!);
    expect(Object.values(persisted).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const resumed = await e6(
      { EVAL_CACHE_DIR: await freshCache() },
      { maxUsd: 1000, resumeRunId: aborted.result.runId! },
    );
    expect(resumed.result.status).toBe('complete');
    // The resume's estimate counts the persisted tasks as done.
    expect(resumed.result.estimate.estimatedUsd).toBeLessThan(full.result.estimate.estimatedUsd);
    // Only the missing or failed tasks were asked again.
    expect(resumed.requests).toBeLessThan(full.requests);
    expect(aborted.requests + resumed.requests).toBeLessThanOrEqual(full.requests);
  });

  it('asks a shared card id once per distinct English text and scores each rater on its own copy', async () => {
    // Rater B holds A's battery card (shared by text hash, D-100; added in the E6 test above). An
    // English-card run froze a different translation for B's copy (another locale hint): its Call B
    // question differs, so it is asked separately and kept under B's own key (D-112 addendum).
    const { rt } = runtime(ctx, { EVAL_CACHE_DIR: await freshCache() });
    let baseId: string;
    try {
      const e2 = await runExperiment(rt, { experiment: 'E2', yes: true, gitSha: 'test' });
      expect(e2.status).toBe('complete');
      baseId = e2.runId!;
    } finally {
      await rt.close();
    }
    const { configSha: _sha, ...base } = parseRunConfig((await runRow(ctx, baseId)).config);
    const copyOf = (raterId: string) =>
      base.cards.find((c) => c.raterId === raterId && c.cardId === golden.cards.battery);
    expect(copyOf(golden.raters.a)).toMatchObject({ textStatus: 'english', interestEn: null });
    expect(copyOf(golden.raters.b)).toBeDefined();
    const textB = 'Distant galaxy observations';
    const config = withConfigSha({
      ...base,
      cards: base.cards.map((c) =>
        c.raterId === golden.raters.b && c.cardId === golden.cards.battery
          ? { ...c, interestEn: textB, textStatus: 'translated', lang: 'sk' }
          : c,
      ),
    });
    const insert = async () =>
      (
        await ctx.owner.query<{ id: string }>(
          `INSERT INTO eval.runs (experiment, dataset_version, config, git_sha)
           VALUES ('E2', $1, $2::jsonb, 'test') RETURNING id::text`,
          [config.datasetVersion, JSON.stringify(config)],
        )
      ).rows[0]!.id;
    const resume = async (runId: string) => {
      const { rt: r } = runtime(ctx, { EVAL_CACHE_DIR: await freshCache() });
      const before = ctx.typesafe.requestCount();
      try {
        const result = await runExperiment(r, {
          experiment: 'E2',
          resumeRunId: runId,
          yes: true,
          gitSha: 'test',
        });
        expect(result.status).toBe('complete');
        return ctx.typesafe.requestCount() - before;
      } finally {
        await r.close();
      }
    };

    const sentB = () =>
      ctx.typesafe.requests.filter((r) => JSON.stringify(r.body).includes(textB)).length;
    const sentBefore = sentB();
    const runId = await insert();
    expect(await resume(runId)).toBeGreaterThan(0);
    // B's own text was sent (once per English article B rated).
    expect(sentB() - sentBefore).toBeGreaterThan(0);

    const rows = await loadRunAnswers(ctx.db, runId);
    const keyB = `card.r${golden.raters.b}`;
    const battery = rows.filter((r) => r.cardId === golden.cards.battery);
    const astronomy = golden.articleIds.en.filter((id) =>
      golden.titles.get(id)!.startsWith('Astronomy'),
    );
    for (const articleId of astronomy) {
      const shared = battery.find((r) => r.articleId === articleId && r.questionKey === 'card');
      const own = battery.find((r) => r.articleId === articleId && r.questionKey === keyB);
      // A's copy (the battery text) misses an astronomy title; B's copy (galaxies) matches it.
      expect(shared?.answer).toMatchObject({ ok: true, p: 0.1 });
      expect(own?.answer).toMatchObject({ ok: true, p: 0.9 });
    }
    // Slovak articles are A's only: no rater-keyed row there.
    expect(
      battery.filter((r) => r.questionKey === keyB && golden.articleIds.sk.includes(r.articleId)),
    ).toEqual([]);
    // Only B's divergent copy is rater-keyed.
    expect([
      ...new Set(rows.filter((r) => r.questionKey.startsWith('card.r')).map((r) => r.cardId)),
    ]).toEqual([golden.cards.battery]);

    // The report reads each rater's own copy: B's override, A's shared answer.
    const row = await runRow(ctx, runId);
    const data = parseRunData(
      {
        id: runId,
        experiment: row.experiment,
        datasetVersion: config.datasetVersion,
        config: row.config,
        gitSha: 'test',
        startedAt: new Date(),
        finishedAt: new Date(),
        results: row.results,
      },
      rows,
    );
    const article = astronomy[0]!;
    expect(
      raterCardResults(data, golden.raters.b, article)?.get(golden.cards.battery),
    ).toMatchObject({ ok: true, p: 0.9 });
    expect(
      raterCardResults(data, golden.raters.a, article)?.get(golden.cards.battery),
    ).toMatchObject({ ok: true, p: 0.1 });

    // Resume reuse: a second run with the same config and the first run's Call A/B rows (another
    // host, cleared cache) sends nothing and scores the same.
    const again = await insert();
    await ctx.owner.query(
      `INSERT INTO eval.run_answers (run_id, article_id, card_id, question_key, answer)
       SELECT $2, article_id, card_id, question_key, answer FROM eval.run_answers
        WHERE run_id = $1 AND question_key NOT LIKE 'score.r%'`,
      [runId, again],
    );
    expect(await resume(again)).toBe(0);
    const scores = async (id: string) =>
      (
        await ctx.owner.query<{ k: string; s: string | null }>(
          `SELECT article_id::text || question_key AS k, answer->>'score' AS s
             FROM eval.run_answers WHERE run_id = $1 AND question_key LIKE 'score.r%' ORDER BY 1`,
          [id],
        )
      ).rows;
    expect(await scores(again)).toEqual(await scores(runId));
  });

  it('reprices cached answers at the current price for the uncached cost (cache savings)', async () => {
    // The cache identity has no price: a run fully answered from the cache reports what its calls
    // would cost NOW, from the stored token counts, not the cost recorded when they were cached.
    const cacheDir = await freshCache();
    type Cost = {
      billedUsd: number;
      cacheMisses: number;
      cacheHits: number;
      cacheSavingsUsd: number;
      byLang: Record<string, { billedUsd: number; cacheSavingsUsd: number }>;
    };
    const e1 = async (price: string) => {
      const { rt } = runtime(ctx, { TYPESAFE_PRICE_PER_MTOK_USD: price, EVAL_CACHE_DIR: cacheDir });
      const before = ctx.typesafe.requestCount();
      try {
        const result = await runExperiment(rt, {
          experiment: 'E1',
          yes: true,
          maxUsd: 1000,
          gitSha: 'test',
        });
        expect(result.status).toBe('complete');
        const row = await runRow(ctx, result.runId!);
        return {
          cost: (row.results as { cost: Cost }).cost,
          estimate: result.estimate,
          requests: ctx.typesafe.requestCount() - before,
        };
      } finally {
        await rt.close();
      }
    };
    const first = await e1('200');
    expect(first.requests).toBeGreaterThan(0);
    expect(first.cost.billedUsd).toBeGreaterThan(0);
    expect(first.cost.cacheSavingsUsd).toBe(0);

    // The price doubles; everything is cached, so nothing is sent or estimated.
    const second = await e1('400');
    expect(second.requests).toBe(0);
    expect(second.estimate).toMatchObject({ estimatedUsd: 0, uncachedCalls: 0 });
    expect(second.cost.cacheMisses).toBe(0);
    expect(second.cost.billedUsd).toBe(0);
    expect(second.cost.cacheSavingsUsd).toBeCloseTo(2 * first.cost.billedUsd, 9);
    for (const [lang, cell] of Object.entries(first.cost.byLang)) {
      expect(second.cost.byLang[lang]?.cacheSavingsUsd).toBeCloseTo(2 * cell.billedUsd, 9);
    }
    // Back at the original price the same hits are worth what they were billed.
    const third = await e1('200');
    expect(third.cost.cacheSavingsUsd).toBeCloseTo(first.cost.billedUsd, 9);
  });

  it('estimates Call A/B of a translated-state run on an empty cache at least at the live cost', async () => {
    // Nothing is translated while estimating: the classifier estimate uses an upper-bound stand-in
    // for the English text (D-110 addendum), never the native text the live run does not send.
    const sk = await ctx.owner.query<{ title: string; excerpt: string | null }>(
      `SELECT title, excerpt FROM articles WHERE lang = 'sk'`,
    );
    // Translations twice as long as their source (still within the 2.5 ratio check).
    ctx.libretranslate.reset({
      translations: Object.fromEntries(
        sk.rows.flatMap((row) =>
          [row.title, row.excerpt]
            .filter((t): t is string => t !== null)
            .map((t) => [t.trim(), `${t.trim()} — ${t.trim()} (${t.trim().slice(0, 8)})`]),
        ),
      ),
    });
    const { rt } = runtime(ctx, {
      TYPESAFE_PRICE_PER_MTOK_USD: '200',
      EVAL_CACHE_DIR: await freshCache(),
    });
    try {
      const result = await runExperiment(rt, {
        experiment: 'E3',
        langs: ['sk'],
        yes: true,
        maxUsd: 1000,
        gitSha: 'test',
      });
      expect(result.runId).not.toBeNull();
      const row = await runRow(ctx, result.runId!);
      const cost = (row.results as { cost: { billedUsd: number } }).cost;
      expect(cost.billedUsd).toBeGreaterThan(0);
      expect(result.estimate.estimatedUsd).toBeGreaterThanOrEqual(cost.billedUsd);
    } finally {
      await rt.close();
      ctx.libretranslate.reset();
    }
  });

  it("suggests E6 examples with the run's frozen lane thresholds, not the defaults", async () => {
    // The fake answers 0.9 on matching cards: a liked article at 0.9 is For You by default (0.65),
    // so it suggests nothing; with For You at 0.95 it lies in [maybe, forYou) and becomes a `yes`.
    const e6 = async () => {
      const { rt } = runtime(ctx);
      try {
        const e1 = await runExperiment(rt, { experiment: 'E1', yes: true, gitSha: 'test' });
        expect(e1.status).toBe('complete');
        const result = await runExperiment(rt, {
          experiment: 'E6',
          yes: true,
          gitSha: 'test',
          baseRunId: e1.runId!,
        });
        expect(result.status).toBe('complete');
        return runRow(ctx, result.runId!);
      } finally {
        await rt.close();
      }
    };
    const added = (row: Awaited<ReturnType<typeof runRow>>) =>
      (row.results as { e6: { examplesAdded: Record<string, { yes: number; no: number }> } }).e6
        .examplesAdded;
    await ctx.owner.query(`DELETE FROM settings WHERE key = 'ranker.thresholds'`);
    const yes = (row: Awaited<ReturnType<typeof runRow>>) =>
      Object.values(added(row)).reduce((sum, c) => sum + c.yes, 0);
    const defaults = await e6();
    expect(yes(defaults)).toBe(0);

    const lanes = { forYou: 0.95, maybe: 0.5 };
    await ctx.owner.query(
      `INSERT INTO settings (key, value) VALUES ('ranker.thresholds', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ lanes })],
    );
    try {
      const custom = await e6();
      expect(custom.config['rankerThresholds']).toEqual({ lanes });
      expect(yes(custom)).toBeGreaterThan(0);
      expect(added(custom)).not.toEqual(added(defaults));
    } finally {
      await ctx.owner.query(`DELETE FROM settings WHERE key = 'ranker.thresholds'`);
    }
  });

  it("targets E7 with each rater's own E1 copy of a shared card and honours --raters on base-run experiments", async () => {
    const { rt } = runtime(ctx);
    try {
      const e1 = await runExperiment(rt, { experiment: 'E1', yes: true, gitSha: 'test' });
      expect(e1.status).toBe('complete');
      const e1Id = e1.runId!;
      const e1Config = parseRunConfig((await runRow(ctx, e1Id)).config);
      const b = golden.raters.b;
      // B shares A's battery card (added in the E6 test above).
      expect(e1Config.cards.some((c) => c.raterId === b && c.cardId === golden.cards.battery)).toBe(
        true,
      );
      const targets = async () => {
        const e7 = await runExperiment(rt, {
          experiment: 'E7',
          yes: true,
          gitSha: 'test',
          baseRunId: e1Id,
        });
        expect(e7.status).toBe('complete');
        const row = await runRow(ctx, e7.runId!);
        return (
          row.results as { e7: { items: Array<{ raterId: string; targetedCardId: string }> } }
        ).e7.items.filter((item) => item.raterId === b);
      };
      // Shared answers: battery (the lower id) wins every tie at 0.1, so some of B's items target it.
      const shared = await targets();
      expect(shared.length).toBeGreaterThan(0);
      expect(shared.some((item) => item.targetedCardId === golden.cards.battery)).toBe(true);
      // B's own copy of battery answered 0.99 everywhere (`card.r<B>`, D-112): never the lowest.
      await ctx.owner.query(
        `INSERT INTO eval.run_answers (run_id, article_id, card_id, question_key, answer)
         SELECT $1, article_id, card_id, $2, '{"ok": true, "p": 0.99, "engine": "typesafe"}'::jsonb
           FROM eval.run_answers
          WHERE run_id = $1 AND card_id = $3 AND question_key = 'card'`,
        [e1Id, `card.r${b}`, golden.cards.battery],
      );
      const own = await targets();
      expect(own.length).toBe(shared.length);
      expect(own.every((item) => item.targetedCardId === golden.cards.astronomy)).toBe(true);

      // --raters narrows a base-run experiment to those raters; an unknown id is refused.
      const e6 = await runExperiment(rt, {
        experiment: 'E6',
        yes: true,
        gitSha: 'test',
        baseRunId: e1Id,
        raterIds: [golden.raters.a],
      });
      expect(e6.status).toBe('complete');
      const e6Config = parseRunConfig((await runRow(ctx, e6.runId!)).config);
      expect(e6Config.raters.map((r) => r.raterId)).toEqual([golden.raters.a]);
      expect(new Set(e6Config.cards.map((c) => c.raterId))).toEqual(new Set([golden.raters.a]));
      expect(new Set(e6Config.ratings.map((r) => r.raterId))).toEqual(new Set([golden.raters.a]));
      expect(Object.keys(e6Config.assignments)).toEqual([golden.raters.a]);
      const keys = await ctx.owner.query<{ question_key: string }>(
        `SELECT DISTINCT question_key FROM eval.run_answers WHERE run_id = $1 AND card_id IS NOT NULL`,
        [e6.runId!],
      );
      expect(keys.rows.map((r) => r.question_key)).toEqual([`e6.r${golden.raters.a}`]);
      await expect(
        runExperiment(rt, {
          experiment: 'E7',
          yes: true,
          gitSha: 'test',
          baseRunId: e1Id,
          raterIds: ['999999'],
        }),
      ).rejects.toMatchObject({
        name: 'EvalCommandError',
        message: 'unknown rater id in --raters',
      });
    } finally {
      await rt.close();
    }
  });

  it('estimates again when the deployed ranker thresholds change before the freeze', async () => {
    // E6 suggests its card examples with the frozen thresholds: a change after the first prompt
    // changes the Call B questions, so the run must be estimated and confirmed again.
    const base = runtime(ctx);
    let e1Id: string;
    try {
      const e1 = await runExperiment(base.rt, { experiment: 'E1', yes: true, gitSha: 'test' });
      e1Id = e1.runId!;
    } finally {
      await base.rt.close();
    }
    await ctx.owner.query(`DELETE FROM settings WHERE key = 'ranker.thresholds'`);
    const asked: number[] = [];
    const { rt, out } = runtime(ctx, {
      TYPESAFE_PRICE_PER_MTOK_USD: '200',
      EVAL_CACHE_DIR: await freshCache(),
    });
    let result;
    try {
      result = await runExperiment(rt, {
        experiment: 'E6',
        baseRunId: e1Id,
        gitSha: 'test',
        maxUsd: 1000,
        confirm: async (estimate) => {
          asked.push(estimate.estimatedUsd);
          if (asked.length === 1) {
            await ctx.owner.query(
              `INSERT INTO settings (key, value) VALUES ('ranker.thresholds', $1::jsonb)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
              [JSON.stringify({ lanes: { forYou: 0.95, maybe: 0.5 } })],
            );
            return true;
          }
          return false;
        },
      });
    } finally {
      await rt.close();
      await ctx.owner.query(`DELETE FROM settings WHERE key = 'ranker.thresholds'`);
    }
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toBe(asked[0]);
    expect(out()).toMatch(/revised estimate/);
    expect(result).toMatchObject({ runId: null, status: 'declined' });
  });
});
