import { randomUUID } from 'node:crypto';

import {
  answerPrompt,
  bookmarkArticle,
  createDatabase,
  labelArticle,
  markArticleRead,
  openArticle,
  rateArticle,
  rateArticlesBulk,
  saveMutation,
  tenantOutbox,
  undoArticleMutation,
  unbookmarkArticle,
  unlabelArticle,
  withTenant,
  type ActionInput,
  type ActionResult,
  type Database,
  type TenantTx,
} from '@bantoozi/db';
import {
  DEFAULT_ESTIMATE_OPTIONS,
  DEFAULT_RANKER_CONFIG,
  type EstimateOptions,
} from '@bantoozi/ranker';
import { createCard } from '@bantoozi/testing';
import pg from 'pg';

import { DAY, HOUR, MINUTE, type ClassifyHarness } from './classify.js';

/** The trainer options `user.estimate` derives from the default ranker config. */
export const ESTIMATE_OPTIONS: EstimateOptions = {
  ...DEFAULT_ESTIMATE_OPTIONS,
  minRatings: DEFAULT_RANKER_CONFIG.estimate.minRatings,
  minEachClass: DEFAULT_RANKER_CONFIG.estimate.minEachClass,
};

export const POOL = 40;

const LIKE_WORDS = ['rocket', 'orbit', 'satellite', 'launch', 'telescope', 'mission', 'planet'];
const DISLIKE_WORDS = ['gossip', 'scandal', 'rumor', 'celebrity', 'divorce', 'feud', 'drama'];

/** Article `i`: even indexes read like a liked topic, odd ones like a disliked topic. */
export const classOf = (i: number): 1 | -1 => (i % 2 === 0 ? 1 : -1);

export interface StoredModelRow {
  version: number;
  spec: string;
  n: number;
  nPos: number;
  nNeg: number;
  intercept: number;
  weights: Record<string, number>;
  platt: { a: number; b: number };
  metrics: Record<string, unknown>;
}

/**
 * EST-2 fixtures: one feed with a pool of articles whose titles and excerpts carry class-specific
 * words, readers who rate in SQL (fast, with chosen rating times) and readers who act through the
 * real reader-action functions with their outbox effects.
 */
export class EstimateWorld {
  readonly appPool: pg.Pool;
  readonly appDb: Database;
  private clock = Date.now() - 20 * DAY;
  private readonly base = Date.now();

  private constructor(
    readonly h: ClassifyHarness,
    readonly feedId: string,
    readonly articles: string[],
  ) {
    this.appPool = new pg.Pool({ connectionString: h.testDb.urls.app, max: 4 });
    this.appDb = createDatabase(this.appPool);
  }

  static async create(h: ClassifyHarness, size = POOL): Promise<EstimateWorld> {
    const feedId = await h.feed('Estimate feed');
    const articles: string[] = [];
    for (let i = 0; i < size; i += 1) {
      const words = classOf(i) === 1 ? LIKE_WORDS : DISLIKE_WORDS;
      const w = (k: number): string => words[(i + k) % words.length] as string;
      articles.push(
        await h.article({
          feedIds: [feedId],
          title: `${w(0)} ${w(1)} report number ${i}`,
          excerpt: `${w(2)} ${w(3)} ${w(4)} coverage of story ${i} with details ${w(5)}`,
        }),
      );
    }
    return new EstimateWorld(h, feedId, articles);
  }

  async close(): Promise<void> {
    await this.appPool.end();
  }

  tick(): Date {
    this.clock += MINUTE;
    return new Date(this.clock);
  }

  /** A reader subscribed to the feed. */
  async user(): Promise<string> {
    const userId = await this.h.user();
    await this.h.subscribe(userId, this.feedId, 'active');
    return userId;
  }

  /** The rating time of pool article `index` unless a test chooses another (whole milliseconds). */
  ratedAtOf(index: number): Date {
    return new Date(this.base - (POOL + 5 - index) * HOUR);
  }

  /** Rate pool article `index` in SQL, with the given rating time. */
  async setRating(
    userId: string,
    index: number,
    rating: 1 | -1 | null,
    ratedAt: Date | null = rating === null ? null : this.ratedAtOf(index),
  ): Promise<void> {
    await this.h.owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, article_id) DO UPDATE SET rating = $3, rated_at = $4`,
      [userId, this.articles[index], rating, ratedAt],
    );
  }

  /**
   * Ratings by class over pool articles: likes use the even indexes from 0, dislikes the odd ones
   * from 1, `likes` and `dislikes` of them. Returns the indexes in rating order.
   */
  async rateClasses(
    userId: string,
    likes: number,
    dislikes: number,
    ratedAt?: (index: number) => Date,
  ): Promise<number[]> {
    const indexes: number[] = [];
    for (let k = 0; k < Math.max(likes, dislikes); k += 1) {
      if (k < likes) indexes.push(2 * k);
      if (k < dislikes) indexes.push(2 * k + 1);
    }
    for (const index of indexes) {
      await this.setRating(
        userId,
        index,
        classOf(index),
        ratedAt?.(index) ?? this.ratedAtOf(index),
      );
    }
    return indexes;
  }

  /** A reader with `likes` and `dislikes` explicit ratings. */
  async reader(likes: number, dislikes: number): Promise<string> {
    const userId = await this.user();
    await this.rateClasses(userId, likes, dislikes);
    return userId;
  }

  async setPreferences(userId: string, patch: Record<string, unknown>): Promise<void> {
    await this.h.owner.query(
      `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [userId, JSON.stringify(patch)],
    );
  }

  // ── Stored models ────────────────────────────────────────────────────────────────────────────

  async models(userId: string): Promise<StoredModelRow[]> {
    const result = await this.h.owner.query<{
      version: number;
      spec: string;
      n: number;
      n_pos: number;
      n_neg: number;
      intercept: number;
      weights: Record<string, number>;
      platt: { a: number; b: number };
      metrics: Record<string, unknown>;
    }>(
      `SELECT version, spec, n, n_pos, n_neg, intercept, weights, platt, metrics
         FROM user_estimate_models WHERE user_id = $1 ORDER BY version`,
      [userId],
    );
    return result.rows.map((row) => ({
      version: row.version,
      spec: row.spec,
      n: row.n,
      nPos: row.n_pos,
      nNeg: row.n_neg,
      intercept: row.intercept,
      weights: row.weights,
      platt: row.platt,
      metrics: row.metrics,
    }));
  }

  async versions(userId: string): Promise<number[]> {
    return (await this.models(userId)).map((m) => m.version);
  }

  /** Pending outbox payloads of `queue` for the user. */
  async pending(queue: string, userId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.h.intents(queue, { pending: true }))
      .map((intent) => intent.payload)
      .filter((payload) => payload['userId'] === userId);
  }

  async softDelete(userId: string): Promise<void> {
    await this.h.owner.query(
      `UPDATE users SET deleted_at = now() - interval '1 day' WHERE id = $1`,
      [userId],
    );
  }

  // ── Reader actions through the API functions ─────────────────────────────────────────────────

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

  private async withReceipt<R extends ActionResult>(
    userId: string,
    fn: (tx: TenantTx) => Promise<R>,
  ): Promise<{ result: R; key: string | null }> {
    return withTenant(this.appDb, userId, async (tx) => {
      const result = await fn(tx);
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

  async run<R extends ActionResult>(
    userId: string,
    index: number,
    fn: (tx: TenantTx, base: ActionInput) => Promise<R>,
  ): Promise<{ result: R; key: string | null }> {
    const articleId = this.articles[index]!;
    const fence = await this.fence(userId, articleId);
    const now = this.tick();
    return this.withReceipt(userId, (tx) =>
      fn(tx, {
        articleId,
        fence,
        now,
        outbox: tenantOutbox(tx),
        matchFingerprint: this.h.matchFingerprint,
      }),
    );
  }

  rate(userId: string, index: number, rating: 1 | -1 | null = classOf(index)) {
    return this.run(userId, index, (tx, base) =>
      rateArticle(tx, { ...base, rating, reason: null, hide: false }),
    );
  }

  hide(userId: string, index: number) {
    return this.run(userId, index, (tx, base) =>
      rateArticle(tx, { ...base, rating: null, reason: null, hide: true }),
    );
  }

  answer(userId: string, index: number, liked: boolean) {
    return this.run(userId, index, (tx, base) => answerPrompt(tx, { ...base, liked }));
  }

  async rateBulk(userId: string, indexes: readonly number[], rating: 1 | -1 | null) {
    const targets: Array<{ articleId: string; fence: ActionInput['fence'] }> = [];
    for (const index of indexes) {
      const articleId = this.articles[index]!;
      targets.push({ articleId, fence: await this.fence(userId, articleId) });
    }
    const now = this.tick();
    return this.withReceipt(userId, (tx) =>
      rateArticlesBulk(tx, {
        targets,
        rating,
        now,
        outbox: tenantOutbox(tx),
        matchFingerprint: this.h.matchFingerprint,
      }),
    );
  }

  bookmark(userId: string, index: number) {
    return this.run(userId, index, (tx, base) => bookmarkArticle(tx, base));
  }

  unbookmark(userId: string, index: number) {
    return this.run(userId, index, (tx, base) => unbookmarkArticle(tx, base));
  }

  markRead(userId: string, index: number) {
    return this.run(userId, index, (tx, base) => markArticleRead(tx, base));
  }

  open(userId: string, index: number) {
    return this.run(userId, index, (tx, base) => openArticle(tx, base));
  }

  /** A private label card assigned to the user. */
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
    return this.run(userId, index, (tx, base) => labelArticle(tx, { ...base, labelId }));
  }

  unlabel(userId: string, index: number, labelId: string) {
    return this.run(userId, index, (tx, base) => unlabelArticle(tx, { ...base, labelId }));
  }

  async undo(userId: string, key: string): Promise<void> {
    const now = this.tick();
    await withTenant(this.appDb, userId, (tx) =>
      undoArticleMutation(tx, { mutationId: key, now, outbox: tenantOutbox(tx) }),
    );
  }
}
