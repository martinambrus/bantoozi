import {
  createDatabase,
  createPgOriginLimiter,
  createPool,
  ensureDevUser,
  feedArticlesAwaitingExtraction,
  feedOverview,
  resolveLiveFeedId,
  subscribeToFeed,
  workerOutbox,
  type Database,
  type FeedOverview,
} from '@bantoozi/db';
import { decodeBody, discoverFeed, parseFeed } from '@bantoozi/feeds';
import { createLogger, loadConfig, type ProcessConfig } from '@bantoozi/shared/server';
import { Command } from 'commander';
import type pg from 'pg';

import { createWorkerDeps, fetchWith, type WorkerDeps } from './handlers/deps.js';
import { createHandlers } from './handlers/index.js';

/**
 * Development CLI (M1-T9, spec 03 §10), run as `pnpm worker-cli <command>` against the dev
 * database of `.env` with the worker role:
 * - `feeds:add <url> [--user dev@localhost]`: discover the feed, create the dev user when missing,
 *   subscribe it (inference off) and record a fetch;
 * - `feeds:fetch-now <feedId>`: fetch and ingest the feed now (forced), then run the pending
 *   extractions of its articles inline;
 * - `feeds:show <feedId>`: the feed's bookkeeping and newest articles.
 */

interface Runtime {
  config: ProcessConfig<'worker'>;
  pool: pg.Pool;
  lockPool: pg.Pool;
  db: Database;
  deps: WorkerDeps;
}

function runtime(): Runtime {
  const config = loadConfig({ process: 'worker' });
  const pool = createPool({ connectionString: config.databaseUrlWorker, max: 4 });
  const lockPool = createPool({ connectionString: config.databaseUrlWorker, max: 2 });
  const db = createDatabase(pool);
  const logger = createLogger({ name: 'worker-cli', level: 'warn', pretty: true });
  const deps = createWorkerDeps({
    db,
    lockPool,
    fetch: {
      userAgent: config.fetchUserAgent,
      timeoutMs: config.fetchTimeoutMs,
      maxBytes: config.fetchMaxBytes,
      allowPrivate: config.fetchAllowPrivate,
    },
    ingestMaxAgeDays: config.ingestMaxAgeDays,
    settingsEnv: {
      dailyBudgetUsd: config.dailyBudgetUsd,
      languageModes: config.languageModes,
      signupMode: config.signupMode,
    },
    limiter: createPgOriginLimiter(db),
    logger,
  });
  return { config, pool, lockPool, db, deps };
}

async function withRuntime(fn: (rt: Runtime) => Promise<void>): Promise<void> {
  const rt = runtime();
  try {
    await fn(rt);
  } finally {
    await Promise.all([rt.pool.end(), rt.lockPool.end()]);
  }
}

function printOverview(overview: FeedOverview): void {
  const lines = [
    `feed ${overview.id}: ${overview.title ?? '(untitled)'}`,
    `  url            ${overview.url}`,
    `  fetch_url      ${overview.fetchUrl}`,
    `  status         ${overview.status}  subscribers ${overview.subscriberCount}  lang_hint ${overview.langHint ?? '-'}`,
    `  fetches        ${overview.totalFetches}  last ${overview.lastFetchAt?.toISOString() ?? '-'}  last ok ${overview.lastSuccessAt?.toISOString() ?? '-'}  last error ${overview.lastErrorCode ?? '-'}`,
    `  schedule       every ${overview.fetchIntervalS} s, next ${overview.nextFetchAt.toISOString()}`,
    `  articles (${overview.articles.length} newest):`,
    ...overview.articles.map(
      (a) =>
        `    #${a.id} [${a.pipelineState}${a.bodyStatus === null ? '' : `, body ${a.bodyStatus}`}, ${a.lang ?? 'und'}, ${a.wordCount ?? 0} words] ${a.title}`,
    ),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

const program = new Command('worker-cli').description('Bantoozi worker development CLI (M1-T9)');

program
  .command('feeds:add')
  .description('discover a feed, subscribe the dev user (inference off) and queue a fetch')
  .argument('<url>', 'feed or site URL')
  .option('--user <email>', 'subscriber email (created when missing)', 'dev@localhost')
  .action(async (url: string, options: { user: string }) => {
    await withRuntime(async ({ db, deps }) => {
      const found = await discoverFeed(url, {
        fetch: (u, o) => fetchWith(deps, u, o),
        parse: parseFeed,
        decode: decodeBody,
        allowPrivate: deps.fetch.allowPrivate,
      });
      if (!found.ok) {
        process.stderr.write(`discovery failed: ${found.code} ${found.message}\n`);
        process.exitCode = 1;
        return;
      }
      const [candidate, ...others] = found.candidates;
      if (candidate === undefined || others.length > 0) {
        process.stdout.write('several feeds found; run feeds:add again with one of:\n');
        for (const c of found.candidates) {
          process.stdout.write(`  ${c.url}  (${c.type}) ${c.title ?? ''}\n`);
        }
        process.exitCode = 2;
        return;
      }
      await db.transaction(async (tx) => {
        const user = await ensureDevUser(tx, options.user);
        process.stdout.write(
          `${user.created ? 'created' : 'using'} user ${options.user} (${user.id})\n`,
        );
        const sub = await subscribeToFeed(tx, workerOutbox(tx), {
          userId: user.id,
          url: candidate.canonicalUrl,
          fetchUrl: candidate.url,
          title: found.validated?.parsed.feed.title ?? candidate.title,
        });
        process.stdout.write(
          `${sub.createdSubscription ? 'subscribed' : 'already subscribed'} to feed ${sub.feedId} ` +
            `${candidate.canonicalUrl} (${candidate.type}, inference off${sub.createdFeed ? ', new feed' : ''}); fetch queued\n`,
        );
      });
    });
  });

program
  .command('feeds:fetch-now')
  .description('fetch and ingest a feed now, then extract its new articles inline')
  .argument('<feedId>', 'feed id')
  .action(async (feedId: string) => {
    await withRuntime(async ({ db, deps }) => {
      const handlers = createHandlers(deps);
      const context = { jobId: 'worker-cli', queue: 'feed.fetch' as const };
      const fetch = handlers['feed.fetch'];
      const extract = handlers['article.extract'];
      if (fetch.status !== 'implemented' || extract.status !== 'implemented') {
        throw new Error('ingestion handlers are not implemented');
      }
      await fetch.handle({ feedId, force: true }, context);
      // `feedId` may name a retired feed, or this fetch may have merged it into another feed (a
      // permanent redirect): extract and show the live survivor that now carries the articles.
      const liveId = (await resolveLiveFeedId(db, feedId)) ?? feedId;
      const pending = await feedArticlesAwaitingExtraction(db, liveId);
      for (const articleId of pending) {
        await extract.handle({ articleId }, { jobId: 'worker-cli', queue: 'article.extract' });
      }
      const shown = liveId === feedId ? feedId : `${feedId} (merged into ${liveId})`;
      process.stdout.write(`fetched feed ${shown}; extracted ${pending.length} article(s)\n`);
      const overview = await feedOverview(db, liveId);
      if (overview !== null) printOverview(overview);
    });
  });

program
  .command('feeds:show')
  .description("print a feed's bookkeeping and newest articles")
  .argument('<feedId>', 'feed id')
  .action(async (feedId: string) => {
    await withRuntime(async ({ db }) => {
      const overview = await feedOverview(db, feedId);
      if (overview === null) {
        process.stderr.write(`feed ${feedId} not found\n`);
        process.exitCode = 1;
        return;
      }
      printOverview(overview);
    });
  });

await program.parseAsync(process.argv);
