import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
} from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  insertEstimateModel,
  loadEstimateModel,
  lockEstimateUser,
  rankEstimatePage,
  rankWindowPage,
  recordEstimateLastRun,
  type RankCursor,
} from '../src/index.js';
import { asTenant, setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * EST-3b db layer (visible-learning §4.4): the estimate refresh's window page, the recheck of an
 * estimate row that waits on queued card work, and the `lastRun` metrics write.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_DAYS = 14;
const ago = (ms: number): Date => new Date(Date.now() - ms);

type Source = 'none' | 'estimate' | 'cards' | 'model' | 'degraded';

interface Seed {
  userId: string;
  feedId: string;
}

async function reader(mode: 'off' | 'training' | 'active' = 'active'): Promise<Seed> {
  const user = await createUser(ctx.owner);
  const feed = await createFeed(ctx.owner);
  await createSubscription(ctx.owner, {
    userId: user.id,
    feedId: feed.id,
    mode,
    ...(mode === 'active' ? { activatedAt: ago(30 * DAY) } : {}),
  });
  return { userId: user.id, feedId: feed.id };
}

interface RowOptions {
  lane?: string;
  source?: Source;
  readAt?: Date | null;
  archivedAt?: Date | null;
  firstSeenAt?: Date;
  scoredAt?: Date;
  rules?: string[];
  /** false leaves the article without a `user_article` row. */
  stored?: boolean;
}

async function article(seed: Seed, options: RowOptions = {}): Promise<string> {
  const created = await createArticle(ctx.owner, {
    feedIds: [seed.feedId],
    firstSeenAt: options.firstSeenAt ?? ago(HOUR),
  });
  if (options.stored !== false) {
    await ctx.owner.query(
      `INSERT INTO user_article (user_id, article_id, lane, score_source, tier, p_like, read_at,
                                 archived_at, scored_at, rules_fired, score_version, rank_revision)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7, $8::text[], 'sv', 0)`,
      [
        seed.userId,
        created.id,
        options.lane ?? 'new',
        options.source ?? 'none',
        options.readAt ?? null,
        options.archivedAt ?? null,
        options.scoredAt ?? new Date(),
        options.rules ?? [],
      ],
    );
  }
  return created.id;
}

const page = (
  userId: string,
  sources: readonly ('none' | 'estimate')[],
  more: { cursor?: RankCursor; limit?: number } = {},
) =>
  rankEstimatePage(ctx.worker, {
    userId,
    now: new Date(),
    windowDays: WINDOW_DAYS,
    sources,
    limit: more.limit ?? 100,
    ...(more.cursor === undefined ? {} : { cursor: more.cursor }),
  });

const ids = (rows: readonly { articleId: string }[]): string[] => rows.map((row) => row.articleId);

describe('rankEstimatePage', () => {
  it('returns the window rows stored as lane new with a requested source, and no others', async () => {
    const s = await reader();
    const none = await article(s, { source: 'none' });
    const estimate = await article(s, { source: 'estimate' });
    await article(s, { lane: 'for_you', source: 'cards' });
    await article(s, { lane: 'everything', source: 'model' });
    await article(s, { lane: 'maybe', source: 'degraded' });
    await article(s, { lane: 'hidden', source: 'none' });
    await article(s, { lane: 'everything', source: 'estimate' });

    expect(new Set(ids(await page(s.userId, ['none', 'estimate'])))).toEqual(
      new Set([none, estimate]),
    );
  });

  it('filters by the requested sources: estimate alone leaves none rows out', async () => {
    const s = await reader();
    await article(s, { source: 'none' });
    const estimate = await article(s, { source: 'estimate' });
    expect(ids(await page(s.userId, ['estimate']))).toEqual([estimate]);
    expect(await page(s.userId, [])).toEqual([]);
  });

  it('leaves out archived rows and window articles without a user_article row', async () => {
    const s = await reader();
    const kept = await article(s, { source: 'none' });
    await article(s, { source: 'none', archivedAt: new Date() });
    await article(s, { source: 'estimate', archivedAt: ago(DAY) });
    await article(s, { stored: false });
    expect(ids(await page(s.userId, ['none', 'estimate']))).toEqual([kept]);
  });

  it('keeps the window of the dirty page: old carrier arrivals and other readers are out, unread flags are exact', async () => {
    const s = await reader();
    const other = await reader();
    const unread = await article(s, { source: 'none', firstSeenAt: ago(2 * HOUR) });
    const read = await article(s, {
      source: 'estimate',
      readAt: ago(HOUR),
      firstSeenAt: ago(3 * HOUR),
    });
    await article(s, { source: 'none', firstSeenAt: ago((WINDOW_DAYS + 2) * DAY) });
    await article(other, { source: 'none' });

    const rows = await page(s.userId, ['none', 'estimate']);
    expect(rows.map((row) => [row.articleId, row.unread])).toEqual([
      [unread, true],
      [read, false],
    ]);
  });

  it('includes an old article the reader selected (a complete request at the current revision)', async () => {
    const s = await reader('training');
    const old = await article(s, { source: 'none', firstSeenAt: ago(60 * DAY) });
    const unselected = await article(s, { source: 'none', firstSeenAt: ago(61 * DAY) });
    expect(ids(await page(s.userId, ['none', 'estimate']))).toEqual([]);

    await asTenant(ctx.owner, s.userId, async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha)
         SELECT gen_random_uuid(), $1, $2, a.id, a.content_revision, 1, '{}'::jsonb,
                encode(sha256(convert_to('{}', 'UTF8')), 'hex')
           FROM articles a WHERE a.id = $3
         RETURNING id`,
        [s.userId, s.feedId, old],
      );
      await client.query(
        `UPDATE analysis_requests
            SET status = 'complete', completed_at = now(), result_snapshot = '{}', result_sha = 'x'
          WHERE id = $1`,
        [created.rows[0]?.id],
      );
    });

    const rows = await page(s.userId, ['none', 'estimate']);
    expect(ids(rows)).toEqual([old]);
    expect(ids(rows)).not.toContain(unselected);
  });

  it('orders by (arrival, article id) descending and returns the exact arrival with microseconds', async () => {
    const s = await reader();
    const same = ago(5 * HOUR);
    const first = await article(s, { source: 'none', firstSeenAt: same });
    const second = await article(s, { source: 'estimate', firstSeenAt: same });
    const newest = await article(s, { source: 'none', firstSeenAt: ago(HOUR) });
    const oldest = await article(s, { source: 'none', firstSeenAt: ago(9 * HOUR) });

    const rows = await page(s.userId, ['none', 'estimate']);
    expect(ids(rows)).toEqual([newest, second, first, oldest]);
    expect(Number(second)).toBeGreaterThan(Number(first));
    for (const row of rows)
      expect(row.arrival).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u);
    expect(rows[1]?.arrival).toBe(rows[2]?.arrival);
    expect(new Date(rows[1]?.arrival ?? '').getTime()).toBe(same.getTime());
  });

  it('pages strictly below the cursor and stops at limit, visiting every row once', async () => {
    const s = await reader();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(
        await article(s, {
          source: i % 2 === 0 ? 'none' : 'estimate',
          firstSeenAt: ago((i + 1) * HOUR),
        }),
      );
    }
    // Two rows share an arrival so the cursor's article id decides.
    const tie = ago(10 * HOUR);
    created.push(await article(s, { source: 'none', firstSeenAt: tie }));
    created.push(await article(s, { source: 'none', firstSeenAt: tie }));

    const all = await page(s.userId, ['none', 'estimate']);
    expect(all).toHaveLength(7);

    const first = await page(s.userId, ['none', 'estimate'], { limit: 3 });
    expect(first).toHaveLength(3);
    expect(ids(first)).toEqual(ids(all).slice(0, 3));

    const visited: string[] = [];
    let cursor: RankCursor | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = await page(s.userId, ['none', 'estimate'], {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (rows.length === 0) break;
      expect(rows.length).toBeLessThanOrEqual(2);
      visited.push(...ids(rows));
      const last = rows[rows.length - 1]!;
      cursor = { arrival: last.arrival, articleId: last.articleId };
    }
    expect(visited).toEqual(ids(all));
    expect(new Set(visited).size).toBe(7);
  });

  it('a cursor at a row excludes that row and every row above it', async () => {
    const s = await reader();
    const a = await article(s, { firstSeenAt: ago(1 * HOUR) });
    const b = await article(s, { firstSeenAt: ago(2 * HOUR) });
    const c = await article(s, { firstSeenAt: ago(3 * HOUR) });
    const rows = await page(s.userId, ['none']);
    expect(ids(rows)).toEqual([a, b, c]);
    const below = await page(s.userId, ['none'], {
      cursor: { arrival: rows[1]!.arrival, articleId: b },
    });
    expect(ids(below)).toEqual([c]);
  });
});

describe('the recheck predicate of rankWindowPage', () => {
  async function queued(
    seed: Seed,
    options: RowOptions,
    queue: boolean,
    hold: boolean,
  ): Promise<string> {
    const articleId = await article(seed, { scoredAt: new Date(Date.now() + DAY), ...options });
    if (queue) {
      const card = await createCard(ctx.owner, {});
      if (hold) {
        await ctx.owner.query(
          `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
          [seed.userId, card.id],
        );
      }
      await ctx.owner.query(
        `INSERT INTO match_queue (article_id, card_id, article_revision, priority)
         SELECT a.id, $2, a.content_revision, 5 FROM articles a WHERE a.id = $1`,
        [articleId, card.id],
      );
    }
    return articleId;
  }

  async function flags(userId: string): Promise<Map<string, boolean>> {
    const rows = await rankWindowPage(ctx.worker, {
      userId,
      now: new Date(),
      windowDays: WINDOW_DAYS,
      scoreVersion: 'sv',
      rankRevision: '0',
      contextSha: 'ctx',
      degradedContextSha: 'dctx',
      enrichSetId: null,
      recheckMarginMs: 15 * 60_000,
      limit: 100,
    });
    return new Map(rows.map((row) => [row.articleId, row.recheck]));
  }

  it('a none row with queued card work is a recheck (pins existing behaviour)', async () => {
    const s = await reader();
    const none = await queued(s, { source: 'none' }, true, true);
    expect((await flags(s.userId)).get(none)).toBe(true);
  });

  it('an estimate row with queued card work is a recheck, like a none row', async () => {
    const s = await reader();
    const estimate = await queued(s, { source: 'estimate' }, true, true);
    expect((await flags(s.userId)).get(estimate)).toBe(true);
  });

  it('is not a recheck without queued work, with work of a card the reader does not hold, or in another lane', async () => {
    const s = await reader();
    const noQueue = await queued(s, { source: 'estimate' }, false, false);
    const notHeld = await queued(s, { source: 'estimate' }, true, false);
    const cards = await queued(s, { lane: 'everything', source: 'cards' }, true, true);
    const noneNoQueue = await queued(s, { source: 'none' }, false, false);
    const found = await flags(s.userId);
    expect(found.get(noQueue)).toBe(false);
    expect(found.get(notHeld)).toBe(false);
    expect(found.get(cards)).toBe(false);
    expect(found.get(noneNoQueue)).toBe(false);
  });

  it('a 1b row (inference_not_requested) is not rechecked, whether none or estimate', async () => {
    const s = await reader();
    const none = await queued(
      s,
      { source: 'none', rules: ['inference_not_requested'] },
      true,
      true,
    );
    const estimate = await queued(
      s,
      { source: 'estimate', rules: ['inference_not_requested', 'estimate'] },
      true,
      true,
    );
    const found = await flags(s.userId);
    expect(found.get(none)).toBe(false);
    expect(found.get(estimate)).toBe(false);
  });
});

describe('recordEstimateLastRun', () => {
  async function store(userId: string, metrics: Record<string, unknown> = {}): Promise<number> {
    return ctx.worker.transaction(async (tx) => {
      expect(await lockEstimateUser(tx, userId)).toBe(true);
      return insertEstimateModel(tx, {
        userId,
        spec: 'estimate-test-v1',
        n: 12,
        nPos: 7,
        nNeg: 5,
        intercept: 0.1,
        weights: { 't:alpha': 0.5 },
        platt: { a: 1, b: 0 },
        metrics: { auc: 0.81, inputSha: 'sha-1', ...metrics },
      });
    });
  }

  const metricsOf = async (userId: string, version: number): Promise<Record<string, unknown>> => {
    const result = await ctx.owner.query<{ metrics: Record<string, unknown> }>(
      'SELECT metrics FROM user_estimate_models WHERE user_id = $1 AND version = $2',
      [userId, version],
    );
    return result.rows[0]?.metrics ?? {};
  };

  it('stores lastRun in the given version`s metrics and keeps the other metrics keys', async () => {
    const user = await createUser(ctx.owner);
    const v1 = await store(user.id);
    const v2 = await store(user.id);
    const at = '2026-10-21T10:00:00.000Z';

    expect(
      await recordEstimateLastRun(ctx.worker, user.id, v2, { at, movedUp: 4, movedDown: 1 }),
    ).toBe(true);
    expect(await metricsOf(user.id, v2)).toEqual({
      auc: 0.81,
      inputSha: 'sha-1',
      lastRun: { at, movedUp: 4, movedDown: 1 },
    });
    expect(await metricsOf(user.id, v1)).toEqual({ auc: 0.81, inputSha: 'sha-1' });
    expect((await loadEstimateModel(ctx.worker, user.id))?.metrics['lastRun']).toEqual({
      at,
      movedUp: 4,
      movedDown: 1,
    });
  });

  it('replaces an earlier lastRun and accepts 0 and 0', async () => {
    const user = await createUser(ctx.owner);
    const version = await store(user.id, { lastRun: { at: 'old', movedUp: 9, movedDown: 9 } });
    const at = '2026-10-22T10:00:00.000Z';
    expect(
      await recordEstimateLastRun(ctx.worker, user.id, version, { at, movedUp: 0, movedDown: 0 }),
    ).toBe(true);
    expect((await metricsOf(user.id, version))['lastRun']).toEqual({
      at,
      movedUp: 0,
      movedDown: 0,
    });
  });

  it('returns false and writes nothing when the version is gone or belongs to another user', async () => {
    const user = await createUser(ctx.owner);
    const other = await createUser(ctx.owner);
    const version = await store(user.id);
    const otherVersion = await store(other.id);
    const lastRun = { at: '2026-10-21T10:00:00.000Z', movedUp: 1, movedDown: 2 };

    expect(await recordEstimateLastRun(ctx.worker, user.id, version + 5, lastRun)).toBe(false);
    expect(await recordEstimateLastRun(ctx.worker, user.id, 0, lastRun)).toBe(false);
    expect(await metricsOf(user.id, version)).not.toHaveProperty('lastRun');
    expect(await metricsOf(other.id, otherVersion)).not.toHaveProperty('lastRun');
  });
});
