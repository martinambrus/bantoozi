import {
  HookParamsError,
  httpUrl,
  record,
  runner,
  type Hook,
  type HookDb,
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
 * Ages a bookmark snapshot and its article by 31 days so that the real `house.purge-bodies` (spec 11
 * §5.2) finds them due: the snapshot's capture, the stored body's extraction and the article's
 * carrier arrivals all move back. Nothing is marked cold or cleared here.
 */
const ageForColdMaintenance: Hook<{ snapshotId: string }> = {
  parse: (params) => ({
    snapshotId: databaseId(record(params, ['snapshotId'])['snapshotId'], 'snapshotId'),
  }),
  async run(db, { snapshotId }) {
    // The immutability guard (spec 02 §3.6) refuses a change of captured_at, which is the point of
    // ageing it: the real job reads the real clock. The guard is off only for this statement.
    await db.query('ALTER TABLE article_snapshots DISABLE TRIGGER article_snapshots_guard');
    try {
      return await ageStatement(db, snapshotId);
    } finally {
      await db.query('ALTER TABLE article_snapshots ENABLE TRIGGER article_snapshots_guard');
    }
  },
};

async function ageStatement(db: HookDb, snapshotId: string): Promise<unknown> {
  const { rows } = await db.query(
    `WITH snap AS (
         UPDATE article_snapshots SET captured_at = captured_at - interval '31 days'
          WHERE id = $1::bigint
          RETURNING article_id
       ), body AS (
         UPDATE article_bodies b SET extracted_at = b.extracted_at - interval '31 days'
           FROM snap WHERE b.article_id = snap.article_id
          RETURNING b.article_id
       ), items AS (
         UPDATE feed_items fi SET first_seen_at = fi.first_seen_at - interval '31 days'
           FROM snap WHERE fi.article_id = snap.article_id
          RETURNING fi.article_id
       ), art AS (
         UPDATE articles a SET first_seen_at = a.first_seen_at - interval '31 days'
           FROM snap WHERE a.id = snap.article_id
          RETURNING a.id
       )
       SELECT (SELECT count(*) FROM snap)::int AS "snapshots",
              (SELECT count(*) FROM body)::int AS "bodies",
              (SELECT count(*) FROM art)::int AS "articles"`,
    [snapshotId],
  );
  return rows[0];
}

/** Queues the real `house.purge-bodies` through the outbox; the worker relays and runs it. */
const runPurgeBodies: Hook<Record<string, never>> = {
  parse: (params) => {
    record(params, []);
    return {};
  },
  async run(db) {
    const { rows } = await db.query(
      `INSERT INTO job_outbox (queue, payload) VALUES ('house.purge-bodies', '{}'::jsonb)
       RETURNING id`,
    );
    return { queued: rows.length };
  },
};

/** Whether the snapshot is cold and whether its article still holds a hot copy of the text. */
const snapshotMaintenance: Hook<{ snapshotId: string }> = {
  parse: (params) => ({
    snapshotId: databaseId(record(params, ['snapshotId'])['snapshotId'], 'snapshotId'),
  }),
  async run(db, { snapshotId }) {
    const { rows } = await db.query(
      `SELECT (s.cold_at IS NOT NULL) AS "cold",
              (b.body_text IS NOT NULL OR b.body_html IS NOT NULL) AS "hotCopy",
              (s.body_text IS NOT NULL) AS "snapshotHasText"
         FROM article_snapshots s
         LEFT JOIN article_bodies b ON b.article_id = s.article_id
        WHERE s.id = $1::bigint`,
      [snapshotId],
    );
    return rows[0] ?? null;
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
  ['ageForColdMaintenance', runner(ageForColdMaintenance)],
  ['runPurgeBodies', runner(runPurgeBodies)],
  ['snapshotMaintenance', runner(snapshotMaintenance)],
  ['clearArticleText', runner(clearArticleText)],
  ['engineCalls', runner(engineCalls)],
  ['articleFeedback', runner(feedbackEvents)],
];
