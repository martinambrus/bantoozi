import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import {
  FeedListError,
  feedListMixProblems,
  feedListSummary,
  readFeedList,
} from '../collection/feed-list.js';
import { runIngestSample, WorkerPreconditionError } from '../collection/ingest.js';
import { DEFAULT_FEED_LIST, resolveRepoPath } from '../collection/paths.js';
import { formatProbeReport, probeFeeds } from '../collection/reachability.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval ingest-sample [--feeds apps/eval/data/feeds-golden.txt] [--dry-run] [--watch]` (spec 10
 * §2.1, M3a-T2). `--dry-run` only fetches each listed feed once through the SSRF-safe client and
 * reports its reachability; it reads no database. Without it the command requires a live
 * ingest-only worker (and no ordinary one), subscribes the evaluation user, waits for the drain and
 * prints per-language counts; `--watch` keeps reporting every 10 minutes.
 */

const OptionsSchema = z.object({
  feeds: z.string().min(1),
  dryRun: z.boolean().default(false),
  watch: z.boolean().default(false),
  timeout: z.coerce
    .number()
    .positive()
    .max(24 * 60),
  poll: z.coerce.number().positive().max(3600),
  interval: z.coerce
    .number()
    .positive()
    .max(24 * 60),
});

export function registerIngestSample(program: Command, ctx: CliContext): void {
  program
    .command('ingest-sample')
    .description(describeCommand('ingest-sample'))
    .option(
      '--feeds <path>',
      'golden feed list (relative to the repository root)',
      DEFAULT_FEED_LIST,
    )
    .option('--dry-run', 'only check that every feed is reachable and parses; no database writes')
    .option('--watch', 'after the drain, keep the feeds subscribed and print counts until stopped')
    .option('--timeout <minutes>', 'how long to wait for the extraction drain', '60')
    .option('--poll <seconds>', 'drain poll interval', '15')
    .option('--interval <minutes>', '--watch report interval', '10')
    .action(async (raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      const options = parsed.data;
      await withRuntime(ctx, async (rt) => {
        const path = resolveRepoPath(options.feeds);
        let feeds;
        try {
          feeds = await readFeedList(path, { allowPrivate: rt.config.fetchAllowPrivate });
        } catch (error) {
          if (error instanceof FeedListError) throw new EvalCommandError(error.message);
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new EvalCommandError(`feed list not found: ${path}`);
          }
          throw error;
        }
        const summary = Object.entries(feedListSummary(feeds))
          .map(
            ([lang, byCategory]) =>
              `${lang} ${Object.values(byCategory).reduce((a, b) => a + b, 0)} (` +
              Object.entries(byCategory)
                .map(([category, n]) => `${category} ${n}`)
                .join(', ') +
              ')',
          )
          .join('; ');
        rt.out(`${feeds.length} golden feeds from ${options.feeds}: ${summary}\n`);
        for (const problem of feedListMixProblems(feeds)) {
          rt.err(`warning: ${problem} (spec 10 §2.1)\n`);
        }

        if (options.dryRun) {
          const results = await probeFeeds(feeds, {
            userAgent: rt.config.fetchUserAgent,
            timeoutMs: rt.config.fetchTimeoutMs,
            maxBytes: rt.config.fetchMaxBytes,
            allowPrivate: rt.config.fetchAllowPrivate,
            now: rt.now,
          });
          rt.out(formatProbeReport(results));
          return;
        }

        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          await runIngestSample(
            { db: rt.db, now: rt.now, out: rt.out, signal: controller.signal },
            {
              feeds,
              drainTimeoutMs: options.timeout * 60_000,
              pollMs: options.poll * 1000,
              watch: options.watch,
              watchIntervalMs: options.interval * 60_000,
            },
          );
        } catch (error) {
          if (error instanceof WorkerPreconditionError) throw new EvalCommandError(error.message);
          throw error;
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
      });
    });
}
