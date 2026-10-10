import { createHash, randomUUID } from 'node:crypto';

import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
} from '@bantoozi/testing';

import * as dbModule from '../../src/index.js';
import {
  answerPrompt,
  bookmarkArticle,
  markArticleRead,
  markArticleUnread,
  markArticlesRead,
  openArticle,
  rateArticle,
  recordDwell,
  saveMutation,
  tenantOutbox,
  unbookmarkArticle,
  undoArticleMutation,
  labelArticle,
  unlabelArticle,
  withTenant,
  type ActionInput,
  type ActionResult,
  type TenantTx,
} from '../../src/index.js';
import { withConnection, type DbTestContext } from '../support/test-db.js';

/**
 * M7-T2 test fixtures. The sample loader contract is declared test-locally and the db namespace is
 * cast to it, so these files typecheck before the implementation exists; a missing export is
 * `undefined` and fails the calling test (never the runner).
 */

export type LearnSignal = 'rating' | 'bookmark' | 'dwell' | 'bounce' | 'read';

export interface Features {
  specSha: string;
  ratingSha: string;
  snapshotAt: string;
  cards: { id: string; strength: string; p: number | null; engine: string | null }[];
  values: {
    facets: Record<string, number> | null;
    facetsEngine: string | null;
    clusterId: string | null;
    [key: string]: unknown;
  };
  sourceManifest?: Record<string, unknown>;
}

export interface LearnSample {
  articleId: string;
  eventId: string;
  signal: LearnSignal;
  y: 0 | 1;
  weight: number;
  explicit: boolean;
  feedbackAt: Date;
  groupId: string;
  features: Features | null;
}

interface LoaderApi {
  loadLearnSamples(
    db: unknown,
    input: { userId: string; now: Date },
  ): Promise<{ samples: LearnSample[]; cutoffEventId: string | null }>;
}

const loader = dbModule as unknown as LoaderApi;

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export const FEATURE_SPEC_SHA = createHash('sha256')
  .update('bantoozi:feature-snapshot:raw-v1')
  .digest('hex');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stored event JSON is read loosely by assertions
export type EventValue = Record<string, any>;

export interface EventRow {
  id: string;
  articleId: string;
  kind: string;
  value: EventValue;
  createdAt: Date;
}

export interface Done {
  result: ActionResult;
  /** The idempotency key the undo receipt was saved under (when the action is undoable). */
  key: string | null;
  now: Date;
}

/** One reader on one active feed, with a monotonic synthetic clock 20 days in the past. */
export class Scenario {
  clock = Date.now() - 20 * DAY;

  private constructor(
    readonly ctx: DbTestContext,
    readonly userId: string,
    readonly feedId: string,
  ) {}

  static async create(
    ctx: DbTestContext,
    prefs: { implicitFeedback?: boolean; implicitNegative?: boolean } = {},
  ): Promise<Scenario> {
    const user = await createUser(ctx.owner);
    const feed = await createFeed(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: user.id,
      feedId: feed.id,
      mode: 'active',
      activatedAt: new Date(Date.now() - 30 * DAY),
    });
    const scenario = new Scenario(ctx, user.id, feed.id);
    await scenario.setPrefs(prefs);
    return scenario;
  }

  tick(): Date {
    this.clock += 2 * MINUTE;
    return new Date(this.clock);
  }

  async setPrefs(prefs: { implicitFeedback?: boolean; implicitNegative?: boolean }): Promise<void> {
    await this.ctx.owner.query(
      `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [this.userId, JSON.stringify(prefs)],
    );
  }

  async article(options: { clusterId?: string } = {}): Promise<string> {
    const article = await createArticle(this.ctx.owner, { feedIds: [this.feedId] });
    if (options.clusterId !== undefined) {
      await this.ctx.owner.query(`UPDATE articles SET story_cluster_id = $2 WHERE id = $1`, [
        article.id,
        options.clusterId,
      ]);
    }
    return article.id;
  }

  async cluster(articleId: string): Promise<string> {
    const result = await this.ctx.owner.query<{ id: string }>(
      `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, 2) RETURNING id::text AS id`,
      [articleId],
    );
    const id = result.rows[0]!.id;
    await this.ctx.owner.query(`UPDATE articles SET story_cluster_id = $2 WHERE id = $1`, [
      articleId,
      id,
    ]);
    return id;
  }

  /** Stop authorizing inference for the feed: later feedback snapshots are `null`. */
  async inferenceOff(): Promise<void> {
    await this.ctx.owner.query(
      `UPDATE subscriptions SET inference_mode = 'off', inference_activated_at = NULL, inference_version = inference_version + 1
        WHERE user_id = $1 AND feed_id = $2`,
      [this.userId, this.feedId],
    );
  }

  private async fence(articleId: string): Promise<ActionInput['fence']> {
    const state = await this.ctx.owner.query<{ state_version: string }>(
      `SELECT state_version::text AS state_version FROM user_article
        WHERE user_id = $1 AND article_id = $2`,
      [this.userId, articleId],
    );
    const revision = await this.ctx.owner.query<{ r: string }>(
      `SELECT content_revision::text AS r FROM articles WHERE id = $1`,
      [articleId],
    );
    return {
      stateVersion: state.rows[0]?.state_version ?? '0',
      contentRevision: revision.rows[0]!.r,
    };
  }

  async run<R extends ActionResult>(
    articleId: string,
    fn: (tx: TenantTx, base: ActionInput) => Promise<R>,
  ): Promise<Done & { result: R }> {
    const fence = await this.fence(articleId);
    const now = this.tick();
    return withTenant(this.ctx.app, this.userId, async (tx) => {
      const result = await fn(tx, { articleId, fence, now, outbox: tenantOutbox(tx) });
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
      return { result, key, now };
    });
  }

  rate(articleId: string, rating: 1 | -1 | null) {
    return this.run(articleId, (tx, base) =>
      rateArticle(tx, { ...base, rating, reason: null, hide: false }),
    );
  }

  answer(articleId: string, liked: boolean) {
    return this.run(articleId, (tx, base) => answerPrompt(tx, { ...base, liked }));
  }

  bookmark(articleId: string) {
    return this.run(articleId, (tx, base) => bookmarkArticle(tx, base));
  }

  unbookmark(articleId: string) {
    return this.run(articleId, (tx, base) => unbookmarkArticle(tx, base));
  }

  open(articleId: string) {
    return this.run(articleId, (tx, base) => openArticle(tx, base));
  }

  /** A dwell report of `ms` (the clock ticks 2 minutes per action, so up to 120 s is accepted). */
  dwell(articleId: string, ms: number) {
    return this.run(articleId, (tx, base) => recordDwell(tx, { ...base, ms }));
  }

  read(articleId: string, trigger?: 'expand') {
    return this.run(articleId, (tx, base) =>
      markArticleRead(tx, { ...base, ...(trigger === undefined ? {} : { trigger }) }),
    );
  }

  unread(articleId: string) {
    return this.run(articleId, (tx, base) => markArticleUnread(tx, base));
  }

  async bulkRead(articleId: string): Promise<Done> {
    const fence = await this.fence(articleId);
    const now = this.tick();
    return withTenant(this.ctx.app, this.userId, async (tx) => {
      const result = await markArticlesRead(tx, {
        targets: [{ articleId, fence }],
        now,
        outbox: tenantOutbox(tx),
      });
      return { result, key: null, now };
    });
  }

  /** A held label card of this user. */
  async labelCard(): Promise<string> {
    const card = await createCard(this.ctx.owner, {
      kind: 'label',
      visibility: 'private',
      ownerUserId: this.userId,
    });
    await this.ctx.owner.query(
      `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Label')`,
      [this.userId, card.id],
    );
    return card.id;
  }

  label(articleId: string, labelId: string) {
    return this.run(articleId, (tx, base) => labelArticle(tx, { ...base, labelId }));
  }

  unlabel(articleId: string, labelId: string) {
    return this.run(articleId, (tx, base) => unlabelArticle(tx, { ...base, labelId }));
  }

  /** Undo the mutation saved under `key` (the clock ticks first). */
  async undo(key: string): Promise<void> {
    const now = this.tick();
    await withTenant(this.ctx.app, this.userId, (tx) =>
      undoArticleMutation(tx, { mutationId: key, now, outbox: tenantOutbox(tx) }),
    );
  }

  async events(articleId?: string): Promise<EventRow[]> {
    const result = await this.ctx.owner.query<{
      id: string;
      article_id: string;
      kind: string;
      value: EventValue;
      created_at: Date;
    }>(
      `SELECT id::text AS id, article_id::text AS article_id, kind, value, created_at
         FROM feedback_events
        WHERE user_id = $1 AND ($2::bigint IS NULL OR article_id = $2::bigint)
        ORDER BY feedback_events.id`,
      [this.userId, articleId ?? null],
    );
    return result.rows.map((r) => ({
      id: r.id,
      articleId: r.article_id,
      kind: r.kind,
      value: r.value,
      createdAt: r.created_at,
    }));
  }

  /** The id of the `nth` (0-based) event of `kind` on the article. */
  async eventId(articleId: string, kind: string, nth = 0): Promise<string> {
    const found = (await this.events(articleId)).filter((e) => e.kind === kind)[nth];
    if (found === undefined) throw new Error(`fixture: no ${kind} event #${nth}`);
    return found.id;
  }

  async event(articleId: string, kind: string, nth = 0): Promise<EventRow> {
    const found = (await this.events(articleId)).filter((e) => e.kind === kind)[nth];
    if (found === undefined) throw new Error(`fixture: no ${kind} event #${nth}`);
    return found;
  }

  /** Rewrite one event's JSON (fixture-only: shapes the API cannot produce). */
  async patchEvent(id: string, expression: string): Promise<void> {
    await this.ctx.owner.query(
      `UPDATE feedback_events SET value = ${expression} WHERE id = $1::bigint`,
      [id],
    );
  }

  /** Insert an event row (and the reader state a real action would have left) directly. */
  async insertEvent(
    articleId: string,
    kind: string,
    value: Record<string, unknown>,
    at: Date = this.tick(),
  ): Promise<string> {
    const result = await this.ctx.owner.query<{ id: string }>(
      `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id::text AS id`,
      [this.userId, articleId, kind, JSON.stringify(value), at],
    );
    return result.rows[0]!.id;
  }

  /** A rating exactly as M4 leaves it: reader columns plus a `rate` event with the given extras. */
  async insertRating(
    articleId: string,
    extra: Record<string, unknown>,
    options: { rating?: 1 | -1; at?: Date } = {},
  ): Promise<{ id: string; at: Date }> {
    const at = options.at ?? this.tick();
    const rating = options.rating ?? 1;
    await this.ctx.owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, article_id) DO UPDATE SET rating = $3, rated_at = $4`,
      [this.userId, articleId, rating, at],
    );
    const id = await this.insertEvent(
      articleId,
      'rate',
      {
        v: 1,
        rating,
        reason: null,
        hide: false,
        contentRevision: '1',
        signalOrigin: 'explicit',
        learningConsent: { implicitFeedback: false, implicitNegative: false },
        ...extra,
      },
      at,
    );
    return { id, at };
  }

  async samples(): Promise<LearnSample[]> {
    return (await this.load()).samples;
  }

  async load(): Promise<{ samples: LearnSample[]; cutoffEventId: string | null }> {
    return loader.loadLearnSamples(this.ctx.worker, { userId: this.userId, now: new Date() });
  }
}

export function snapshot(over: Partial<Features> & { at?: Date } = {}): Features {
  const { at, ...rest } = over;
  return {
    specSha: FEATURE_SPEC_SHA,
    ratingSha: 'a'.repeat(64),
    snapshotAt: (at ?? new Date()).toISOString(),
    cards: [],
    values: {
      facets: null,
      facetsEngine: null,
      wordCount: 400,
      ageHours: 3,
      lang: 'en',
      hasImage: false,
      hasVideo: false,
      bodyImageCount: 0,
      clusterId: null,
      clusterSize: 0,
      sourceFeedId: null,
      author: null,
    },
    sourceManifest: { contentRevision: '1', mediaRevision: '1', inferenceFeedIds: [] },
    ...rest,
  };
}

/** A request of the scenario's user for the article at revision 1, completed or left pending. */
export async function analysisRequest(
  s: Scenario,
  articleId: string,
  options: {
    status: 'pending' | 'complete';
    cards?: { cardId: string; p: number }[];
    features?: Record<string, number>;
  },
): Promise<{ requestId: string; inputSha: string }> {
  const requestId = randomUUID();
  const inputSnapshot = { v: 1, fixture: requestId };
  return withConnection(s.ctx.owner, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.user_id', $1, true)", [s.userId]);
      const inserted = await client.query<{ input_sha: string }>(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha)
         VALUES ($1, $2, $3, $4, 1, 1, $5::jsonb,
                 encode(sha256(convert_to($5::jsonb::text, 'UTF8')), 'hex'))
         RETURNING input_sha`,
        [requestId, s.userId, s.feedId, articleId, JSON.stringify(inputSnapshot)],
      );
      const inputSha = inserted.rows[0]!.input_sha;
      if (options.status === 'complete') {
        const result = {
          v: 1,
          requestId,
          inputSha,
          processedAt: new Date().toISOString(),
          article: { id: articleId, revision: '1' },
          model: { engine: 'typesafe', model: 'fixture-model' },
          translation: null,
          enrich: {
            questionSetSha: 'b'.repeat(64),
            stateSha256: 'c'.repeat(64),
            stateVariant: 'native',
            answers: {},
            features: options.features ?? {},
          },
          match: {
            questionSetSha: 'd'.repeat(64),
            stateSha256: 'e'.repeat(64),
            stateVariant: 'native',
            cards: (options.cards ?? []).map((c) => ({
              cardId: c.cardId,
              cardInputSha256: 'f'.repeat(64),
              p: c.p,
              answer: {},
            })),
            l2: [],
          },
        };
        await client.query(
          `UPDATE analysis_requests
              SET result_snapshot = $2::jsonb, result_sha = $3, status = 'complete',
                  completed_at = now()
            WHERE id = $1`,
          [requestId, JSON.stringify(result), '9'.repeat(64)],
        );
      }
      await client.query('COMMIT');
      return { requestId, inputSha };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
