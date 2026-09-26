import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { getArticleBody, type StoredArticleBody } from './bodies.js';

/**
 * Worker side of durable bookmark capture (`article.capture-bookmark`, spec 03 §8.5 steps 3–5;
 * spec 02 §3.5, §5.2 "Bookmark binding", §6). The API's `capture_bookmark_snapshot` binds whatever
 * trusted content already exists and leaves the generation `pending` when it is absent or partial;
 * the worker then captures the best available content without any model inference and completes the
 * still-pending generations here. Snapshot rows are immutable: a better capture is a new row.
 */

/** Text + HTML cap in UTF-8 bytes: the `article_snapshots` CHECK (spec 02 §3). */
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

const DECIMAL = /^[0-9]{1,19}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest stored capture error code (a bounded machine code, never a URL or response text). */
const MAX_ERROR_CODE_LENGTH = 64;

export interface PendingCapture {
  userId: string;
  generation: string;
  /** The snapshot bound now (the API binds the feed excerpt as a partial one while pending). */
  snapshotId: string | null;
  snapshotCompleteness: 'complete' | 'partial' | null;
  originFeedId: string | null;
}

export interface CaptureSource {
  articleId: string;
  /** The observed `content_revision`: pass it back as `observedRevision` on completion. */
  revision: string;
  url: string | null;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  excerpt: string | null;
  excerptHtml: string | null;
  /** The stored body row, whatever its revision: only a row at `revision` is current content. */
  body: StoredArticleBody | null;
  pending: PendingCapture[];
}

/**
 * Current pending bookmark generations (bookmarked_at set, capture status 'pending') of the article
 * with the stored content to prefer before any network fetch; null when the article is gone.
 * Readers of soft-deleted accounts are left out (no capture work for them). Pending generations
 * are in user UUID order.
 */
export async function loadCaptureSource(
  db: Executor,
  articleId: string,
): Promise<CaptureSource | null> {
  const articles = await db.execute<{
    revision: string;
    url: string | null;
    title: string;
    author: string | null;
    published_at: Date | null;
    excerpt: string | null;
    excerpt_html: string | null;
  }>(sql`
    SELECT content_revision::text AS revision, url, title, author, published_at, excerpt,
           excerpt_html
      FROM articles WHERE id = ${articleId}::bigint`);
  const article = articles.rows[0];
  if (article === undefined) return null;
  const pending = await db.execute<{
    user_id: string;
    generation: string;
    snapshot_id: string | null;
    snapshot_completeness: 'complete' | 'partial' | null;
    origin_feed_id: string | null;
  }>(sql`
    SELECT ua.user_id::text AS user_id, ua.bookmark_capture_generation::text AS generation,
           ua.bookmark_snapshot_id::text AS snapshot_id, s.completeness AS snapshot_completeness,
           ua.bookmark_origin_feed_id::text AS origin_feed_id
      FROM user_article ua
      JOIN users u ON u.id = ua.user_id AND u.deleted_at IS NULL
      LEFT JOIN article_snapshots s ON s.id = ua.bookmark_snapshot_id
     WHERE ua.article_id = ${articleId}::bigint AND ua.bookmarked_at IS NOT NULL
       AND ua.bookmark_capture_status = 'pending'
     ORDER BY ua.user_id`);
  return {
    articleId,
    revision: article.revision,
    url: article.url,
    title: article.title,
    author: article.author,
    publishedAt: article.published_at === null ? null : new Date(article.published_at),
    excerpt: article.excerpt,
    excerptHtml: article.excerpt_html,
    body: await getArticleBody(db, articleId),
    pending: pending.rows.map((row) => ({
      userId: row.user_id,
      generation: row.generation,
      snapshotId: row.snapshot_id,
      snapshotCompleteness: row.snapshot_completeness,
      originFeedId: row.origin_feed_id,
    })),
  };
}

export interface CapturedContent {
  /** Must equal the completion's `observedRevision`: content is frozen from the observed source. */
  sourceRevision: string;
  sourceUrl: string | null;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  /** Full available readable text (never model-truncated); text + HTML ≤ 10 MiB of UTF-8. */
  bodyText: string;
  bodyHtml: string | null;
  /** `partial` for a feed summary, teaser, truncation or known omission (spec 03 §8.5 step 4). */
  completeness: 'complete' | 'partial';
  completenessReason: string | null;
  source: 'feed' | 'page';
  extractorVersion: string;
}

export type CaptureOutcome =
  { status: 'captured'; content: CapturedContent } | { status: 'failed'; errorCode: string };

export interface CaptureCompletion {
  /** Generations that received their terminal capture status. */
  bound: number;
  /** Requested generations that are no longer pending at that generation (or were never). */
  skipped: number;
  /**
   * The article's revision moved past `observedRevision`: nothing was bound; retry from the current
   * source.
   */
  revisionChanged: boolean;
}

function assertCompletionInput(input: {
  articleId: string;
  observedRevision: string;
  generations: ReadonlyArray<{ userId: string; generation: string }>;
  outcome: CaptureOutcome;
}): void {
  if (!DECIMAL_ID.test(input.articleId) || !DECIMAL_ID.test(input.observedRevision)) {
    throw new TypeError('articleId and observedRevision must be positive decimal strings');
  }
  for (const { userId, generation } of input.generations) {
    if (!UUID.test(userId) || !DECIMAL.test(generation)) {
      throw new TypeError('each generation needs a UUID userId and a decimal generation');
    }
  }
  if (input.outcome.status !== 'captured') return;
  const content = input.outcome.content;
  if (content.sourceRevision !== input.observedRevision) {
    throw new TypeError(
      'captured content must come from the observed revision (sourceRevision = observedRevision)',
    );
  }
  const bytes =
    Buffer.byteLength(content.bodyText, 'utf8') +
    (content.bodyHtml === null ? 0 : Buffer.byteLength(content.bodyHtml, 'utf8'));
  if (bytes > MAX_CONTENT_BYTES) {
    throw new RangeError(
      `captured text + HTML is ${bytes} UTF-8 bytes, above the 10 MiB (${MAX_CONTENT_BYTES}) ` +
        'snapshot limit: truncate well-formed and mark the capture partial (spec 03 §8.1 step 6)',
    );
  }
}

/** Whether captured content has readable (non-blank) text or HTML. */
function readable(content: CapturedContent): boolean {
  return (
    /\S/u.test(content.bodyText) || (content.bodyHtml !== null && /\S/u.test(content.bodyHtml))
  );
}

/** A bounded machine code for `bookmark_capture_error_code`. */
function captureErrorCode(code: string): string {
  const cleaned = code
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_ERROR_CODE_LENGTH);
  return cleaned === '' ? 'capture_failed' : cleaned;
}

/**
 * Insert the immutable snapshot, or reuse the identical row of this revision (`UNIQUE (article_id,
 * source_revision, content_sha256)`, so readers of one article share one row), with the same
 * canonical checksum as the API-side capture: `snapshot_content_sha256(title, author,
 * published_at, source_url, body_text, body_html)` over the exact stored values. Each value is
 * sent once. Returns the row's id and its stored completeness (a reused row keeps its own).
 */
async function insertSnapshot(
  tx: Transaction,
  articleId: string,
  content: CapturedContent,
): Promise<{ id: string; completeness: 'complete' | 'partial' }> {
  const result = await tx.execute<{
    inserted_id: string | null;
    inserted_completeness: 'complete' | 'partial' | null;
    sha: string;
  }>(sql`
    WITH v AS MATERIALIZED (
      SELECT ${articleId}::bigint AS article_id,
             ${content.sourceRevision}::bigint AS source_revision,
             ${content.sourceUrl}::text AS source_url, ${content.title}::text AS title,
             ${content.author}::text AS author, ${content.publishedAt}::timestamptz AS published_at,
             ${content.bodyText}::text AS body_text, ${content.bodyHtml}::text AS body_html),
    h AS MATERIALIZED (
      SELECT v.*, snapshot_content_sha256(v.title, v.author, v.published_at, v.source_url,
                                          v.body_text, v.body_html) AS sha
        FROM v),
    ins AS (
      INSERT INTO article_snapshots (article_id, source_revision, source_url, title, author,
                                     published_at, body_text, body_html, content_sha256,
                                     completeness, completeness_reason, source, extractor_version)
      SELECT h.article_id, h.source_revision, h.source_url, h.title, h.author, h.published_at,
             h.body_text, h.body_html, h.sha, ${content.completeness},
             ${content.completenessReason}, ${content.source}, ${content.extractorVersion}
        FROM h
      ON CONFLICT (article_id, source_revision, content_sha256) DO NOTHING
      RETURNING id, completeness)
    SELECT (SELECT id::text FROM ins) AS inserted_id,
           (SELECT completeness FROM ins) AS inserted_completeness, h.sha
      FROM h`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('snapshot insert returned no row');
  if (row.inserted_id !== null && row.inserted_completeness !== null) {
    return { id: row.inserted_id, completeness: row.inserted_completeness };
  }
  // The identical capture exists (possibly committed by a concurrent transaction this statement
  // waited for): a new statement sees it.
  const existing = await tx.execute<{ id: string; completeness: 'complete' | 'partial' }>(sql`
    SELECT id::text AS id, completeness FROM article_snapshots
     WHERE article_id = ${articleId}::bigint AND source_revision = ${content.sourceRevision}::bigint
       AND content_sha256 = ${row.sha}`);
  const reused = existing.rows[0];
  if (reused === undefined) throw new Error('conflicting snapshot row not found');
  return reused;
}

type ReaderRow = {
  user_id: string;
  generation: string;
  bookmarked: boolean;
  status: string | null;
  snapshot_id: string | null;
  snapshot_completeness: 'complete' | 'partial' | null;
  snapshot_readable: boolean;
};

type Binding = {
  userId: string;
  generation: string;
  snapshotId: string | null;
  status: 'saved' | 'partial' | 'failed';
  errorCode: string | null;
  /** The previous binding this one replaces (its final reference may have detached). */
  released: string | null;
};

/**
 * spec 03 §8.5 step 5: lock the article then the user rows; bind only still-pending matching
 * generations at the observed revision.
 *
 * In the caller's short transaction, with no network work:
 * 1. lock the article `FOR NO KEY UPDATE` (serializing with the API's bookmark helpers, which hold
 *    it `FOR SHARE`, with resets and with other completions); gone → nothing bound; its
 *    `content_revision` ≠ `observedRevision` → `revisionChanged` and nothing bound, existing saved
 *    content untouched (the caller retries from the current source instead of mislabeling stale
 *    input);
 * 2. lock the requested readers' `user_article` rows `FOR UPDATE` in user UUID order and keep only
 *    generations still current: bookmarked, status `pending`, `bookmark_capture_generation` equal
 *    to the captured one. An unbookmark or rebookmark advanced the generation, so a late worker can
 *    never resurrect an unbookmark or change a newer generation;
 * 3. `captured`: insert or reuse the immutable snapshot (only when a generation will bind it; an
 *    unbound row would never be garbage-collected), clear its `unreferenced_at` under its row
 *    lock, and bind it: status `saved` for a complete row, `partial` otherwise (a teaser or feed
 *    summary);
 * 4. `failed` (and `captured` content without readable text, as `no_content`): keep the bookmark
 *    and its current binding, never fabricating text: `partial` with the error code as its reason
 *    when a partial snapshot with readable content is bound (spec 03 §8.5 step 1: terminal
 *    `partial` once the attempt cannot improve it), otherwise `failed` with the bounded error code;
 * 5. a bound complete snapshot is never replaced (by a partial, failed or other capture): the
 *    generation completes as `saved` with it;
 * 6. `mark_snapshot_if_unreferenced` on every replaced binding, in id order.
 *
 * Lock order: article → reader rows (UUID order) → the bound snapshot → released snapshots. It
 * never locks `users` rows, so it cannot deadlock with the API helpers (users → article → reader).
 */
export async function completeBookmarkCapture(
  tx: Transaction,
  input: {
    articleId: string;
    observedRevision: string;
    generations: ReadonlyArray<{ userId: string; generation: string }>;
    outcome: CaptureOutcome;
  },
): Promise<CaptureCompletion> {
  assertCompletionInput(input);
  const { articleId } = input;
  // Blank "captured" content is no readable content: an honest failure, never an empty archive.
  const outcome: CaptureOutcome =
    input.outcome.status === 'captured' && !readable(input.outcome.content)
      ? { status: 'failed', errorCode: 'no_content' }
      : input.outcome;
  const requested = new Map<string, { userId: string; generation: string }>();
  for (const g of input.generations) {
    const userId = g.userId.toLowerCase();
    const generation = BigInt(g.generation).toString();
    requested.set(`${userId}:${generation}`, { userId, generation });
  }

  const locked = await tx.execute<{ revision: string }>(sql`
    SELECT content_revision::text AS revision FROM articles
     WHERE id = ${articleId}::bigint FOR NO KEY UPDATE`);
  const article = locked.rows[0];
  if (article === undefined) return { bound: 0, skipped: requested.size, revisionChanged: false };
  if (article.revision !== input.observedRevision) {
    return { bound: 0, skipped: requested.size, revisionChanged: true };
  }
  if (requested.size === 0) return { bound: 0, skipped: 0, revisionChanged: false };

  const userIds = [...new Set([...requested.values()].map((g) => g.userId))].sort();
  const readers = await tx.execute<ReaderRow>(sql`
    SELECT ua.user_id::text AS user_id, ua.bookmark_capture_generation::text AS generation,
           ua.bookmarked_at IS NOT NULL AS bookmarked, ua.bookmark_capture_status AS status,
           ua.bookmark_snapshot_id::text AS snapshot_id, s.completeness AS snapshot_completeness,
           coalesce(s.body_text <> '' OR coalesce(s.body_html, '') <> '', false)
             AS snapshot_readable
      FROM user_article ua
      LEFT JOIN article_snapshots s ON s.id = ua.bookmark_snapshot_id
     WHERE ua.article_id = ${articleId}::bigint
       AND ua.user_id = ANY(${sql.param(userIds)}::uuid[])
     ORDER BY ua.user_id
       FOR UPDATE OF ua`);
  const current = readers.rows.filter(
    (row) =>
      row.bookmarked &&
      row.status === 'pending' &&
      requested.has(`${row.user_id}:${row.generation}`),
  );
  if (current.length === 0) return { bound: 0, skipped: requested.size, revisionChanged: false };

  let captured: { id: string; completeness: 'complete' | 'partial' } | null = null;
  if (
    outcome.status === 'captured' &&
    current.some((r) => r.snapshot_completeness !== 'complete')
  ) {
    captured = await insertSnapshot(tx, articleId, outcome.content);
    // Attach: clear the unreferenced marker under the snapshot row lock (as the API helper does).
    await tx.execute(sql`
      SELECT 1 FROM article_snapshots WHERE id = ${captured.id}::bigint FOR UPDATE`);
    await tx.execute(sql`
      UPDATE article_snapshots SET unreferenced_at = NULL
       WHERE id = ${captured.id}::bigint AND unreferenced_at IS NOT NULL`);
  }

  const bindings: Binding[] = current.map((row) => {
    const keep = { userId: row.user_id, generation: row.generation, snapshotId: row.snapshot_id };
    if (row.snapshot_completeness === 'complete') {
      return { ...keep, status: 'saved', errorCode: null, released: null };
    }
    if (captured !== null) {
      return {
        ...keep,
        snapshotId: captured.id,
        status: captured.completeness === 'complete' ? 'saved' : 'partial',
        errorCode: null,
        released:
          row.snapshot_id !== null && row.snapshot_id !== captured.id ? row.snapshot_id : null,
      };
    }
    const code = outcome.status === 'failed' ? captureErrorCode(outcome.errorCode) : null;
    return {
      ...keep,
      status: row.snapshot_id !== null && row.snapshot_readable ? 'partial' : 'failed',
      errorCode: code,
      released: null,
    };
  });

  const updated = await tx.execute(sql`
    UPDATE user_article ua
       SET bookmark_snapshot_id = v.snapshot_id, bookmark_capture_status = v.status,
           bookmark_capture_error_code = v.error_code
      FROM unnest(${sql.param(bindings.map((b) => b.userId))}::uuid[],
                  ${sql.param(bindings.map((b) => b.generation))}::bigint[],
                  ${sql.param(bindings.map((b) => b.snapshotId))}::bigint[],
                  ${sql.param(bindings.map((b) => b.status))}::text[],
                  ${sql.param(bindings.map((b) => b.errorCode))}::text[])
           AS v(user_id, generation, snapshot_id, status, error_code)
     WHERE ua.article_id = ${articleId}::bigint AND ua.user_id = v.user_id
       AND ua.bookmark_capture_generation = v.generation AND ua.bookmarked_at IS NOT NULL
       AND ua.bookmark_capture_status = 'pending'`);
  const bound = updated.rowCount ?? 0;

  const released = [
    ...new Set(bindings.map((b) => b.released).filter((id): id is string => id !== null)),
  ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  for (const snapshotId of released) {
    await tx.execute(sql`SELECT mark_snapshot_if_unreferenced(${snapshotId}::bigint)`);
  }
  return { bound, skipped: requested.size - bound, revisionChanged: false };
}
