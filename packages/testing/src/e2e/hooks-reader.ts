import {
  HookParamsError,
  httpUrl,
  record,
  runner,
  type Hook,
  type NamedHook,
} from './hooks-kit.js';

/**
 * SQL hooks of the reader scenarios of spec 09 §9 (feeds, automatic mode, bookmarks, images). Each
 * one reaches state that no HTTP endpoint exposes or stands in for a job that is not built yet.
 */

/** A bigint key as the API prints it: digits only, no leading zero, below 2^63. */
function databaseId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,17}$/.test(value)) {
    throw new HookParamsError(`${name} must be a database id (digits, no leading zero)`);
  }
  return value;
}

function emailAddress(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(value)) {
    throw new HookParamsError(`${name} must be an email address of at most 254 characters`);
  }
  return value;
}

/**
 * Asks the worker to fetch a feed now, as the minute cron would once the feed is due: the intent
 * `feed.fetch {feedId, force: true}` goes to the transactional outbox, which the worker relays. A
 * scenario that appends an item to a fixture feed uses it instead of waiting for the schedule.
 */
const fetchFeedNow: Hook<{ feedUrl: string }> = {
  parse: (params) => ({ feedUrl: httpUrl(record(params, ['feedUrl'])['feedUrl'], 'feedUrl') }),
  async run(db, { feedUrl }) {
    const { rows } = await db.query(
      `INSERT INTO job_outbox (queue, payload)
       SELECT 'feed.fetch', jsonb_build_object('feedId', f.id::text, 'force', true)
         FROM feeds f
        WHERE (f.url = $1 OR f.fetch_url = $1) AND f.merged_into_id IS NULL
       RETURNING id`,
      [feedUrl],
    );
    return { queued: rows.length };
  },
};

export interface AnalysisRequestRow {
  id: string;
  articleId: string;
  status: string;
  errorCode: string | null;
}

/** The analysis requests one account made, oldest first, whatever their status. */
const analysisRequests: Hook<{ email: string }> = {
  parse: (params) => ({ email: emailAddress(record(params, ['email'])['email'], 'email') }),
  async run(db, { email }) {
    const { rows } = await db.query(
      `SELECT r.id::text AS "id", r.article_id::text AS "articleId", r.status AS "status",
              r.last_error_code AS "errorCode"
         FROM analysis_requests r
         JOIN users u ON u.id = r.user_id
        WHERE u.email = $1
        ORDER BY r.created_at, r.id`,
      [email],
    );
    return rows as AnalysisRequestRow[];
  },
};

export interface EngineCallRow {
  id: string;
  articleId: string | null;
  kind: string;
  engine: string;
  status: string;
}

/**
 * The provider calls made on one account's behalf, oldest first: the audit row of every attempt the
 * worker sent, with the article it was about. The fake TypeSafe server only counts the requests it
 * receives, so this tells which article each of them was for.
 */
const engineCalls: Hook<{ email: string }> = {
  parse: (params) => ({ email: emailAddress(record(params, ['email'])['email'], 'email') }),
  async run(db, { email }) {
    const { rows } = await db.query(
      `SELECT c.id::text AS "id", c.article_id::text AS "articleId", c.kind AS "kind",
              c.engine AS "engine", c.status AS "status"
         FROM engine_calls c
         JOIN users u ON u.id = c.user_id
        WHERE u.email = $1
        ORDER BY c.id`,
      [email],
    );
    return rows as EngineCallRow[];
  },
};

export interface FeedbackEventRow {
  id: string;
  kind: string;
  rating: number | null;
  reason: string | null;
  analysisRequestId: string | null;
}

/**
 * The feedback events one account stored for one article, oldest first, with what a rating carries:
 * the rating, the reason of a dislike and the analysis request a selected article was rated under.
 * The API shows the outcome of a rating but not the request id it was stored with.
 */
const feedbackEvents: Hook<{ email: string; articleId: string }> = {
  parse(params) {
    const fields = record(params, ['email', 'articleId']);
    return {
      email: emailAddress(fields['email'], 'email'),
      articleId: databaseId(fields['articleId'], 'articleId'),
    };
  },
  async run(db, { email, articleId }) {
    const { rows } = await db.query(
      `SELECT e.id::text AS "id", e.kind AS "kind", e.value -> 'rating' AS "rating",
              e.value ->> 'reason' AS "reason",
              e.value ->> 'analysisRequestId' AS "analysisRequestId"
         FROM feedback_events e
         JOIN users u ON u.id = e.user_id
        WHERE u.email = $1 AND e.article_id = $2::bigint
        ORDER BY e.id`,
      [email, articleId],
    );
    return rows as FeedbackEventRow[];
  },
};

/**
 * What `house.purge-bodies` does to a bookmark snapshot at 30 days (spec 11 §5.2), which M8 has not
 * built yet: the snapshot is marked cold and the redundant hot copy of the article's full text and
 * HTML is removed; the snapshot keeps its content.
 */
const markSnapshotCold: Hook<{ snapshotId: string }> = {
  parse: (params) => ({
    snapshotId: databaseId(record(params, ['snapshotId'])['snapshotId'], 'snapshotId'),
  }),
  async run(db, { snapshotId }) {
    const { rows } = await db.query(
      `WITH cold AS (
         UPDATE article_snapshots SET cold_at = now()
          WHERE id = $1::bigint AND cold_at IS NULL
          RETURNING article_id
       ), removed AS (
         UPDATE article_bodies b SET body_text = NULL, body_html = NULL
           FROM cold c
          WHERE b.article_id = c.article_id
          RETURNING b.article_id
       )
       SELECT (SELECT count(*) FROM cold)::int AS "markedCold",
              (SELECT count(*) FROM removed)::int AS "hotCopiesRemoved"`,
      [snapshotId],
    );
    return rows[0];
  },
};

/**
 * Leaves an article with no stored text: no feed excerpt and no stored body. Every fixture item
 * carries a description, so a bookmark that can neither read its page nor fall back on the feed's
 * text (capture `failed`, `no_content`) needs this to exist, as it would for a feed item that
 * arrived without a description.
 */
const clearArticleText: Hook<{ articleId: string }> = {
  parse: (params) => ({
    articleId: databaseId(record(params, ['articleId'])['articleId'], 'articleId'),
  }),
  async run(db, { articleId }) {
    const { rows } = await db.query(
      `WITH cleared AS (
         UPDATE articles SET excerpt = NULL, excerpt_html = NULL
          WHERE id = $1::bigint
          RETURNING id
       ), emptied AS (
         UPDATE article_bodies SET body_text = NULL, body_html = NULL, body_lead = NULL
          WHERE article_id = $1::bigint
          RETURNING article_id
       )
       SELECT (SELECT count(*) FROM cleared)::int AS "articles",
              (SELECT count(*) FROM emptied)::int AS "bodies"`,
      [articleId],
    );
    return rows[0];
  },
};

export const READER_HOOKS: readonly NamedHook[] = [
  ['fetchFeedNow', runner(fetchFeedNow)],
  ['analysisRequests', runner(analysisRequests)],
  ['markSnapshotCold', runner(markSnapshotCold)],
  ['clearArticleText', runner(clearArticleText)],
  ['engineCalls', runner(engineCalls)],
  ['articleFeedback', runner(feedbackEvents)],
];
