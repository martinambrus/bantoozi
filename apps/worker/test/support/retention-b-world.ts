import { createHash, randomUUID } from 'node:crypto';

import {
  bindReaderClock,
  pinUnbookmark,
  saveMutation,
  tenantOutbox,
  undoArticleMutation,
  unbookmarkArticle,
  withTenant,
} from '@bantoozi/db';
import type pg from 'pg';

import type { RetentionWorld } from './retention-world.js';
import { DAY, MINUTE } from './retention-world.js';

export { DAY, MINUTE };

/** The columns of a snapshot row a test compares. */
export interface SnapshotRow {
  id: string;
  article_id: string;
  captured_at: Date;
  cold_at: Date | null;
  unreferenced_at: Date | null;
  body_text: string;
  body_html: string | null;
  content_sha256: string;
  recomputed_sha256: string;
}

export interface BodyOptions {
  extractedAt: Date;
  text?: string;
  html?: string | null;
  completeness?: 'complete' | 'partial';
  lead?: string;
}

export interface SavedArticle {
  userId: string;
  feedId: string;
  articleId: string;
  snapshotId: string;
  captureStatus: string;
}

/**
 * Fixtures of the `house.purge-articles` and `house.purge-bodies` tests (spec 11 §5, §5.2): saved
 * articles through the real bookmark action, unbookmark with its receipt and Undo pin and undo
 * through the real API functions, and plain-SQL rows for everything the API does not create.
 */
export class RetentionBWorld {
  constructor(readonly w: RetentionWorld) {}

  get owner(): pg.Pool {
    return this.w.owner;
  }

  /** Run a registered handler as if the clock read `now`. */
  run(queue: Parameters<RetentionWorld['run']>[0], now: Date): Promise<void> {
    return this.w.run(queue, now);
  }

  async rows<R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
    return (await this.owner.query<R>(text, values)).rows;
  }

  async exists(text: string, ...values: unknown[]): Promise<boolean> {
    return ((await this.owner.query(text, values)).rowCount ?? 0) > 0;
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────────────────────

  user(): Promise<string> {
    return this.w.h.user();
  }

  /** A feed with no subscriber (its `unsubscribed_at` is the database clock at creation). */
  feed(): Promise<string> {
    return this.w.h.feed();
  }

  /** A feed the users are subscribed to, with its subscriber count and idle marker consistent. */
  async subscribedFeed(userIds: readonly string[]): Promise<string> {
    const feedId = await this.w.h.feed();
    for (const userId of userIds) await this.w.h.subscribe(userId, feedId, 'off');
    await this.owner.query(`SELECT refresh_feed_subscribers($1::bigint[])`, [[feedId]]);
    return feedId;
  }

  /** The stored extraction of an article's current revision (`article_bodies`). */
  async body(articleId: string, options: BodyOptions): Promise<void> {
    const text = options.text ?? `Full text of ${articleId}.`;
    await this.owner.query(
      `INSERT INTO article_bodies (article_id, article_revision, status, body_text, body_html,
                                   body_lead, completeness, extractor_version, extracted_at)
       VALUES ($1, 1, 'ok', $2, $3, $4, $5, 'test', $6)`,
      [
        articleId,
        text,
        options.html === undefined ? `<p>${text}</p>` : options.html,
        options.lead ?? `Lead of ${articleId}.`,
        options.completeness ?? 'complete',
        options.extractedAt,
      ],
    );
  }

  /**
   * An article `userId`'s subscribed feed carries since `arrival`, with a stored body extracted at
   * `extractedAt` (default `arrival`) and bookmarked through the real action.
   */
  async saved(options: {
    arrival: Date;
    userId?: string;
    feedId?: string;
    extractedAt?: Date;
    text?: string;
    html?: string | null;
    completeness?: 'complete' | 'partial';
  }): Promise<SavedArticle> {
    const userId = options.userId ?? (await this.user());
    const feedId = options.feedId ?? (await this.subscribedFeed([userId]));
    const articleId = await this.w.article([{ feedId, at: options.arrival }]);
    await this.body(articleId, {
      extractedAt: options.extractedAt ?? options.arrival,
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.html === undefined ? {} : { html: options.html }),
      ...(options.completeness === undefined ? {} : { completeness: options.completeness }),
    });
    await this.w.bookmark(userId, articleId, new Date());
    return { userId, feedId, articleId, ...(await this.bookmarkOf(userId, articleId)) };
  }

  /** Another user's bookmark of an article a subscribed feed of theirs carries. */
  async alsoSave(userId: string, feedId: string, articleId: string): Promise<void> {
    await this.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at, last_seen_at)
       SELECT $1::bigint, $2::bigint, 'guid-' || $1::text || '-' || $2::text, max(first_seen_at),
              max(last_seen_at)
         FROM feed_items WHERE article_id = $2::bigint`,
      [feedId, articleId],
    );
    await this.w.bookmark(userId, articleId, new Date());
  }

  async bookmarkOf(
    userId: string,
    articleId: string,
  ): Promise<{ snapshotId: string; captureStatus: string }> {
    const result = await this.owner.query<{ snapshot_id: string; status: string }>(
      `SELECT bookmark_snapshot_id::text AS snapshot_id, bookmark_capture_status AS status
         FROM user_article WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId],
    );
    const row = result.rows[0];
    if (row === undefined || row.snapshot_id === null) throw new Error('bookmark has no snapshot');
    return { snapshotId: row.snapshot_id, captureStatus: row.status };
  }

  /**
   * `DELETE /bookmark` as the API runs it: the action, the saved receipt and the Undo pin that
   * references the receipt, which lives for 10 minutes after `at`.
   */
  async unbookmark(
    userId: string,
    articleId: string,
    at: Date,
  ): Promise<{ mutationId: string; snapshotId: string | null }> {
    const mutationId = randomUUID();
    const result = await this.w.act(userId, articleId, at, async (tx, base) => {
      const outcome = await unbookmarkArticle(tx, base);
      await saveMutation(tx, {
        key: mutationId,
        requestHash: 'h',
        route: 'DELETE /api/v1/articles/:id/bookmark',
        status: 200,
        response: {},
        undo: outcome.undo ?? null,
      });
      if (outcome.pinSnapshotId !== null) {
        await pinUnbookmark(tx, { mutationId, snapshotId: outcome.pinSnapshotId, now: at });
      }
      return outcome;
    });
    return { mutationId, snapshotId: result.pinSnapshotId };
  }

  /** `POST /articles/undo` of a receipt. */
  undo(userId: string, mutationId: string, at: Date): Promise<unknown> {
    return withTenant(this.w.appDb, userId, (tx) => {
      bindReaderClock(tx, at);
      return undoArticleMutation(tx, { mutationId, now: at, outbox: tenantOutbox(tx) });
    });
  }

  /** A mark of the unreferenced grace, set directly (the only column besides `cold_at` that moves). */
  async mark(snapshotId: string, at: Date | null): Promise<void> {
    await this.owner.query(`UPDATE article_snapshots SET unreferenced_at = $2 WHERE id = $1`, [
      snapshotId,
      at,
    ]);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────

  async snapshot(id: string): Promise<SnapshotRow | null> {
    const rows = await this.rows<SnapshotRow>(
      `SELECT id::text AS id, article_id::text AS article_id, captured_at, cold_at, unreferenced_at,
              body_text, body_html, content_sha256,
              snapshot_content_sha256(title, author, published_at, source_url, body_text, body_html)
                AS recomputed_sha256
         FROM article_snapshots WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  articleExists(id: string): Promise<boolean> {
    return this.exists('SELECT 1 FROM articles WHERE id = $1', id);
  }

  feedExists(id: string): Promise<boolean> {
    return this.exists('SELECT 1 FROM feeds WHERE id = $1', id);
  }

  cluster(id: string): Promise<boolean> {
    return this.exists('SELECT 1 FROM story_clusters WHERE id = $1', id);
  }

  pins(snapshotId: string): Promise<number> {
    return this.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookmark_snapshot_pins WHERE snapshot_id = $1`,
      [snapshotId],
    ).then((rows) => rows[0]!.n);
  }

  /** The stored body of an article: whether the two hot copies are present, and the lead. */
  async hot(articleId: string): Promise<{ text: boolean; html: boolean; lead: string | null }> {
    const rows = await this.rows<{ text: boolean; html: boolean; lead: string | null }>(
      `SELECT body_text IS NOT NULL AS text, body_html IS NOT NULL AS html, body_lead AS lead
         FROM article_bodies WHERE article_id = $1`,
      [articleId],
    );
    if (rows[0] === undefined) throw new Error('article has no body row');
    return rows[0];
  }

  // ── Plain-SQL rows ────────────────────────────────────────────────────────────────────────

  /**
   * An analysis request of the user's, created at `createdAt`: inserted as the API does (pending,
   * under the user's tenant, with a live training subscription and carrier), then finished.
   */
  async analysisRequest(
    userId: string,
    feedId: string,
    articleId: string,
    createdAt: Date,
    status: 'failed' | 'cancelled' | 'pending' = 'failed',
  ): Promise<string> {
    const id = randomUUID();
    const client = await this.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE subscriptions SET inference_mode = 'training', inference_version = inference_version + 1
          WHERE user_id = $1 AND feed_id = $2 AND inference_mode = 'off'`,
        [userId, feedId],
      );
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      await client.query(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha, created_at,
                                        next_attempt_at)
         SELECT $1, $2, $3, $4, 1, s.inference_version, '{}'::jsonb, $5, $6, $6
           FROM subscriptions s WHERE s.user_id = $2 AND s.feed_id = $3`,
        [id, userId, feedId, articleId, createHash('sha256').update('{}').digest('hex'), createdAt],
      );
      if (status !== 'pending') {
        await client.query(
          `UPDATE analysis_requests SET status = $2, completed_at = $3 WHERE id = $1`,
          [id, status, createdAt],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return id;
  }

  /** A story cluster the articles belong to (size and representative as the clusterer leaves them). */
  async storyCluster(articleIds: readonly string[]): Promise<string> {
    const result = await this.owner.query<{ id: string }>(
      `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, $2) RETURNING id::text AS id`,
      [articleIds[0] ?? null, articleIds.length],
    );
    const id = result.rows[0]!.id;
    if (articleIds.length > 0) {
      await this.owner.query(
        `UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])`,
        [id, articleIds],
      );
    }
    return id;
  }

  async muteStory(userId: string, clusterId: string, expiresAt: Date): Promise<void> {
    await this.owner.query(
      `INSERT INTO user_rules (user_id, kind, value, expires_at) VALUES ($1, 'mute_story', $2, $3)`,
      [userId, clusterId, expiresAt],
    );
  }

  /** An article in a dataset of the golden set (`eval.sample`). */
  async evalSample(articleId: string): Promise<void> {
    const version = `b-${randomUUID().slice(0, 8)}`;
    await this.owner.query(
      `INSERT INTO eval.datasets (version, seed, params) VALUES ($1, 's', '{}'::jsonb)`,
      [version],
    );
    await this.owner.query(
      `INSERT INTO eval.sample (dataset_version, article_id, lang, snapshot, snapshot_sha, split)
       VALUES ($1, $2, 'en', '{}'::jsonb, 'x', 'dev')`,
      [version, articleId],
    );
  }

  /** A facet label of the golden set on the article (`eval.facet_labels`). */
  async evalFacetLabel(articleId: string): Promise<void> {
    await this.owner.query(
      `INSERT INTO eval.facet_labels (labeler, article_id, question_key, value)
       VALUES ('owner', $1, 'q', 'v')`,
      [articleId],
    );
  }

  /** A rater whose feed list names the feed (`eval.rater_feeds`). */
  async evalRaterFeed(feedId: string): Promise<void> {
    const rater = await this.owner.query<{ id: string }>(
      `INSERT INTO eval.raters (name, participant_key, token_hash, token_expires_at, langs)
       VALUES ('r', $1::uuid, $1::uuid::text, now() + interval '1 day', ARRAY['en']) RETURNING id::text AS id`,
      [randomUUID()],
    );
    await this.owner.query(`INSERT INTO eval.rater_feeds (rater_id, feed_id) VALUES ($1, $2)`, [
      rater.rows[0]!.id,
      feedId,
    ]);
  }

  /** Set the feed's subscription bookkeeping as the last unsubscribe leaves it. */
  async idleFeed(feedId: string, unsubscribedAt: Date | null, subscribers = 0): Promise<void> {
    await this.owner.query(
      `UPDATE feeds SET subscriber_count = $2, unsubscribed_at = $3 WHERE id = $1`,
      [feedId, subscribers, unsubscribedAt],
    );
  }
}
