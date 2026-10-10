import { createHash } from 'node:crypto';

import {
  AppError,
  DEFAULT_RANKER_CONFIG,
  ExplainSchema,
  canonicalJson,
  enqueueLearn,
  mergeRankerConfig,
  planLimits,
  readUserPreferences,
  type ArticleListItem,
  type Explain,
  type JobSender,
  type RankerConfig,
  type RatingReason,
  type Strength,
  type UserPreferences,
} from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import { parseCardBody } from '../cards/body.js';
import { exampleFromArticleTitle } from '../cards/validation.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { recordRankIntents } from '../ingest/rank-intents.js';
import { readStoredSetting, readStoredSettings } from '../settings.js';
import type { Executor } from '../client.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';
import { articleContexts, loadArticleItems } from './articles.js';
import { lockMutationForUndo, updateMutationUndo } from './mutations.js';
import { createUserRule, type UserRule } from './rules.js';

/**
 * Reader actions (spec 08 §5.3–5.4, spec 06 §8.2, §8.4, §10). Every action runs inside the caller's
 * idempotent mutation transaction (`req.mutate`):
 *
 * 1. Lock the caller's `users` row, then the target articles (`FOR SHARE`, id order) and reader rows
 *    (`FOR UPDATE`, id order) — the order of the bookmark SQL functions and the label triggers — and
 *    read the preferences under that lock, so an offline replay cannot claim historical consent.
 * 2. Check access (a subscribed carrier or an owned bookmark; anything else is `NOT_FOUND`, and a
 *    mixed bulk request fails as a whole) and each target's fence: the displayed `stateVersion` and
 *    `contentRevision` (or, for a saved snapshot, its bound `snapshotId` and captured revision). A
 *    stale fence is `STALE_STATE` with the current item(s).
 * 3. Build the feedback event's immutable `before`/`features` snapshot **before** applying the
 *    change, apply the reader patch and increment `state_version`, append the event with the
 *    server-derived `learningConsent` and `signalOrigin`, and write rank/learn intents to the outbox.
 *    Ranking-cache columns are never written.
 * 4. Return the receipt's undo payload (prior values of exactly the changed fields and the resulting
 *    versions) for read/unread/unhide/rating/bookmark/label and bulk actions.
 */

/** Undo is accepted for 10 minutes after commit (spec 08 §5.4); unbookmark pins live as long. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

/**
 * Identity of the raw feature snapshot this API records (spec 06 §8.2 `features.specSha`): the
 * observed card answers with snapshot-time strengths plus raw `values` (facets, length, age, language,
 * media, story group, source), from which `FEATURE_SPEC_V1` derives its named inputs at training time.
 */
export const FEATURE_SNAPSHOT_SPEC = 'bantoozi:feature-snapshot:raw-v1';
export const FEATURE_SNAPSHOT_SPEC_SHA = createHash('sha256')
  .update(FEATURE_SNAPSHOT_SPEC)
  .digest('hex');

/** The settings whose change alters the meaning of every answer (spec 06 §8.1 rating fingerprint). */
const RATING_FINGERPRINT_SETTINGS = [
  'engine.model_pin',
  'question_sets.active',
  'language_modes',
  'card_text_mode',
] as const;

/**
 * The current rating fingerprint (spec 06 §8.1): the raw snapshot spec sha with the settings that
 * change the meaning of an answer. The API records it in each snapshot; learning compares against it.
 */
export async function readRatingFingerprint(executor: Executor): Promise<string> {
  return ratingShaOf(await readStoredSettings(executor, RATING_FINGERPRINT_SETTINGS));
}

/** The rating fingerprint of already-read stored settings (missing keys absent). */
function ratingShaOf(stored: ReadonlyMap<string, unknown>): string {
  return createHash('sha256')
    .update(
      canonicalJson({ specSha: FEATURE_SNAPSHOT_SPEC_SHA, settings: Object.fromEntries(stored) }),
    )
    .digest('hex');
}

/**
 * The fingerprint settings in one share-locked statement, in key order: a writer of any of them
 * waits for this transaction, so the filters and the stamp of a snapshot come from one state.
 */
async function readRatingSettingsLocked(tx: Executor): Promise<Map<string, unknown>> {
  const result = await tx.execute<{ key: string; value: unknown }>(
    sql`SELECT key, value FROM settings
         WHERE key = ANY(${sql.param([...RATING_FINGERPRINT_SETTINGS])}::text[])
         ORDER BY key FOR SHARE`,
  );
  return new Map(result.rows.map((row) => [row.key, row.value]));
}

const objectField = (value: unknown, field: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[field]
    : undefined;

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

/** The displayed item's fence (spec 08 §5.3). */
export interface ReaderFence {
  stateVersion: string;
  contentRevision: string;
  snapshotId?: string | undefined;
}

export interface ActionInput {
  articleId: string;
  fence: ReaderFence;
  now: Date;
  outbox: JobSender;
}

type ReaderField =
  | 'openedAt'
  | 'readAt'
  | 'rating'
  | 'reason'
  | 'ratedAt'
  | 'archivedAt'
  | 'labelIds'
  | 'labelSuggestions';

type BeforeValue = string | number | string[] | null;

export interface UndoTarget {
  articleId: string;
  /** The reader version this mutation produced; undo requires it to be unchanged. */
  resultVersion: string;
  /** Prior values of exactly the fields this mutation changed (timestamps as ISO strings). */
  before: Partial<Record<ReaderField, BeforeValue>>;
}

/**
 * `api_mutations.undo` of an undoable reader action. An unbookmark also carries the top-level
 * `articleId`/`stateVersion`/`prior` contract `restore_bookmark_snapshot` reads (spec 02 §6).
 */
export interface UndoReceipt {
  v: 1;
  kind: 'reader' | 'bookmark' | 'unbookmark';
  action: string;
  targets: UndoTarget[];
  effects: { rankFull: boolean; learn: boolean };
  articleId?: string;
  stateVersion?: string;
  prior?: { bookmarkedAt: string; originFeedId: string | null; captureStatus: string };
  undoneAt?: string;
}

export interface ActionResult {
  /** The affected article ids, for the response items. */
  articleIds: string[];
  /** False when the action was a no-op (nothing written, no event). */
  changed: boolean;
  undo?: UndoReceipt;
}

// ── Locking and reading ────────────────────────────────────────────────────────────────────────

interface ReaderRow {
  stateVersion: string;
  openedAt: Date | null;
  readAt: Date | null;
  rating: 1 | -1 | null;
  reason: RatingReason | null;
  ratedAt: Date | null;
  dwellMs: number | null;
  bookmarkedAt: Date | null;
  snapshotId: string | null;
  snapshotRevision: string | null;
  originFeedId: string | null;
  captureStatus: string | null;
  captureGeneration: string;
  archivedAt: Date | null;
  labelIds: string[];
  labelSuggestions: string[];
  feedbackPromptedAt: Date | null;
  lane: string;
  pLike: number | null;
  tier: number | null;
  scoreVersion: string;
  rankRevision: string;
  scoredAt: Date | null;
  explain: unknown;
}

interface LockedArticle {
  articleId: string;
  contentRevision: string;
  url: string | null;
  title: string;
  storyClusterId: string | null;
  row: ReaderRow | null;
}

interface ReaderLock {
  user: string;
  prefs: UserPreferences;
  plan: string;
  articles: Map<string, LockedArticle>;
}

/** Lock the caller's `users` row and read its preferences/plan (step 1 of the module comment). */
export async function lockReaderUser(
  tx: TenantTx,
): Promise<{ user: string; prefs: UserPreferences; plan: string }> {
  const user = tenantUserId(tx);
  const result = await tx.execute<{ preferences: unknown; plan: string }>(sql`
    SELECT preferences, plan FROM users WHERE id = ${user}::uuid FOR NO KEY UPDATE`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('tenant user row is missing');
  return { user, prefs: readUserPreferences(row.preferences), plan: row.plan };
}

type ReaderSqlRow = {
  article_id: string;
  state_version: string;
  opened_at: RawTimestamp | null;
  read_at: RawTimestamp | null;
  rating: number | null;
  reason: RatingReason | null;
  rated_at: RawTimestamp | null;
  dwell_ms: number | null;
  bookmarked_at: RawTimestamp | null;
  snapshot_id: string | null;
  snapshot_revision: string | null;
  origin_feed_id: string | null;
  capture_status: string | null;
  capture_generation: string;
  archived_at: RawTimestamp | null;
  label_ids: string[];
  label_suggestions: string[];
  feedback_prompted_at: RawTimestamp | null;
  lane: string;
  p_like: number | null;
  tier: number | null;
  score_version: string;
  rank_revision: string;
  scored_at: RawTimestamp | null;
  explain: unknown;
};

/**
 * Lock the targets (step 1–2): every id must exist and be accessible, or the whole request is
 * `NOT_FOUND` without revealing which id failed.
 */
async function lockReaders(tx: TenantTx, ids: readonly string[]): Promise<ReaderLock> {
  const { user, prefs, plan } = await lockReaderUser(tx);
  const unique = [...new Set(ids)];
  const articles = await tx.execute<{
    id: string;
    content_revision: string;
    url: string | null;
    title: string;
    story_cluster_id: string | null;
  }>(sql`
    SELECT a.id::text AS id, a.content_revision::text AS content_revision, a.url, a.title,
           a.story_cluster_id::text AS story_cluster_id
      FROM articles a WHERE a.id = ANY(${sql.param(unique)}::bigint[])
     ORDER BY a.id FOR SHARE`);
  const readers = await tx.execute<ReaderSqlRow>(sql`
    SELECT ua.article_id::text AS article_id, ua.state_version::text AS state_version,
           ua.opened_at, ua.read_at, ua.rating, ua.reason, ua.rated_at, ua.dwell_ms,
           ua.bookmarked_at, ua.bookmark_snapshot_id::text AS snapshot_id,
           s.source_revision::text AS snapshot_revision,
           ua.bookmark_origin_feed_id::text AS origin_feed_id,
           ua.bookmark_capture_status AS capture_status,
           ua.bookmark_capture_generation::text AS capture_generation, ua.archived_at,
           ua.label_ids::text[] AS label_ids, ua.label_suggestions::text[] AS label_suggestions,
           ua.feedback_prompted_at, ua.lane, ua.p_like, ua.tier, ua.score_version,
           ua.rank_revision::text AS rank_revision, ua.scored_at, ua.explain
      FROM user_article ua
      LEFT JOIN article_snapshots s ON s.id = ua.bookmark_snapshot_id
     WHERE ua.user_id = ${user}::uuid AND ua.article_id = ANY(${sql.param(unique)}::bigint[])
     ORDER BY ua.article_id FOR UPDATE OF ua`);
  const accessible = await tx.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM articles a
     WHERE a.id = ANY(${sql.param(unique)}::bigint[])
       AND (EXISTS (SELECT 1 FROM feed_items fi
                      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${user}::uuid
                     WHERE fi.article_id = a.id)
            OR EXISTS (SELECT 1 FROM user_article ua
                        WHERE ua.user_id = ${user}::uuid AND ua.article_id = a.id
                          AND ua.bookmarked_at IS NOT NULL))`);
  const allowed = new Set(accessible.rows.map((r) => r.id));
  if (unique.some((id) => !allowed.has(id))) throw new AppError('NOT_FOUND', 'Article not found');
  const rows = new Map(readers.rows.map((r) => [r.article_id, readerRow(r)]));
  return {
    user,
    prefs,
    plan,
    articles: new Map(
      articles.rows.map((a) => [
        a.id,
        {
          articleId: a.id,
          contentRevision: a.content_revision,
          url: a.url,
          title: a.title,
          storyClusterId: a.story_cluster_id,
          row: rows.get(a.id) ?? null,
        },
      ]),
    ),
  };
}

function readerRow(r: ReaderSqlRow): ReaderRow {
  return {
    stateVersion: r.state_version,
    openedAt: toDateOrNull(r.opened_at),
    readAt: toDateOrNull(r.read_at),
    rating: r.rating === 1 || r.rating === -1 ? r.rating : null,
    reason: r.reason,
    ratedAt: toDateOrNull(r.rated_at),
    dwellMs: r.dwell_ms,
    bookmarkedAt: toDateOrNull(r.bookmarked_at),
    snapshotId: r.snapshot_id,
    snapshotRevision: r.snapshot_revision,
    originFeedId: r.origin_feed_id,
    captureStatus: r.capture_status,
    captureGeneration: r.capture_generation,
    archivedAt: toDateOrNull(r.archived_at),
    labelIds: r.label_ids,
    labelSuggestions: r.label_suggestions,
    feedbackPromptedAt: toDateOrNull(r.feedback_prompted_at),
    lane: r.lane,
    pLike: r.p_like,
    tier: r.tier,
    scoreVersion: r.score_version,
    rankRevision: r.rank_revision,
    scoredAt: toDateOrNull(r.scored_at),
    explain: r.explain,
  };
}

function locked(lock: ReaderLock, articleId: string): LockedArticle {
  const article = lock.articles.get(articleId);
  if (article === undefined) throw new AppError('NOT_FOUND', 'Article not found');
  return article;
}

/** The current items for a `STALE_STATE` response (the client shows what is now true). */
async function currentItems(
  tx: TenantTx,
  ids: readonly string[],
  prefs: UserPreferences,
): Promise<ArticleListItem[]> {
  const contexts = await articleContexts(tx, ids);
  return loadArticleItems(tx, contexts, { loadRemoteImages: prefs.loadRemoteImages });
}

async function staleState(
  tx: TenantTx,
  ids: readonly string[],
  prefs: UserPreferences,
  single: boolean,
): Promise<never> {
  const items = await currentItems(tx, ids, prefs);
  throw new AppError('STALE_STATE', 'The article changed since it was displayed', {
    details: single ? { item: items[0] ?? null } : { items },
  });
}

/**
 * Whether a target's fence still holds (step 2). A saved-snapshot fence must name the snapshot bound
 * to the caller's current bookmark, captured at `contentRevision`; otherwise the live revision must
 * equal it. The reader version must equal the displayed one (`'0'` for no row).
 */
function fenceHolds(article: LockedArticle, fence: ReaderFence): boolean {
  const row = article.row;
  if (fence.snapshotId !== undefined) {
    if (
      row === null ||
      row.bookmarkedAt === null ||
      row.snapshotId !== fence.snapshotId ||
      row.snapshotRevision !== fence.contentRevision
    ) {
      return false;
    }
  } else if (article.contentRevision !== fence.contentRevision) {
    return false;
  }
  return (row?.stateVersion ?? '0') === fence.stateVersion;
}

async function lockFenced(
  tx: TenantTx,
  targets: readonly { articleId: string; fence: ReaderFence }[],
  single: boolean,
): Promise<ReaderLock> {
  const lock = await lockReaders(
    tx,
    targets.map((t) => t.articleId),
  );
  const stale = targets.filter((t) => !fenceHolds(locked(lock, t.articleId), t.fence));
  if (stale.length > 0) {
    await staleState(
      tx,
      stale.map((t) => t.articleId),
      lock.prefs,
      single,
    );
  }
  return lock;
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────

interface ReaderPatch {
  openedAt?: Date | null;
  readAt?: Date | null;
  rating?: 1 | -1 | null;
  reason?: RatingReason | null;
  ratedAt?: Date | null;
  dwellMs?: number;
  archivedAt?: Date | null;
  labelIds?: string[];
  labelSuggestions?: string[];
  feedbackPromptedAt?: Date | null;
}

const COLUMNS: Record<keyof ReaderPatch, string> = {
  openedAt: 'opened_at',
  readAt: 'read_at',
  rating: 'rating',
  reason: 'reason',
  ratedAt: 'rated_at',
  dwellMs: 'dwell_ms',
  archivedAt: 'archived_at',
  labelIds: 'label_ids',
  labelSuggestions: 'label_suggestions',
  feedbackPromptedAt: 'feedback_prompted_at',
};

function patchValue(key: keyof ReaderPatch, value: unknown): SQL {
  if (value === null) return sql`NULL`;
  if (value instanceof Date) return sql`${value.toISOString()}::timestamptz`;
  if (key === 'labelIds' || key === 'labelSuggestions') {
    return sql`${sql.param(value as string[])}::bigint[]`;
  }
  if (key === 'rating') return sql`${value as number}::smallint`;
  if (key === 'dwellMs') return sql`${value as number}::int`;
  return sql`${value as string}`;
}

/**
 * Apply a reader patch and increment `state_version` (spec 02 §5.2 "Reader state and feedback
 * agree"); an absent row is created with version 1 (a concurrent rank-cache insert is merged, its
 * version 0 standing for "absent"). Returns the new version.
 */
async function writeReader(
  tx: TenantTx,
  user: string,
  articleId: string,
  patch: ReaderPatch,
): Promise<string> {
  const entries = (Object.keys(patch) as (keyof ReaderPatch)[])
    .filter((key) => patch[key] !== undefined)
    .map((key) => ({ key, column: sql.raw(COLUMNS[key]), value: patchValue(key, patch[key]) }));
  // `label_suggestions` is not insertable by the API (a new row has none anyway).
  const inserted = entries.filter((e) => e.key !== 'labelSuggestions');
  const columns = [
    sql`user_id`,
    sql`article_id`,
    sql`state_version`,
    ...inserted.map((e) => e.column),
  ];
  const values = [
    sql`${user}::uuid`,
    sql`${articleId}::bigint`,
    sql`1`,
    ...inserted.map((e) => e.value),
  ];
  const updates = [
    sql`state_version = user_article.state_version + 1`,
    ...entries.map((e) => sql`${e.column} = ${e.value}`),
  ];
  const result = await tx.execute<{ state_version: string }>(sql`
    INSERT INTO user_article (${sql.join(columns, sql`, `)})
    VALUES (${sql.join(values, sql`, `)})
    ON CONFLICT (user_id, article_id) DO UPDATE SET ${sql.join(updates, sql`, `)}
    RETURNING state_version::text AS state_version`);
  const version = result.rows[0]?.state_version;
  if (version === undefined) throw new Error('reader write returned no row');
  return version;
}

type FeedbackKind =
  | 'rate'
  | 'unrate'
  | 'open'
  | 'read'
  | 'unread'
  | 'dwell'
  | 'prompt_answer'
  | 'bookmark'
  | 'unbookmark'
  | 'label'
  | 'unlabel'
  | 'mark_read'
  | 'hide'
  | 'unhide'
  | 'undo';

async function appendEvent(
  tx: TenantTx,
  user: string,
  articleId: string,
  kind: FeedbackKind,
  value: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
    VALUES (${user}::uuid, ${articleId}::bigint, ${kind}, ${JSON.stringify(value)}::jsonb,
            ${now.toISOString()}::timestamptz)`);
}

const isoOrNull = (date: Date | null | undefined): string | null => date?.toISOString() ?? null;

/** The prior values of the fields `patch` changes, for the undo receipt. */
function beforeOf(row: ReaderRow | null, patch: ReaderPatch): UndoTarget['before'] {
  const before: UndoTarget['before'] = {};
  for (const key of Object.keys(patch) as (keyof ReaderPatch)[]) {
    if (patch[key] === undefined || key === 'dwellMs' || key === 'feedbackPromptedAt') continue;
    switch (key) {
      case 'openedAt':
      case 'readAt':
      case 'ratedAt':
      case 'archivedAt':
        before[key] = isoOrNull(row?.[key]);
        break;
      case 'rating':
        before.rating = row?.rating ?? null;
        break;
      case 'reason':
        before.reason = row?.reason ?? null;
        break;
      case 'labelIds':
      case 'labelSuggestions':
        before[key] = [...(row?.[key] ?? [])];
        break;
    }
  }
  return before;
}

/** The patch that restores an undo target's `before` values. */
function restorePatch(before: UndoTarget['before']): ReaderPatch {
  const patch: ReaderPatch = {};
  const date = (value: BeforeValue | undefined): Date | null =>
    typeof value === 'string' ? new Date(value) : null;
  for (const [key, value] of Object.entries(before) as [ReaderField, BeforeValue][]) {
    switch (key) {
      case 'openedAt':
      case 'readAt':
      case 'ratedAt':
      case 'archivedAt':
        patch[key] = date(value);
        break;
      case 'rating':
        patch.rating = value === 1 || value === -1 ? value : null;
        break;
      case 'reason':
        patch.reason = typeof value === 'string' ? (value as RatingReason) : null;
        break;
      case 'labelIds':
      case 'labelSuggestions':
        patch[key] = Array.isArray(value) ? value : [];
        break;
    }
  }
  return patch;
}

// ── Learning context ───────────────────────────────────────────────────────────────────────────

/** The merged `RankerConfig` (spec 06 §11); an invalid stored override falls back to defaults. */
export async function readRankerConfig(tx: TenantTx): Promise<RankerConfig> {
  const stored = await readStoredSetting(tx, 'ranker.thresholds');
  try {
    return mergeRankerConfig(stored ?? {});
  } catch {
    return mergeRankerConfig({}, DEFAULT_RANKER_CONFIG as unknown as RankerConfig);
  }
}

const learningConsent = (prefs: UserPreferences) => ({
  implicitFeedback: prefs.implicitFeedback,
  implicitNegative: prefs.implicitNegative,
});

/** The ranking the reader saw before the action (spec 06 §8.2 `before`). */
function rankBefore(row: ReaderRow | null): Record<string, unknown> {
  return {
    lane: row?.lane ?? 'new',
    pLike: row?.pLike ?? null,
    tier: row?.tier ?? null,
    scoreVersion: row?.scoreVersion ?? null,
    rankRevision: row?.rankRevision ?? null,
    scoredAt: isoOrNull(row?.scoredAt),
  };
}

interface FeatureCapture {
  features: Record<string, unknown> | null;
  staleAtFeedback: boolean | null;
}

/**
 * The event-time feature snapshot of one article (spec 06 §8.2), built before the action applies.
 * `cards` lists every interest card the user holds that applies to the item — positive and never,
 * unscoped or scoped to an authorized carrier — with its strength now and its current-revision
 * answer (`p: null` when it has no usable answer; `prefilter` is unknown). `values` holds the raw
 * observed inputs and the story group. Without an authorized carrier (no valid inputs) the
 * snapshot is `null`; a rating on an older saved snapshot never borrows current features either.
 */
async function captureFeatures(
  tx: TenantTx,
  user: string,
  article: LockedArticle,
  config: RankerConfig,
  now: Date,
  options: { live: boolean },
): Promise<FeatureCapture> {
  if (!options.live) return { features: null, staleAtFeedback: null };
  const id = article.articleId;
  const stored = await readRatingSettingsLocked(tx);
  const sets = stored.get('question_sets.active');
  const enrichSet = textOrNull(objectField(sets, 'enrich'));
  const matchSet = textOrNull(objectField(sets, 'match'));
  const result = await tx.execute<{
    inference_feed_ids: string[];
    word_count: number | null;
    has_image: boolean;
    has_video: boolean | null;
    body_image_count: number | null;
    lang: string | null;
    author: string | null;
    published_at: RawTimestamp | null;
    first_seen_at: RawTimestamp;
    enrich_engine: string | null;
    media_revision: string;
    story_cluster_id: string | null;
    cluster_size: number | null;
    facets: Record<string, unknown> | null;
  }>(sql`
    WITH inf AS (
      SELECT s.feed_id FROM subscriptions s
        JOIN feed_items fi ON fi.feed_id = s.feed_id AND fi.article_id = ${id}::bigint
        JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
       WHERE s.user_id = ${user}::uuid AND s.inference_mode = 'active'
         AND fi.first_seen_at >= s.inference_activated_at
      UNION
      SELECT r.feed_id FROM analysis_requests r
        JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
        JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                            AND s.inference_mode IN ('training', 'active')
                            AND s.inference_version = r.inference_version
       WHERE r.user_id = ${user}::uuid AND r.article_id = ${id}::bigint
         AND r.status IN ('pending', 'running', 'complete')
         AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS}))
    SELECT coalesce((SELECT array_agg(feed_id::text ORDER BY feed_id) FROM inf), '{}') AS inference_feed_ids,
           a.word_count, a.image_url IS NOT NULL AS has_image, a.has_video, a.body_image_count,
           a.lang, a.author, a.published_at, a.first_seen_at, a.enrich_engine,
           a.media_revision::text AS media_revision, a.story_cluster_id::text AS story_cluster_id,
           sc.size AS cluster_size,
           (SELECT f.features FROM article_facets f
             WHERE f.article_id = a.id AND f.article_revision = a.content_revision
               AND f.question_set_id::text = ${enrichSet}::text
             ORDER BY f.updated_at DESC LIMIT 1) AS facets
      FROM articles a LEFT JOIN story_clusters sc ON sc.id = a.story_cluster_id
     WHERE a.id = ${id}::bigint`);
  const row = result.rows[0];
  if (row === undefined) return { features: null, staleAtFeedback: null };

  const publishedAt = toDateOrNull(row.published_at);
  const firstSeenAt = toDate(row.first_seen_at);
  const origin = Math.min(publishedAt?.getTime() ?? firstSeenAt.getTime(), firstSeenAt.getTime());
  const ageHours = Math.max(0, (now.getTime() - origin) / 3_600_000);
  const timeSensitive = row.facets?.['time_sensitive'];
  const staleAtFeedback =
    typeof timeSensitive === 'number'
      ? timeSensitive >= config.demotion.staleTimeSensitive &&
        ageHours > config.demotion.staleAgeHours
      : null;
  if (row.inference_feed_ids.length === 0) return { features: null, staleAtFeedback };

  const translated =
    row.lang !== null &&
    textOrNull(objectField(stored.get('language_modes'), row.lang)) === 'translate';
  const cards = await tx.execute<{
    id: string;
    strength: Strength;
    p: number | null;
    engine: string | null;
  }>(sql`
    SELECT uc.card_id::text AS id, uc.strength, ca.p, ca.engine
      FROM user_cards uc
      JOIN interest_cards c ON c.id = uc.card_id AND c.kind = 'interest'
      LEFT JOIN card_answers ca ON ca.article_id = ${id}::bigint AND ca.card_id = uc.card_id
                               AND ca.article_revision = ${article.contentRevision}::bigint
                               AND ca.engine <> 'prefilter'
                               AND ca.question_set_sha = (
                                 SELECT qs.sha256 FROM question_sets qs
                                  WHERE qs.id::text = ${matchSet}::text)
                               AND ca.state_variant = ${translated ? 'translated' : 'native'}
     WHERE uc.user_id = ${user}::uuid
       AND (uc.scope_feed_id IS NULL
            OR uc.scope_feed_id::text = ANY(${sql.param(row.inference_feed_ids)}::text[]))
     ORDER BY uc.card_id`);
  const ratingSha = ratingShaOf(stored);
  return {
    staleAtFeedback,
    features: {
      specSha: FEATURE_SNAPSHOT_SPEC_SHA,
      ratingSha,
      cards: cards.rows.map((card) => ({
        id: card.id,
        strength: card.strength,
        p: card.p,
        engine: card.engine,
      })),
      values: {
        facets: row.facets,
        facetsEngine: row.enrich_engine,
        wordCount: row.word_count,
        ageHours,
        lang: row.lang,
        hasImage: row.has_image,
        hasVideo: row.has_video,
        bodyImageCount: row.body_image_count,
        clusterId: row.story_cluster_id,
        clusterSize: row.cluster_size ?? (row.story_cluster_id === null ? 0 : 1),
        sourceFeedId: row.inference_feed_ids[0] ?? null,
        author: row.author,
      },
      sourceManifest: {
        contentRevision: article.contentRevision,
        mediaRevision: row.media_revision,
        inferenceFeedIds: row.inference_feed_ids,
      },
      snapshotAt: now.toISOString(),
    },
  };
}

/**
 * Record `user.learn` after explicit feedback (spec 06 §8.4): once at least `model.retrainEvery`
 * articles have effective explicit rating changes since the last processed cutoff (a bulk change
 * crossing the boundary included; never `n % 10`), or at once with `force` (undo, un-rate,
 * unbookmark). The cutoff is the newest `metrics.feedbackCutoffEventId` of the user's models (M7);
 * without one every explicit rating event counts. The intent is debounced and the handler retrains
 * only when its inputs changed.
 */
async function recordLearnIntent(
  tx: TenantTx,
  user: string,
  outbox: JobSender,
  config: RankerConfig,
  force: boolean,
): Promise<void> {
  if (!force) {
    const result = await tx.execute<{ n: number }>(sql`
      SELECT count(DISTINCT e.article_id)::int AS n FROM feedback_events e
       WHERE e.user_id = ${user}::uuid AND e.kind IN ('rate', 'unrate', 'prompt_answer')
         AND e.id > coalesce((
           SELECT max(CASE WHEN m.metrics ->> 'feedbackCutoffEventId' ~ '^[0-9]{1,18}$'
                           THEN (m.metrics ->> 'feedbackCutoffEventId')::bigint END)
             FROM user_models m WHERE m.user_id = ${user}::uuid), 0)`);
    if ((result.rows[0]?.n ?? 0) < config.model.retrainEvery) return;
  }
  await enqueueLearn(outbox, { userId: user });
}

/** Validate a selected training request for a rated article/revision (spec 08 §5.3). */
async function requireAnalysisRequest(
  tx: TenantTx,
  user: string,
  articleId: string,
  revision: string,
  requestId: string,
): Promise<{ id: string; inputSha: string }> {
  const result = await tx.execute<{ input_sha: string; current: boolean }>(sql`
    SELECT r.input_sha,
           (r.status IN ('pending', 'running', 'complete')
            AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
            AND EXISTS (SELECT 1 FROM subscriptions s
                         WHERE s.user_id = r.user_id AND s.feed_id = r.feed_id
                           AND s.inference_mode IN ('training', 'active')
                           AND s.inference_version = r.inference_version)) AS current
      FROM analysis_requests r
     WHERE r.id = ${requestId}::uuid AND r.user_id = ${user}::uuid
       AND r.article_id = ${articleId}::bigint AND r.article_revision = ${revision}::bigint`);
  const row = result.rows[0];
  if (row === undefined) throw new AppError('NOT_FOUND', 'Analysis request not found');
  if (!row.current) {
    throw new AppError('CONFLICT', 'The analysis request is no longer current', {
      details: { reason: 'obsolete_request' },
    });
  }
  return { id: requestId, inputSha: row.input_sha };
}

async function rankFull(tx: TenantTx, user: string, outbox: JobSender, reason: string) {
  await recordRankIntents(tx, outbox, [user], { reason, full: true });
}

// ── Single-article state actions ───────────────────────────────────────────────────────────────

/**
 * `/read` (spec 08 §5.3): set `read_at`. An individual explicit read records `signalOrigin:
 * 'explicit'`; the list's expand side effect records `'expand'`, which is never negative evidence.
 * A story's seen state changes ranking (`user.rank {full}`).
 */
export async function markArticleRead(
  tx: TenantTx,
  input: ActionInput & { trigger?: 'expand' | undefined },
): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  if (article.row?.readAt != null) return { articleIds: [input.articleId], changed: false };
  const config = await readRankerConfig(tx);
  const origin = input.trigger === 'expand' ? 'expand' : 'explicit';
  const behavioral =
    origin === 'explicit' && lock.prefs.implicitFeedback && lock.prefs.implicitNegative;
  const capture = behavioral
    ? await captureFeatures(tx, lock.user, article, config, input.now, {
        live: input.fence.snapshotId === undefined,
      })
    : { features: null, staleAtFeedback: null };
  const patch: ReaderPatch = { readAt: input.now };
  const before = beforeOf(article.row, patch);
  const version = await writeReader(tx, lock.user, input.articleId, patch);
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'read',
    {
      v: 1,
      signalOrigin: origin,
      learningConsent: learningConsent(lock.prefs),
      before: rankBefore(article.row),
      ...(behavioral ? { features: capture.features } : {}),
    },
    input.now,
  );
  const rank = article.storyClusterId !== null;
  if (rank) await rankFull(tx, lock.user, input.outbox, 'feedback:read');
  return {
    articleIds: [input.articleId],
    changed: true,
    undo: undoReceipt(
      'reader',
      'read',
      [{ articleId: input.articleId, resultVersion: version, before }],
      {
        rankFull: rank,
        // An explicit consented read is an implicit-negative sample; undoing it revokes evidence.
        learn: behavioral,
      },
    ),
  };
}

function undoReceipt(
  kind: UndoReceipt['kind'],
  action: string,
  targets: UndoTarget[],
  effects: UndoReceipt['effects'],
): UndoReceipt {
  return { v: 1, kind, action, targets, effects };
}

/** `/unread`: clear `read_at` and `archived_at`, record `unread`, invalidate story ranking. */
export async function markArticleUnread(tx: TenantTx, input: ActionInput): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  const patch: ReaderPatch = {};
  if (article.row?.readAt != null) patch.readAt = null;
  if (article.row?.archivedAt != null) patch.archivedAt = null;
  if (Object.keys(patch).length === 0) return { articleIds: [input.articleId], changed: false };
  const before = beforeOf(article.row, patch);
  // Clearing `read_at` removes an explicit consented read sample (spec 06 §8.4): force learning.
  const revokesRead =
    patch.readAt === null &&
    (
      await tx.execute<{ revoked: boolean }>(sql`
      SELECT coalesce(
               e.value ->> 'signalOrigin' = 'explicit'
               AND (e.value -> 'learningConsent' ->> 'implicitFeedback') = 'true'
               AND (e.value -> 'learningConsent' ->> 'implicitNegative') = 'true',
               false) AS revoked
        FROM feedback_events e
       WHERE e.user_id = ${lock.user}::uuid AND e.article_id = ${input.articleId}::bigint
         AND e.kind = 'read'
       ORDER BY e.id DESC LIMIT 1`)
    ).rows[0]?.revoked === true;
  const version = await writeReader(tx, lock.user, input.articleId, patch);
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'unread',
    { v: 1, signalOrigin: 'explicit', learningConsent: learningConsent(lock.prefs) },
    input.now,
  );
  const rank = article.storyClusterId !== null || patch.archivedAt !== undefined;
  if (rank) await rankFull(tx, lock.user, input.outbox, 'feedback:unread');
  if (revokesRead) {
    await recordLearnIntent(tx, lock.user, input.outbox, await readRankerConfig(tx), true);
  }
  return {
    articleIds: [input.articleId],
    changed: true,
    undo: undoReceipt(
      'reader',
      'unread',
      [{ articleId: input.articleId, resultVersion: version, before }],
      {
        rankFull: rank,
        learn: revokesRead,
      },
    ),
  };
}

/**
 * `/unhide`: clear only `archived_at`, record `unhide` and rerank. A Never card or a block/mute
 * rule may still hide it; the item's explanation names that rule (spec 08 §5.3).
 */
export async function unhideArticle(tx: TenantTx, input: ActionInput): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  if (article.row?.archivedAt == null) return { articleIds: [input.articleId], changed: false };
  const patch: ReaderPatch = { archivedAt: null };
  const before = beforeOf(article.row, patch);
  const version = await writeReader(tx, lock.user, input.articleId, patch);
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'unhide',
    { v: 1, signalOrigin: 'explicit', learningConsent: learningConsent(lock.prefs) },
    input.now,
  );
  await rankFull(tx, lock.user, input.outbox, 'feedback:unhide');
  return {
    articleIds: [input.articleId],
    changed: true,
    undo: undoReceipt(
      'reader',
      'unhide',
      [{ articleId: input.articleId, resultVersion: version, before }],
      {
        rankFull: true,
        learn: false,
      },
    ),
  };
}

/** A safe original URL to open: absolute `http(s)` only. */
export function isSafeOriginalUrl(url: string | null): url is string {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * `/open`: the reader opened the original URL. Requires a safe URL (`400` otherwise); sets
 * `opened_at` and `read_at`, records `open` (with behavioral features only under the
 * implicit-feedback opt-in). Not undoable.
 */
export async function openArticle(tx: TenantTx, input: ActionInput): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  if (!isSafeOriginalUrl(article.url)) {
    throw new AppError('VALIDATION_FAILED', 'The article has no original URL to open', {
      details: { reason: 'no_url' },
    });
  }
  const config = await readRankerConfig(tx);
  const behavioral = lock.prefs.implicitFeedback;
  const capture = behavioral
    ? await captureFeatures(tx, lock.user, article, config, input.now, {
        live: input.fence.snapshotId === undefined,
      })
    : { features: null, staleAtFeedback: null };
  const wasRead = article.row?.readAt != null;
  await writeReader(tx, lock.user, input.articleId, {
    openedAt: input.now,
    ...(wasRead ? {} : { readAt: input.now }),
  });
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'open',
    {
      v: 1,
      signalOrigin: 'explicit',
      learningConsent: learningConsent(lock.prefs),
      before: rankBefore(article.row),
      ...(behavioral ? { features: capture.features } : {}),
    },
    input.now,
  );
  if (!wasRead && article.storyClusterId !== null) {
    await rankFull(tx, lock.user, input.outbox, 'feedback:open');
  }
  return { articleIds: [input.articleId], changed: true };
}

/** Dwell-prompt sampling rates of `prefs.feedbackPrompt` (spec 06 §10). */
const PROMPT_RATE: Record<UserPreferences['feedbackPrompt'], number> = {
  often: 1 / 5,
  occasionally: 1 / 20,
  never: 0,
};
/** A "Did you like it?" prompt needs at least this much dwell (spec 06 §10). */
export const PROMPT_MIN_DWELL_MS = 6000;

/** Deterministic uniform sample in [0, 1) of (user, article, open session). */
export function promptSample(user: string, articleId: string, openedAt: Date): number {
  const digest = createHash('sha256')
    .update(`${user}:${articleId}:${openedAt.toISOString()}`)
    .digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/**
 * `/dwell` (spec 08 §5.3, spec 06 §10): only with the implicit-feedback opt-in — without it the
 * current item is returned with `prompt:false` and nothing is stored. Requires a prior open and
 * clamps `ms` to the time elapsed since it; stores `max(existing, ms)` and a `dwell` event. Answers
 * `prompt:true` at most once per article (setting `feedback_prompted_at` under the row lock) when
 * the dwell is ≥ 6 s, the article is unrated and either in Maybe or sampled for this open session.
 */
export async function recordDwell(
  tx: TenantTx,
  input: ActionInput & { ms: number },
): Promise<ActionResult & { prompt: boolean }> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  if (!lock.prefs.implicitFeedback) {
    return { articleIds: [input.articleId], changed: false, prompt: false };
  }
  const row = article.row;
  if (row?.openedAt == null) {
    throw new AppError('CONFLICT', 'The article was not opened', {
      details: { reason: 'not_opened' },
    });
  }
  const elapsed = Math.max(0, input.now.getTime() - row.openedAt.getTime());
  const ms = Math.min(input.ms, elapsed);
  const dwellMs = Math.max(row.dwellMs ?? 0, ms);
  const rate = PROMPT_RATE[lock.prefs.feedbackPrompt];
  const eligibleLane = (await articleContexts(tx, [input.articleId]))[0]?.eligible === true;
  const prompt =
    rate > 0 &&
    dwellMs >= PROMPT_MIN_DWELL_MS &&
    row.rating === null &&
    row.feedbackPromptedAt === null &&
    ((eligibleLane && row.lane === 'maybe') ||
      promptSample(lock.user, input.articleId, row.openedAt) < rate);
  const config = await readRankerConfig(tx);
  const capture = await captureFeatures(tx, lock.user, article, config, input.now, {
    live: input.fence.snapshotId === undefined,
  });
  await writeReader(tx, lock.user, input.articleId, {
    dwellMs,
    ...(prompt ? { feedbackPromptedAt: input.now } : {}),
  });
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'dwell',
    {
      v: 1,
      ms,
      dwellMs,
      openedAt: row.openedAt.toISOString(),
      prompt,
      signalOrigin: 'explicit',
      learningConsent: learningConsent(lock.prefs),
      before: rankBefore(row),
      features: capture.features,
    },
    input.now,
  );
  return { articleIds: [input.articleId], changed: true, prompt };
}

// ── Ratings ─────────────────────────────────────────────────────────────────────────────────────

export interface ExampleSuggestionValue {
  cardId: string;
  side: 'yes' | 'no';
}

/** The inputs of the ranker's pure `suggestExample` (spec 06 §10), minus the trigger. */
export interface ExampleSuggestionContext {
  rating: 1 | -1 | null;
  reason: RatingReason | null;
  ratedContentRevision: string;
  explain: Explain | null;
  cards: {
    cardId: string;
    strength: Strength;
    isPrivateFork: boolean;
    examplesYes: string[];
    examplesNo: string[];
  }[];
  exampleText: string | null;
  enabled: boolean;
  forkCount: number;
  maxForks: number;
  recent: { cardId: string; at: Date }[];
  now: Date;
  config: RankerConfig;
}

/** Earlier suggestions are counted for 7 days (spec 06 §10). */
const SUGGESTION_LOOKBACK_DAYS = 7;

async function suggestionContext(
  tx: TenantTx,
  lock: ReaderLock,
  article: LockedArticle,
  input: { rating: 1 | -1 | null; reason: RatingReason | null; revision: string; now: Date },
  config: RankerConfig,
): Promise<ExampleSuggestionContext> {
  const cards = await tx.execute<{
    id: string;
    strength: Strength;
    visibility: string;
    body: unknown;
  }>(sql`
    SELECT uc.card_id::text AS id, uc.strength, c.visibility, c.body
      FROM user_cards uc JOIN interest_cards c ON c.id = uc.card_id AND c.kind = 'interest'
     WHERE uc.user_id = ${lock.user}::uuid ORDER BY uc.card_id`);
  const recent = await tx.execute<{ card_id: string; created_at: RawTimestamp }>(sql`
    SELECT e.value -> 'exampleSuggestion' ->> 'cardId' AS card_id, e.created_at
      FROM feedback_events e
     WHERE e.user_id = ${lock.user}::uuid AND e.kind = 'rate'
       AND jsonb_typeof(e.value -> 'exampleSuggestion') = 'object'
       AND e.created_at > ${input.now.toISOString()}::timestamptz
                          - make_interval(days => ${SUGGESTION_LOOKBACK_DAYS})`);
  // Only an eligible (global view) explanation of the rated revision can explain the rating.
  const eligible = (await articleContexts(tx, [article.articleId]))[0]?.eligible === true;
  const parsed = eligible ? ExplainSchema.safeParse(article.row?.explain) : null;
  return {
    rating: input.rating,
    reason: input.reason,
    ratedContentRevision: input.revision,
    explain: parsed?.success === true ? parsed.data : null,
    cards: cards.rows.map((card) => {
      const body = parseCardBody(card.body);
      return {
        cardId: card.id,
        strength: card.strength,
        isPrivateFork: card.visibility === 'private',
        examplesYes: body.examplesYes,
        examplesNo: body.examplesNo,
      };
    }),
    exampleText: exampleFromArticleTitle(article.title),
    enabled: lock.prefs.exampleSuggestions,
    forkCount: cards.rows.filter((card) => card.visibility === 'private').length,
    maxForks: planLimits(lock.plan).maxForks,
    recent: recent.rows
      .filter((r) => typeof r.card_id === 'string')
      .map((r) => ({ cardId: r.card_id, at: toDate(r.created_at) })),
    now: input.now,
    config,
  };
}

interface RatingTarget {
  articleId: string;
  fence: ReaderFence;
  rating: 1 | -1 | null;
  reason: RatingReason | null;
  hide: boolean;
  analysisRequestId?: string | undefined;
  /** The item came from the calibration round (spec 06 §10). */
  selection?: 'calibration' | undefined;
}

/** Apply one rating under an existing lock; returns its undo target. */
async function applyRating(
  tx: TenantTx,
  lock: ReaderLock,
  target: RatingTarget,
  options: {
    kind: 'rate' | 'prompt_answer';
    now: Date;
    config: RankerConfig;
    suggestion?: ExampleSuggestionValue | null;
  },
): Promise<UndoTarget> {
  const article = locked(lock, target.articleId);
  const revision = target.fence.contentRevision;
  const request =
    target.analysisRequestId === undefined
      ? null
      : await requireAnalysisRequest(
          tx,
          lock.user,
          target.articleId,
          revision,
          target.analysisRequestId,
        );
  // Event-time context first: the snapshot describes what the reader rated, before the change.
  const capture = await captureFeatures(tx, lock.user, article, options.config, options.now, {
    live: revision === article.contentRevision,
  });
  const ratingSha =
    request !== null && capture.features === null
      ? ratingShaOf(await readRatingSettingsLocked(tx))
      : null;
  const row = article.row;
  const patch: ReaderPatch =
    target.rating === null
      ? { rating: null, reason: null, ratedAt: null }
      : { rating: target.rating, reason: target.reason, ratedAt: options.now };
  if (target.rating !== null && lock.prefs.markReadOnRate && row?.readAt == null) {
    patch.readAt = options.now;
  }
  if (target.hide && row?.archivedAt == null) patch.archivedAt = options.now;
  const before = beforeOf(row, patch);
  const version = await writeReader(tx, lock.user, target.articleId, patch);
  const kind =
    options.kind === 'prompt_answer' ? 'prompt_answer' : target.rating === null ? 'unrate' : 'rate';
  await appendEvent(
    tx,
    lock.user,
    target.articleId,
    kind,
    {
      v: 1,
      rating: target.rating,
      reason: target.reason,
      hide: target.hide,
      contentRevision: revision,
      ...(target.fence.snapshotId === undefined ? {} : { snapshotId: target.fence.snapshotId }),
      ...(request === null ? {} : { analysisRequestId: request.id, inputSha: request.inputSha }),
      ...(ratingSha === null ? {} : { ratingSha }),
      signalOrigin: 'explicit',
      learningConsent: learningConsent(lock.prefs),
      before: rankBefore(row),
      staleAtFeedback: capture.staleAtFeedback,
      features: capture.features,
      ...(options.suggestion == null ? {} : { exampleSuggestion: options.suggestion }),
      ...(target.selection === undefined
        ? {}
        : { selection: { method: target.selection, sourceLane: row?.lane ?? 'new' } }),
    },
    options.now,
  );
  return { articleId: target.articleId, resultVersion: version, before };
}

/**
 * `/rating` (spec 08 §5.3): set the explicit rating (`null` clears rating, reason and `rated_at`
 * and leaves read/archive alone); a non-null rating marks read under `markReadOnRate`; `hide:true`
 * archives. The event carries the frozen feature snapshot and, when `suggest` returns one, the
 * example suggestion (spec 06 §10), which the response also returns. Reasons/counts change
 * ranking (`user.rank {full}`); learning follows spec 06 §8.4 (un-rating forces it).
 */
export async function rateArticle(
  tx: TenantTx,
  input: ActionInput & {
    rating: 1 | -1 | null;
    reason: RatingReason | null;
    hide: boolean;
    analysisRequestId?: string | undefined;
    /** Set when the rated item came from `GET /articles/calibration` (spec 06 §10). */
    selection?: 'calibration' | undefined;
    suggest?: (context: ExampleSuggestionContext) => ExampleSuggestionValue | null;
  },
): Promise<ActionResult & { exampleSuggestion: ExampleSuggestionValue | null }> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  const config = await readRankerConfig(tx);
  const reason = input.rating === -1 ? input.reason : null;
  const suggestion =
    input.suggest === undefined
      ? null
      : input.suggest(
          await suggestionContext(
            tx,
            lock,
            article,
            { rating: input.rating, reason, revision: input.fence.contentRevision, now: input.now },
            config,
          ),
        );
  const target = await applyRating(
    tx,
    lock,
    { ...input, reason },
    { kind: 'rate', now: input.now, config, suggestion },
  );
  await rankFull(tx, lock.user, input.outbox, 'feedback:rating');
  await recordLearnIntent(tx, lock.user, input.outbox, config, input.rating === null);
  return {
    articleIds: [input.articleId],
    changed: true,
    exampleSuggestion: suggestion,
    undo: undoReceipt('reader', 'rating', [target], { rankFull: true, learn: true }),
  };
}

/** `/prompt-answer`: stored as a rating (`liked ? 1 : -1`), recorded as `prompt_answer`. */
export async function answerPrompt(
  tx: TenantTx,
  input: ActionInput & { liked: boolean; analysisRequestId?: string | undefined },
): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  const config = await readRankerConfig(tx);
  const target = await applyRating(
    tx,
    lock,
    {
      articleId: input.articleId,
      fence: input.fence,
      rating: input.liked ? 1 : -1,
      reason: null,
      hide: false,
      analysisRequestId: input.analysisRequestId,
    },
    { kind: 'prompt_answer', now: input.now, config },
  );
  await rankFull(tx, lock.user, input.outbox, 'feedback:prompt');
  await recordLearnIntent(tx, lock.user, input.outbox, config, false);
  return {
    articleIds: [input.articleId],
    changed: true,
    undo: undoReceipt('reader', 'prompt_answer', [target], { rankFull: true, learn: true }),
  };
}

/**
 * `/articles/rate-bulk`: one transaction with single-rating semantics per target (fences, feature
 * snapshots, events), one coalesced rank and learn intent, all-or-nothing. No example suggestions.
 */
export async function rateArticlesBulk(
  tx: TenantTx,
  input: {
    targets: { articleId: string; fence: ReaderFence; analysisRequestId?: string | undefined }[];
    rating: 1 | -1 | null;
    now: Date;
    outbox: JobSender;
  },
): Promise<ActionResult> {
  const lock = await lockFenced(tx, input.targets, false);
  const config = await readRankerConfig(tx);
  const sorted = [...input.targets].sort((a, b) => compareIds(a.articleId, b.articleId));
  const targets: UndoTarget[] = [];
  for (const target of sorted) {
    targets.push(
      await applyRating(
        tx,
        lock,
        { ...target, rating: input.rating, reason: null, hide: false },
        { kind: 'rate', now: input.now, config },
      ),
    );
  }
  await rankFull(tx, lock.user, input.outbox, 'feedback:rating');
  await recordLearnIntent(tx, lock.user, input.outbox, config, input.rating === null);
  return {
    articleIds: input.targets.map((t) => t.articleId),
    changed: true,
    undo: undoReceipt('reader', 'rate_bulk', targets, { rankFull: true, learn: true }),
  };
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ── Bulk mark-read ─────────────────────────────────────────────────────────────────────────────

/**
 * `/articles/mark-read` with explicit targets (≤ 500, every fence checked, all-or-nothing), or the
 * materialized ids of a confirmed filter (`fences: false`; the caller compared its dataset version
 * under the user lock). Sets `read_at` where unset and records `mark_read` with `signalOrigin:
 * 'bulk_mark_read'` — housekeeping, never negative evidence, so no features. One full rank when a
 * story is affected.
 */
export async function markArticlesRead(
  tx: TenantTx,
  input: {
    targets: { articleId: string; fence: ReaderFence | null }[];
    now: Date;
    outbox: JobSender;
  },
): Promise<ActionResult & { count: number }> {
  const fenced = input.targets.flatMap((t) =>
    t.fence === null ? [] : [{ articleId: t.articleId, fence: t.fence }],
  );
  const lock =
    fenced.length === input.targets.length && fenced.length > 0
      ? await lockFenced(tx, fenced, false)
      : await lockReaders(
          tx,
          input.targets.map((t) => t.articleId),
        );
  const ids = [...new Set(input.targets.map((t) => t.articleId))].sort(compareIds);
  const targets: UndoTarget[] = [];
  let rank = false;
  for (const id of ids) {
    const article = locked(lock, id);
    if (article.row?.readAt != null) continue;
    const patch: ReaderPatch = { readAt: input.now };
    const before = beforeOf(article.row, patch);
    const version = await writeReader(tx, lock.user, id, patch);
    await appendEvent(
      tx,
      lock.user,
      id,
      'mark_read',
      { v: 1, signalOrigin: 'bulk_mark_read', learningConsent: learningConsent(lock.prefs) },
      input.now,
    );
    targets.push({ articleId: id, resultVersion: version, before });
    rank ||= article.storyClusterId !== null;
  }
  if (rank) await rankFull(tx, lock.user, input.outbox, 'feedback:mark-read');
  return {
    articleIds: ids,
    changed: targets.length > 0,
    count: targets.length,
    ...(targets.length === 0
      ? {}
      : { undo: undoReceipt('reader', 'mark_read', targets, { rankFull: rank, learn: false }) }),
  };
}

// ── Bookmarks ───────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /bookmark` (spec 08 §5.3, spec 02 §6): `capture_bookmark_snapshot` binds the stored trusted
 * content of the current revision (or the excerpt as a partial snapshot plus a local
 * `article.capture-bookmark` intent) under the chosen owned display feed; no inference demand. The
 * reader version advances once and a `bookmark` event (an interest signal, with its feature
 * snapshot) is appended. An existing bookmark is left as it is.
 */
export async function bookmarkArticle(
  tx: TenantTx,
  input: ActionInput & { mediaPolicyFeedId?: string | undefined },
): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  if (article.row?.bookmarkedAt != null) return { articleIds: [input.articleId], changed: false };
  const config = await readRankerConfig(tx);
  const capture = await captureFeatures(tx, lock.user, article, config, input.now, {
    live: input.fence.snapshotId === undefined,
  });
  const bound = await tx.execute<{ snapshot_id: string | null; capture_status: string }>(sql`
    SELECT snapshot_id::text AS snapshot_id, capture_status
      FROM capture_bookmark_snapshot(${input.articleId}::bigint,
                                     ${input.mediaPolicyFeedId ?? null}::bigint)`);
  const version = await writeReader(tx, lock.user, input.articleId, {});
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'bookmark',
    {
      v: 1,
      snapshotId: bound.rows[0]?.snapshot_id ?? null,
      captureStatus: bound.rows[0]?.capture_status ?? null,
      contentRevision: input.fence.contentRevision,
      signalOrigin: 'explicit',
      learningConsent: learningConsent(lock.prefs),
      before: rankBefore(article.row),
      staleAtFeedback: capture.staleAtFeedback,
      features: capture.features,
    },
    input.now,
  );
  return {
    articleIds: [input.articleId],
    changed: true,
    undo: undoReceipt(
      'bookmark',
      'bookmark',
      [{ articleId: input.articleId, resultVersion: version, before: {} }],
      { rankFull: false, learn: true },
    ),
  };
}

/**
 * `DELETE /bookmark`: `clear_bookmark_snapshot` advances the capture generation (late captures are
 * fenced) and returns the previous snapshot, which `pinUnbookmark` pins for the undo window once the
 * receipt exists. Removing bookmark evidence records `user.learn`.
 */
export async function unbookmarkArticle(
  tx: TenantTx,
  input: ActionInput,
): Promise<ActionResult & { pinSnapshotId: string | null }> {
  const lock = await lockFenced(tx, [input], true);
  const article = locked(lock, input.articleId);
  const row = article.row;
  if (row?.bookmarkedAt == null) {
    return { articleIds: [input.articleId], changed: false, pinSnapshotId: null };
  }
  const cleared = await tx.execute<{ previous_snapshot_id: string | null }>(sql`
    SELECT previous_snapshot_id::text AS previous_snapshot_id
      FROM clear_bookmark_snapshot(${input.articleId}::bigint)`);
  const previous = cleared.rows[0]?.previous_snapshot_id ?? null;
  const version = await writeReader(tx, lock.user, input.articleId, {});
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'unbookmark',
    {
      v: 1,
      snapshotId: previous,
      signalOrigin: 'explicit',
      learningConsent: learningConsent(lock.prefs),
    },
    input.now,
  );
  const config = await readRankerConfig(tx);
  await recordLearnIntent(tx, lock.user, input.outbox, config, true);
  return {
    articleIds: [input.articleId],
    changed: true,
    pinSnapshotId: previous,
    undo: {
      ...undoReceipt(
        'unbookmark',
        'unbookmark',
        [{ articleId: input.articleId, resultVersion: version, before: {} }],
        { rankFull: false, learn: true },
      ),
      articleId: input.articleId,
      stateVersion: version,
      prior: {
        bookmarkedAt: row.bookmarkedAt.toISOString(),
        originFeedId: row.originFeedId,
        captureStatus: row.captureStatus ?? 'partial',
      },
    },
  };
}

/** Pin the unbookmarked snapshot to the saved receipt until the undo deadline (spec 02 §3.5). */
export async function pinUnbookmark(
  tx: TenantTx,
  input: { mutationId: string; snapshotId: string; now: Date },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO bookmark_snapshot_pins (user_id, mutation_id, snapshot_id, expires_at)
    VALUES (${tenantUserId(tx)}::uuid, ${input.mutationId}::uuid, ${input.snapshotId}::bigint,
            ${new Date(input.now.getTime() + UNDO_WINDOW_MS).toISOString()}::timestamptz)
    ON CONFLICT DO NOTHING`);
}

/**
 * `/bookmark/retry-capture`: an explicit local recapture of an owned `partial`/`failed` bookmark at
 * the displayed capture generation (else `STALE_STATE`). `capture_bookmark_snapshot` keeps the
 * bookmark's origin, advances the generation (fencing older capture jobs) and records the local
 * capture intent; no classification or translation is requested.
 */
export async function retryBookmarkCapture(
  tx: TenantTx,
  input: ActionInput & { captureGeneration: string },
): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  const row = locked(lock, input.articleId).row;
  if (row?.bookmarkedAt == null) throw new AppError('NOT_FOUND', 'Bookmark not found');
  if (row.captureGeneration !== input.captureGeneration) {
    await staleState(tx, [input.articleId], lock.prefs, true);
  }
  if (row.captureStatus !== 'partial' && row.captureStatus !== 'failed') {
    throw new AppError('CONFLICT', 'Only a partial or failed capture can be retried', {
      details: { reason: 'not_retryable' },
    });
  }
  await tx.execute(sql`
    SELECT 1 FROM capture_bookmark_snapshot(${input.articleId}::bigint, NULL::bigint)`);
  await writeReader(tx, lock.user, input.articleId, {});
  return { articleIds: [input.articleId], changed: true };
}

// ── Labels ──────────────────────────────────────────────────────────────────────────────────────

async function requireHeldLabel(tx: TenantTx, user: string, labelId: string): Promise<void> {
  const result = await tx.execute(sql`
    SELECT 1 FROM user_labels WHERE user_id = ${user}::uuid AND card_id = ${labelId}::bigint
       FOR KEY SHARE`);
  if (result.rows.length === 0) throw new AppError('NOT_FOUND', 'Label not found');
}

/**
 * `POST /articles/:id/labels` (spec 08 §5.3, spec 05 §5.1): add a held label to `label_ids` and drop
 * it from `label_suggestions`; a neutral `label` event — no preference signal, no features, no learn
 * or card change.
 */
export async function labelArticle(
  tx: TenantTx,
  input: ActionInput & { labelId: string },
): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  await requireHeldLabel(tx, lock.user, input.labelId);
  const row = locked(lock, input.articleId).row;
  if (row?.labelIds.includes(input.labelId) === true) {
    return { articleIds: [input.articleId], changed: false };
  }
  const patch: ReaderPatch = { labelIds: [...(row?.labelIds ?? []), input.labelId] };
  if (row?.labelSuggestions.includes(input.labelId) === true) {
    patch.labelSuggestions = row.labelSuggestions.filter((id) => id !== input.labelId);
  }
  const before = beforeOf(row, patch);
  const version = await writeReader(tx, lock.user, input.articleId, patch);
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'label',
    { v: 1, labelId: input.labelId, signalOrigin: 'explicit' },
    input.now,
  );
  return {
    articleIds: [input.articleId],
    changed: true,
    undo: undoReceipt(
      'reader',
      'label',
      [{ articleId: input.articleId, resultVersion: version, before }],
      {
        rankFull: false,
        learn: false,
      },
    ),
  };
}

/** `DELETE /articles/:id/labels/:labelId`: remove a held label and record `unlabel`. */
export async function unlabelArticle(
  tx: TenantTx,
  input: ActionInput & { labelId: string },
): Promise<ActionResult> {
  const lock = await lockFenced(tx, [input], true);
  await requireHeldLabel(tx, lock.user, input.labelId);
  const row = locked(lock, input.articleId).row;
  if (row?.labelIds.includes(input.labelId) !== true) {
    return { articleIds: [input.articleId], changed: false };
  }
  const patch: ReaderPatch = { labelIds: row.labelIds.filter((id) => id !== input.labelId) };
  const before = beforeOf(row, patch);
  const version = await writeReader(tx, lock.user, input.articleId, patch);
  await appendEvent(
    tx,
    lock.user,
    input.articleId,
    'unlabel',
    { v: 1, labelId: input.labelId, signalOrigin: 'explicit' },
    input.now,
  );
  return {
    articleIds: [input.articleId],
    changed: true,
    undo: undoReceipt(
      'reader',
      'unlabel',
      [{ articleId: input.articleId, resultVersion: version, before }],
      {
        rankFull: false,
        learn: false,
      },
    ),
  };
}

// ── Mute story ──────────────────────────────────────────────────────────────────────────────────

/**
 * `/mute-story` (spec 08 §5.3): give the article a story cluster when it has none (under the
 * article's row lock), then create the `mute_story` rule expiring after `days` through
 * `createUserRule` (the `POST /rules` path: live-rule quota `maxRules` under the user lock, an
 * existing live mute of the story is extended rather than duplicated, `user.rank {full}`).
 */
export async function muteArticleStory(
  tx: TenantTx,
  input: { articleId: string; days: 1 | 3 | 7 | 30 },
): Promise<UserRule> {
  await lockReaders(tx, [input.articleId]);
  const current = await tx.execute<{ story_cluster_id: string | null }>(sql`
    SELECT story_cluster_id::text AS story_cluster_id FROM articles
     WHERE id = ${input.articleId}::bigint FOR NO KEY UPDATE`);
  let clusterId = current.rows[0]?.story_cluster_id ?? null;
  if (clusterId === null) {
    const created = await tx.execute<{ id: string }>(sql`
      INSERT INTO story_clusters (representative_article_id, size)
      VALUES (${input.articleId}::bigint, 1) RETURNING id::text AS id`);
    clusterId = created.rows[0]?.id ?? null;
    if (clusterId === null) throw new Error('story cluster insert returned no id');
    await tx.execute(sql`
      UPDATE articles SET story_cluster_id = ${clusterId}::bigint
       WHERE id = ${input.articleId}::bigint`);
  }
  const { rule } = await createUserRule(tx, {
    kind: 'mute_story',
    value: clusterId,
    expiresInDays: input.days,
  });
  return rule;
}

// ── Undo ────────────────────────────────────────────────────────────────────────────────────────

function parseUndoReceipt(raw: unknown): UndoReceipt | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const receipt = raw as Partial<UndoReceipt>;
  if (receipt.v !== 1 || !Array.isArray(receipt.targets) || receipt.effects === undefined)
    return null;
  if (receipt.kind !== 'reader' && receipt.kind !== 'bookmark' && receipt.kind !== 'unbookmark') {
    return null;
  }
  const valid = receipt.targets.every(
    (t) =>
      typeof t === 'object' &&
      typeof t.articleId === 'string' &&
      typeof t.resultVersion === 'string' &&
      typeof t.before === 'object',
  );
  return valid ? (receipt as UndoReceipt) : null;
}

/**
 * `/articles/undo` (spec 08 §5.4): restore exactly the fields the original mutation changed, as
 * one atomic operation. Accepted within 10 minutes for the caller's own, not-yet-undone receipt
 * when every target still has the version that mutation produced and is still accessible;
 * otherwise `STALE_STATE` (newer changes are kept) or `CONFLICT` (expired, already undone, not
 * undoable). Bookmark receipts restore through `clear_bookmark_snapshot` /
 * `restore_bookmark_snapshot` (exact snapshot and origin, advancing the capture generation).
 * Versions advance, an `undo` event references the original mutation, the same rank/learn
 * invalidation is requested, and the receipt is marked undone.
 */
export async function undoArticleMutation(
  tx: TenantTx,
  input: { mutationId: string; now: Date; outbox: JobSender },
): Promise<ActionResult & { count: number }> {
  const receipt = await lockMutationForUndo(tx, input.mutationId);
  if (receipt === null) throw new AppError('NOT_FOUND', 'Mutation not found');
  const undo = parseUndoReceipt(receipt.undo);
  if (undo === null) {
    throw new AppError('CONFLICT', 'This mutation cannot be undone', {
      details: { reason: 'not_undoable' },
    });
  }
  if (undo.undoneAt !== undefined) {
    throw new AppError('CONFLICT', 'This mutation was already undone', {
      details: { reason: 'already_undone' },
    });
  }
  if (input.now.getTime() - receipt.createdAt.getTime() > UNDO_WINDOW_MS) {
    throw new AppError('CONFLICT', 'The undo window has passed', {
      details: { reason: 'expired' },
    });
  }
  const ids = undo.targets.map((t) => t.articleId);
  let lock: ReaderLock;
  try {
    lock = await lockReaders(tx, ids);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      throw new AppError('STALE_STATE', 'An article is no longer accessible', {
        details: { items: [] },
      });
    }
    throw error;
  }
  const changed = undo.targets.filter(
    (t) => (locked(lock, t.articleId).row?.stateVersion ?? '0') !== t.resultVersion,
  );
  if (changed.length > 0) {
    await staleState(
      tx,
      changed.map((t) => t.articleId),
      lock.prefs,
      false,
    );
  }
  const sorted = [...undo.targets].sort((a, b) => compareIds(a.articleId, b.articleId));
  for (const target of sorted) {
    if (undo.kind === 'bookmark') {
      await tx.execute(sql`SELECT 1 FROM clear_bookmark_snapshot(${target.articleId}::bigint)`);
    } else if (undo.kind === 'unbookmark') {
      await tx.execute(sql`
        SELECT 1 FROM restore_bookmark_snapshot(${target.articleId}::bigint,
                                                ${input.mutationId}::uuid)`);
    }
    await writeReader(tx, lock.user, target.articleId, restorePatch(target.before));
    await appendEvent(
      tx,
      lock.user,
      target.articleId,
      'undo',
      {
        v: 1,
        mutationId: input.mutationId,
        action: undo.action,
        restored: Object.keys(target.before),
        signalOrigin: 'explicit',
        learningConsent: learningConsent(lock.prefs),
      },
      input.now,
    );
  }
  if (undo.effects.rankFull) await rankFull(tx, lock.user, input.outbox, 'feedback:undo');
  if (undo.effects.learn) {
    await recordLearnIntent(tx, lock.user, input.outbox, await readRankerConfig(tx), true);
  }
  await updateMutationUndo(tx, input.mutationId, { ...undo, undoneAt: input.now.toISOString() });
  return { articleIds: ids, changed: true, count: ids.length };
}
