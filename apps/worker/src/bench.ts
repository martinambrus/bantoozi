/**
 * Dev benchmark (not a test, D-259): runs the real handlers and reader queries in-process against
 * the dev database and reports their wall time. Statement times: `log_min_duration_statement`.
 *
 *   pnpm --filter @bantoozi/worker bench <userId> [rank-full|rank|learn|samples|ratebulk|api|api-nojit]...
 *
 * `rank-full` rewrites every window row (what a model activation triggers); `learn` trains inline and
 * in a thread and stores nothing; `samples` loads the learning samples as `GET /me/learning` does;
 * `ratebulk` rates 200 unread articles of feed 29 and rolls back; `api` / `api-nojit` time the
 * reader's counts, badges and lists.
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  countArticles,
  countSubscriptionUnread,
  createDatabase,
  createPool,
  listArticlePage,
  loadLearnSamples,
  rateArticlesBulk,
  tenantOutbox,
  lockLearnUser,
  readerReleaseClock,
  readStoredSetting,
  retryTransaction,
  withTenant,
} from '@bantoozi/db';
import { activeTrainingKernel, scoreVersion, setTrainingKernel } from '@bantoozi/ranker';
import { parseSetting } from '@bantoozi/shared';
import { trainUserModel, type TrainingSample } from '@bantoozi/ranker';
import { createLogger, loadConfig } from '@bantoozi/shared/server';

import { loadLearnInputs } from './learn/inputs.js';
import { CpuPool, cpuPoolSize } from './cpu-pool.js';
import { poolTrainer } from './learn/trainer.js';
import { isDeepStrictEqual } from 'node:util';
import { createUserRankHandler } from './handlers/user-rank.js';
import { createWorkerRuntime } from './runtime.js';
import type { WorkerDeps } from './handlers/deps.js';

const [userId, ...modes] = process.argv.slice(2);
if (userId === undefined) throw new Error('usage: bench.ts <userId> [rank-full|rank|learn]...');

const config = loadConfig({ process: 'worker' });
const logger = createLogger({ name: 'bench', level: 'warn', pretty: true });
const pool = createPool({ connectionString: config.databaseUrlWorker, max: 4 });

const db = createDatabase(pool);

const runtime = await createWorkerRuntime({
  db,
  config,
  logger,
  exit: () => undefined,
  drain: async () => undefined,
  selfRestart: false,
  recordPin: false,
} as never);
const settingsEnv = {
  prefilterMinCards: config.prefilterMinCards,
  dailyBudgetUsd: config.dailyBudgetUsd,
  languageModes: config.languageModes,
  signupMode: config.signupMode,
};
const deps = {
  db,
  settingsEnv,
  logger: { ...logger, info: (o: unknown) => console.log('  ', JSON.stringify(o)) },
  classification: runtime.models.classification,
} as unknown as WorkerDeps;

function report(label: string, wall: number) {
  console.log(`== ${label}: ${wall.toFixed(0)} ms`);
}

const appPool = createPool({ connectionString: process.env['DATABASE_URL'] ?? '', max: 2 });
let jit = 'on';
appPool.on('acquire', (client) => void client.query(`SET jit = ${jit}`));
const appDb = createDatabase(appPool);

/** The reader calls of a tier switch (counts, badges, list) for the global view and feed 29. */
async function benchApi(noJit: boolean) {
  const time = async (label: string, fn: (tx: never) => Promise<unknown>) => {
    const t0 = performance.now();
    jit = noJit ? 'off' : 'on';
    await withTenant(appDb, userId!, async (tx) => {
      await fn(tx as never);
    });
    console.log(`  ${label.padEnd(36)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`);
  };
  const base = async (tx: never) => {
    const stored = await readStoredSetting(tx, 'ranker.settings_version');
    return {
      asOf: (await readerReleaseClock(tx, new Date())).asOf,
      scoreVersion: scoreVersion(
        stored === undefined ? 0 : parseSetting('ranker.settings_version', stored),
      ),
    };
  };
  for (const minTier of [2, 1]) {
    await time(`badges (perFeed) tier ${minTier}`, async (tx) =>
      countSubscriptionUnread(tx, { ...(await base(tx)), minTier }),
    );
    await time(`counts global tier ${minTier}`, async (tx) =>
      countArticles(tx, { ...(await base(tx)), scope: {}, status: 'unread', minTier }),
    );
    await time(`counts feed 29 tier ${minTier}`, async (tx) =>
      countArticles(tx, {
        ...(await base(tx)),
        scope: { feedId: '29' },
        status: 'unread',
        minTier,
      }),
    );
    for (const [scope, lane] of [
      [{}, 'for_you'],
      [{ feedId: '29' }, 'all'],
    ] as const) {
      await time(`list ${JSON.stringify(scope)} ${lane} tier ${minTier}`, async (tx) =>
        listArticlePage(tx, {
          ...(await base(tx)),
          scope,
          lane,
          status: 'unread',
          minTier,
          sort: 'score',
          limit: 50,
          after: null,
        } as never),
      );
    }
  }
}

/** `rate-bulk` of 200 unread, unrated feed-29 articles (like "rate visible"), always rolled back. */
async function benchRateBulk() {
  const rows = await pool.query<{ id: string; sv: string; rev: string }>(
    `SELECT ua.article_id::text AS id, ua.state_version::text AS sv, a.content_revision::text AS rev
       FROM user_article ua JOIN articles a ON a.id = ua.article_id
       JOIN feed_items fi ON fi.article_id = a.id AND fi.feed_id = 29
      WHERE ua.user_id = $1 AND ua.read_at IS NULL AND ua.rating IS NULL
      ORDER BY a.id DESC LIMIT 200`,
    [userId],
  );
  const t0 = performance.now();
  await withTenant(appDb, userId!, async (tx) => {
    await rateArticlesBulk(tx, {
      targets: rows.rows.map((r) => ({
        articleId: r.id,
        fence: { stateVersion: r.sv, contentRevision: r.rev },
      })),
      rating: 1,
      now: new Date(),
      outbox: tenantOutbox(tx),
    } as never);
    console.log(
      `  rate-bulk ${rows.rows.length}: ${(performance.now() - t0).toFixed(0)} ms (rolling back)`,
    );
    throw new Error('rollback');
  }).catch((error: unknown) => {
    if ((error as Error).message !== 'rollback') throw error;
  });
}

for (const mode of modes.length === 0 ? ['rank'] : modes) {
  const t0 = performance.now();
  if (mode === 'rank' || mode === 'rank-full') {
    const handler = createUserRankHandler(deps);
    await handler(
      { userId, reason: 'bench', ...(mode === 'rank-full' ? { full: true } : {}) } as never,
      {} as never,
    );
  } else if (mode === 'learn') {
    // BENCH_KERNEL=js|wasm: the Newton accumulation kernel of this process (D-264).
    const kernel = process.env['BENCH_KERNEL'];
    if (kernel === 'js' || kernel === 'wasm') setTrainingKernel(kernel);
    console.log(`  training kernel: ${activeTrainingKernel()}`);
    const inputs = await retryTransaction(db, async (tx) => {
      await lockLearnUser(tx, userId, 'share');
      return loadLearnInputs(tx, deps, userId, new Date());
    });
    const loaded = performance.now();
    console.log(
      `  learn inputs: ${inputs.samples.length} samples in ${(loaded - t0).toFixed(0)} ms`,
    );
    const args = {
      samples: inputs.samples as unknown as TrainingSample[],
      now: inputs.now,
      config: inputs.config,
      heldCards: inputs.held,
      ratingSha: inputs.ratingSha,
      consent: inputs.consent,
      seedMaterial: `learn:${userId}:${inputs.eligibleSetSha}`,
      feedbackCutoffEventId: inputs.cutoffEventId,
    };
    // BENCH_ARGS=<file>: the training arguments, to replay one training elsewhere.
    const argsFile = process.env['BENCH_ARGS'];
    if (argsFile !== undefined) writeFileSync(argsFile, JSON.stringify(args));
    const result = trainUserModel(args, { mode: 'production' });
    const inline = performance.now();
    // BENCH_DUMP=<file>: the training result, to compare two code versions.
    const dump = process.env['BENCH_DUMP'];
    if (dump !== undefined) {
      writeFileSync(dump, JSON.stringify(result));
      console.log(`  train inline: ${(inline - loaded).toFixed(0)} ms (dumped)`);
      report(mode, performance.now() - t0);
      continue;
    }
    console.log(
      `  train inline: ${(inline - loaded).toFixed(0)} ms, features ${result.model?.features.length ?? 0}`,
    );
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 100);
    const pool = new CpuPool({ size: cpuPoolSize() });
    const threaded = await poolTrainer(pool)(args, 'production');
    // Warm threads: a second run.
    if (process.env['BENCH_PHASES'] === '1') {
      const w0 = performance.now();
      await poolTrainer(pool)(args, 'production');
      console.log(`  warm pool: ${(performance.now() - w0).toFixed(0)} ms`);
    }
    await pool.close();
    clearInterval(ticker);
    console.log(
      `  train pool (${cpuPoolSize()} threads): ${(performance.now() - inline).toFixed(0)} ms, event-loop ticks ${ticks}, identical ${isDeepStrictEqual(result, threaded)}`,
    );
  } else if (mode === 'samples') {
    await withTenant(appDb, userId, async (tx) => {
      const { samples } = await loadLearnSamples(tx, { userId, now: new Date() });
      console.log(`  loadLearnSamples (as /me/learning): ${samples.length} samples`);
    });
  } else if (mode === 'ratebulk') {
    await benchRateBulk();
  } else if (mode === 'api' || mode === 'api-nojit') {
    await benchApi(mode === 'api-nojit');
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  report(mode, performance.now() - t0);
}
await Promise.all([pool.end(), appPool.end()]);
process.exit(0);
