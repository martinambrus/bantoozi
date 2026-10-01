import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRun, finishRun, getRun } from '@bantoozi/db';

import { replayRun } from '../src/experiments/replay.js';
import { runExperiment } from '../src/experiments/runner.js';
import {
  answerCounts,
  runCli,
  runRow,
  runtime,
  seedGolden,
  setupRunnerTest,
  type RunnerTestContext,
} from './runner-fixtures.js';

/**
 * M3a-T6 (spec 10 §6): `eval replay <runId> [--engine llm]` re-runs a stored run's frozen inputs
 * through the cache and writes the markdown diff report. Tested on fixture runs: an unchanged
 * TypeSafe replay is served from the cache (no request) and passes or is inconclusive; an `llm`
 * replay goes through fake Ollama with the pinned LLM engine; translations are the base run's
 * frozen ones; non-replayable runs and unknown question sets are refused.
 */

let ctx: RunnerTestContext;
let reportDir: string;
const runs: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupRunnerTest();
  await seedGolden(ctx);
  reportDir = await mkdtemp(path.join(tmpdir(), 'bantoozi-eval-replay-'));
  for (const experiment of ['E1', 'E3', 'B0'] as const) {
    const { rt } = runtime(ctx);
    try {
      const result = await runExperiment(rt, { experiment, yes: true, gitSha: 'base' });
      runs[experiment] = result.runId!;
    } finally {
      await rt.close();
    }
  }
});

afterAll(async () => {
  await ctx?.close();
});

describe('eval replay (M3a-T6)', () => {
  it('replays an E1 run unchanged from the cache and writes the diff report', async () => {
    const before = ctx.typesafe.requestCount();
    const reportPath = path.join(reportDir, 'same.md');
    const { rt } = runtime(ctx);
    let result;
    try {
      result = await replayRun(rt, {
        againstRunId: runs['E1']!,
        yes: true,
        gitSha: 'replay',
        reportPath,
      });
    } finally {
      await rt.close();
    }
    expect(ctx.typesafe.requestCount()).toBe(before);
    expect(result.run.status).toBe('complete');
    expect(result.reportPath).toBe(reportPath);
    expect(['pass', 'inconclusive']).toContain(result.verdict);

    const row = await runRow(ctx, result.run.runId!);
    expect(row.experiment).toBe('replay:E1');
    expect(row.config).toMatchObject({
      experiment: 'E1',
      baseRunId: runs['E1'],
      replay: { of: runs['E1'], engine: 'typesafe', model: 'jev-fake', questionSet: 'enrich-v1' },
    });
    expect(await answerCounts(ctx, result.run.runId!)).toEqual(
      await answerCounts(ctx, runs['E1']!),
    );

    const report = await readFile(reportPath, 'utf8');
    expect(report).toBe(result.report);
    expect(report).toContain(`# Replay ${result.run.runId!} vs run ${runs['E1']!} (E1)`);
    expect(report).toContain('## ΔAUC per rater and language');
    expect(report).toMatch(/\| \d+ \| en \| \d+ \| \d+ \| \d+ \| [\d.]+ \| [\d.]+ \| 0\.000 \|/);
    expect(report).toContain('| `card` |');
    expect(report).toMatch(/Items changing lane: 0\/56/);
  });

  it('replays the E1 run with --engine llm through fake Ollama', async () => {
    const typesafeBefore = ctx.typesafe.requestCount();
    const ollamaBefore = ctx.ollama.requestCount();
    const { rt } = runtime(ctx);
    let result;
    try {
      result = await replayRun(rt, {
        againstRunId: runs['E1']!,
        engine: 'llm',
        yes: true,
        gitSha: 'replay',
        reportPath: path.join(reportDir, 'llm.md'),
      });
    } finally {
      await rt.close();
    }
    expect(ctx.typesafe.requestCount()).toBe(typesafeBefore);
    expect(ctx.ollama.requestCount()).toBeGreaterThan(ollamaBefore);
    expect(result.run.status).not.toBe('declined');
    const row = await runRow(ctx, result.run.runId!);
    expect(row.config).toMatchObject({
      engine: { provider: 'llm', requiredEngine: 'llm', model: 'glm-5.3-flash' },
      replay: { engine: 'llm', model: 'glm-5.3-flash' },
    });
    const engines = await ctx.owner.query<{ engine: string }>(
      `SELECT DISTINCT answer->>'engine' AS engine FROM eval.run_answers
        WHERE run_id = $1 AND question_key = 'card' AND (answer->>'ok')::boolean`,
      [result.run.runId],
    );
    expect(engines.rows).toEqual([{ engine: 'llm' }]);
    const calls = await ctx.owner.query<{ kind: string; engine: string }>(
      `SELECT DISTINCT kind, engine FROM engine_calls WHERE engine = 'llm'`,
    );
    expect(calls.rows).toEqual([{ kind: 'eval', engine: 'llm' }]);
    expect(result.report).toContain('engine `llm`, model `glm-5.3-flash`');
  });

  it('reuses the base run’s frozen translations (no LibreTranslate request)', async () => {
    const ltBefore = ctx.libretranslate.requests.length;
    const { rt } = runtime(ctx);
    let result;
    try {
      result = await replayRun(rt, {
        againstRunId: runs['E3']!,
        yes: true,
        gitSha: 'replay',
        reportPath: null,
      });
    } finally {
      await rt.close();
    }
    expect(result.reportPath).toBeNull();
    expect(result.run.status).toBe('complete');
    expect(ctx.libretranslate.requests.length).toBe(ltBefore);
    const row = await runRow(ctx, result.run.runId!);
    expect(row.experiment).toBe('replay:E3');
  });

  it('runs through the CLI and refuses non-replayable runs and unknown question sets', async () => {
    const out = await runCli(ctx, [
      'replay',
      runs['E1']!,
      '--yes',
      '--thresholds',
      path.join(reportDir, 'missing.json'),
    ]).catch((error: unknown) => error);
    expect(out).toMatchObject({ name: 'EvalCommandError', message: /cannot read thresholds/ });

    const reportPath = path.join(reportDir, 'cli.md');
    const printed = await runCli(ctx, ['replay', runs['E1']!, '--yes', '--out', reportPath]);
    expect(printed).toMatch(new RegExp(`replay \\d+ vs ${runs['E1']!}: pass`));
    expect(await readFile(reportPath, 'utf8')).toContain('## Verdict: PASS');

    await expect(runCli(ctx, ['replay', runs['B0']!, '--yes'])).rejects.toMatchObject({
      message: /cannot be replayed/,
    });
    await expect(
      runCli(ctx, ['replay', runs['E1']!, '--yes', '--question-set', 'enrich-v2']),
    ).rejects.toMatchObject({ message: /question set enrich-v2 is not built/ });
    await expect(runCli(ctx, ['replay'])).rejects.toMatchObject({
      message: /name the run to replay/,
    });
  });

  /** A copy of the E1 run's row with other results (and optionally another config). */
  async function copyOfE1(
    results: Record<string, unknown>,
    config?: (c: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<string> {
    const { rt } = runtime(ctx);
    try {
      const e1 = (await getRun(rt.db, runs['E1']!))!;
      const run = await createRun(rt.db, {
        experiment: 'E1',
        datasetVersion: e1.datasetVersion,
        config: config === undefined ? e1.config : config(e1.config),
        gitSha: 'copy',
      });
      await finishRun(rt.db, run.id, results);
      return run.id;
    } finally {
      await rt.close();
    }
  }

  async function replayOf(runId: string, thresholds?: unknown) {
    const { rt } = runtime(ctx);
    try {
      return await replayRun(rt, {
        againstRunId: runId,
        yes: true,
        gitSha: 'replay',
        reportPath: null,
        ...(thresholds === undefined ? {} : { thresholds }),
      });
    } finally {
      await rt.close();
    }
  }

  it('exits nonzero for every verdict but pass: 4 = fail, 5 = inconclusive', async () => {
    // A hard-hide threshold below the never-card's p hides liked articles: the rule fails.
    const thresholds = path.join(reportDir, 'hide-all.json');
    await writeFile(thresholds, JSON.stringify({ never: { hide: 0.05, soft: 0.04 } }));
    const failOut = path.join(reportDir, 'fail.md');
    await expect(
      runCli(ctx, ['replay', runs['E1']!, '--yes', '--thresholds', thresholds, '--out', failOut]),
    ).rejects.toMatchObject({ name: 'EvalCommandError', exitCode: 4 });
    expect(await readFile(failOut, 'utf8')).toContain('## Verdict: FAIL');

    // A base without stored answers leaves the comparison unsupported: inconclusive.
    const e1Results = (await runRow(ctx, runs['E1']!)).results!;
    const empty = await copyOfE1(e1Results);
    const inconclusiveOut = path.join(reportDir, 'inconclusive.md');
    await expect(
      runCli(ctx, ['replay', empty, '--yes', '--out', inconclusiveOut]),
    ).rejects.toMatchObject({
      name: 'EvalCommandError',
      exitCode: 5,
      message: /inconclusive/,
    });
    expect(await readFile(inconclusiveOut, 'utf8')).toContain('## Verdict: INCONCLUSIVE');
  });

  it('refuses an aborted, partial or incompletely covered base run', async () => {
    const e1Results = (await runRow(ctx, runs['E1']!)).results!;
    for (const status of ['aborted', 'partial']) {
      const id = await copyOfE1({ ...e1Results, status });
      await expect(replayOf(id)).rejects.toMatchObject({
        name: 'EvalCommandError',
        message: new RegExp(`run ${id} is ${status}, not complete`),
      });
    }
    const coverage = e1Results['coverage'] as { byLang: Record<string, { expected: number }> };
    const [lang, cell] = Object.entries(coverage.byLang)[0]!;
    const gap = await copyOfE1({
      ...e1Results,
      coverage: { ...coverage, byLang: { ...coverage.byLang, [lang]: { ...cell, valid: 0 } } },
    });
    await expect(replayOf(gap)).rejects.toMatchObject({
      message: new RegExp(`incomplete byLang coverage for ${lang}`),
    });
  });

  it('compares against the deployed thresholds frozen by the base run; --thresholds is replay-only', async () => {
    const base = await runRow(ctx, runs['E1']!);
    expect(base.config['rankerThresholds']).toEqual({});
    // A later settings change does not move the baseline of a run that recorded its thresholds.
    await ctx.owner.query(
      `INSERT INTO settings (key, value) VALUES ('ranker.thresholds', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ lanes: { forYou: 0.8 } })],
    );
    try {
      const proposed = await replayOf(runs['E1']!, { lanes: { maybe: 0.4 } });
      const replay = (await runRow(ctx, proposed.run.runId!)).config['replay'] as Record<
        string,
        { lanes?: unknown } | string | null
      >;
      expect(replay['baseRankerSource']).toBe('base_run');
      expect((replay['baseRanker'] as { lanes: unknown }).lanes).toEqual({
        forYou: 0.65,
        maybe: 0.35,
      });
      expect((replay['replayRanker'] as { lanes: unknown }).lanes).toEqual({
        forYou: 0.65,
        maybe: 0.4,
      });
      expect(replay['thresholds']).toEqual({ lanes: { maybe: 0.4 } });
      expect(proposed.report).toMatch(/Baseline ranker \(from the base run\)/);

      // A base run written before thresholds were recorded uses the stored setting now.
      const legacy = await copyOfE1(base.results!, (c) => {
        const { rankerThresholds: _t, ...rest } = c;
        return rest;
      });
      const fromSettings = await replayOf(legacy, { lanes: { maybe: 0.4 } });
      const legacyReplay = (await runRow(ctx, fromSettings.run.runId!)).config['replay'] as Record<
        string,
        { lanes?: unknown } | string | null
      >;
      expect(legacyReplay['baseRankerSource']).toBe('settings');
      expect((legacyReplay['baseRanker'] as { lanes: unknown }).lanes).toEqual({
        forYou: 0.8,
        maybe: 0.35,
      });
      expect((legacyReplay['replayRanker'] as { lanes: unknown }).lanes).toEqual({
        forYou: 0.8,
        maybe: 0.4,
      });
      expect(fromSettings.report).toContain('the stored `ranker.thresholds` at replay time');
      expect(fromSettings.report).toMatch(/Maybe share \d+\/\d+/);
    } finally {
      await ctx.owner.query(`DELETE FROM settings WHERE key = 'ranker.thresholds'`);
    }
  });
});
