import { setTimeout as delay } from 'node:timers/promises';

import {
  collectionLangCounts,
  collectionProgress,
  ensureEvalUser,
  listEvalFeeds,
  readWorkerHeartbeats,
  subscribeToFeed,
  subscribedFeedsByUrl,
  workerOutbox,
  type CollectionLangCount,
  type CollectionProgress,
  type Database,
} from '@bantoozi/db';
import { enqueueFetch } from '@bantoozi/shared';

import type { GoldenFeed } from './feed-list.js';
import { checkWorkers, type WorkerCheck } from './worker-check.js';

/**
 * `eval ingest-sample` (spec 10 §2.1): with a live ingest-only worker and no ordinary one, create
 * or reuse the evaluation user, subscribe it to the golden feeds (inference stays `off`), fetch every
 * feed once now, wait until the extraction of what that fetched has drained, and print the
 * collected articles per language. `--watch` then keeps the user subscribed and prints the counts
 * every 10 minutes until stopped; between runs the normal schedule keeps fetching, because the
 * evaluation user is a subscriber.
 */

export interface IngestDeps {
  db: Database;
  now: () => Date;
  out: (text: string) => void;
  /** Waits `ms`; resolves early (never rejects) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Stops the drain wait and `--watch`. */
  signal?: AbortSignal;
}

export interface IngestOptions {
  feeds: readonly GoldenFeed[];
  /** How long to wait for the drain before reporting and returning. */
  drainTimeoutMs: number;
  /** Drain poll interval. */
  pollMs: number;
  watch: boolean;
  /** `--watch` report interval (spec 10 §2.1: 10 minutes). */
  watchIntervalMs: number;
  /** Stop `--watch` after this many reports (tests); default: until the signal aborts. */
  maxWatchReports?: number;
}

export class WorkerPreconditionError extends Error {
  readonly check: Extract<WorkerCheck, { ok: false }>;
  constructor(check: Extract<WorkerCheck, { ok: false }>) {
    super(check.message);
    this.name = 'WorkerPreconditionError';
    this.check = check;
  }
}

export interface SubscribeReport {
  userId: string;
  userCreated: boolean;
  created: number;
  subscribed: number;
  alreadySubscribed: number;
  /** Feeds not fetched now (paused, dead or quarantined), by canonical URL. */
  notFetched: { url: string; status: string }[];
}

export interface IngestResult {
  subscribe: SubscribeReport;
  drained: boolean;
  progress: CollectionProgress;
  counts: CollectionLangCount[];
  watchReports: number;
}

export const defaultSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  try {
    await delay(ms, undefined, signal === undefined ? {} : { signal });
  } catch (error) {
    if (signal?.aborted !== true) throw error;
  }
};

/** Refuse unless an ingest-only worker, and no ordinary worker, is live (spec 10 §2.1). */
export async function assertCollectionWorkers(db: Database, now: Date): Promise<WorkerCheck> {
  const check = checkWorkers(await readWorkerHeartbeats(db), now);
  if (!check.ok) throw new WorkerPreconditionError(check);
  return check;
}

/**
 * Subscribe the evaluation user to every listed feed it is not subscribed to yet (each in its own
 * transaction, so one bad feed does not undo the others; the subscription records the feed's fetch,
 * due at once for a new feed), and record a forced fetch for every feed it already subscribed to,
 * so each active feed is fetched once now.
 */
export async function subscribeGoldenFeeds(
  db: Database,
  feeds: readonly GoldenFeed[],
): Promise<SubscribeReport> {
  const user = await db.transaction((tx) => ensureEvalUser(tx));
  const report: SubscribeReport = {
    userId: user.id,
    userCreated: user.created,
    created: 0,
    subscribed: 0,
    alreadySubscribed: 0,
    notFetched: [],
  };
  const existing = await subscribedFeedsByUrl(
    db,
    user.id,
    feeds.map((f) => f.canonicalUrl),
  );
  for (const feed of feeds) {
    await db.transaction(async (tx) => {
      const sender = workerOutbox(tx);
      const known = existing.get(feed.canonicalUrl);
      let status: string;
      if (known !== undefined) {
        report.alreadySubscribed += 1;
        status = known.status;
        if (status === 'active') await enqueueFetch(sender, { feedId: known.feedId, force: true });
      } else {
        const sub = await subscribeToFeed(tx, sender, {
          userId: user.id,
          url: feed.canonicalUrl,
          fetchUrl: feed.url,
          title: null,
        });
        if (sub.createdFeed) report.created += 1;
        if (sub.createdSubscription) report.subscribed += 1;
        else report.alreadySubscribed += 1;
        status = sub.feedStatus;
      }
      if (status !== 'active') report.notFetched.push({ url: feed.canonicalUrl, status });
    });
  }
  return report;
}

/** Re-subscribe listed feeds the user lost (`--watch`); returns how many were re-subscribed. */
export async function keepSubscribed(
  db: Database,
  userId: string,
  feeds: readonly GoldenFeed[],
): Promise<number> {
  const existing = await subscribedFeedsByUrl(
    db,
    userId,
    feeds.map((f) => f.canonicalUrl),
  );
  let n = 0;
  for (const feed of feeds) {
    if (existing.has(feed.canonicalUrl)) continue;
    await db.transaction(async (tx) => {
      await subscribeToFeed(tx, workerOutbox(tx), {
        userId,
        url: feed.canonicalUrl,
        fetchUrl: feed.url,
        title: null,
      });
    });
    n += 1;
  }
  return n;
}

/** Extraction drained: every active golden feed was fetched since the start, nothing awaits extraction. */
export function isDrained(progress: CollectionProgress): boolean {
  return (
    progress.awaitingFetch === 0 &&
    progress.awaitingExtraction === 0 &&
    (progress.pendingIntents['article.extract'] ?? 0) === 0 &&
    (progress.pendingJobs['article.extract'] ?? 0) === 0
  );
}

export function formatProgress(progress: CollectionProgress): string {
  const q = (queue: string) =>
    (progress.pendingIntents[queue] ?? 0) + (progress.pendingJobs[queue] ?? 0);
  return (
    `feeds fetched ${progress.feeds - progress.awaitingFetch - progress.inactive}/` +
    `${progress.feeds - progress.inactive}` +
    (progress.inactive > 0 ? ` (${progress.inactive} not fetched)` : '') +
    `, awaiting extraction ${progress.awaitingExtraction}, queued feed.fetch ${q('feed.fetch')}, ` +
    `article.extract ${q('article.extract')}`
  );
}

export function formatLangCounts(counts: readonly CollectionLangCount[]): string {
  const lines = ['lang  articles  eligible  pending  stale  failed'];
  for (const c of counts) {
    lines.push(
      [
        c.lang.padEnd(4),
        String(c.articles).padStart(8),
        String(c.eligible).padStart(9),
        String(c.pending).padStart(8),
        String(c.stale).padStart(6),
        String(c.failed).padStart(7),
      ].join(' '),
    );
  }
  if (counts.length === 0) lines.push('(no articles collected yet)');
  return `${lines.join('\n')}\n`;
}

export async function runIngestSample(
  deps: IngestDeps,
  options: IngestOptions,
): Promise<IngestResult> {
  const { db, now, out } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const aborted = () => deps.signal?.aborted === true;

  const check = await assertCollectionWorkers(db, now());
  if (check.ok) {
    out(`ingest-only worker(s) live: ${check.ingestOnly.map((w) => w.processId).join(', ')}\n`);
  }
  const started = now();
  const subscribe = await subscribeGoldenFeeds(db, options.feeds);
  out(
    `${subscribe.userCreated ? 'created' : 'using'} the evaluation user; ` +
      `${options.feeds.length} feeds: ${subscribe.created} new, ${subscribe.subscribed} subscribed, ` +
      `${subscribe.alreadySubscribed} already subscribed\n`,
  );
  for (const feed of subscribe.notFetched) {
    out(`  not fetched now (${feed.status}): ${feed.url}\n`);
  }

  // Fetch attempts are stamped by the worker's clock: allow a little skew against ours.
  const since = new Date(started.getTime() - 5_000);
  const deadline = started.getTime() + options.drainTimeoutMs;
  let progress = await collectionProgress(db, subscribe.userId, since);
  let last = '';
  for (;;) {
    const line = formatProgress(progress);
    if (line !== last) out(`${now().toISOString()}  ${line}\n`);
    last = line;
    if (isDrained(progress) || aborted() || now().getTime() >= deadline) break;
    await sleep(Math.min(options.pollMs, Math.max(0, deadline - now().getTime())), deps.signal);
    progress = await collectionProgress(db, subscribe.userId, since);
  }
  const drained = isDrained(progress);
  out(
    drained
      ? 'drained: every feed was fetched and its new articles extracted\n'
      : `not drained after ${Math.round((now().getTime() - started.getTime()) / 1000)} s; ` +
          'the worker keeps collecting (check with `eval status` or `eval ingest-sample --watch`)\n',
  );
  let counts = await collectionLangCounts(db, subscribe.userId);
  out(formatLangCounts(counts));
  const feeds = await listEvalFeeds(db, subscribe.userId);
  for (const feed of feeds) {
    if (feed.lastErrorCode !== null || feed.articles === 0) {
      out(
        `  feed ${feed.feedId} ${feed.url}: ${feed.articles} articles` +
          `${feed.lastErrorCode === null ? '' : `, last error ${feed.lastErrorCode}`}\n`,
      );
    }
  }

  let watchReports = 0;
  if (options.watch) {
    out(
      `watching: counts every ${Math.round(options.watchIntervalMs / 60_000)} min until stopped (Ctrl-C)\n`,
    );
    while (
      !aborted() &&
      (options.maxWatchReports === undefined || watchReports < options.maxWatchReports)
    ) {
      await sleep(options.watchIntervalMs, deps.signal);
      if (aborted()) break;
      const workers = checkWorkers(await readWorkerHeartbeats(db), now());
      if (!workers.ok) out(`WARNING: ${workers.message.split('\n')[0] ?? ''}\n`);
      const resubscribed = await keepSubscribed(db, subscribe.userId, options.feeds);
      if (resubscribed > 0) out(`re-subscribed ${resubscribed} feed(s)\n`);
      progress = await collectionProgress(db, subscribe.userId, since);
      counts = await collectionLangCounts(db, subscribe.userId);
      out(`${now().toISOString()}  ${formatProgress(progress)}\n${formatLangCounts(counts)}`);
      watchReports += 1;
    }
  }
  return { subscribe, drained, progress, counts, watchReports };
}
