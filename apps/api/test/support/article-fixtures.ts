import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';

import {
  apiClient,
  createTestUser,
  type ApiClient,
  type ApiHarness,
  type TestUser,
} from './harness.js';

/**
 * Reader fixtures for the article integration tests (M4-T6/T7): subscriptions with inference
 * modes, articles carried at chosen arrivals, stored rankings stamped current, clusters, and
 * readers of the outbox and feedback events. Everything is written through the owner pool.
 */

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const ago = (ms: number): Date => new Date(Date.now() - ms);

/** `scoreVersion(0)`: no `ranker.settings_version` row is stored in the test database. */
export const CURRENT_SCORE_VERSION = '1:0';

export interface Reader {
  user: TestUser;
  api: ApiClient;
}

export async function newReader(
  h: ApiHarness,
  preferences: Record<string, unknown> = {},
): Promise<Reader> {
  const user = await createTestUser(h);
  if (Object.keys(preferences).length > 0) {
    await h.owner.query(`UPDATE users SET preferences = $2::jsonb WHERE id = $1`, [
      user.id,
      JSON.stringify(preferences),
    ]);
  }
  return { user, api: apiClient(h.server, user) };
}

export interface FeedOptions {
  mode?: 'off' | 'training' | 'active';
  /** Default: 30 days ago, so every test arrival is after activation. */
  activatedAt?: Date;
  allowDuplicates?: boolean;
  hidden?: boolean;
  folder?: string;
  title?: string;
}

/** A feed the user subscribes to (default `active`, activated 30 days ago). */
export async function subscribedFeed(
  h: ApiHarness,
  userId: string,
  options: FeedOptions = {},
): Promise<string> {
  const feed = await createFeed(
    h.owner,
    options.title === undefined ? {} : { title: options.title },
  );
  await subscribe(h, userId, feed.id, options);
  return feed.id;
}

export async function subscribe(
  h: ApiHarness,
  userId: string,
  feedId: string,
  options: FeedOptions = {},
): Promise<void> {
  const mode = options.mode ?? 'active';
  await createSubscription(h.owner, {
    userId,
    feedId,
    mode,
    ...(mode === 'active' ? { activatedAt: options.activatedAt ?? ago(30 * DAY) } : {}),
  });
  await h.owner.query(
    `UPDATE subscriptions SET allow_duplicates = $3, hidden = $4, folder = $5
      WHERE user_id = $1 AND feed_id = $2`,
    [
      userId,
      feedId,
      options.allowDuplicates ?? false,
      options.hidden ?? false,
      options.folder ?? null,
    ],
  );
}

/** An article carried by `feedIds`, arriving at `arrival` (default: now). */
export async function carriedArticle(
  h: ApiHarness,
  feedIds: readonly string[],
  options: { arrival?: Date; title?: string; publishedAt?: Date; url?: string } = {},
): Promise<string> {
  const article = await createArticle(h.owner, {
    feedIds,
    ...(options.arrival === undefined ? {} : { firstSeenAt: options.arrival }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.publishedAt === undefined ? {} : { publishedAt: options.publishedAt }),
    ...(options.url === undefined ? {} : { url: options.url }),
  });
  return article.id;
}

/** Another carrier of an existing article, arriving at `arrival`. */
export async function carry(
  h: ApiHarness,
  feedId: string,
  articleId: string,
  arrival: Date = new Date(),
): Promise<void> {
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, $3, $4)`,
    [feedId, articleId, `extra-${feedId}-${articleId}`, arrival],
  );
}

export interface ExplainInput {
  p: number | null;
  lane: string;
  tier: number | null;
  contentRevision?: string;
  source?: 'cards' | 'model' | 'degraded' | 'none';
  decidingCardId?: string;
  cards?: { id: string; title: string; strength: string; p: number; engine: string }[];
  rules?: { code: string; ruleId?: string }[];
}

export function explainJson(input: ExplainInput): Record<string, unknown> {
  return {
    v: 1,
    inputs: {
      contentRevision: input.contentRevision ?? '1',
      mediaRevision: '0',
      rankRevision: '0',
      contextSha: 'a'.repeat(64),
    },
    source: input.source ?? 'cards',
    p: input.p,
    lane: input.lane,
    tier: input.tier,
    ...(input.decidingCardId === undefined ? {} : { decidingCardId: input.decidingCardId }),
    cards: input.cards ?? [],
    rules: input.rules ?? [],
  };
}

export interface RankInput {
  lane: 'new' | 'for_you' | 'maybe' | 'everything' | 'hidden';
  p?: number | null;
  tier?: number | null;
  explain?: Record<string, unknown> | null;
  rulesFired?: string[];
  /** Default: the current score version (not outdated). */
  scoreVersion?: string;
}

/**
 * A stored ranking for (user, article), stamped with the user's current `rank_revision` and the
 * current score version unless told otherwise. Leaves reader state alone.
 */
export async function rank(
  h: ApiHarness,
  userId: string,
  articleId: string,
  input: RankInput,
): Promise<void> {
  const p = input.p ?? null;
  const tier = input.tier ?? null;
  const explain =
    input.explain === undefined ? explainJson({ p, lane: input.lane, tier }) : input.explain;
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, lane, p_like, tier, score_source, rules_fired,
                               explain, score_version, rank_revision, scored_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
             (SELECT rank_revision FROM users WHERE id = $1), now())
     ON CONFLICT (user_id, article_id) DO UPDATE
       SET lane = EXCLUDED.lane, p_like = EXCLUDED.p_like, tier = EXCLUDED.tier,
           score_source = EXCLUDED.score_source, rules_fired = EXCLUDED.rules_fired,
           explain = EXCLUDED.explain, score_version = EXCLUDED.score_version,
           rank_revision = EXCLUDED.rank_revision, scored_at = EXCLUDED.scored_at`,
    [
      userId,
      articleId,
      input.lane,
      p,
      tier,
      p === null ? 'none' : 'cards',
      input.rulesFired ?? [],
      explain === null ? null : JSON.stringify(explain),
      input.scoreVersion ?? CURRENT_SCORE_VERSION,
    ],
  );
}

/** Re-stamp every stored ranking of the user as current (after an action bumped `rank_revision`). */
export async function restamp(h: ApiHarness, userId: string): Promise<void> {
  await h.owner.query(
    `UPDATE user_article SET rank_revision = (SELECT rank_revision FROM users WHERE id = $1),
                             score_version = $2
      WHERE user_id = $1`,
    [userId, CURRENT_SCORE_VERSION],
  );
}

/** Put the articles in one new story cluster; returns its id. */
export async function clusterOf(h: ApiHarness, articleIds: readonly string[]): Promise<string> {
  const created = await h.owner.query<{ id: string }>(
    `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, $2) RETURNING id::text AS id`,
    [articleIds[0], articleIds.length],
  );
  const id = created.rows[0]!.id;
  await h.owner.query(`UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])`, [
    id,
    articleIds,
  ]);
  return id;
}

export async function setReader(
  h: ApiHarness,
  userId: string,
  articleId: string,
  patch: { readAt?: Date | null; archivedAt?: Date | null; bookmarked?: boolean },
): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, read_at, archived_at, state_version)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (user_id, article_id) DO UPDATE
       SET read_at = EXCLUDED.read_at, archived_at = EXCLUDED.archived_at,
           state_version = user_article.state_version + 1`,
    [userId, articleId, patch.readAt ?? null, patch.archivedAt ?? null],
  );
}

export interface OutboxRow {
  queue: string;
  payload: Record<string, unknown>;
}

export async function outbox(h: ApiHarness, userId: string, queue?: string): Promise<OutboxRow[]> {
  const result = await h.owner.query<OutboxRow>(
    `SELECT queue, payload FROM job_outbox
      WHERE user_id = $1 AND ($2::text IS NULL OR queue = $2) ORDER BY id`,
    [userId, queue ?? null],
  );
  return result.rows;
}

export async function clearOutbox(h: ApiHarness, userId: string): Promise<void> {
  await h.owner.query(`DELETE FROM job_outbox WHERE user_id = $1`, [userId]);
}

export interface EventRow {
  id: string;
  article_id: string;
  kind: string;
  value: Record<string, unknown>;
}

export async function events(
  h: ApiHarness,
  userId: string,
  articleId?: string,
): Promise<EventRow[]> {
  const result = await h.owner.query<EventRow>(
    `SELECT id::text, article_id::text, kind, value FROM feedback_events
      WHERE user_id = $1 AND ($2::bigint IS NULL OR article_id = $2) ORDER BY id`,
    [userId, articleId ?? null],
  );
  return result.rows;
}

export interface ReaderState {
  state_version: string;
  read_at: Date | null;
  opened_at: Date | null;
  rating: number | null;
  reason: string | null;
  archived_at: Date | null;
  bookmarked_at: Date | null;
  bookmark_snapshot_id: string | null;
  bookmark_capture_status: string | null;
  bookmark_capture_generation: string;
  label_ids: string[];
  dwell_ms: number | null;
  feedback_prompted_at: Date | null;
}

export async function readerState(
  h: ApiHarness,
  userId: string,
  articleId: string,
): Promise<ReaderState | undefined> {
  const result = await h.owner.query<ReaderState>(
    `SELECT state_version::text, read_at, opened_at, rating, reason, archived_at, bookmarked_at,
            bookmark_snapshot_id::text, bookmark_capture_status,
            bookmark_capture_generation::text, label_ids::text[] AS label_ids, dwell_ms,
            feedback_prompted_at
       FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  return result.rows[0];
}

export async function rankRevision(h: ApiHarness, userId: string): Promise<string> {
  const result = await h.owner.query<{ r: string }>(
    `SELECT rank_revision::text AS r FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]!.r;
}

/** The displayed fence of an item as the list returned it. */
export const fence = (item: { stateVersion: string; contentRevision: string }) => ({
  stateVersion: item.stateVersion,
  contentRevision: item.contentRevision,
});

/** A fresh-row fence (`stateVersion '0'`) for an article at content revision 1. */
export const freshFence = { stateVersion: '0', contentRevision: '1' };
