import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  bindReaderClock,
  answerPrompt,
  markArticlesRead,
  tenantOutbox,
  withTenant,
} from '@bantoozi/db';
import { parseJobPayload } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHandlers, dispatch } from '../src/handlers/index.js';
import { ClassifyHarness } from './support/classify.js';
import { RetentionBWorld } from './support/retention-b-world.js';
import { DAY, MINUTE, RetentionWorld } from './support/retention-world.js';

/**
 * D-253 (retention rules, owner-approved 2026-10-15): the purge of `house.purge-articles` keys on the
 * article's arrival = max(`feed_items.last_seen_at`) (fallback `articles.first_seen_at`) and has three
 * rules: UNOPENED (nobody engaged: 21 days), DISLIKE (only dislikes protect, until max(rated_at) +
 * max(180, `model.historyDays`) days, never before arrival + 90 days) and the unchanged NORMAL 90-day
 * rule. Engaged = opened_at, a rating, a bookmark, labels, or an individual `read` event; a bulk
 * mark-read (`mark_read` event, `signalOrigin: bulk_mark_read`) is not engagement.
 *
 * Same method as house-retention-b: registered handler, fake clock `NOW`, a minute either side of each
 * threshold, effects read from the database. Carrier rows are written here, with `last_seen_at` set
 * only when the column exists, so each test fails on a behavioural assertion before the build too.
 */

const NOW = new Date(Date.now() + 100 * DAY);
const before = (ms: number): Date => new Date(NOW.getTime() - ms);
const PURGE = 'house.purge-articles' as const;
const UNOPENED_DAYS = 21;
const NORMAL_DAYS = 90;
const DISLIKE_DAYS = 180;

let h: ClassifyHarness;
let w: RetentionWorld;
let b: RetentionBWorld;
let hasLastSeen = false;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new RetentionWorld(h);
  b = new RetentionBWorld(w);
  hasLastSeen = await b.exists(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'feed_items' AND column_name = 'last_seen_at'`,
  );
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

interface Carrier {
  feedId: string;
  /** The first sighting. */
  at: Date;
  /** The last sighting (default: `at`). */
  seen?: Date;
}

/** An article carried by the feeds; `last_seen_at` is written only once the column exists. */
async function article(carriers: readonly Carrier[], firstSeenAt?: Date): Promise<string> {
  const n = randomUUID();
  const earliest = new Date(Math.min(...carriers.map((c) => c.at.getTime())));
  const inserted = await b.owner.query<{ id: string }>(
    `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, first_seen_at,
                           content_hash, content_revision)
     VALUES ($1, $1, $2, $3, lower($3), 'x', $4, $5, 1) RETURNING id::text AS id`,
    [
      `https://news.example.test/d/${n}`,
      `news.example.test/d/${n}`,
      `D ${n}`,
      firstSeenAt ?? earliest,
      n,
    ],
  );
  const id = inserted.rows[0]!.id;
  for (const c of carriers) {
    await b.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, $3, $4)`,
      [c.feedId, id, `guid-${n}-${c.feedId}`, c.at],
    );
    if (hasLastSeen) {
      await b.owner.query(
        `UPDATE feed_items SET last_seen_at = $3 WHERE feed_id = $1 AND article_id = $2`,
        [c.feedId, id, c.seen ?? c.at],
      );
    }
  }
  return id;
}

/** The reader row of a user who has not touched the article. */
async function untouched(userId: string, articleId: string): Promise<void> {
  await b.owner.query(
    `INSERT INTO user_article (user_id, article_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, articleId],
  );
}

async function opened(userId: string, articleId: string): Promise<void> {
  await b.owner.query(
    `INSERT INTO user_article (user_id, article_id, opened_at, read_at) VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id, article_id) DO UPDATE SET opened_at = $3, read_at = $3`,
    [userId, articleId, before(DAY)],
  );
}

/** `/articles/mark-read` (bulk): sets `read_at`, records `mark_read`, never a `read` event. */
async function bulkRead(userId: string, articleId: string): Promise<void> {
  await untouched(userId, articleId);
  await withTenant(w.appDb, userId, (tx) => {
    bindReaderClock(tx, NOW);
    return markArticlesRead(tx, {
      targets: [{ articleId, fence: null }],
      now: NOW,
      outbox: tenantOutbox(tx),
    });
  });
}

interface LogLine {
  fields: Record<string, unknown>;
  message: string;
}

/** Run the purge handler at `now`, returning what it logged at info level. */
async function purge(now: Date): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  const logger = {
    ...h.deps.logger,
    info: (fields: unknown, message?: string) => {
      lines.push({ fields: (fields ?? {}) as Record<string, unknown>, message: message ?? '' });
    },
  } as typeof h.deps.logger;
  const handlers = createHandlers({ ...h.deps, now: () => now, logger });
  await dispatch(handlers, PURGE, parseJobPayload(PURGE, {}), { queue: PURGE, jobId: 'direct' });
  return lines;
}

const gone = async (...ids: string[]): Promise<boolean[]> =>
  Promise.all(ids.map(async (id) => !(await b.articleExists(id))));

// ── 1 + 2: the unopened rule and the engagement signal ─────────────────────────────────────────

describe('unopened articles (21 days after arrival)', () => {
  it('purges an article nobody engaged with 21 days after arrival, not one minute earlier', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const noReader = await b.feed();
    const stale = await article([{ feedId: feed, at: before(UNOPENED_DAYS * DAY + MINUTE) }]);
    const fresh = await article([{ feedId: feed, at: before(UNOPENED_DAYS * DAY - MINUTE) }]);
    await untouched(user, stale);
    await untouched(user, fresh);
    const staleNoRow = await article([
      { feedId: noReader, at: before(UNOPENED_DAYS * DAY + MINUTE) },
    ]);
    await purge(NOW);
    expect(await gone(stale, fresh, staleNoRow)).toEqual([true, false, true]);
  });

  it('counts a bulk mark-read as not engaged, but an individual read, open, bookmark, rating and label as engaged', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const at = before(30 * DAY);
    const bulk = await article([{ feedId: feed, at }]);
    await bulkRead(user, bulk);
    // The bulk path must leave `read_at` set and no individual `read` event: that is the distinction.
    expect((await w.reader(user, bulk)).read_at).not.toBeNull();
    expect(
      await b.exists(`SELECT 1 FROM feedback_events WHERE article_id = $1 AND kind = 'read'`, bulk),
    ).toBe(false);
    expect(
      await b.exists(
        `SELECT 1 FROM feedback_events WHERE article_id = $1 AND kind = 'mark_read'`,
        bulk,
      ),
    ).toBe(true);
    const read = await article([{ feedId: feed, at }]);
    await w.read(user, read, new Date());
    const open = await article([{ feedId: feed, at }]);
    await opened(user, open);
    const liked = await article([{ feedId: feed, at }]);
    await w.rate(user, liked, new Date(), 1);
    const disliked = await article([{ feedId: feed, at }]);
    await w.rate(user, disliked, new Date(), -1);
    const labelled = await article([{ feedId: feed, at }]);
    await w.label(user, labelled, new Date());
    const saved = (await b.saved({ arrival: at, userId: user, feedId: feed })).articleId;
    await purge(NOW);
    expect(await gone(bulk, read, open, liked, disliked, labelled, saved)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('engaged by any one of several users keeps it', async () => {
    const [a, c] = [await b.user(), await b.user()];
    const feed = await b.subscribedFeed([a, c]);
    const id = await article([{ feedId: feed, at: before(40 * DAY) }]);
    await untouched(a, id);
    await w.read(c, id, new Date());
    await purge(NOW);
    expect(await b.articleExists(id)).toBe(true);
  });
});

describe('normal rule (90 days) for engaged articles without a protecting state', () => {
  it('keeps an individually read or opened article until 90 days after arrival', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const readStale = await article([{ feedId: feed, at: before(NORMAL_DAYS * DAY + MINUTE) }]);
    const readFresh = await article([{ feedId: feed, at: before(NORMAL_DAYS * DAY - MINUTE) }]);
    const openStale = await article([{ feedId: feed, at: before(NORMAL_DAYS * DAY + MINUTE) }]);
    const openFresh = await article([{ feedId: feed, at: before(NORMAL_DAYS * DAY - MINUTE) }]);
    await w.read(user, readStale, new Date());
    await w.read(user, readFresh, new Date());
    await opened(user, openStale);
    await opened(user, openFresh);
    await purge(NOW);
    expect(await gone(readStale, readFresh, openStale, openFresh)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});

// ── 3: arrival = max(last_seen_at) ─────────────────────────────────────────────────────────────

describe('arrival is the latest sighting in any feed', () => {
  it('never purges an unopened article still present in a feed, however old its first sighting', async () => {
    const feed = await b.feed();
    const other = await b.feed();
    const stillListed = await article([{ feedId: feed, at: before(120 * DAY), seen: before(DAY) }]);
    const otherFeedFresh = await article([
      { feedId: feed, at: before(120 * DAY), seen: before(120 * DAY) },
      { feedId: other, at: before(120 * DAY), seen: before(UNOPENED_DAYS * DAY - MINUTE) },
    ]);
    const bothStale = await article([
      { feedId: feed, at: before(120 * DAY), seen: before(UNOPENED_DAYS * DAY + 2 * MINUTE) },
      { feedId: other, at: before(120 * DAY), seen: before(UNOPENED_DAYS * DAY + MINUTE) },
    ]);
    const fallback = await article([], before(UNOPENED_DAYS * DAY + MINUTE));
    await purge(NOW);
    expect(await gone(stillListed, otherFeedFresh, bothStale, fallback)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it('does not purge an engaged article before 90 days after its last sighting', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const id = await article([
      { feedId: feed, at: before(200 * DAY), seen: before(NORMAL_DAYS * DAY - MINUTE) },
    ]);
    await w.read(user, id, new Date());
    const old = await article([
      { feedId: feed, at: before(200 * DAY), seen: before(NORMAL_DAYS * DAY + MINUTE) },
    ]);
    await w.read(user, old, new Date());
    await purge(NOW);
    expect(await gone(id, old)).toEqual([false, true]);
  });
});

// ── 4: dislike rule ────────────────────────────────────────────────────────────────────────────

describe('dislike-only articles', () => {
  async function disliked(
    userId: string,
    feedId: string,
    arrival: Date,
    ratedAt: Date,
  ): Promise<string> {
    const id = await article([{ feedId, at: arrival }]);
    await w.rate(userId, id, ratedAt, -1);
    // A historic dislike can predate a later arrival/re-sighting; backdate that fixture state
    // after the real action, which now requires a released carrier.
    if (ratedAt < arrival)
      await b.owner.query(
        'UPDATE user_article SET rated_at = $3 WHERE user_id = $1 AND article_id = $2',
        [userId, id, ratedAt],
      );
    const row = await b.rows<{ rated_at: Date }>(
      `SELECT rated_at FROM user_article WHERE user_id = $1 AND article_id = $2`,
      [userId, id],
    );
    expect(row[0]!.rated_at.getTime()).toBe(ratedAt.getTime());
    return id;
  }

  it('protects until 180 days after the dislike, not one minute longer', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const arrival = before(400 * DAY);
    const inside = await disliked(user, feed, arrival, before(DISLIKE_DAYS * DAY - MINUTE));
    const outside = await disliked(user, feed, arrival, before(DISLIKE_DAYS * DAY + MINUTE));
    await purge(NOW);
    expect(await gone(inside, outside)).toEqual([false, true]);
  });

  it('is never purged before arrival + 90 days, whatever the dislike age', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const longRated = before(300 * DAY);
    const young = await disliked(user, feed, before(NORMAL_DAYS * DAY - MINUTE), longRated);
    const matured = await disliked(user, feed, before(NORMAL_DAYS * DAY + MINUTE), longRated);
    await purge(NOW);
    expect(await gone(young, matured)).toEqual([false, true]);
  });

  it('is protected by the latest of several dislikes', async () => {
    const [a, c] = [await b.user(), await b.user()];
    const feed = await b.subscribedFeed([a, c]);
    const id = await article([{ feedId: feed, at: before(400 * DAY) }]);
    await w.rate(a, id, before(300 * DAY), -1);
    await w.rate(c, id, before(DISLIKE_DAYS * DAY - MINUTE), -1);
    const both = await article([{ feedId: feed, at: before(400 * DAY) }]);
    await w.rate(a, both, before(300 * DAY), -1);
    await w.rate(c, both, before(DISLIKE_DAYS * DAY + MINUTE), -1);
    await purge(NOW);
    expect(await gone(id, both)).toEqual([false, true]);
  });

  it('is kept forever when anyone also liked, bookmarked or labelled it', async () => {
    const [a, c] = [await b.user(), await b.user()];
    const feed = await b.subscribedFeed([a, c]);
    const arrival = before(400 * DAY);
    const longRated = before(300 * DAY);
    const withLike = await article([{ feedId: feed, at: arrival }]);
    await w.rate(a, withLike, longRated, -1);
    await w.rate(c, withLike, longRated, 1);
    const withBookmark = await article([{ feedId: feed, at: arrival }]);
    await w.rate(a, withBookmark, longRated, -1);
    await w.bookmark(c, withBookmark, new Date());
    const withLabel = await article([{ feedId: feed, at: arrival }]);
    await w.rate(a, withLabel, longRated, -1);
    await w.label(c, withLabel, new Date());
    await purge(NOW);
    expect(await gone(withLike, withBookmark, withLabel)).toEqual([false, false, false]);
  });

  it('protects for max(180, model.historyDays) days: a longer history window lengthens it, a shorter one does not', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const arrival = before(900 * DAY);
    try {
      await h.setSetting('ranker.thresholds', { model: { historyDays: 365 } });
      const inside = await disliked(user, feed, arrival, before(365 * DAY - MINUTE));
      const outside = await disliked(user, feed, arrival, before(365 * DAY + MINUTE));
      await purge(NOW);
      expect(await gone(inside, outside)).toEqual([false, true]);

      await h.setSetting('ranker.thresholds', { model: { historyDays: 30 } });
      const stillInside = await disliked(user, feed, arrival, before(DISLIKE_DAYS * DAY - MINUTE));
      const stillOutside = await disliked(user, feed, arrival, before(DISLIKE_DAYS * DAY + MINUTE));
      await purge(NOW);
      expect(await gone(stillInside, stillOutside)).toEqual([false, true]);
    } finally {
      await h.deleteSetting('ranker.thresholds');
    }
  });
});

// ── 5: unchanged holds ─────────────────────────────────────────────────────────────────────────

describe('holds that still apply to unopened articles', () => {
  it('keeps an unopened article with an analysis request under 180 days or a golden-set reference', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const at = before(30 * DAY);
    const requested = await article([{ feedId: feed, at }]);
    await b.analysisRequest(user, feed, requested, before(DISLIKE_DAYS * DAY - MINUTE));
    const expired = await article([{ feedId: feed, at }]);
    await b.analysisRequest(user, feed, expired, before(DISLIKE_DAYS * DAY + MINUTE));
    const sampled = await article([{ feedId: feed, at }]);
    await b.evalSample(sampled);
    const labelled = await article([{ feedId: feed, at }]);
    await b.evalFacetLabel(labelled);
    const plain = await article([{ feedId: feed, at }]);
    await purge(NOW);
    expect(await gone(requested, expired, sampled, labelled, plain)).toEqual([
      false,
      true,
      false,
      false,
      true,
    ]);
  });
});

// ── 6: feeds the evaluation uses keep 90 days ──────────────────────────────────────────────────

describe('evaluation feeds', () => {
  it('keep the 90-day rule for unopened articles: a rater feed and a feed the evaluation user subscribes to', async () => {
    const at21 = before(UNOPENED_DAYS * DAY + MINUTE);
    const at90Old = before(NORMAL_DAYS * DAY + MINUTE);
    const at90Young = before(NORMAL_DAYS * DAY - MINUTE);
    const raterFeed = await b.feed();
    await b.evalRaterFeed(raterFeed);
    const evalUser = (
      await b.rows<{ id: string }>(
        `INSERT INTO users (id, email, display_name, role, invites_left)
         VALUES (gen_random_uuid(), 'eval@bantoozi.local', 'Evaluation (system)', 'user', 0)
         RETURNING id::text AS id`,
      )
    )[0]!.id;
    const goldenFeed = await b.subscribedFeed([evalUser]);
    const ordinary = await b.feed();
    const rater21 = await article([{ feedId: raterFeed, at: at21 }]);
    const rater90Old = await article([{ feedId: raterFeed, at: at90Old }]);
    const rater90Young = await article([{ feedId: raterFeed, at: at90Young }]);
    const golden21 = await article([{ feedId: goldenFeed, at: at21 }]);
    const golden90Old = await article([{ feedId: goldenFeed, at: at90Old }]);
    const ordinary21 = await article([{ feedId: ordinary, at: at21 }]);
    await purge(NOW);
    expect(await gone(rater21, rater90Old, rater90Young)).toEqual([false, true, false]);
    expect(await gone(golden21, golden90Old)).toEqual([false, true]);
    expect(await gone(ordinary21)).toEqual([true]);
  });
});

// ── 8: per-rule counts in the log ──────────────────────────────────────────────────────────────

describe('purge log', () => {
  it('reports the number deleted by each rule: unopened21, dislike and normal90', async () => {
    await purge(NOW); // clear whatever the earlier tests left eligible
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const u1 = await article([{ feedId: feed, at: before(30 * DAY) }]);
    const u2 = await article([{ feedId: feed, at: before(60 * DAY) }]);
    const d1 = await article([{ feedId: feed, at: before(400 * DAY) }]);
    await w.rate(user, d1, before(300 * DAY), -1);
    const n1 = await article([{ feedId: feed, at: before(100 * DAY) }]);
    await w.read(user, n1, new Date());
    const lines = await purge(NOW);
    expect(await gone(u1, u2, d1, n1)).toEqual([true, true, true, true]);
    const line = lines.find((l) => l.fields['job'] === PURGE);
    expect(line).toBeDefined();
    expect(line!.fields).toMatchObject({ unopened21: 2, dislike: 1, normal90: 1, articles: 4 });
  });
});

// ── 9: dry-run report ──────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);
const workerDir = fileURLToPath(new URL('..', import.meta.url));

describe('pnpm worker-cli purge-report', () => {
  const counts = (stdout: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const key of ['unopened21', 'dislike', 'normal90']) {
      const match = new RegExp(`${key}\\D*(\\d+)`, 'u').exec(stdout);
      if (match === null) throw new Error(`purge-report prints no ${key} count:\n${stdout}`);
      out[key] = Number(match[1]);
    }
    return out;
  };
  const report = async (): Promise<Record<string, number>> => {
    const { stdout } = await execFileAsync(
      './node_modules/.bin/tsx',
      ['--conditions=bantoozi-source', 'src/cli.ts', 'purge-report'],
      {
        cwd: workerDir,
        env: { ...process.env, DATABASE_URL_WORKER: h.testDb.urls.worker },
        timeout: 90_000,
      },
    );
    return counts(stdout);
  };

  it('prints what each rule would delete and deletes nothing', async () => {
    // Real clock here: the CLI reads the database/process clock, so fixtures are relative to it.
    const real = (ms: number): Date => new Date(Date.now() - ms);
    const baseline = await report();
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const unopened = await article([{ feedId: feed, at: real(30 * DAY) }]);
    const unopenedToo = await article([{ feedId: feed, at: real(50 * DAY) }]);
    const young = await article([{ feedId: feed, at: real(5 * DAY) }]);
    const dislike = await article([{ feedId: feed, at: real(400 * DAY) }]);
    await w.rate(user, dislike, real(300 * DAY), -1);
    const normal = await article([{ feedId: feed, at: real(100 * DAY) }]);
    await w.read(user, normal, new Date());
    const ids = [unopened, unopenedToo, young, dislike, normal];
    const countRows = async (): Promise<number> =>
      (await b.rows<{ n: number }>(`SELECT count(*)::int AS n FROM articles`))[0]!.n;
    const rowsBefore = await countRows();

    const after = await report();
    expect(after['unopened21']! - baseline['unopened21']!).toBe(2);
    expect(after['dislike']! - baseline['dislike']!).toBe(1);
    expect(after['normal90']! - baseline['normal90']!).toBe(1);
    expect(await countRows()).toBe(rowsBefore);
    expect(await gone(...ids)).toEqual([false, false, false, false, false]);
  }, 240_000);
});

// ── Historical engagement counts for the 21-versus-90-day decision (Codex r1) ──────────────────

describe('historical engagement', () => {
  it('keeps a 30-day-old article whose bookmark, rating or label was later cleared, but purges one with only a bulk mark-read', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const at = before(30 * DAY);
    const unbookmarked = await b.saved({ arrival: at, userId: user, feedId: feed });
    await b.unbookmark(user, unbookmarked.articleId, new Date());
    const unrated = await article([{ feedId: feed, at }]);
    await w.rate(user, unrated, new Date(), 1);
    await w.rate(user, unrated, new Date(), null);
    const bulkOnly = await article([{ feedId: feed, at }]);
    await bulkRead(user, bulkOnly);
    // Current state of the first two holds no engagement; only their events remember it.
    expect(
      await b.exists(
        `SELECT 1 FROM user_article WHERE article_id = $1 AND (bookmarked_at IS NOT NULL OR rating IS NOT NULL)`,
        unbookmarked.articleId,
      ),
    ).toBe(false);
    await purge(NOW);
    expect(await gone(unbookmarked.articleId, unrated, bulkOnly)).toEqual([false, false, true]);
  });
});

// ── Codex r2: prompt answers, and engagement that outlives its feedback events ─────────────────

describe('durable engagement (Codex r2)', () => {
  it('counts a rating given through /prompt-answer, even when later cleared, as engagement', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const at = before(30 * DAY);
    const answered = await article([{ feedId: feed, at }]);
    await w.act(user, answered, new Date(), (tx, base) =>
      answerPrompt(tx, { ...base, liked: true }),
    );
    await w.rate(user, answered, new Date(), null);
    const bulkOnly = await article([{ feedId: feed, at }]);
    await bulkRead(user, bulkOnly);
    expect(
      await b.exists(
        `SELECT 1 FROM feedback_events WHERE article_id = $1 AND kind = 'prompt_answer'`,
        answered,
      ),
    ).toBe(true);
    expect(
      await b.exists(
        `SELECT 1 FROM user_article WHERE article_id = $1 AND (rating IS NOT NULL OR opened_at IS NOT NULL)`,
        answered,
      ),
    ).toBe(false);
    await purge(NOW);
    expect(await gone(answered, bulkOnly)).toEqual([false, true]);
  });

  it('keeps the 90-day rule after the feedback purge deleted the engagement events (365 days)', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const at = before(30 * DAY);
    const engaged = await article([{ feedId: feed, at }]);
    await w.rate(user, engaged, new Date(), 1);
    await w.rate(user, engaged, new Date(), null);
    const never = await article([{ feedId: feed, at }]);
    await untouched(user, never);
    // The events are a year old by now; the feedback purge deletes them.
    await b.owner.query(`UPDATE feedback_events SET created_at = $2 WHERE article_id = $1`, [
      engaged,
      before(366 * DAY),
    ]);
    await w.run('house.purge-engine-calls', NOW);
    expect(await b.exists(`SELECT 1 FROM feedback_events WHERE article_id = $1`, engaged)).toBe(
      false,
    );
    await purge(NOW);
    expect(await gone(engaged, never)).toEqual([false, true]);
  });
});
