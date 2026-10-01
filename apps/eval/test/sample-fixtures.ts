import {
  createDatabase,
  ensureEvalUser,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
  type Database,
} from '@bantoozi/db';
import {
  createArticle,
  createFeed,
  createSubscription,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';

import { buildCli } from '../src/cli.js';
import { createEvalRuntime } from '../src/runtime.js';

/**
 * Shared fixtures of the M3a-T2 integration tests: a migrated test database with owner and worker
 * pools, the evaluation user, golden feeds it subscribes to, collected articles, and the CLI run as
 * `bantoozi_worker` (as `pnpm evaluate` runs it).
 */

export interface EvalTestContext {
  testDb: TestDatabase;
  owner: pg.Pool;
  workerPool: pg.Pool;
  db: Database;
  evalUserId: string;
  close(): Promise<void>;
}

export async function setupEvalTest(): Promise<EvalTestContext> {
  const testDb = await setupTestDatabase({
    pkg: 'eval',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  const owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 3 });
  const workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  const db = createDatabase(workerPool);
  const user = await db.transaction((tx) => ensureEvalUser(tx));
  return {
    testDb,
    owner,
    workerPool,
    db,
    evalUserId: user.id,
    async close() {
      await Promise.all([owner.end(), workerPool.end()]);
      await dropCreatedTestDatabases();
    },
  };
}

/** A golden feed: subscribed by the evaluation user. */
export async function goldenFeed(ctx: EvalTestContext, name: string): Promise<string> {
  const feed = await createFeed(ctx.owner, { url: `https://${name}.example.test/feed.xml` });
  await createSubscription(ctx.owner, { userId: ctx.evalUserId, feedId: feed.id });
  return feed.id;
}

export interface ArticleSpec {
  feedIds: string[];
  lang: string | null;
  state?: string;
  title?: string;
  firstSeenAt?: Date;
}

/** A collected article with its detected language and pipeline state. */
export async function collected(ctx: EvalTestContext, spec: ArticleSpec): Promise<string> {
  const article = await createArticle(ctx.owner, {
    feedIds: spec.feedIds,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    firstSeenAt: spec.firstSeenAt ?? new Date('2026-09-20T08:00:00Z'),
    publishedAt: spec.firstSeenAt ?? new Date('2026-09-20T07:00:00Z'),
  });
  await ctx.owner.query(
    'UPDATE articles SET lang = $2, pipeline_state = $3, word_count = 300 WHERE id = $1',
    [article.id, spec.lang, spec.state ?? 'extracted'],
  );
  return article.id;
}

export interface CliRun {
  out: string;
  err: string;
}

/** Run `eval <args>` against the test database as the worker role. */
export async function runCli(
  ctx: EvalTestContext,
  args: string[],
  options: { now?: () => Date; env?: Record<string, string> } = {},
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  const runtime = createEvalRuntime({
    env: { DATABASE_URL_WORKER: ctx.testDb.urls.worker, ...options.env },
    io,
    ...(options.now === undefined ? {} : { now: options.now }),
    poolMax: 2,
  });
  try {
    await buildCli({ io, openRuntime: () => runtime }).parseAsync(['node', 'cli', ...args]);
  } catch (error) {
    if (error instanceof Error) {
      Object.assign(error, { out: out.join(''), err: err.join('') });
    }
    throw error;
  }
  return { out: out.join(''), err: err.join('') };
}

export { dropCreatedTestDatabases };
