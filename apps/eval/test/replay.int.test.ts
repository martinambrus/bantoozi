import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    expect(printed).toMatch(new RegExp(`replay \\d+ vs ${runs['E1']!}: (pass|inconclusive)`));
    expect(await readFile(reportPath, 'utf8')).toContain('## Verdict');

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
});
