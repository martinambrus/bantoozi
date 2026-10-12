import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { DAY, HOUR, MetricsS17World, pick, utcDay } from './support/metrics-s17-world.js';

/**
 * M8-F10 and M8-F11 (PLAN §14.1): the nightly `house.metrics` at scale and the recovery denominator.
 * Same fake clock as the other metrics tests (00:10 UTC, 100 days after the real date; the handler
 * computes the previous UTC day).
 *
 * What is asserted, and how (nothing here measures memory or wall time):
 * - F11/F10 denominator: results of fixtures where the cached `user_article` lane disagrees with the
 *   feedback-time `before.lane`, and where a downranked cached row lies outside the window.
 * - F10 rating replay: no single statement on `feedback_events` returns more rows than a page bound
 *   (counted on the worker pool). This sees pages and plain queries; a server-side cursor or a
 *   stream is not visible to it (the bound is then vacuous), but the totals are still checked, with
 *   pairs whose events straddle every page boundary.
 * - F10 reader mix: the number of transactions (BEGIN statements on the worker pool) of a run with N
 *   readers is far below N, and the totals stay exact.
 */

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 0, 10));
const YESTERDAY = utcDay(new Date(NOW.getTime() - DAY));
const onDay = (daysBack: number, hour = 10): Date =>
  new Date(Date.parse(`${YESTERDAY}T00:00:00.000Z`) - daysBack * DAY + hour * HOUR);

let h: ClassifyHarness;
let w: MetricsS17World;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new MetricsS17World(h);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await w.reset();
});

/** Records every statement of a pool with its row count; `stop` restores the pool. */
function recordStatements(pool: pg.Pool): {
  statements: Array<{ text: string; rows: number }>;
  stop(): void;
} {
  const statements: Array<{ text: string; rows: number }> = [];
  const mutable = pool as unknown as {
    query: (...args: unknown[]) => unknown;
    connect: (...args: unknown[]) => unknown;
  };
  const originalQuery = mutable.query;
  const originalConnect = mutable.connect;
  const wrapped: Array<{ client: { query: unknown }; original: unknown }> = [];
  const wrap = (owner: object, original: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const first = args[0];
      const text =
        typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
      const out = original.apply(owner, args) as Promise<{ rowCount?: number; rows?: unknown[] }>;
      if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
        return out.then((result) => {
          statements.push({ text, rows: result?.rows?.length ?? result?.rowCount ?? 0 });
          return result;
        });
      }
      return out;
    };
  mutable.query = wrap(pool, originalQuery);
  mutable.connect = function (this: unknown, ...args: unknown[]): unknown {
    const out = originalConnect.apply(pool, args) as Promise<pg.PoolClient>;
    if (typeof args[0] === 'function') return out;
    return out.then((client) => {
      const target = client as unknown as { query: (...a: unknown[]) => unknown };
      if (!wrapped.some((entry) => entry.client === target)) {
        wrapped.push({ client: target, original: target.query });
        target.query = wrap(client, target.query.bind(client));
      }
      return client;
    });
  };
  return {
    statements,
    stop() {
      mutable.query = originalQuery;
      mutable.connect = originalConnect;
      for (const entry of wrapped) entry.client.query = entry.original;
    },
  };
}

describe('M8-F11: the recovery denominator reads the feedback-time lane', () => {
  it('counts a pair opened from Everything whose cached lane is now For You, and not a pair opened from For You whose cached lane is now Everything', async () => {
    const u = await w.user();
    const [down, up] = [await w.article(), await w.article()];
    // Opened from Everything, since ranked up: the pre-action lane makes it eligible (and recovered).
    await w.open(u, down, 'everything', onDay(0, 9));
    await w.cachedLane(u, down, 'for_you');
    // Opened from For You, since ranked down: it was never downranked at feedback time.
    await w.open(u, up, 'for_you', onDay(0, 10));
    await w.cachedLane(u, up, 'everything');
    // Cached rows are fresh (inside the window) so only the lane source can explain the result.
    for (const article of [down, up]) {
      await h.owner.query(
        'UPDATE user_article SET scored_at = $3 WHERE user_id = $1 AND article_id = $2',
        [u.id, article.id, onDay(0, 9)],
      );
      await h.owner.query('UPDATE articles SET first_seen_at = $2 WHERE id = $1', [
        article.id,
        onDay(0, 8),
      ]);
    }

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    for (const path of ['regret', 'windows.d7.regret', 'windows.d30.regret']) {
      expect(pick(s, `${path}.numerator`), path).toBe(1);
      expect(pick(s, `${path}.denominator`), path).toBe(1);
    }
  });
});

describe('M8-F10: the cached part of the regret denominator is bounded by the window', () => {
  it('leaves out downranked cached rows scored and first seen long before the window, per window', async () => {
    const u = await w.user();
    const acted = await w.article();
    await w.open(u, acted, 'everything', onDay(0, 9));
    const inside: Array<Awaited<ReturnType<typeof w.article>>> = [];
    const outside: Array<Awaited<ReturnType<typeof w.article>>> = [];
    for (let i = 0; i < 3; i += 1) inside.push(await w.article());
    for (let i = 0; i < 25; i += 1) outside.push(await w.article());
    for (const article of [...inside, ...outside]) {
      await w.cachedLane(u, article, i2lane(article.id));
    }
    // Inside: scored and first seen yesterday. Outside: both 60 days before yesterday (past d30).
    await place(u.id, inside, onDay(0, 6));
    await place(u.id, outside, onDay(60, 6));
    await place(u.id, [acted], onDay(0, 6));

    await w.run(NOW);

    const s = await w.snapshot(YESTERDAY);
    // The acted pair and the three fresh cached rows; the 25 old ones are in no window.
    for (const path of ['regret', 'windows.d7.regret', 'windows.d30.regret']) {
      expect(pick(s, `${path}.numerator`), path).toBe(1);
      expect(pick(s, `${path}.denominator`), path).toBe(4);
    }
  });
});

const i2lane = (id: string): 'everything' | 'hidden' =>
  Number(id) % 2 === 0 ? 'everything' : 'hidden';

async function place(
  userId: string,
  articles: ReadonlyArray<{ id: string }>,
  at: Date,
): Promise<void> {
  const ids = articles.map((a) => a.id);
  await h.owner.query(
    'UPDATE user_article SET scored_at = $3 WHERE user_id = $1 AND article_id = ANY($2::bigint[])',
    [userId, ids, at],
  );
  await h.owner.query('UPDATE articles SET first_seen_at = $2 WHERE id = ANY($1::bigint[])', [
    ids,
    at,
  ]);
}

describe('M8-F10: the rating replay does not load the 30-day window in one result', () => {
  const USERS = 5;
  const ARTICLES = 100;
  const EVENTS_PER_PAIR = 3;
  const PAGE_BOUND = 500;

  it('reads rating events in pages of at most 500 rows and keeps the replay exact across page boundaries', async () => {
    const users = [];
    for (let i = 0; i < USERS; i += 1) users.push(await w.user());
    await h.owner.query(
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, content_hash, pipeline_state)
       SELECT 'https://replay.example.test/' || g, 'https://replay.example.test/' || g,
              'replay.example.test/' || g, 'Replay ' || g, 'replay ' || g,
              encode(sha256(convert_to('replay' || g, 'UTF8')), 'hex'), 'enriched'
         FROM generate_series(1, $1::int) g`,
      [ARTICLES],
    );
    const ids = (
      await h.owner.query<{ id: string }>(
        `SELECT id::text AS id FROM articles WHERE url_key LIKE 'replay.example.test/%' ORDER BY id`,
      )
    ).rows.map((r) => r.id);
    // Every pair gets +1, -1, +1 (final: liked) in one day; 5 x 100 pairs x 3 = 1,500 events.
    const before = JSON.stringify({
      v: 1,
      rating: 1,
      reason: null,
      hide: false,
      before: w.before('for_you', 3),
    });
    const beforeDislike = JSON.stringify({
      v: 1,
      rating: -1,
      reason: null,
      hide: false,
      before: w.before('for_you', 3),
    });
    for (const [ui, user] of users.entries()) {
      await h.owner.query(
        `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
         SELECT $1, a.id::bigint, 'rate',
                CASE WHEN k.n = 2 THEN $3::jsonb ELSE $2::jsonb END,
                $4::timestamptz + make_interval(secs => (($5::int * 1000) + a.ord * 3 + k.n))
           FROM unnest($6::bigint[]) WITH ORDINALITY AS a(id, ord)
           CROSS JOIN generate_series(1, $7::int) k(n)`,
        [user.id, before, beforeDislike, onDay(0, 1).toISOString(), ui, ids, EVENTS_PER_PAIR],
      );
    }
    const total = await h.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feedback_events WHERE kind = 'rate'`,
    );
    expect(total.rows[0]?.n).toBe(USERS * ARTICLES * EVENTS_PER_PAIR);

    const recorder = recordStatements(h.worker);
    try {
      await w.run(NOW);
    } finally {
      recorder.stop();
    }

    const s = await w.snapshot(YESTERDAY);
    for (const path of ['lanes', 'windows.d7.lanes', 'windows.d30.lanes']) {
      expect(pick(s, `${path}.for_you.rated`), path).toBe(USERS * ARTICLES);
      expect(pick(s, `${path}.for_you.likeRate`), path).toBe(1);
    }
    const feedback = recorder.statements.filter((st) => /feedback_events/u.test(st.text));
    expect(feedback.length).toBeGreaterThan(0);
    const widest = Math.max(...feedback.map((st) => st.rows));
    expect(widest).toBeLessThanOrEqual(PAGE_BOUND);
  }, 120_000);
});

describe('M8-F10: the reader lane mix opens a bounded number of transactions', () => {
  const READERS = 40;

  it('counts Maybe share and source mix of 40 readers in far fewer than 40 transactions', async () => {
    const feed = await w.feed();
    const long = new Date(NOW.getTime() - 30 * DAY);
    const fresh = new Date(NOW.getTime() - 2 * HOUR);
    const [maybe, forYou, everything] = [
      await w.carried(feed, fresh),
      await w.carried(feed, fresh),
      await w.carried(feed, fresh),
    ];
    for (let i = 0; i < READERS; i += 1) {
      const user = await w.user();
      await w.subscribe(user, feed, 'active', long);
      await w.ranked(user, maybe.id, { lane: 'maybe', source: 'cards' });
      await w.ranked(user, forYou.id, { lane: 'for_you', source: 'model' });
      await w.ranked(user, everything.id, { lane: 'everything', source: 'degraded' });
    }

    const recorder = recordStatements(h.worker);
    try {
      await w.run(NOW);
    } finally {
      recorder.stop();
    }

    const s = await w.snapshot(YESTERDAY);
    expect(pick(s, 'current.maybeShare.maybe')).toBe(READERS);
    expect(pick(s, 'current.maybeShare.scored')).toBe(READERS * 3);
    expect(pick(s, 'current.sourceMix.cards')).toBe(READERS);
    expect(pick(s, 'current.sourceMix.model')).toBe(READERS);
    expect(pick(s, 'current.sourceMix.degraded')).toBe(READERS);
    const transactions = recorder.statements.filter((st) => /^\s*begin\b/iu.test(st.text));
    expect(transactions.length).toBeGreaterThan(0);
    // One tenant transaction per reader is 40; a batch or a page per tens of readers is a handful.
    expect(transactions.length).toBeLessThanOrEqual(10);
  }, 120_000);
});
