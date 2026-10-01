import {
  ExplainSchema,
  RANK_WINDOW_DAYS,
  effectiveImagesAllowed,
  type ArticleAnalysis,
  type ArticleCluster,
  type ArticleDetail,
  type ArticleListItem,
  type ArticleStatus,
  type ArticleViewLane,
  type BookmarkCapture,
  type BookmarkSnapshot,
  type Explain,
  type ImagePolicy,
  type Lane,
  type LaneUnreadCounts,
  type RatingReason,
  type TopReason,
} from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * The reader's article views (spec 08 §5.1–5.2, spec 06 §6.4, §10): list, counts, detail and the
 * calibration round, plus the per-subscription unread counts of `GET /subscriptions`.
 *
 * Every view is one query builder, evaluated in a single statement so a page and its digest are
 * consistent:
 * 1. **Scope** (`vs`): the caller's subscriptions in the view's feed/folder scope. A row is
 *    `listable` when its feed may supply candidates (hidden feeds only in a feed view or the hidden
 *    lane); every in-scope row may authorize inference.
 * 2. **Candidates** (`carried`): articles carried by a listable feed whose arrival — the latest
 *    `feed_items.first_seen_at` among those carriers at or before `asOf` — is within the fixed
 *    `RANK_WINDOW_DAYS`; or, for bookmarks, every bookmarked article.
 * 3. **Demand projection** (`proj`, spec 06 §6.4): a row is `eligible` when an in-scope carrier is an
 *    active subscription's arrival at/after its activation, or a current selected analysis request
 *    of an in-scope training/active subscription covers its revision (spec 05 §1.1). An ineligible
 *    row is neutral: lane `new` (or `hidden` when the stored result came from an explicit hide/mute
 *    rule, which the ranker applies before admission), no P, tier or suggestions, and no folding.
 * 4. **Folding**: foldable rows (eligible, clustered, carried by a feed with `allow_duplicates =
 *    false`) of one story collapse into their best visible member, before the lane filter.
 * 5. Lane, status and tier filters; sort; keyset pagination.
 */

/** The selected-request window of spec 05 §1.1 (also used by the rank handler). */
const SELECTION_DAYS = SELECTION_WINDOW_DAYS;

/** A view's feed/folder/label scope. Both a feed and a folder intersect. */
export interface ArticleScope {
  feedId?: string | undefined;
  folder?: string | undefined;
  labelId?: string | undefined;
}

/** Sort orders: `uncertainty` is the Maybe lane's `|P − 0.5|` order (spec 06 §10). */
export type ArticleListSort = 'score' | 'uncertainty' | 'date';

/** The sort-key tuple of a list row: `(k1 DESC, k2 DESC, id DESC)`. */
export interface ArticleListKey {
  k1: number;
  k2: string;
  id: string;
}

/** What a list row contributes to its item besides the stored state. */
export interface ArticleContext {
  articleId: string;
  /** Whether this view may show inference for the row (spec 06 §6.4). */
  eligible: boolean;
  /** The display feed: the requested feed, else the smallest in-scope subscribed carrier. */
  displayFeedId: string | null;
  /** The view's arrival (latest in-scope carrier arrival; the article's own when none). */
  arrival: Date;
  cluster: ArticleCluster | null;
}

export interface ArticleViewInput {
  scope: ArticleScope;
  lane: ArticleViewLane;
  status: ArticleStatus;
  /** `minTier` for `for_you`/`maybe` (also inside `all`). */
  minTier: number;
  asOf: Date;
  /** `scoreVersion()` of the current `ranker.settings_version` (spec 06 §7). */
  scoreVersion: string;
}

type ViewMode = { kind: 'single'; scope: ArticleScope; listHidden: boolean } | { kind: 'perFeed' };

const HIDE_RULE_PATTERN = '^(mute_keyword:|mute_story$|block_feed$|block_domain$|block_author$)';
const HIDE_RULE = new RegExp(HIDE_RULE_PATTERN);

/** Microseconds since the epoch of a timestamp expression, as an exact bigint. */
const micros = (expr: SQL): SQL => sql`(extract(epoch FROM ${expr}) * 1000000)::bigint`;

function viewScope(user: string, mode: ViewMode): SQL {
  if (mode.kind === 'perFeed') {
    return sql`
      SELECT s.feed_id AS view_key, s.feed_id, s.allow_duplicates, s.inference_mode,
             s.inference_version, s.inference_activated_at, true AS listable
        FROM subscriptions s WHERE s.user_id = ${user}::uuid`;
  }
  const { scope } = mode;
  const filters: SQL[] = [sql`s.user_id = ${user}::uuid`];
  if (scope.feedId !== undefined) filters.push(sql`s.feed_id = ${scope.feedId}::bigint`);
  if (scope.folder !== undefined) filters.push(sql`s.folder = ${scope.folder}`);
  const listable = scope.feedId !== undefined || mode.listHidden ? sql`true` : sql`NOT s.hidden`;
  return sql`
    SELECT 0::bigint AS view_key, s.feed_id, s.allow_duplicates, s.inference_mode,
           s.inference_version, s.inference_activated_at, ${listable} AS listable
      FROM subscriptions s WHERE ${sql.join(filters, sql` AND `)}`;
}

/**
 * Inference eligibility of article `a` in view `c.view_key` (spec 05 §1.1, spec 06 §6.4): an
 * in-scope active subscription carried it at/after activation (a stale article is never automatic),
 * or a live selected request of an in-scope training/active subscription covers its revision.
 */
function eligibleExpr(user: string): SQL {
  return sql`(
    (a.pipeline_state <> 'stale' AND EXISTS (
       SELECT 1 FROM vs e JOIN feed_items ef ON ef.feed_id = e.feed_id AND ef.article_id = a.id
        WHERE e.view_key = c.view_key AND e.inference_mode = 'active'
          AND ef.first_seen_at >= e.inference_activated_at))
    OR EXISTS (
       SELECT 1 FROM analysis_requests r
         JOIN vs e ON e.feed_id = r.feed_id AND e.view_key = c.view_key
        WHERE r.user_id = ${user}::uuid AND r.article_id = a.id
          AND r.article_revision = a.content_revision
          AND r.status IN ('pending', 'running', 'complete')
          AND e.inference_mode IN ('training', 'active')
          AND e.inference_version = r.inference_version
          AND r.created_at > now() - make_interval(days => ${SELECTION_DAYS})))`;
}

interface ProjectionInput {
  user: string;
  mode: ViewMode;
  asOf: Date;
  scoreVersion: string;
  /** `bookmarks`: every bookmarked article instead of the window. */
  bookmarks: boolean;
  labelId: string | undefined;
}

/** `WITH vs, carried, proj` (steps 1–3 of the module comment). */
function projectionCtes(input: ProjectionInput): SQL {
  const { user, asOf } = input;
  const asOfIso = asOf.toISOString();
  const scoped =
    input.mode.kind === 'single' &&
    (input.mode.scope.feedId !== undefined || input.mode.scope.folder !== undefined);
  const carried = input.bookmarks
    ? sql`
        SELECT 0::bigint AS view_key, ua.article_id,
               (SELECT max(ef.first_seen_at) FROM vs e
                  JOIN feed_items ef ON ef.feed_id = e.feed_id
                 WHERE ef.article_id = ua.article_id) AS arrival
          FROM user_article ua
         WHERE ua.user_id = ${user}::uuid AND ua.bookmarked_at IS NOT NULL
           ${
             scoped
               ? sql`AND EXISTS (SELECT 1 FROM vs e JOIN feed_items ef ON ef.feed_id = e.feed_id
                                  WHERE ef.article_id = ua.article_id)`
               : sql``
           }`
    : sql`
        SELECT vs.view_key, fi.article_id, max(fi.first_seen_at) AS arrival
          FROM vs JOIN feed_items fi ON fi.feed_id = vs.feed_id
         WHERE vs.listable
           AND fi.first_seen_at <= ${asOfIso}::timestamptz
           AND fi.first_seen_at >= ${asOfIso}::timestamptz - make_interval(days => ${RANK_WINDOW_DAYS})
         GROUP BY vs.view_key, fi.article_id`;
  const label =
    input.labelId === undefined
      ? sql``
      : sql`AND coalesce(ua.label_ids, '{}') @> ARRAY[${input.labelId}::bigint]`;
  return sql`
    WITH vs AS (${viewScope(user, input.mode)}),
    carried AS (${carried}),
    proj AS (
      SELECT c.view_key, c.article_id, coalesce(c.arrival, a.first_seen_at) AS arrival,
             (SELECT min(e.feed_id) FROM vs e JOIN feed_items ef ON ef.feed_id = e.feed_id
               WHERE e.view_key = c.view_key AND e.listable AND ef.article_id = c.article_id)
               AS display_feed_id,
             el.eligible, a.published_at, a.story_cluster_id,
             ua.read_at, ua.archived_at, ua.label_ids, ua.rating,
             CASE WHEN el.eligible THEN coalesce(ua.lane, 'new')
                  WHEN ua.lane = 'hidden' AND ua.rules_fired[1] ~ ${HIDE_RULE_PATTERN} THEN 'hidden'
                  ELSE 'new' END AS lane,
             CASE WHEN el.eligible THEN ua.p_like END AS p_like,
             CASE WHEN el.eligible THEN ua.tier END AS tier,
             (el.eligible AND (ua.article_id IS NULL
                OR ua.score_version <> ${input.scoreVersion}
                OR ua.rank_revision <> (SELECT u.rank_revision FROM users u WHERE u.id = ${user}::uuid)
                OR ua.next_rank_at <= now())) AS outdated,
             (el.eligible AND a.story_cluster_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM feed_items fx
                  JOIN subscriptions sx ON sx.feed_id = fx.feed_id AND sx.user_id = ${user}::uuid
                 WHERE fx.article_id = c.article_id AND NOT sx.allow_duplicates)) AS foldable
        FROM carried c
        JOIN articles a ON a.id = c.article_id
        LEFT JOIN user_article ua ON ua.user_id = ${user}::uuid AND ua.article_id = c.article_id
        CROSS JOIN LATERAL (SELECT ${eligibleExpr(user)} AS eligible) el
       WHERE true ${label}
    )`;
}

/** The lane rows of a view (`rows`, steps 4–5) after {@link projectionCtes}. */
function laneRowsCtes(lane: ArticleViewLane, status: ArticleStatus, minTier: number): SQL {
  const unread = status === 'unread' ? sql`AND read_at IS NULL` : sql``;
  if (lane === 'bookmarks') {
    return sql`, rows AS (SELECT proj.*, false AS folded FROM proj WHERE true ${unread})`;
  }
  if (lane === 'hidden') {
    return sql`, rows AS (SELECT proj.*, false AS folded FROM proj
                          WHERE (lane = 'hidden' OR archived_at IS NOT NULL) ${unread})`;
  }
  const laneFilter = lane === 'all' ? sql`` : sql`AND lane = ${lane}`;
  return sql`,
    vis AS (SELECT * FROM proj WHERE lane <> 'hidden' AND archived_at IS NULL ${unread}),
    ranked AS (
      SELECT vis.*, row_number() OVER (
               PARTITION BY view_key,
                            CASE WHEN foldable THEN story_cluster_id ELSE -article_id END
               ORDER BY p_like DESC NULLS LAST, arrival ASC, article_id ASC) AS rn
        FROM vis),
    rows AS (
      SELECT ranked.*, foldable AS folded FROM ranked
       WHERE rn = 1 AND (lane NOT IN ('for_you', 'maybe') OR coalesce(tier, 0) >= ${minTier})
             ${laneFilter})`;
}

/**
 * `datasetVersion` (spec 08 §5.1): a digest of the view's rows ordered by id with every mutable
 * filter/sort field (lane, P, tier, read/archive state, arrival, publication date, story, labels,
 * eligibility), prefixed by the view itself. It is independent of the sort, so the list, the counts
 * (`lane=all`) and a mark-read filter over the same view and `asOf` agree. Reranking, cluster,
 * read/label changes and unsubscribing all change it.
 */
function digestExpr(prefix: string): SQL {
  return sql`encode(sha256(convert_to(${prefix} || coalesce(string_agg(concat_ws('|',
      article_id, lane, coalesce(p_like::text, '-'), coalesce(tier::text, '-'),
      (read_at IS NOT NULL)::text, (archived_at IS NOT NULL)::text, ${micros(sql`arrival`)},
      coalesce(${micros(sql`published_at`)}::text, '-'), coalesce(story_cluster_id::text, '-'),
      coalesce(label_ids::text, '{}'), eligible::text), ',' ORDER BY article_id), ''), 'UTF8')),
      'hex')`;
}

function viewPrefix(input: ArticleViewInput): string {
  const { scope } = input;
  return [
    'v1',
    input.lane,
    input.status,
    input.minTier,
    scope.feedId ?? '',
    scope.folder ?? '',
    scope.labelId ?? '',
    input.asOf.toISOString(),
    '',
  ].join('\u0001');
}

function sortKeys(sort: ArticleListSort): { k1: SQL; k2: SQL } {
  switch (sort) {
    case 'score':
      return { k1: sql`coalesce(p_like::float8, -1)`, k2: micros(sql`arrival`) };
    case 'uncertainty':
      return {
        k1: sql`CASE WHEN p_like IS NULL THEN -2 ELSE -abs(p_like::float8 - 0.5) END`,
        k2: micros(sql`arrival`),
      };
    case 'date':
      return {
        k1: sql`${micros(sql`coalesce(published_at, arrival)`)}::float8`,
        k2: sql`0::bigint`,
      };
  }
}

const singleMode = (scope: ArticleScope, lane: ArticleViewLane): ViewMode => ({
  kind: 'single',
  scope,
  listHidden: lane === 'hidden',
});

export interface ArticleListInput extends ArticleViewInput {
  sort: ArticleListSort;
  limit: number;
  /** The last row of the previous page. */
  after: ArticleListKey | null;
}

export interface ArticleListPage {
  rows: ArticleContext[];
  /** The key of the page's last row when another page follows. */
  nextKey: ArticleListKey | null;
  datasetVersion: string;
  /** Some eligible candidate has a missing/outdated rank (spec 08 §5.1 "Outdated scores"). */
  rankingPending: boolean;
}

type ListRow = {
  dataset_version: string;
  ranking_pending: boolean;
  article_id: string | null;
  eligible: boolean | null;
  display_feed_id: string | null;
  arrival: RawTimestamp | null;
  k1: number | null;
  k2: string | null;
  cluster_id: string | null;
  cluster_size: number | null;
  other_feeds: string[] | null;
};

/**
 * One page of `GET /articles` (spec 08 §5.1) with the view's `datasetVersion` and whether ranking is
 * pending, evaluated in one statement. Rows carry what the item mapping needs from the view.
 */
export async function listArticlePage(
  tx: TenantTx,
  input: ArticleListInput,
): Promise<ArticleListPage> {
  const user = tenantUserId(tx);
  const { k1, k2 } = sortKeys(input.sort);
  const after =
    input.after === null
      ? sql``
      : sql`WHERE (k1, k2, article_id) <
              (${input.after.k1}::float8, ${input.after.k2}::bigint, ${input.after.id}::bigint)`;
  const result = await tx.execute<ListRow>(sql`
    ${projectionCtes({
      user,
      mode: singleMode(input.scope, input.lane),
      asOf: input.asOf,
      scoreVersion: input.scoreVersion,
      bookmarks: input.lane === 'bookmarks',
      labelId: input.scope.labelId,
    })}
    ${laneRowsCtes(input.lane, input.status, input.minTier)},
    keyed AS (SELECT rows.*, ${k1} AS k1, ${k2} AS k2 FROM rows),
    page AS (SELECT * FROM keyed ${after} ORDER BY k1 DESC, k2 DESC, article_id DESC
             LIMIT ${input.limit + 1}),
    summary AS (SELECT ${digestExpr(viewPrefix(input))} AS dataset_version FROM rows),
    pending AS (SELECT coalesce(bool_or(outdated), false) AS ranking_pending FROM proj)
    SELECT summary.dataset_version, pending.ranking_pending,
           p.article_id::text AS article_id, p.eligible, p.display_feed_id::text AS display_feed_id,
           p.arrival, p.k1, p.k2::text AS k2,
           CASE WHEN p.folded THEN p.story_cluster_id::text END AS cluster_id,
           CASE WHEN p.folded THEN (
             SELECT count(*)::int FROM proj m
              WHERE m.view_key = p.view_key AND m.foldable AND m.story_cluster_id = p.story_cluster_id
                AND m.lane <> 'hidden' AND m.archived_at IS NULL) END AS cluster_size,
           CASE WHEN p.folded THEN (
             SELECT coalesce(array_agg(DISTINCT coalesce(s.title_override, f.title, f.url)), '{}')
               FROM proj m
               JOIN feeds f ON f.id = m.display_feed_id
               LEFT JOIN subscriptions s ON s.user_id = ${user}::uuid AND s.feed_id = f.id
              WHERE m.view_key = p.view_key AND m.foldable AND m.story_cluster_id = p.story_cluster_id
                AND m.article_id <> p.article_id AND m.lane <> 'hidden' AND m.archived_at IS NULL
                AND m.display_feed_id IS DISTINCT FROM p.display_feed_id) END AS other_feeds
      FROM summary CROSS JOIN pending LEFT JOIN page p ON true
     ORDER BY p.k1 DESC, p.k2 DESC, p.article_id DESC`);
  const first = result.rows[0];
  if (first === undefined) throw new Error('article list query returned no summary row');
  const rows: ArticleContext[] = [];
  const keys: ArticleListKey[] = [];
  for (const row of result.rows) {
    if (row.article_id === null) continue;
    rows.push({
      articleId: row.article_id,
      eligible: row.eligible === true,
      displayFeedId: row.display_feed_id,
      arrival: toDate(row.arrival ?? new Date(0)),
      cluster:
        row.cluster_id === null
          ? null
          : {
              id: row.cluster_id,
              size: Math.max(1, row.cluster_size ?? 1),
              otherFeeds: (row.other_feeds ?? []).sort(),
            },
    });
    keys.push({ k1: Number(row.k1), k2: row.k2 ?? '0', id: row.article_id });
  }
  const more = rows.length > input.limit;
  if (more) {
    rows.length = input.limit;
    keys.length = input.limit;
  }
  return {
    rows,
    nextKey: more ? (keys.at(-1) ?? null) : null,
    datasetVersion: first.dataset_version,
    rankingPending: first.ranking_pending,
  };
}

/** The `datasetVersion` and the row ids of a view (mark-read by filter, spec 08 §5.3). */
export async function articleViewIds(
  tx: TenantTx,
  input: ArticleViewInput,
  options: { maxIds: number },
): Promise<{ datasetVersion: string; ids: string[]; total: number }> {
  const user = tenantUserId(tx);
  const result = await tx.execute<{ dataset_version: string; total: number; ids: string[] | null }>(
    sql`
    ${projectionCtes({
      user,
      mode: singleMode(input.scope, input.lane),
      asOf: input.asOf,
      scoreVersion: input.scoreVersion,
      bookmarks: input.lane === 'bookmarks',
      labelId: input.scope.labelId,
    })}
    ${laneRowsCtes(input.lane, input.status, input.minTier)}
    SELECT ${digestExpr(viewPrefix(input))} AS dataset_version, count(*)::int AS total,
           (array_agg(article_id::text ORDER BY article_id))[1:${options.maxIds}] AS ids
      FROM rows`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('article view query returned no row');
  return { datasetVersion: row.dataset_version, ids: row.ids ?? [], total: row.total };
}

export interface ArticleCountsResult {
  forYou: number;
  maybe: number;
  everything: number;
  new: number;
  bookmarks: number;
  hidden: number;
  scored: number;
  total: number;
  datasetVersion: string;
  rankingPending: boolean;
}

type LaneCountRow = {
  view_key: string;
  for_you: number;
  maybe: number;
  everything: number;
  new: number;
  dataset_version: string;
  ranking_pending: boolean;
};

async function laneCounts(
  tx: TenantTx,
  mode: ViewMode,
  input: Omit<ArticleViewInput, 'lane'>,
): Promise<LaneCountRow[]> {
  const user = tenantUserId(tx);
  const result = await tx.execute<LaneCountRow>(sql`
    ${projectionCtes({
      user,
      mode,
      asOf: input.asOf,
      scoreVersion: input.scoreVersion,
      bookmarks: false,
      labelId: input.scope.labelId,
    })}
    ${laneRowsCtes('all', input.status, input.minTier)},
    pending AS (SELECT view_key, bool_or(outdated) AS ranking_pending FROM proj GROUP BY view_key)
    SELECT rows.view_key::text AS view_key,
           count(*) FILTER (WHERE lane = 'for_you')::int AS for_you,
           count(*) FILTER (WHERE lane = 'maybe')::int AS maybe,
           count(*) FILTER (WHERE lane = 'everything')::int AS everything,
           count(*) FILTER (WHERE lane = 'new')::int AS new,
           ${digestExpr(viewPrefix({ ...input, lane: 'all' }))} AS dataset_version,
           coalesce(bool_or(pending.ranking_pending), false) AS ranking_pending
      FROM rows LEFT JOIN pending ON pending.view_key = rows.view_key
     GROUP BY rows.view_key`);
  return result.rows;
}

/**
 * `GET /articles/counts` (spec 08 §5.1): the lane counts use the same builder and predicates as the
 * list (so they equal `lane=<lane>` list totals for the same `asOf`), `bookmarks` uses bookmark-view
 * semantics and counts every saved item, `hidden` is the recovery view's count; neither is in
 * `scored`/`total`. `datasetVersion` is the `lane=all` list's.
 */
export async function countArticles(
  tx: TenantTx,
  input: Omit<ArticleViewInput, 'lane'>,
): Promise<ArticleCountsResult> {
  const user = tenantUserId(tx);
  const lanes = await laneCounts(tx, singleMode(input.scope, 'all'), input);
  const lane = lanes[0];
  const hidden = await tx.execute<{ n: number; pending: boolean }>(sql`
    ${projectionCtes({
      user,
      mode: singleMode(input.scope, 'hidden'),
      asOf: input.asOf,
      scoreVersion: input.scoreVersion,
      bookmarks: false,
      labelId: input.scope.labelId,
    })}
    ${laneRowsCtes('hidden', input.status, input.minTier)}
    SELECT count(*)::int AS n FROM rows`);
  const bookmarks = await tx.execute<{ n: number }>(sql`
    ${projectionCtes({
      user,
      mode: singleMode(input.scope, 'bookmarks'),
      asOf: input.asOf,
      scoreVersion: input.scoreVersion,
      bookmarks: true,
      labelId: input.scope.labelId,
    })}
    SELECT count(*)::int AS n FROM proj`);
  const forYou = lane?.for_you ?? 0;
  const maybe = lane?.maybe ?? 0;
  const everything = lane?.everything ?? 0;
  const fresh = lane?.new ?? 0;
  const empty = await emptyDigest(tx, { ...input, lane: 'all' });
  return {
    forYou,
    maybe,
    everything,
    new: fresh,
    bookmarks: bookmarks.rows[0]?.n ?? 0,
    hidden: hidden.rows[0]?.n ?? 0,
    scored: forYou + maybe + everything,
    total: forYou + maybe + everything + fresh,
    datasetVersion: lane?.dataset_version ?? empty,
    rankingPending: lane?.ranking_pending ?? false,
  };
}

/** The digest of an empty view (no grouped row exists to compute it from). */
async function emptyDigest(tx: TenantTx, input: ArticleViewInput): Promise<string> {
  const result = await tx.execute<{ d: string }>(sql`
    WITH rows AS (
      SELECT NULL::bigint AS article_id, NULL::text AS lane, NULL::real AS p_like,
             NULL::smallint AS tier, NULL::timestamptz AS read_at, NULL::timestamptz AS archived_at,
             NULL::timestamptz AS arrival, NULL::timestamptz AS published_at,
             NULL::bigint AS story_cluster_id, NULL::bigint[] AS label_ids, NULL::boolean AS eligible
      WHERE false)
    SELECT ${digestExpr(viewPrefix(input))} AS d FROM rows`);
  return result.rows[0]?.d ?? '';
}

/**
 * Unread lane counts per subscription (spec 08 §4 `GET /subscriptions` `unread`): for each of the
 * caller's subscriptions — hidden ones too — the counts its own feed view (`GET
 * /articles/counts?feedId=<id>&status=unread`) reports for the same `asOf` and `minTier`. Folding,
 * demand projection and the window apply per feed. Subscriptions with nothing unread are absent
 * from the map (all four counts zero).
 */
export async function countSubscriptionUnread(
  tx: TenantTx,
  input: { asOf: Date; minTier: number; scoreVersion: string },
): Promise<Map<string, LaneUnreadCounts>> {
  const rows = await laneCounts(
    tx,
    { kind: 'perFeed' },
    {
      scope: {},
      status: 'unread',
      minTier: input.minTier,
      asOf: input.asOf,
      scoreVersion: input.scoreVersion,
    },
  );
  return new Map(
    rows.map((row) => [
      row.view_key,
      { forYou: row.for_you, maybe: row.maybe, everything: row.everything, new: row.new },
    ]),
  );
}

/** Calibration round size, recency and per-feed cap (spec 06 §10). */
export const CALIBRATION_SIZE = 10;
export const CALIBRATION_MAX_AGE_DAYS = 7;
export const CALIBRATION_PER_FEED = 3;

/**
 * `GET /articles/calibration` (spec 06 §10): up to 10 unrated, inference-eligible articles of the
 * global view that arrived within 7 days, not hidden or archived — the most uncertain Maybe items
 * first, then Everything items by highest P — one member per story and at most 3 per display feed
 * across both steps, ties by numeric article id. Retrieval authorizes no new model work.
 */
export async function calibrationArticles(
  tx: TenantTx,
  input: { now: Date; scoreVersion: string },
): Promise<ArticleContext[]> {
  const user = tenantUserId(tx);
  const result = await tx.execute<{
    article_id: string;
    display_feed_id: string | null;
    arrival: RawTimestamp;
  }>(sql`
    ${projectionCtes({
      user,
      mode: singleMode({}, 'all'),
      asOf: input.now,
      scoreVersion: input.scoreVersion,
      bookmarks: false,
      labelId: undefined,
    })},
    cand AS (
      SELECT proj.*, CASE WHEN lane = 'maybe' THEN 0 ELSE 1 END AS phase,
             CASE WHEN lane = 'maybe' THEN abs(p_like::float8 - 0.5) ELSE -p_like::float8 END AS key
        FROM proj
       WHERE eligible AND lane IN ('maybe', 'everything') AND p_like IS NOT NULL
         AND archived_at IS NULL AND rating IS NULL
         AND arrival >= ${input.now.toISOString()}::timestamptz
                        - make_interval(days => ${CALIBRATION_MAX_AGE_DAYS})),
    per_story AS (
      SELECT cand.*, row_number() OVER (
               PARTITION BY coalesce(story_cluster_id, -article_id)
               ORDER BY phase, key, article_id) AS story_rn
        FROM cand),
    per_feed AS (
      SELECT per_story.*, row_number() OVER (
               PARTITION BY display_feed_id ORDER BY phase, key, article_id) AS feed_rn
        FROM per_story WHERE story_rn = 1)
    SELECT article_id::text AS article_id, display_feed_id::text AS display_feed_id, arrival
      FROM per_feed WHERE feed_rn <= ${CALIBRATION_PER_FEED}
     ORDER BY phase, key, article_id
     LIMIT ${CALIBRATION_SIZE}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    eligible: true,
    displayFeedId: row.display_feed_id,
    arrival: toDate(row.arrival),
    cluster: null,
  }));
}

/**
 * The detail/action access predicate (spec 08 §5.2): the article is carried by one of the caller's
 * subscriptions or the caller bookmarked it. Anything else is indistinguishable from a missing id.
 */
export async function accessibleArticleIds(
  tx: TenantTx,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const user = tenantUserId(tx);
  const result = await tx.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM articles a
     WHERE a.id = ANY(${sql.param([...ids])}::bigint[])
       AND (EXISTS (SELECT 1 FROM feed_items fi
                      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${user}::uuid
                     WHERE fi.article_id = a.id)
            OR EXISTS (SELECT 1 FROM user_article ua
                        WHERE ua.user_id = ${user}::uuid AND ua.article_id = a.id
                          AND ua.bookmarked_at IS NOT NULL))`);
  return new Set(result.rows.map((row) => row.id));
}

/** Whether the caller subscribes to `feedId` (feed-scoped actions, spec 08 §4). */
export async function ownsSubscription(tx: TenantTx, feedId: string): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM subscriptions
                    WHERE user_id = ${tenantUserId(tx)}::uuid AND feed_id = ${feedId}::bigint) AS ok`);
  return result.rows[0]?.ok === true;
}

/** Whether `feedId` is one of the caller's subscriptions carrying the article. */
export async function isOwnedCarrier(
  tx: TenantTx,
  articleId: string,
  feedId: string,
): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM feed_items fi
                     JOIN subscriptions s ON s.feed_id = fi.feed_id
                                         AND s.user_id = ${tenantUserId(tx)}::uuid
                    WHERE fi.article_id = ${articleId}::bigint AND fi.feed_id = ${feedId}::bigint) AS ok`);
  return result.rows[0]?.ok === true;
}

/**
 * Item contexts outside a list (detail and action responses): eligibility and display feed of the
 * global view (every subscription; hidden feeds only display when nothing else carries the
 * article), or of the `sourceFeedId` view (spec 08 §5.2), without the list window. The cluster is
 * reported for eligible foldable rows with its members accessible through the view's feeds.
 */
export async function articleContexts(
  tx: TenantTx,
  ids: readonly string[],
  scope: { sourceFeedId?: string | undefined } = {},
): Promise<ArticleContext[]> {
  if (ids.length === 0) return [];
  const user = tenantUserId(tx);
  const mode: ViewMode = {
    kind: 'single',
    scope: scope.sourceFeedId === undefined ? {} : { feedId: scope.sourceFeedId },
    listHidden: false,
  };
  const result = await tx.execute<{
    article_id: string;
    eligible: boolean;
    display_feed_id: string | null;
    arrival: RawTimestamp;
    cluster_id: string | null;
    cluster_size: number | null;
    other_feeds: string[] | null;
  }>(sql`
    WITH vs AS (${viewScope(user, mode)}),
    c AS (SELECT 0::bigint AS view_key, x.id AS article_id
            FROM unnest(${sql.param([...ids])}::bigint[]) WITH ORDINALITY AS x(id, ord)),
    base AS (
      SELECT c.article_id, el.eligible, a.story_cluster_id,
             coalesce(
               (SELECT min(e.feed_id) FROM vs e JOIN feed_items ef ON ef.feed_id = e.feed_id
                 WHERE e.listable AND ef.article_id = c.article_id),
               (SELECT min(e.feed_id) FROM vs e JOIN feed_items ef ON ef.feed_id = e.feed_id
                 WHERE ef.article_id = c.article_id)) AS display_feed_id,
             coalesce(
               (SELECT max(ef.first_seen_at) FROM vs e JOIN feed_items ef ON ef.feed_id = e.feed_id
                 WHERE ef.article_id = c.article_id),
               a.first_seen_at) AS arrival,
             (el.eligible AND a.story_cluster_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM feed_items fx
                  JOIN subscriptions sx ON sx.feed_id = fx.feed_id AND sx.user_id = ${user}::uuid
                 WHERE fx.article_id = c.article_id AND NOT sx.allow_duplicates)) AS foldable
        FROM c JOIN articles a ON a.id = c.article_id
        CROSS JOIN LATERAL (SELECT ${eligibleExpr(user)} AS eligible) el)
    SELECT b.article_id::text AS article_id, b.eligible, b.display_feed_id::text AS display_feed_id,
           b.arrival,
           CASE WHEN b.foldable THEN b.story_cluster_id::text END AS cluster_id,
           CASE WHEN b.foldable THEN (
             SELECT count(DISTINCT m.id)::int FROM articles m
              WHERE m.story_cluster_id = b.story_cluster_id
                AND EXISTS (SELECT 1 FROM vs e JOIN feed_items ef ON ef.feed_id = e.feed_id
                             WHERE e.listable AND ef.article_id = m.id)) END AS cluster_size,
           CASE WHEN b.foldable THEN (
             SELECT coalesce(array_agg(DISTINCT coalesce(s.title_override, f.title, f.url)), '{}')
               FROM articles m
               JOIN feed_items ef ON ef.article_id = m.id
               JOIN vs e ON e.feed_id = ef.feed_id AND e.listable
               JOIN feeds f ON f.id = e.feed_id
               LEFT JOIN subscriptions s ON s.user_id = ${user}::uuid AND s.feed_id = f.id
              WHERE m.story_cluster_id = b.story_cluster_id AND m.id <> b.article_id
                AND f.id IS DISTINCT FROM b.display_feed_id) END AS other_feeds
      FROM base b`);
  const byId = new Map(result.rows.map((row) => [row.article_id, row]));
  const contexts: ArticleContext[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) continue;
    contexts.push({
      articleId: row.article_id,
      eligible: row.eligible,
      displayFeedId: row.display_feed_id,
      arrival: toDate(row.arrival),
      cluster:
        row.cluster_id === null
          ? null
          : {
              id: row.cluster_id,
              size: Math.max(1, row.cluster_size ?? 1),
              otherFeeds: (row.other_feeds ?? []).sort(),
            },
    });
  }
  return contexts;
}

// ── Item mapping ────────────────────────────────────────────────────────────────────────────────

type ItemRow = {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  published_at: RawTimestamp | null;
  excerpt: string | null;
  image_url: string | null;
  lang: string | null;
  content_revision: string;
  pipeline_state: string;
  feed_id: string | null;
  feed_title: string | null;
  feed_icon: string | null;
  sub_mode: 'off' | 'training' | 'active' | null;
  ua_lane: Lane | null;
  tier: number | null;
  p_like: number | null;
  rules_fired: string[] | null;
  explain: unknown;
  label_ids: string[] | null;
  label_suggestions: string[] | null;
  rating: number | null;
  reason: RatingReason | null;
  read_at: RawTimestamp | null;
  bookmarked_at: RawTimestamp | null;
  archived_at: RawTimestamp | null;
  state_version: string | null;
  capture_status: BookmarkCapture['status'] | null;
  capture_generation: string | null;
  snapshot_id: string | null;
  capture_error: string | null;
  captured_at: RawTimestamp | null;
  media_feed_id: string | null;
  image_policy: ImagePolicy | null;
  translation_available: boolean;
  request_id: string | null;
  request_status: ArticleAnalysis['status'] | null;
};

/** The stored ranking projected for a view (spec 06 §6.4; `projectRankForView` of the ranker). */
interface ProjectedRank {
  lane: Lane;
  tier: number | null;
  pLike: number | null;
  explain: Explain | null;
  labelSuggestions: string[];
}

function parseExplain(raw: unknown): Explain | null {
  if (raw === null || raw === undefined) return null;
  const parsed = ExplainSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function projectRank(row: ItemRow, eligible: boolean): ProjectedRank {
  const explain = parseExplain(row.explain);
  if (eligible) {
    return {
      lane: row.ua_lane ?? 'new',
      tier: row.tier,
      pLike: row.p_like,
      explain,
      labelSuggestions: row.label_suggestions ?? [],
    };
  }
  const hideCode = row.rules_fired?.[0];
  const hidden = row.ua_lane === 'hidden' && hideCode !== undefined && HIDE_RULE.test(hideCode);
  const lane: Lane = hidden ? 'hidden' : 'new';
  const rule =
    hidden && hideCode !== undefined
      ? (explain?.rules.find((r) => r.code === hideCode) ?? { code: hideCode })
      : { code: 'inference_not_requested' };
  return {
    lane,
    tier: null,
    pLike: null,
    explain:
      explain === null
        ? null
        : {
            v: 1,
            inputs: { ...explain.inputs },
            source: 'none',
            p: null,
            lane,
            tier: null,
            cards: [],
            rules: [rule],
          },
    labelSuggestions: [],
  };
}

const RULE_REASON =
  /^(?:must:|never:|never_soft:|mute_keyword:)|^(?:boost_feed|boost_domain|llm_answer|seen_story|mute_story|block_feed|block_domain|block_author)$/;

/**
 * `topReason` from the (projected) explanation (spec 08 §5.1): a fired floor, cap or hide rule; else
 * the deciding card of a card score, titled by the user's current name for that card id (a rename
 * triggers no rank, so the stored title may be old); else the model's top contribution; else
 * `keyword` for the degraded path.
 */
export function topReasonOf(
  explain: Explain | null,
  cardTitles: ReadonlyMap<string, string>,
): TopReason | null {
  if (explain === null) return null;
  const rule = explain.rules.find((r) => RULE_REASON.test(r.code));
  if (rule !== undefined) {
    return {
      kind: 'rule',
      code: rule.code,
      ...(rule.ruleId === undefined ? {} : { ruleId: rule.ruleId }),
    };
  }
  if (explain.source === 'cards' && explain.decidingCardId !== undefined) {
    const id = explain.decidingCardId;
    const entry = explain.cards.find((card) => card.id === id);
    return {
      kind: 'card',
      cardId: id,
      title: (cardTitles.get(id) ?? entry?.title ?? '').slice(0, 200),
      p: entry?.p ?? explain.p ?? 0,
    };
  }
  if (explain.source === 'model') {
    const top = explain.model?.top[0];
    return top === undefined ? null : { kind: 'model', feature: top.feature, label: top.label };
  }
  if (explain.source === 'degraded') return { kind: 'keyword' };
  return null;
}

const iso = (value: RawTimestamp | null): string | null =>
  toDateOrNull(value)?.toISOString() ?? null;

function analysisOf(row: ItemRow, eligible: boolean): ArticleAnalysis {
  const mode = row.sub_mode ?? 'off';
  if (row.request_id !== null && row.request_status !== null) {
    return { mode, status: row.request_status, requestId: row.request_id };
  }
  if (!eligible) return { mode, status: 'not_requested', requestId: null };
  const status =
    row.pipeline_state === 'failed'
      ? 'failed'
      : row.pipeline_state === 'matched' || row.pipeline_state === 'degraded'
        ? 'complete'
        : 'pending';
  return { mode, status, requestId: null };
}

/** The deciding cards' current display titles for the given explanations. */
async function heldCardTitles(tx: TenantTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await tx.execute<{ id: string; title: string }>(sql`
    SELECT uc.card_id::text AS id, coalesce(uc.title_override, c.title) AS title
      FROM user_cards uc JOIN interest_cards c ON c.id = uc.card_id
     WHERE uc.user_id = ${tenantUserId(tx)}::uuid
       AND uc.card_id = ANY(${sql.param([...new Set(ids)])}::bigint[])`);
  return new Map(result.rows.map((row) => [row.id, row.title]));
}

interface LoadedItem {
  item: ArticleListItem;
  explain: Explain | null;
}

async function loadItemRows(
  tx: TenantTx,
  contexts: readonly ArticleContext[],
  loadRemoteImages: boolean,
): Promise<LoadedItem[]> {
  if (contexts.length === 0) return [];
  const user = tenantUserId(tx);
  const ids = contexts.map((c) => c.articleId);
  const displays = contexts.map((c) => c.displayFeedId);
  const result = await tx.execute<ItemRow>(sql`
    WITH x AS (
      SELECT * FROM unnest(${sql.param(ids)}::bigint[], ${sql.param(displays)}::bigint[])
               AS x(article_id, display_feed_id))
    SELECT a.id::text AS id, a.title, a.url, a.author, a.published_at,
           left(a.excerpt, 300) AS excerpt, a.image_url, a.lang,
           a.content_revision::text AS content_revision, a.pipeline_state,
           f.id::text AS feed_id, coalesce(s.title_override, f.title, f.url) AS feed_title,
           f.icon_url AS feed_icon, s.inference_mode AS sub_mode,
           ua.lane AS ua_lane, ua.tier, ua.p_like, ua.rules_fired, ua.explain,
           ua.label_ids::text[] AS label_ids, ua.label_suggestions::text[] AS label_suggestions,
           ua.rating, ua.reason, ua.read_at, ua.bookmarked_at, ua.archived_at,
           ua.state_version::text AS state_version, ua.bookmark_capture_status AS capture_status,
           ua.bookmark_capture_generation::text AS capture_generation,
           ua.bookmark_snapshot_id::text AS snapshot_id,
           ua.bookmark_capture_error_code AS capture_error, snap.captured_at,
           m.feed_id::text AS media_feed_id, pref.image_policy,
           EXISTS (SELECT 1 FROM article_translations t
                    WHERE t.article_id = a.id AND t.article_revision = a.content_revision
                      AND t.quality <> 'fail' AND t.title IS NOT NULL) AS translation_available,
           req.id AS request_id, req.status AS request_status
      FROM x
      JOIN articles a ON a.id = x.article_id
      LEFT JOIN feeds f ON f.id = x.display_feed_id
      LEFT JOIN subscriptions s ON s.user_id = ${user}::uuid AND s.feed_id = x.display_feed_id
      LEFT JOIN user_article ua ON ua.user_id = ${user}::uuid AND ua.article_id = a.id
      LEFT JOIN article_snapshots snap ON snap.id = ua.bookmark_snapshot_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN ua.bookmarked_at IS NOT NULL THEN ua.bookmark_origin_feed_id
                    ELSE x.display_feed_id END AS feed_id) m
      LEFT JOIN user_feed_preferences pref ON pref.user_id = ${user}::uuid AND pref.feed_id = m.feed_id
      LEFT JOIN LATERAL (
        SELECT r.id::text AS id, r.status FROM analysis_requests r
         WHERE r.user_id = ${user}::uuid AND r.article_id = a.id
           AND r.article_revision = a.content_revision
         ORDER BY r.created_at DESC LIMIT 1) req ON true`);
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const projected = contexts.map((context) => {
    const row = byId.get(context.articleId);
    return row === undefined ? null : { context, row, rank: projectRank(row, context.eligible) };
  });
  const deciding = projected.flatMap((p) =>
    p?.rank.explain?.decidingCardId === undefined ? [] : [p.rank.explain.decidingCardId],
  );
  const titles = await heldCardTitles(tx, deciding);
  const items: LoadedItem[] = [];
  for (const entry of projected) {
    if (entry === null) continue;
    const { context, row, rank } = entry;
    const bookmarked = row.bookmarked_at !== null;
    items.push({
      explain: rank.explain,
      item: {
        id: row.id,
        title: row.title,
        url: row.url,
        feed:
          row.feed_id === null
            ? null
            : { id: row.feed_id, title: row.feed_title ?? '', iconUrl: row.feed_icon },
        author: row.author,
        publishedAt: iso(row.published_at),
        firstSeenAt: context.arrival.toISOString(),
        excerpt: row.excerpt,
        imageUrl: row.image_url,
        lang: row.lang,
        lane: rank.lane,
        tier: rank.tier,
        pLike: rank.pLike,
        topReason: topReasonOf(rank.explain, titles),
        labelIds: row.label_ids ?? [],
        labelSuggestions: rank.labelSuggestions,
        rating: row.rating === 1 || row.rating === -1 ? row.rating : null,
        reason: row.reason,
        readAt: iso(row.read_at),
        bookmarkedAt: iso(row.bookmarked_at),
        archivedAt: iso(row.archived_at),
        stateVersion: row.state_version ?? '0',
        contentRevision: row.content_revision,
        translationAvailable: row.translation_available,
        analysis: analysisOf(row, context.eligible),
        mediaPolicyFeedId: row.media_feed_id,
        effectiveImagesAllowed: effectiveImagesAllowed(row.image_policy, loadRemoteImages),
        bookmarkCapture:
          bookmarked && row.capture_status !== null
            ? {
                status: row.capture_status,
                generation: row.capture_generation ?? '0',
                snapshotId: row.snapshot_id,
                capturedAt: iso(row.captured_at),
                errorCode: row.capture_error,
              }
            : null,
        cluster: context.cluster,
      },
    });
  }
  return items;
}

/**
 * `ArticleListItem`s for contexts (in their order; missing articles are dropped). The stored ranking
 * is projected per context: ineligible rows are neutral (spec 06 §6.4), whatever the global cache
 * holds. `loadRemoteImages` is the caller's global image preference (spec 08 §4.2).
 */
export async function loadArticleItems(
  tx: TenantTx,
  contexts: readonly ArticleContext[],
  options: { loadRemoteImages: boolean },
): Promise<ArticleListItem[]> {
  return (await loadItemRows(tx, contexts, options.loadRemoteImages)).map((entry) => entry.item);
}

/**
 * `GET /articles/:id` (spec 08 §5.2): the item plus sanitized excerpt HTML, the body lead, the
 * projected explanation, the best usable translation, accessible cluster members and, with
 * `view=saved`, the saved snapshot bound to the caller's bookmark. `null` (→ 404) unless the article
 * is accessible; with `sourceFeedId`, that feed must be an owned carrier; `view=saved` needs an owned
 * bookmark. Reading has no side effect.
 */
export async function getArticleDetail(
  tx: TenantTx,
  input: {
    articleId: string;
    sourceFeedId?: string | undefined;
    savedView: boolean;
    loadRemoteImages: boolean;
  },
): Promise<ArticleDetail | null> {
  const user = tenantUserId(tx);
  const { articleId } = input;
  if (!(await accessibleArticleIds(tx, [articleId])).has(articleId)) return null;
  if (
    input.sourceFeedId !== undefined &&
    !(await isOwnedCarrier(tx, articleId, input.sourceFeedId))
  ) {
    return null;
  }
  const contexts = await articleContexts(tx, [articleId], { sourceFeedId: input.sourceFeedId });
  const [loaded] = await loadItemRows(tx, contexts, input.loadRemoteImages);
  if (loaded === undefined) return null;
  const { item, explain } = loaded;
  if (input.savedView && item.bookmarkedAt === null) return null;

  const extra = await tx.execute<{
    excerpt_html: string | null;
    body_lead: string | null;
    tr_title: string | null;
    tr_excerpt: string | null;
    tr_engine: string | null;
    tr_quality: string | null;
  }>(sql`
    SELECT a.excerpt_html, b.body_lead,
           t.title AS tr_title, t.excerpt AS tr_excerpt, t.engine AS tr_engine, t.quality AS tr_quality
      FROM articles a
      LEFT JOIN article_bodies b ON b.article_id = a.id AND b.article_revision = a.content_revision
                                AND b.status = 'ok'
      LEFT JOIN LATERAL (
        SELECT t.* FROM article_translations t
         WHERE t.article_id = a.id AND t.article_revision = a.content_revision
           AND t.quality <> 'fail' AND t.title IS NOT NULL
         ORDER BY (t.quality = 'ok') DESC, (t.engine = 'ollama') DESC LIMIT 1) t ON true
     WHERE a.id = ${articleId}::bigint`);
  const row = extra.rows[0];

  // Members of the story the reader can open independently; none for a neutral row (no folding).
  const eligible = contexts[0]?.eligible === true;
  const members = eligible
    ? await tx.execute<{
        id: string;
        title: string;
        feed_title: string | null;
        url: string | null;
      }>(sql`
        SELECT m.id::text AS id, m.title, m.url,
               (SELECT coalesce(s.title_override, f.title, f.url)
                  FROM feed_items fi
                  JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${user}::uuid
                  JOIN feeds f ON f.id = fi.feed_id
                 WHERE fi.article_id = m.id ORDER BY s.hidden, fi.feed_id LIMIT 1) AS feed_title
          FROM articles a JOIN articles m ON m.story_cluster_id = a.story_cluster_id AND m.id <> a.id
         WHERE a.id = ${articleId}::bigint
           AND (EXISTS (SELECT 1 FROM feed_items fi
                          JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${user}::uuid
                         WHERE fi.article_id = m.id)
                OR EXISTS (SELECT 1 FROM user_article ua
                            WHERE ua.user_id = ${user}::uuid AND ua.article_id = m.id
                              AND ua.bookmarked_at IS NOT NULL))
         ORDER BY m.id
         LIMIT 50`)
    : { rows: [] };

  let snapshot: BookmarkSnapshot | null = null;
  if (input.savedView) {
    const saved = await tx.execute<{
      id: string;
      source_url: string | null;
      title: string;
      author: string | null;
      published_at: RawTimestamp | null;
      captured_at: RawTimestamp;
      source_revision: string;
      completeness: 'complete' | 'partial';
      body_text: string;
      body_html: string | null;
    }>(sql`
      SELECT s.id::text AS id, s.source_url, s.title, s.author, s.published_at, s.captured_at,
             s.source_revision::text AS source_revision, s.completeness, s.body_text, s.body_html
        FROM user_article ua
        JOIN article_snapshots s ON s.id = ua.bookmark_snapshot_id
       WHERE ua.user_id = ${user}::uuid AND ua.article_id = ${articleId}::bigint
         AND ua.bookmarked_at IS NOT NULL`);
    const s = saved.rows[0];
    if (s !== undefined) {
      snapshot = {
        id: s.id,
        sourceUrl: s.source_url,
        title: s.title,
        author: s.author,
        publishedAt: iso(s.published_at),
        capturedAt: toDate(s.captured_at).toISOString(),
        contentRevision: s.source_revision,
        completeness: s.completeness,
        text: s.body_text,
        html: s.body_html,
        mediaPolicyFeedId: item.mediaPolicyFeedId,
        effectiveImagesAllowed: item.effectiveImagesAllowed,
      };
    }
  }

  return {
    ...item,
    excerptHtml: row?.excerpt_html ?? null,
    bodyLead: row?.body_lead ?? null,
    explain,
    translation:
      row?.tr_engine === null || row?.tr_engine === undefined
        ? null
        : {
            title: row.tr_title,
            excerpt: row.tr_excerpt,
            engine: row.tr_engine,
            quality: row.tr_quality ?? 'ok',
          },
    clusterMembers: members.rows.map((m) => ({
      id: m.id,
      title: m.title,
      feedTitle: m.feed_title,
      url: m.url,
    })),
    bookmarkSnapshot: snapshot,
  };
}
