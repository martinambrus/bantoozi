import { readdir } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runExperiment } from '../src/experiments/runner.js';
import {
  answerCounts,
  runRow,
  runtime,
  seedGolden,
  setupRunnerTest,
  type RunnerTestContext,
} from './runner-fixtures.js';

/**
 * M3a-T6 (spec 10 §3): the content-addressed eval cache in `EVAL_CACHE_DIR`. A second run of the
 * same experiment sends nothing to the (counting) fake TypeSafe, bills nothing, and stores the same
 * answers; its estimate is zero. Changing the model id misses the cache.
 */

let ctx: RunnerTestContext;

beforeAll(async () => {
  ctx = await setupRunnerTest();
  await seedGolden(ctx);
});

afterAll(async () => {
  await ctx?.close();
});

async function cardAnswers(runId: string) {
  const result = await ctx.owner.query<{ article_id: string; card_id: string; p: number }>(
    `SELECT article_id::text, card_id::text, (answer->>'p')::float8 AS p FROM eval.run_answers
      WHERE run_id = $1 AND question_key = 'card' ORDER BY article_id, card_id`,
    [runId],
  );
  return result.rows;
}

async function run(overrides: Record<string, string> = {}) {
  const { rt, out } = runtime(ctx, overrides);
  try {
    const result = await runExperiment(rt, { experiment: 'E1', yes: true, gitSha: 'test' });
    return { result, out: out() };
  } finally {
    await rt.close();
  }
}

describe('eval cache (M3a-T6)', () => {
  it('a re-run hits the cache: no new TypeSafe requests, nothing billed, same answers', async () => {
    const before = ctx.typesafe.requestCount();
    const first = await run();
    const afterFirst = ctx.typesafe.requestCount();
    expect(first.result.status).toBe('complete');
    expect(afterFirst).toBeGreaterThan(before);
    expect((await readdir(ctx.cacheDir)).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(
      0,
    );

    const second = await run();
    expect(second.result.status).toBe('complete');
    expect(ctx.typesafe.requestCount()).toBe(afterFirst);
    expect(second.result.estimate).toMatchObject({ estimatedUsd: 0, uncachedCalls: 0 });
    expect(second.result.estimate.cacheHits).toBeGreaterThan(0);
    expect(second.out).toMatch(/estimated cost \$0\.0000 \(0 uncached request\(s\)/);
    const results = (await runRow(ctx, second.result.runId!)).results as {
      cost: { billedUsd: number; cacheHits: number; cacheMisses: number; cacheSavingsUsd: number };
      cacheLookupMs: { n: number };
    };
    expect(results.cost).toMatchObject({ billedUsd: 0, cacheMisses: 0 });
    expect(results.cost.cacheHits).toBeGreaterThan(0);
    expect(results.cost.cacheSavingsUsd).toBeGreaterThan(0);
    expect(results.cacheLookupMs.n).toBeGreaterThan(0);

    expect(await cardAnswers(second.result.runId!)).toEqual(await cardAnswers(first.result.runId!));
    expect(await answerCounts(ctx, second.result.runId!)).toEqual(
      await answerCounts(ctx, first.result.runId!),
    );
    const cached = await ctx.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM eval.run_answers
        WHERE run_id = $1 AND question_key = 'card' AND (answer->>'cached')::boolean`,
      [second.result.runId],
    );
    expect(cached.rows[0]!.n).toBe(32 * 4 + 24);
  });

  it('a different model id is a different cache key', async () => {
    const before = ctx.typesafe.requestCount();
    const other = await run({ TYPESAFE_MODEL: 'jev-fake-2' });
    // The model id is part of every manifest: the same inputs are asked again.
    expect(ctx.typesafe.requestCount()).toBeGreaterThan(before);
    expect(other.result.estimate.uncachedCalls).toBeGreaterThan(0);
  });
});
