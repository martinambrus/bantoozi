import { randomUUID } from 'node:crypto';

import {
  bookmarkArticle,
  createDatabase,
  labelArticle,
  markArticleRead,
  markArticleUnread,
  rateArticle,
  tenantOutbox,
  withTenant,
  type ActionInput,
  type ActionResult,
  type Database,
  type TenantTx,
} from '@bantoozi/db';
import { parseJobPayload, type QueueName } from '@bantoozi/shared';
import { createCard } from '@bantoozi/testing';
import pg from 'pg';

import { createHandlers, dispatch } from '../../src/handlers/index.js';
import { DAY, MINUTE, type ClassifyHarness } from './classify.js';

export { DAY, MINUTE };

/**
 * Fixtures of the M8-T2 retention job tests (spec 11 §5, §6). Every job runs through the registered
 * handler map with a fake clock (`deps.now`), so a handler that reads the database clock instead of
 * the injected one fails the boundary tests. Reader state is driven through the real API action
 * functions; bulk rows (the unread cap) are written in plain SQL.
 */
export class RetentionWorld {
  readonly appPool: pg.Pool;
  readonly appDb: Database;

  constructor(readonly h: ClassifyHarness) {
    this.appPool = new pg.Pool({ connectionString: h.testDb.urls.app, max: 4 });
    this.appDb = createDatabase(this.appPool);
  }

  async close(): Promise<void> {
    await this.appPool.end();
  }

  get owner(): pg.Pool {
    return this.h.owner;
  }

  /** Run the registered handler of `queue` as if the clock read `now`. */
  async run(queue: QueueName, now: Date): Promise<void> {
    const handlers = createHandlers({ ...this.h.deps, now: () => now });
    await dispatch(handlers, queue, parseJobPayload(queue, {}), { queue, jobId: 'direct' });
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────────────────────

  /**
   * An article with one carrier row per `arrivals` entry (feed id and that feed's first sighting).
   * `articles.first_seen_at` is `firstSeenAt` (default: the earliest arrival), deliberately a
   * different clock from the carriers' where a test needs it.
   */
  async article(
    arrivals: ReadonlyArray<{ feedId: string; at: Date }>,
    firstSeenAt?: Date,
  ): Promise<string> {
    const n = randomUUID();
    const earliest = new Date(Math.min(...arrivals.map((a) => a.at.getTime())));
    const result = await this.owner.query<{ id: string }>(
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, first_seen_at,
                             content_hash, content_revision)
       VALUES ($1, $1, $2, $3, lower($3), 'x', $4, $5, 1) RETURNING id::text AS id`,
      [
        `https://news.example.test/r/${n}`,
        `news.example.test/r/${n}`,
        `Retention ${n}`,
        firstSeenAt ?? earliest,
        n,
      ],
    );
    const id = result.rows[0]!.id;
    for (const arrival of arrivals) {
      await this.owner.query(
        `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, $3, $4)`,
        [arrival.feedId, id, `guid-${n}-${arrival.feedId}`, arrival.at],
      );
    }
    return id;
  }

  /** `count` articles in one feed: article `i` (1-based) arrived `i` minutes before `newest`. */
  async bulkUnread(
    userIds: readonly string[],
    feedId: string,
    count: number,
    newest: Date,
  ): Promise<string[]> {
    // articles.first_seen_at runs the OTHER way, so a job that orders by it picks the wrong rows.
    const inserted = await this.owner.query<{ id: string; i: number }>(
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, first_seen_at,
                             content_hash, content_revision)
       SELECT 'https://bulk.example.test/' || g || '/' || $3::text, 'https://bulk.example.test/' || g || '/' || $3::text,
              'bulk.example.test/' || g || '/' || $3::text, 'Bulk ' || g, 'bulk ' || g, 'x',
              $2::timestamptz - make_interval(mins => $1::int - g + 1),
              md5(g::text || $3::text), 1
         FROM generate_series(1, $1::int) g
       RETURNING id::text AS id, substr(title, 6)::int AS i`,
      [count, newest, randomUUID()],
    );
    const byRank = inserted.rows.sort((a, b) => a.i - b.i).map((row) => row.id);
    // Rank r (1 = newest carrier) is the article with index r, arrived r minutes before `newest`.
    await this.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
       SELECT $1, a.id, 'g-' || a.id, $3::timestamptz - make_interval(mins => (substr(a.title, 6))::int)
         FROM articles a WHERE a.id = ANY($2::bigint[])`,
      [feedId, byRank, newest],
    );
    for (const userId of userIds) {
      await this.owner.query(
        `INSERT INTO user_article (user_id, article_id) SELECT $1, unnest($2::bigint[])`,
        [userId, byRank],
      );
    }
    return byRank;
  }

  // ── Reader actions through the API functions ──────────────────────────────────────────────

  async fence(userId: string, articleId: string): Promise<ActionInput['fence']> {
    const state = await this.owner.query<{ state_version: string }>(
      `SELECT state_version::text AS state_version FROM user_article
        WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId],
    );
    const revision = await this.owner.query<{ r: string }>(
      `SELECT content_revision::text AS r FROM articles WHERE id = $1`,
      [articleId],
    );
    return {
      stateVersion: state.rows[0]?.state_version ?? '0',
      contentRevision: revision.rows[0]!.r,
    };
  }

  /** Run an action as the user with the fence read now (or the one given: an offline client's). */
  async act<R extends ActionResult>(
    userId: string,
    articleId: string,
    now: Date,
    fn: (tx: TenantTx, base: ActionInput) => Promise<R>,
    fence?: ActionInput['fence'],
  ): Promise<R> {
    const used = fence ?? (await this.fence(userId, articleId));
    return withTenant(this.appDb, userId, (tx) =>
      fn(tx, {
        articleId,
        fence: used,
        now,
        outbox: tenantOutbox(tx),
        matchFingerprint: this.h.matchFingerprint,
      }),
    );
  }

  read(userId: string, articleId: string, at: Date) {
    return this.act(userId, articleId, at, (tx, base) => markArticleRead(tx, base));
  }

  unread(userId: string, articleId: string, at: Date, fence?: ActionInput['fence']) {
    return this.act(userId, articleId, at, (tx, base) => markArticleUnread(tx, base), fence);
  }

  bookmark(userId: string, articleId: string, at: Date) {
    return this.act(userId, articleId, at, (tx, base) => bookmarkArticle(tx, base));
  }

  rate(userId: string, articleId: string, at: Date, rating: 1 | -1 | null) {
    return this.act(userId, articleId, at, (tx, base) =>
      rateArticle(tx, { ...base, rating, reason: null, hide: false }),
    );
  }

  /** Label the article with a private label card the user holds. */
  async label(userId: string, articleId: string, at: Date): Promise<void> {
    const card = await createCard(this.owner, {
      kind: 'label',
      visibility: 'private',
      ownerUserId: userId,
    });
    await this.owner.query(
      `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Label')`,
      [userId, card.id],
    );
    await this.act(userId, articleId, at, (tx, base) =>
      labelArticle(tx, { ...base, labelId: card.id }),
    );
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────

  async reader(userId: string, articleId: string) {
    const result = await this.owner.query<{
      state_version: string;
      archived_at: Date | null;
      read_at: Date | null;
    }>(
      `SELECT state_version::text AS state_version, archived_at, read_at FROM user_article
        WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId],
    );
    return result.rows[0]!;
  }

  async events(userId: string): Promise<number> {
    const result = await this.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feedback_events WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0]!.n;
  }
}
