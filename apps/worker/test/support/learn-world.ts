import { randomUUID } from 'node:crypto';

import {
  bookmarkArticle,
  createDatabase,
  labelArticle,
  rateArticle,
  saveMutation,
  tenantOutbox,
  undoArticleMutation,
  unlabelArticle,
  withTenant,
  type ActionInput,
  type ActionResult,
  type Database,
  type TenantTx,
} from '@bantoozi/db';
import { createCard } from '@bantoozi/testing';
import pg from 'pg';

import { DAY, MINUTE, type ClassifyHarness } from './classify.js';

/**
 * M7-T4 fixtures: one classified feed with a pool of enriched articles and one shared interest card
 * `M`, whose answers separate the classes, plus readers who rate through the real API functions
 * (so every rating carries its event-time snapshot, spec 06 §8.2).
 *
 * Article `i` (0-based): even -> a like, answer p 0.9; odd -> a dislike, answer p 0.1 when
 * `i % 4 === 1`, else 0.6. A reader who rates the first 48 therefore has 24 likes and 24 dislikes,
 * perfectly separable by `M`, and `M` is applicable (p >= 0.5) for 24 + 12 samples of both classes,
 * so it earns an own input in every training partition.
 */
export const POOL = 60;
export const RATED = 48;

export const likeOf = (i: number): 1 | -1 => (i % 2 === 0 ? 1 : -1);
export const answerOf = (i: number): number => (i % 2 === 0 ? 0.9 : i % 4 === 1 ? 0.1 : 0.6);

export interface ModelRow {
  version: number;
  active: boolean;
  nLabels: number;
  nPos: number;
  nNeg: number;
  weights: unknown;
  metrics: Record<string, unknown>;
  trainedAt: Date;
}

export class LearnWorld {
  readonly appPool: pg.Pool;
  readonly appDb: Database;
  /** A monotonic synthetic clock 10 days in the past (the rating timestamps). */
  private clock = Date.now() - 10 * DAY;

  private constructor(
    readonly h: ClassifyHarness,
    readonly feedId: string,
    readonly articles: string[],
    readonly cardM: string,
  ) {
    this.appPool = new pg.Pool({ connectionString: h.testDb.urls.app, max: 4 });
    this.appDb = createDatabase(this.appPool);
  }

  static async create(h: ClassifyHarness): Promise<LearnWorld> {
    const feedId = await h.feed('Learn feed');
    // The card belongs to a throwaway owner so it is a plain shared interest card.
    const cardM = await h.card({ interest: 'Zorblax electric vehicles and their batteries' });
    const articles: string[] = [];
    for (let i = 0; i < POOL; i += 1) {
      const id = await h.article({
        feedIds: [feedId],
        title: `Zorblax story ${i}`,
        excerpt: `Zorblax report number ${i} about vehicles.`,
      });
      await h.enrichDirect(id);
      await h.answerCard(id, cardM, { engine: 'typesafe', p: answerOf(i) });
      articles.push(id);
    }
    return new LearnWorld(h, feedId, articles, cardM);
  }

  async close(): Promise<void> {
    await this.appPool.end();
  }

  tick(): Date {
    this.clock += MINUTE;
    return new Date(this.clock);
  }

  // ── Users ──────────────────────────────────────────────────────────────────────────────────

  /** A reader with an active subscription to the feed holding `M` (strength like). */
  async user(
    options: {
      implicit?: boolean;
      strength?: 'must' | 'love' | 'like' | 'never';
      lastActiveDaysAgo?: number | null;
    } = {},
  ): Promise<string> {
    const userId = await this.h.user();
    await this.h.subscribe(userId, this.feedId, 'active');
    await this.h.hold(userId, this.cardM, { strength: options.strength ?? 'like' });
    if (options.implicit === true) {
      await this.h.owner.query(
        `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [userId, JSON.stringify({ implicitFeedback: true })],
      );
    }
    if (options.lastActiveDaysAgo !== undefined) {
      await this.h.owner.query(`UPDATE users SET last_active_at = $2 WHERE id = $1`, [
        userId,
        options.lastActiveDaysAgo === null
          ? null
          : new Date(Date.now() - options.lastActiveDaysAgo * DAY),
      ]);
    }
    return userId;
  }

  // ── Reader actions through the API functions ───────────────────────────────────────────────

  private async fence(userId: string, articleId: string): Promise<ActionInput['fence']> {
    const state = await this.h.owner.query<{ state_version: string }>(
      `SELECT state_version::text AS state_version FROM user_article
        WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId],
    );
    const revision = await this.h.owner.query<{ r: string }>(
      `SELECT content_revision::text AS r FROM articles WHERE id = $1`,
      [articleId],
    );
    return {
      stateVersion: state.rows[0]?.state_version ?? '0',
      contentRevision: revision.rows[0]!.r,
    };
  }

  async run<R extends ActionResult>(
    userId: string,
    articleId: string,
    fn: (tx: TenantTx, base: ActionInput) => Promise<R>,
  ): Promise<{ result: R; key: string | null }> {
    const fence = await this.fence(userId, articleId);
    const now = this.tick();
    return withTenant(this.appDb, userId, async (tx) => {
      const result = await fn(tx, {
        articleId,
        fence,
        now,
        outbox: tenantOutbox(tx),
        matchFingerprint: this.h.matchFingerprint,
      });
      let key: string | null = null;
      if (result.undo !== undefined) {
        key = randomUUID();
        await saveMutation(tx, {
          key,
          requestHash: 'x'.repeat(8),
          route: 'POST /test',
          status: 200,
          response: {},
          undo: result.undo,
        });
      }
      return { result, key };
    });
  }

  /** Rate pool article `index` (default: its class from {@link likeOf}). */
  rate(userId: string, index: number, rating: 1 | -1 | null = likeOf(index)) {
    return this.run(userId, this.articles[index]!, (tx, base) =>
      rateArticle(tx, { ...base, rating, reason: null, hide: false }),
    );
  }

  /** Rate pool articles `[from, to)` with their own class. */
  async rateRange(userId: string, from: number, to: number): Promise<void> {
    for (let i = from; i < to; i += 1) await this.rate(userId, i);
  }

  bookmark(userId: string, index: number) {
    return this.run(userId, this.articles[index]!, (tx, base) => bookmarkArticle(tx, base));
  }

  /** A label card held by the user (neutral organization, spec 06 §8.2). */
  async labelCard(userId: string): Promise<string> {
    const card = await createCard(this.h.owner, {
      kind: 'label',
      visibility: 'private',
      ownerUserId: userId,
    });
    await this.h.owner.query(
      `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Label')`,
      [userId, card.id],
    );
    return card.id;
  }

  label(userId: string, index: number, labelId: string) {
    return this.run(userId, this.articles[index]!, (tx, base) =>
      labelArticle(tx, { ...base, labelId }),
    );
  }

  unlabel(userId: string, index: number, labelId: string) {
    return this.run(userId, this.articles[index]!, (tx, base) =>
      unlabelArticle(tx, { ...base, labelId }),
    );
  }

  async undo(userId: string, key: string): Promise<void> {
    const now = this.tick();
    await withTenant(this.appDb, userId, (tx) =>
      undoArticleMutation(tx, { mutationId: key, now, outbox: tenantOutbox(tx) }),
    );
  }

  // ── State readers ──────────────────────────────────────────────────────────────────────────

  async models(userId: string): Promise<ModelRow[]> {
    const result = await this.h.owner.query<{
      version: number;
      active: boolean;
      n_labels: number;
      n_pos: number;
      n_neg: number;
      weights: unknown;
      metrics: Record<string, unknown>;
      trained_at: Date;
    }>(
      `SELECT version, active, n_labels, n_pos, n_neg, weights, metrics, trained_at
         FROM user_models WHERE user_id = $1 ORDER BY version`,
      [userId],
    );
    return result.rows.map((row) => ({
      version: row.version,
      active: row.active,
      nLabels: row.n_labels,
      nPos: row.n_pos,
      nNeg: row.n_neg,
      weights: row.weights,
      metrics: row.metrics,
      trainedAt: row.trained_at,
    }));
  }

  async active(userId: string): Promise<ModelRow[]> {
    return (await this.models(userId)).filter((m) => m.active);
  }

  async rankRevision(userId: string): Promise<bigint> {
    const result = await this.h.owner.query<{ r: string }>(
      `SELECT rank_revision::text AS r FROM users WHERE id = $1`,
      [userId],
    );
    return BigInt(result.rows[0]!.r);
  }

  /** The newest feedback event id of the user (decimal string). */
  async newestEvent(userId: string): Promise<string> {
    const result = await this.h.owner.query<{ id: string }>(
      `SELECT max(id)::text AS id FROM feedback_events WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0]!.id;
  }

  async maxEventId(): Promise<string> {
    const result = await this.h.owner.query<{ id: string }>(
      `SELECT coalesce(max(id), 0)::text AS id FROM feedback_events`,
    );
    return result.rows[0]!.id;
  }

  /** Intents of `queue` for the user recorded after the outbox mark `since`. */
  async userIntents(
    queue: string,
    userId: string,
    since: string,
  ): Promise<Array<Record<string, unknown>>> {
    return (await this.h.payloads(queue, since)).filter((p) => p['userId'] === userId);
  }

  /** Insert a stored (inactive) attempt row carrying a processed cutoff (the API trigger's input). */
  async seedCutoff(userId: string, cutoffEventId: string): Promise<void> {
    await this.h.owner.query(
      `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                                intercept, scaler, calibration, metrics, active)
       VALUES ($1, 1, $2, 0, 0, 0, '{}'::jsonb, 0, '{}'::jsonb, '{}'::jsonb, $3::jsonb, false)`,
      [
        userId,
        'f'.repeat(64),
        JSON.stringify({ feedbackCutoffEventId: cutoffEventId, status: 'seeded' }),
      ],
    );
  }

  /** The held card ids with an own input in a stored model (named `card.<id>` inputs). */
  ownCardIds(model: ModelRow): string[] {
    const text = JSON.stringify(model.weights) + JSON.stringify(model.metrics);
    return [...new Set([...text.matchAll(/card\.(\d+)/g)].map((m) => m[1]!))];
  }

  /** Age a user's rating on pool article `index` to `days` ago (event time, reader state, snapshot). */
  async ageRating(userId: string, index: number, days: number): Promise<void> {
    const at = new Date(Date.now() - days * DAY);
    const articleId = this.articles[index]!;
    await this.h.owner.query(
      `UPDATE feedback_events
          SET created_at = $3,
              value = CASE WHEN value #> '{features,snapshotAt}' IS NULL THEN value
                           ELSE jsonb_set(value, '{features,snapshotAt}', to_jsonb($4::text)) END
        WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId, at, at.toISOString()],
    );
    await this.h.owner.query(
      `UPDATE user_article SET rated_at = $3 WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId, at],
    );
  }
}
