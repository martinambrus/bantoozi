import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXPERIMENT_IDS } from '../src/experiments/definitions.js';
import { runExperiment } from '../src/experiments/runner.js';
import { composedCostPerArticle } from '../src/report/gate.js';
import { loadDataset } from '../src/report/load.js';
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

    // The CLI exits 3 on an abort (cap 0 with an uncached run of the same price).
    await expect(
      runCli(ctx, ['run', 'E1', '--yes', '--max-usd', '0'], {
        ...env,
        EVAL_CACHE_DIR: await freshCache(),
      }),
    ).rejects.toMatchObject({ name: 'EvalCommandError', exitCode: 3 });

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
    const { rt } = runtime(ctx);
    let e6RunId: string;
    try {
      const e1 = await runExperiment(rt, { experiment: 'E1', yes: true, gitSha: 'test' });
      expect(e1.status).toBe('complete');
      const e6 = await runExperiment(rt, {
        experiment: 'E6',
        yes: true,
        gitSha: 'test',
        baseRunId: e1.runId!,
      });
      expect(e6.status).toBe('complete');
      e6RunId = e6.runId!;
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
  });

  it('`eval run B0 --yes` through the CLI', async () => {
    const out = await runCli(ctx, ['run', 'B0', '--yes', '--langs', 'en']);
    expect(out).toMatch(/B0 on golden-v1: estimated cost \$0\.0000/);
    expect(out).toMatch(/run \d+ complete: billed \$0\.0000/);
  });
});
