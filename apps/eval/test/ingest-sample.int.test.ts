import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { recordWorkerHeartbeat } from '@bantoozi/db';
import { createArticle } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseFeedList, type GoldenFeed } from '../src/collection/feed-list.js';
import { runIngestSample, WorkerPreconditionError } from '../src/collection/ingest.js';
import { runCli, setupEvalTest, type EvalTestContext } from './sample-fixtures.js';

/**
 * M3a-T2 (spec 10 §2.1, D-96): `eval ingest-sample` requires a live ingest-only worker and refuses
 * while any ordinary worker is live; it subscribes the evaluation user to the golden feeds with
 * inference off, fetches each once, waits for the extraction drain (with a timeout), prints
 * per-language counts, and `--watch` keeps the feeds subscribed and reports periodically. The worker
 * itself is simulated with SQL between polls (its handlers are tested in apps/worker).
 */

let ctx: EvalTestContext;
let feeds: GoldenFeed[];
let listPath: string;

const LIST = [
  'en news https://news-en.example.com/feed.xml',
  'en tech https://tech-en.example.com/feed.xml',
  'sk news https://spravy.example.sk/rss',
  'cs news https://zpravy.example.cz/rss',
].join('\n');

async function heartbeat(id: string, evalIngestOnly: boolean, at = new Date()): Promise<void> {
  await recordWorkerHeartbeat(
    ctx.db,
    id,
    {
      at: at.toISOString(),
      queues: evalIngestOnly
        ? ['feed.schedule', 'feed.fetch', 'article.extract']
        : ['feed.fetch', 'article.extract', 'article.enrich'],
      evalIngestOnly,
      envCredentials: [],
    },
    at,
  );
}

async function subscriptions(): Promise<{ url: string; inference_mode: string }[]> {
  const result = await ctx.owner.query<{ url: string; inference_mode: string }>(
    `SELECT f.url, s.inference_mode FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
      WHERE s.user_id = $1 ORDER BY f.url`,
    [ctx.evalUserId],
  );
  return result.rows;
}

/** What an ingest-only worker would do: fetch every queued feed and record new articles. */
async function simulateFetch(langs: Record<string, string>): Promise<void> {
  const fetched = await ctx.owner.query<{ id: string; url: string }>(
    `UPDATE job_outbox o SET delivered_at = now()
       FROM feeds f
      WHERE o.queue = 'feed.fetch' AND o.delivered_at IS NULL AND f.id = (o.payload->>'feedId')::bigint
     RETURNING f.id::text AS id, f.url`,
  );
  for (const feed of new Map(fetched.rows.map((r) => [r.id, r])).values()) {
    await ctx.owner.query('UPDATE feeds SET last_fetch_at = now() WHERE id = $1', [feed.id]);
    const lang = Object.entries(langs).find(([host]) => feed.url.includes(host))?.[1] ?? null;
    for (let i = 0; i < 3; i += 1) {
      const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
      await ctx.owner.query(`UPDATE articles SET lang = $2 WHERE id = $1`, [article.id, lang]);
      await ctx.owner.query(
        `INSERT INTO job_outbox (queue, payload, dedupe_key) VALUES ('article.extract', $1::jsonb, $2)`,
        [JSON.stringify({ articleId: article.id }), `x${article.id}`],
      );
    }
  }
}

/** …and extract them. */
async function simulateExtract(): Promise<void> {
  await ctx.owner.query(
    `UPDATE job_outbox SET delivered_at = now() WHERE queue = 'article.extract' AND delivered_at IS NULL`,
  );
  await ctx.owner.query(
    `UPDATE articles SET pipeline_state = 'extracted' WHERE pipeline_state = 'ingested'`,
  );
}

const HOSTS = {
  'news-en': 'en',
  'tech-en': 'en',
  'spravy.example.sk': 'sk',
  'zpravy.example.cz': 'cs',
};

beforeAll(async () => {
  ctx = await setupEvalTest();
  feeds = parseFeedList(LIST);
  listPath = path.join(tmpdir(), `feeds-int-${process.pid}.txt`);
  await writeFile(listPath, LIST);
});

beforeEach(async () => {
  await ctx.owner.query(`DELETE FROM settings WHERE key = 'worker.heartbeat'`);
});

afterAll(async () => {
  await ctx?.close();
});

describe('eval ingest-sample worker precondition (spec 10 §2.1, D-96)', () => {
  it('exits with instructions when no ingest-only worker sent a heartbeat in the last 90 s', async () => {
    await heartbeat('old-ingest', true, new Date(Date.now() - 120_000));
    const run = runCli(ctx, ['ingest-sample', '--feeds', listPath]);
    await expect(run).rejects.toMatchObject({
      name: 'EvalCommandError',
      message: expect.stringContaining('EVAL_INGEST_ONLY=true'),
    });
    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining('pnpm --filter @bantoozi/worker'),
    });
    expect(await subscriptions()).toEqual([]);
  });

  it('refuses to collect while an ordinary worker is live next to an ingest-only one', async () => {
    await heartbeat('ingest:1', true);
    await heartbeat('ordinary:1', false);
    await expect(runCli(ctx, ['ingest-sample', '--feeds', listPath])).rejects.toMatchObject({
      name: 'EvalCommandError',
      message: expect.stringContaining('refusing to collect: 1 live worker(s) without'),
    });
    await expect(
      runIngestSample(
        { db: ctx.db, now: () => new Date(), out: () => {} },
        { feeds, drainTimeoutMs: 0, pollMs: 1, watch: false, watchIntervalMs: 1 },
      ),
    ).rejects.toBeInstanceOf(WorkerPreconditionError);
    expect(await subscriptions()).toEqual([]);
    // The database is marked golden before the heartbeat check, so an ordinary worker starting at
    // the same time sees the evaluation user after writing its own heartbeat (D-96).
    const evalUser = await ctx.owner.query(
      `SELECT 1 FROM users WHERE email = 'eval@bantoozi.local'`,
    );
    expect(evalUser.rowCount).toBe(1);
  });
});

describe('eval ingest-sample collection (spec 10 §2.1)', () => {
  it('subscribes the golden feeds (inference off), waits for the drain and prints counts per language', async () => {
    await heartbeat('ingest:1', true);
    const out: string[] = [];
    let sleeps = 0;
    const result = await runIngestSample(
      {
        db: ctx.db,
        now: () => new Date(),
        out: (s) => out.push(s),
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) await simulateFetch(HOSTS);
          if (sleeps === 2) await simulateExtract();
        },
      },
      { feeds, drainTimeoutMs: 60_000, pollMs: 1, watch: false, watchIntervalMs: 1 },
    );
    expect(await subscriptions()).toEqual(
      feeds
        .map((f) => ({ url: f.canonicalUrl, inference_mode: 'off' }))
        .sort((a, b) => (a.url < b.url ? -1 : 1)),
    );
    expect(result.subscribe).toMatchObject({ created: 4, subscribed: 4, alreadySubscribed: 0 });
    expect(result.drained).toBe(true);
    expect(sleeps).toBe(2);
    expect(result.counts).toEqual([
      { lang: 'cs', articles: 3, eligible: 3, pending: 0, stale: 0, failed: 0 },
      { lang: 'en', articles: 6, eligible: 6, pending: 0, stale: 0, failed: 0 },
      { lang: 'sk', articles: 3, eligible: 3, pending: 0, stale: 0, failed: 0 },
    ]);
    const text = out.join('');
    expect(text).toContain('ingest-only worker(s) live: ingest:1');
    expect(text).toContain('using the evaluation user; 4 feeds: 4 new, 4 subscribed');
    expect(text).toContain('feeds fetched 0/4, awaiting extraction 0, queued feed.fetch 4');
    expect(text).toContain('feeds fetched 4/4, awaiting extraction 12');
    expect(text).toContain('drained: every feed was fetched and its new articles extracted');
    expect(text).toMatch(/en\s+6\s+6\s+0\s+0\s+0/);
  });

  it('fetches already subscribed feeds once more (forced) and reports a drain timeout', async () => {
    await heartbeat('ingest:1', true);
    const before = await ctx.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM job_outbox WHERE queue = 'feed.fetch' AND delivered_at IS NULL`,
    );
    expect(before.rows[0]!.n).toBe('0');
    // The last fetch was an hour ago (outside the start-time skew allowance).
    await ctx.owner.query(`UPDATE feeds SET last_fetch_at = now() - interval '1 hour'`);
    let clock = Date.now();
    const out: string[] = [];
    const result = await runIngestSample(
      {
        db: ctx.db,
        now: () => new Date(clock),
        out: (s) => out.push(s),
        sleep: async (ms) => {
          clock += ms;
        },
      },
      { feeds, drainTimeoutMs: 30_000, pollMs: 10_000, watch: false, watchIntervalMs: 1 },
    );
    expect(result.subscribe).toMatchObject({ created: 0, subscribed: 0, alreadySubscribed: 4 });
    const forced = await ctx.owner.query<{ payload: { feedId: string; force?: boolean } }>(
      `SELECT payload FROM job_outbox WHERE queue = 'feed.fetch' AND delivered_at IS NULL`,
    );
    expect(forced.rows).toHaveLength(4);
    expect(forced.rows.every((r) => r.payload.force === true)).toBe(true);
    expect(result.drained).toBe(false);
    expect(out.join('')).toContain('not drained after 30 s; the worker keeps collecting');
    await simulateFetch(HOSTS);
    await simulateExtract();
  });

  it('--watch keeps the user subscribed and reports the counts periodically', async () => {
    await heartbeat('ingest:1', true);
    const unsubscribe = (feed: GoldenFeed) =>
      ctx.owner.query(
        `DELETE FROM subscriptions s USING feeds f
          WHERE s.feed_id = f.id AND s.user_id = $1 AND f.url = $2`,
        [ctx.evalUserId, feed.canonicalUrl],
      );
    // Lost before the run: the run itself subscribes it again.
    await unsubscribe(feeds[0]!);
    const waits: number[] = [];
    const out: string[] = [];
    const result = await runIngestSample(
      {
        db: ctx.db,
        now: () => new Date(),
        out: (s) => out.push(s),
        sleep: async (ms) => {
          waits.push(ms);
          // Lost during the watch: the next report re-subscribes it.
          if (ms === 600_000 && waits.filter((w) => w === ms).length === 1) {
            await unsubscribe(feeds[1]!);
          }
          await simulateFetch(HOSTS);
          await simulateExtract();
        },
      },
      {
        feeds,
        drainTimeoutMs: 60_000,
        pollMs: 5,
        watch: true,
        watchIntervalMs: 600_000,
        maxWatchReports: 2,
      },
    );
    expect(result.subscribe.subscribed).toBe(1);
    expect(result.watchReports).toBe(2);
    expect(waits.filter((ms) => ms === 600_000)).toHaveLength(2);
    const text = out.join('');
    expect(text).toContain('watching: counts every 10 min until stopped');
    expect(text).toContain('re-subscribed 1 feed(s)');
    expect(text.match(/lang {2}articles {2}eligible/g)?.length).toBe(3);
    expect(text).not.toContain('WARNING');
    expect(await subscriptions()).toHaveLength(4);
  });

  it('runs end to end through the CLI', async () => {
    await heartbeat('ingest:cli', true);
    const run = await runCli(ctx, [
      'ingest-sample',
      '--feeds',
      listPath,
      '--timeout',
      '0.0005',
      '--poll',
      '0.01',
    ]);
    expect(run.out).toContain('4 golden feeds from');
    expect(run.out).toContain(
      'using the evaluation user; 4 feeds: 0 new, 0 subscribed, 4 already subscribed',
    );
    expect(run.out).toMatch(/lang {2}articles/);
  });
});
