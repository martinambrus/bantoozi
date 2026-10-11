import { randomUUID } from 'node:crypto';

import { MetricsWorld, type Lane, type WorldArticle, type WorldUser } from './metrics-world.js';

export { DAY, HOUR, MINUTE, SECRET_TITLE, pick, utcDay } from './metrics-world.js';
export type { Lane, WorldArticle, WorldUser } from './metrics-world.js';

/** The pre-feedback ranking source of spec 06 §8.2 `before` (amended by S17 with `scoreSource`). */
export type Source = 'cards' | 'model' | 'degraded';

export interface RateOptions {
  lane: Lane;
  /** `undefined`: a legacy snapshot without `scoreSource`. */
  source?: Source;
  at: Date;
  /** `rate` (voluntary) or `prompt_answer`. */
  kind?: 'rate' | 'prompt_answer';
  /** A rating of the calibration round (`GET /articles/calibration`, spec 06 §10). */
  calibration?: boolean;
  hide?: boolean;
  reason?: string | null;
}

export interface ModelFixture {
  version: number;
  status: 'activated' | 'rejected' | 'superseded';
  active?: boolean;
  trainedAt: Date;
  nExplicit?: number;
  skipped?: Record<string, number>;
  cvAuc?: number | null;
  baselineAuc?: number | null;
  cvLogloss?: number | null;
  baselineLogloss?: number | null;
  /** When the model was deactivated because it became invalid (not when a newer model replaced it). */
  deactivatedAt?: Date;
}

export interface CallFixture {
  engine?: 'typesafe' | 'llm' | 'laya' | 'libretranslate';
  kind: 'enrich' | 'match' | 'cluster' | 'suggest' | 'translate' | 'credential_probe' | 'eval';
  status?: 'ok' | 'error' | 'timeout' | 'rate_limited' | 'invalid_response';
  latencyMs?: number | null;
  costUsd?: number;
  articleId?: string | null;
  userId?: string | null;
  at: Date;
}

export interface RequestFixture {
  userId: string;
  feedId: string;
  articleId: string;
  status: 'pending' | 'running' | 'complete' | 'cancelled';
  createdAt: Date;
}

/**
 * S17 fixtures on top of the M8-T4 metrics world: ratings with the amended `before` snapshot,
 * prompt answers and their undo, hide/unhide events, `user_models` attempts, `engine_calls`,
 * analysis requests, due classification jobs and `user_article` rows for the reader-policy counts.
 * Everything is plain SQL; the handler runs with a fake clock through {@link MetricsWorld.run}.
 */
export class MetricsS17World extends MetricsWorld {
  /** Remove everything a previous test left behind (this world owns the whole test database). */
  override async reset(): Promise<void> {
    for (const table of [
      'engine_calls',
      'analysis_requests',
      'user_models',
      'feedback_events',
      'user_article',
      'subscriptions',
      'feed_items',
    ]) {
      await this.owner.query(`DELETE FROM ${table}`);
    }
    await this.owner.query('UPDATE articles SET story_cluster_id = NULL');
    await this.owner.query('DELETE FROM story_clusters');
    await this.owner.query('DELETE FROM articles');
    await this.owner.query('DELETE FROM feeds');
    await this.owner.query('DELETE FROM pgboss.job');
    await this.owner.query("DELETE FROM settings WHERE key LIKE 'metrics.daily.%'");
  }

  // ── Ratings ───────────────────────────────────────────────────────────────────────────────

  async lang(article: WorldArticle, lang: string | null): Promise<void> {
    await this.owner.query('UPDATE articles SET lang = $2 WHERE id = $1', [article.id, lang]);
  }

  /** A `before` snapshot with the ranking source. */
  beforeWith(lane: Lane, source: Source | undefined): Record<string, unknown> {
    return { ...this.before(lane, 3), ...(source === undefined ? {} : { scoreSource: source }) };
  }

  async rating(
    user: WorldUser,
    article: WorldArticle,
    rating: 1 | -1,
    options: RateOptions,
  ): Promise<void> {
    const kind = options.kind ?? 'rate';
    await this.event(user, article, kind, options.at, {
      rating,
      reason: rating === -1 ? (options.reason ?? null) : null,
      hide: options.hide ?? false,
      signalOrigin: 'explicit',
      before: this.beforeWith(options.lane, options.source),
      ...(options.calibration === true
        ? { selection: { method: 'calibration', sourceLane: options.lane } }
        : {}),
    });
  }

  async unrating(
    user: WorldUser,
    article: WorldArticle,
    lane: Lane,
    source: Source | undefined,
    at: Date,
  ): Promise<void> {
    await this.event(user, article, 'unrate', at, {
      rating: null,
      reason: null,
      hide: false,
      before: this.beforeWith(lane, source),
    });
  }

  /** The undo event the API writes: `action` is the undone mutation (`rating` or `prompt_answer`). */
  async undoAction(
    user: WorldUser,
    article: WorldArticle,
    action: 'rating' | 'prompt_answer',
    at: Date,
  ): Promise<void> {
    await this.event(user, article, 'undo', at, {
      action,
      mutationId: randomUUID(),
      restored: ['rating', 'reason', 'ratedAt'],
      signalOrigin: 'explicit',
    });
  }

  async unhide(user: WorldUser, article: WorldArticle, at: Date): Promise<void> {
    await this.event(user, article, 'unhide', at, { signalOrigin: 'explicit' });
  }

  // ── Personal models ───────────────────────────────────────────────────────────────────────

  async model(user: WorldUser, fixture: ModelFixture): Promise<void> {
    const metrics = {
      status: fixture.status,
      reason: fixture.status === 'rejected' ? 'low_auc' : null,
      nExplicit: fixture.nExplicit ?? 40,
      nPos: 20,
      nNeg: 20,
      skipped: fixture.skipped ?? {},
      cvAuc: fixture.cvAuc ?? null,
      baselineAuc: fixture.baselineAuc ?? null,
      cvLogloss: fixture.cvLogloss ?? null,
      baselineLogloss: fixture.baselineLogloss ?? null,
      attemptAt: fixture.trainedAt.toISOString(),
      ...(fixture.deactivatedAt === undefined
        ? {}
        : { deactivatedAt: fixture.deactivatedAt.toISOString() }),
    };
    await this.owner.query(
      `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                                intercept, scaler, calibration, metrics, active, trained_at)
       VALUES ($1, $2, 'spec', $3, 20, 20, '{}'::jsonb, 0, '{}'::jsonb, '{}'::jsonb, $4::jsonb, $5, $6)`,
      [
        user.id,
        fixture.version,
        fixture.nExplicit ?? 40,
        JSON.stringify(metrics),
        fixture.active ?? false,
        fixture.trainedAt,
      ],
    );
  }

  // ── Feeds, subscriptions, articles ────────────────────────────────────────────────────────

  async feed(): Promise<string> {
    return this.h.feed();
  }

  async subscribe(
    user: WorldUser,
    feedId: string,
    mode: 'off' | 'training' | 'active',
    activatedAt: Date,
  ): Promise<void> {
    await this.h.subscribe(user.id, feedId, mode, activatedAt);
  }

  /** An article carried by `feedId`, first seen at `firstSeenAt`. */
  async carried(
    feedId: string,
    firstSeenAt: Date,
    state = 'enriched',
  ): Promise<{ id: string; title: string }> {
    const id = await this.h.article({ feedIds: [feedId], state, firstSeenAt });
    const row = await this.owner.query<{ title: string }>(
      'SELECT title FROM articles WHERE id = $1',
      [id],
    );
    return { id, title: row.rows[0]!.title };
  }

  /** The cached ranking row of a reader. */
  async ranked(
    user: WorldUser,
    articleId: string,
    options: {
      lane: Lane;
      tier?: number | null;
      source?: Source | 'none';
      pLike?: number;
      read?: boolean;
      archived?: boolean;
    },
  ): Promise<void> {
    await this.owner.query(
      `INSERT INTO user_article (user_id, article_id, lane, tier, p_like, score_source, read_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, article_id) DO UPDATE
         SET lane = EXCLUDED.lane, tier = EXCLUDED.tier, p_like = EXCLUDED.p_like,
             score_source = EXCLUDED.score_source, read_at = EXCLUDED.read_at,
             archived_at = EXCLUDED.archived_at`,
      [
        user.id,
        articleId,
        options.lane,
        options.tier === undefined ? 3 : options.tier,
        options.pLike ?? 0.5,
        options.source ?? 'cards',
        options.read === true ? new Date() : null,
        options.archived === true ? new Date() : null,
      ],
    );
  }

  /** Put `articleIds` in one story cluster. */
  async cluster(articleIds: readonly string[]): Promise<void> {
    const cluster = await this.owner.query<{ id: string }>(
      'INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, $2) RETURNING id::text AS id',
      [articleIds[0], articleIds.length],
    );
    await this.owner.query(
      'UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])',
      [cluster.rows[0]!.id, articleIds],
    );
  }

  async preferences(user: WorldUser, preferences: Record<string, unknown>): Promise<void> {
    await this.owner.query(
      `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [user.id, JSON.stringify(preferences)],
    );
  }

  /** `count` pg-boss jobs of `queue`, due from `startAfter`, in `state`. */
  async jobs(
    queue: string,
    count: number,
    startAfter: Date,
    state: 'created' | 'retry' | 'active' | 'completed' = 'created',
  ): Promise<void> {
    await this.owner.query(
      `INSERT INTO pgboss.job (name, state, start_after, created_on)
       SELECT $1, $2::pgboss.job_state, $3, $3 FROM generate_series(1, $4)`,
      [queue, state, startAfter, count],
    );
  }

  // ── Engine ────────────────────────────────────────────────────────────────────────────────

  async call(fixture: CallFixture): Promise<void> {
    await this.owner.query(
      `INSERT INTO engine_calls (engine, kind, model, article_id, logical_request_id, user_id, cost_usd,
                                 latency_ms, status, created_at)
       VALUES ($1, $2, 'jev-test-1', $3, $4, $5, $6, $7, $8, $9)`,
      [
        fixture.engine ?? 'typesafe',
        fixture.kind,
        fixture.articleId ?? null,
        randomUUID(),
        fixture.userId ?? null,
        fixture.costUsd ?? 0,
        fixture.latencyMs === undefined ? 100 : fixture.latencyMs,
        fixture.status ?? 'ok',
        fixture.at,
      ],
    );
  }

  async request(fixture: RequestFixture): Promise<void> {
    const complete = fixture.status === 'complete';
    const running = fixture.status === 'running';
    const done = complete || fixture.status === 'cancelled';
    // The insert trigger wants the active tenant and a pending row; fixtures need finished ones.
    const client = await this.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE analysis_requests DISABLE TRIGGER USER');
      await client.query(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision, inference_version,
                                        input_snapshot, input_sha, result_snapshot, result_sha, status,
                                        lease_token, lease_until, created_at, completed_at)
         VALUES ($1, $2, $3, $4, 1, 1, '{}'::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
        [
          randomUUID(),
          fixture.userId,
          fixture.feedId,
          fixture.articleId,
          randomUUID(),
          complete ? '{}' : null,
          complete ? randomUUID() : null,
          fixture.status,
          running ? randomUUID() : null,
          running ? new Date(fixture.createdAt.getTime() + 3_600_000) : null,
          fixture.createdAt,
          done ? new Date(fixture.createdAt.getTime() + 60_000) : null,
        ],
      );
      await client.query('ALTER TABLE analysis_requests ENABLE TRIGGER USER');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
