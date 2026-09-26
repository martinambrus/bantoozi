import type { JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import {
  FEED_BODY_EXTRACTOR,
  getArticleBody,
  upsertArticleBody,
  type ArticleBodyInput,
  type StoredArticleBody,
} from './bodies.js';
import {
  applyMediaSignals,
  assertImageCount,
  isFeedMediaBody,
  isMediaBody,
  type MediaSignalUpdate,
} from './media.js';
import { resetArticleAnswers } from './reset.js';

/**
 * Extraction results, aliases and revision fencing (spec 03 §8.1, §2.1; spec 02 §3.3). The
 * `article.extract` handler loads the article, snapshots `content_revision` before any network
 * work, and publishes its terminal result in one short transaction here. The next pipeline stage
 * is never decided here: a `saved` result with `advanced: true` means the caller runs
 * `pipeline.after('extract')` for the returned revision in the same transaction.
 */

/** Extracted text + HTML cap in UTF-8 bytes: the `article_bodies`/`article_snapshots` CHECK. */
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;

/** An ISO 639-1 code, `und`, or a publisher hint outside the detector whitelist (spec 03 §8.3). */
const LANG_CODE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,4}$/;

export interface ArticleForExtraction {
  id: string;
  url: string | null;
  canonicalUrl: string;
  urlKey: string;
  revision: string;
  pipelineState: string;
  title: string;
  excerpt: string | null;
  author: string | null;
  publishedAt: Date | null;
  lang: string | null;
  langConfidence: number | null;
  /**
   * lang_hint of the article's carrier feeds (non-null, distinct) — the caller picks the hint for
   * detectLanguage. Ordered by carrier precedence: the source feed (earliest
   * `feed_items.first_seen_at`, tie: feed ID, spec 03 §7) first.
   */
  carrierLangHints: string[];
  /** The stored body row, whatever its revision (feed-v1 fallback or a previous extraction). */
  body: StoredArticleBody | null;
}

/**
 * The article as the extraction handler needs it before any network work (spec 03 §8.1, §2.1):
 * its identity keys, the input revision to fence the result with, the feed text language detection
 * runs on, the carriers' language hints and the stored body. `null` when the article is gone (a
 * merged-away article's queued jobs are successful no-ops, spec 03 §8.4).
 */
export async function loadArticleForExtraction(
  db: Executor,
  articleId: string,
): Promise<ArticleForExtraction | null> {
  const result = await db.execute<{
    id: string;
    url: string | null;
    canonical_url: string;
    url_key: string;
    revision: string;
    pipeline_state: string;
    title: string;
    excerpt: string | null;
    author: string | null;
    published_at: Date | null;
    lang: string | null;
    lang_confidence: number | null;
    carrier_lang_hints: string[];
  }>(sql`
    SELECT a.id::text AS id, a.url, a.canonical_url, a.url_key,
           a.content_revision::text AS revision, a.pipeline_state, a.title, a.excerpt, a.author,
           a.published_at, a.lang, a.lang_confidence,
           array(SELECT h.lang_hint
                   FROM (SELECT DISTINCT ON (f.lang_hint) f.lang_hint, fi.first_seen_at, fi.feed_id
                           FROM feed_items fi JOIN feeds f ON f.id = fi.feed_id
                          WHERE fi.article_id = a.id AND f.lang_hint IS NOT NULL
                            AND f.lang_hint <> ''
                          ORDER BY f.lang_hint, fi.first_seen_at, fi.feed_id) h
                  ORDER BY h.first_seen_at, h.feed_id) AS carrier_lang_hints
      FROM articles a
     WHERE a.id = ${articleId}::bigint`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    urlKey: row.url_key,
    revision: row.revision,
    pipelineState: row.pipeline_state,
    title: row.title,
    excerpt: row.excerpt,
    author: row.author,
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
    lang: row.lang,
    langConfidence: row.lang_confidence,
    carrierLangHints: row.carrier_lang_hints,
    body: await getArticleBody(db, articleId),
  };
}

/** The media signals of an extraction result (spec 03 §6.4, §8.1 step 6), read before sanitizing. */
export interface ExtractionMediaSignals {
  /**
   * Page video evidence (a `<video>` element or a player embed in the Readability fragment), or a
   * URL skipped for its `VIDEO_HOSTS` host (§8.1 step 1).
   */
  videoEvidence: boolean;
  /**
   * The §6.4 in-body image count of the Readability fragment when `body` carries a readable page
   * body; otherwise null.
   */
  bodyImageCount: number | null;
  /**
   * A Readability fragment was examined for media. False for a result without a parsed page
   * (skipped, blocked, not_html, a failed fetch, no Readability result, a linkless article's feed
   * text).
   */
  pageBodyExamined: boolean;
}

export interface ExtractionOutcome {
  articleId: string;
  /**
   * The content_revision the worker snapshotted before its network work (revision fencing, spec 03
   * §2.1).
   */
  expectedRevision: string;
  /**
   * The terminal result: ok, skipped, blocked, not_html, too_large or failed (with bodyText null
   * when nothing was extracted). Text + HTML must fit 10 MiB of UTF-8 (the caller truncates
   * well-formed and records `too_large`/partial, spec 03 §8.1 step 6); a larger body is rejected
   * before anything is written.
   */
  body: ArticleBodyInput;
  /**
   * Language detected on the available text (title + excerpt + body lead). When the result has no
   * text, detect on the stored body's lead ({@link ArticleForExtraction.body}) if it has one: a
   * kept body stays the article's text.
   */
  lang: { lang: string; confidence: number };
  /**
   * Whitespace token count of body_text, or of the excerpt when there is no body. When the stored
   * body of this revision is kept instead of the result (see {@link saveExtractionResult}), the
   * count of the kept text is stored.
   */
  wordCount: number | null;
  /**
   * The result's media signals; see {@link saveExtractionResult} for how they are stored with the
   * body.
   */
  media: ExtractionMediaSignals;
  /**
   * An explicitly requested re-extraction of an already processed revision (an extractor upgrade
   * or an admin reprocess). Without it, a result for a revision that no longer awaits extraction
   * (a duplicate or late job) is a no-op (spec 03 §2.1).
   */
  upgrade?: boolean;
}

export type SaveExtractionResult =
  | { status: 'saved'; revision: string; advanced: boolean; reset: boolean }
  | { status: 'stale_revision'; revision: string }
  | { status: 'missing' }
  | { status: 'unchanged'; revision: string };

/** Whitespace token count (spec 03 §8.1 step 6 `word_count`). */
function countWords(text: string): number {
  let count = 0;
  for (const _token of text.matchAll(/\S+/gu)) count += 1;
  return count;
}

/** Whether a body carries readable content: non-blank text or HTML. */
function hasContent(body: { bodyText: string | null; bodyHtml: string | null }): boolean {
  return (
    (body.bodyText !== null && /\S/u.test(body.bodyText)) ||
    (body.bodyHtml !== null && /\S/u.test(body.bodyHtml))
  );
}

/** UTF-8 bytes of text + HTML, as the table CHECK counts them. */
function contentBytes(text: string | null, html: string | null): number {
  return (
    (text === null ? 0 : Buffer.byteLength(text, 'utf8')) +
    (html === null ? 0 : Buffer.byteLength(html, 'utf8'))
  );
}

function assertOutcome(outcome: ExtractionOutcome): void {
  if (!DECIMAL_ID.test(outcome.articleId) || !DECIMAL_ID.test(outcome.expectedRevision)) {
    throw new TypeError('articleId and expectedRevision must be positive decimal strings');
  }
  const bytes = contentBytes(outcome.body.bodyText, outcome.body.bodyHtml);
  if (bytes > MAX_CONTENT_BYTES) {
    throw new RangeError(
      `extracted text + HTML is ${bytes} UTF-8 bytes, above the 10 MiB (${MAX_CONTENT_BYTES}) ` +
        'limit: truncate well-formed and record too_large/partial before saving (spec 03 §8.1)',
    );
  }
  const { lang, confidence } = outcome.lang;
  if (typeof lang !== 'string' || lang.length > 35 || !LANG_CODE.test(lang)) {
    throw new TypeError('lang must be an ISO 639 code or und');
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError('lang confidence must be within [0, 1]');
  }
  const words = outcome.wordCount;
  if (words !== null && (!Number.isSafeInteger(words) || words < 0)) {
    throw new RangeError('wordCount must be a non-negative integer or null');
  }
  const { media } = outcome;
  if (typeof media.videoEvidence !== 'boolean' || typeof media.pageBodyExamined !== 'boolean') {
    throw new TypeError('media.videoEvidence and media.pageBodyExamined must be booleans');
  }
  assertImageCount('media.bodyImageCount', media.bodyImageCount);
  if (media.bodyImageCount !== null && !media.pageBodyExamined) {
    throw new RangeError('media.bodyImageCount is counted on an examined Readability fragment');
  }
}

/**
 * The media-signal write of an extraction that stores or keeps a body (spec 03 §6.4, §8.1 step 6).
 * `stored` says which row `article_bodies` holds once this call commits: `'result'` when the
 * result's body was stored or installed, `'kept'` when the stored row `kept` stays instead.
 * - `body_image_count`: a stored page body with content brings the fragment's count; while no body
 *   with content is stored (none, no content, or only a linkless article's excerpt) it is null; a
 *   kept body, or a re-stored publisher feed body, keeps the count that already describes it.
 * - `has_video`: true on video evidence; otherwise false only while it is null and a page body was
 *   examined or a publisher feed body (examined at ingestion) is the stored body; never true →
 *   false.
 */
function extractionMedia(
  outcome: ExtractionOutcome,
  stored: 'result' | 'kept',
  kept: StoredArticleBody | null,
): MediaSignalUpdate {
  const after = stored === 'result' ? outcome.body : kept;
  const update: MediaSignalUpdate = {};
  if (after === null || !isMediaBody(after)) {
    update.bodyImageCount = null;
  } else if (stored === 'result' && after.extractorVersion !== FEED_BODY_EXTRACTOR) {
    update.bodyImageCount = outcome.media.bodyImageCount;
  }
  if (outcome.media.videoEvidence) {
    update.hasVideo = true;
  } else if (outcome.media.pageBodyExamined || (after !== null && isFeedMediaBody(after))) {
    update.hasVideo = false;
  }
  return update;
}

/**
 * Whether the stored body row is kept instead of the new result `next` for `revision` (spec 03
 * §8.1 step 8, §7 step 6): a result without readable content never replaces stored content (a
 * feed-v1 fallback, or a previous good extraction, also of an older revision, which stays readable
 * but is no model input), and a partial result never replaces a complete `ok` body of the same
 * revision (a paywall teaser does not replace the publisher's full feed body).
 */
function keepsStoredBody(
  stored: StoredArticleBody | null,
  revision: string,
  next: ArticleBodyInput,
): boolean {
  if (stored === null || !hasContent(stored)) return false;
  if (!hasContent(next)) return true;
  return (
    stored.articleRevision === revision &&
    stored.status === 'ok' &&
    stored.completeness === 'complete' &&
    next.completeness === 'partial'
  );
}

async function setLanguage(
  tx: Transaction,
  articleId: string,
  outcome: ExtractionOutcome,
  wordCount: number | null,
  advance: boolean,
): Promise<void> {
  await tx.execute(sql`
    UPDATE articles
       SET lang = ${outcome.lang.lang}, lang_confidence = ${outcome.lang.confidence},
           word_count = ${wordCount},
           pipeline_state = CASE WHEN ${advance}::boolean AND pipeline_state = 'ingested'
                                 THEN 'extracted' ELSE pipeline_state END,
           updated_at = now()
     WHERE id = ${articleId}::bigint`);
}

/**
 * Publish an extraction result under revision fencing (spec 03 §8.1 steps 6–8, §2.1; spec 02 §3.3),
 * in the caller's transaction. Locks the article `FOR UPDATE` (after any url_key advisory lock of
 * {@link addArticleAlias}, as ingestion orders them), then:
 * - gone → `missing`; `content_revision` ≠ `expectedRevision` → `stale_revision` and nothing is
 *   written (out-of-order results never overwrite a newer revision; the transaction that advanced
 *   the revision recorded its own work);
 * - `ingested` (the pending extraction of this revision), for **every** terminal status: store the
 *   body at this revision, set `lang`, `lang_confidence`, `word_count` and move to `extracted` →
 *   `saved` with `advanced: true`. A stored body with content is kept instead of a result without
 *   one, and a complete `ok` body of this revision instead of a partial result; `word_count` then
 *   counts the kept body, whatever its revision;
 * - `stale`: stored like the pending extraction but the state stays `stale` (`advanced: false`); a
 *   changed re-extraction of a revision that already has a page extraction resets as below, in its
 *   stale-preserving form;
 * - any other state: a duplicate or late job for a processed revision is `unchanged` with nothing
 *   written (spec 03 §2.1). Only an explicit `upgrade` re-extraction with a genuinely changed body
 *   text/HTML or language runs one `resetArticleAnswers` (`body_changed` installing the new body at
 *   the incremented revision, or `lang_changed` keeping the current body), then sets the new
 *   language → `saved` with `reset: true` and `advanced` unless the article is stale. An empty or
 *   partial upgrade that keeps the stored body is `unchanged` too, whatever language it detected
 *   without that body.
 * Every `saved` result also writes the media signals (spec 03 §6.4, §8.1 step 6) through
 * {@link applyMediaSignals}, in the same transaction as the body: a stored page body with content
 * brings its fragment's `body_image_count`, a stored result without a body (no content, or only the
 * excerpt of a linkless article) sets it to null, and a kept body or a re-stored publisher feed
 * body keeps its count; `has_video` becomes true on video evidence, or false while it is null and
 * a page body was examined or a publisher feed body is stored. A change increments
 * `media_revision` and ranks the carriers' subscribers; `missing`, `stale_revision` and
 * `unchanged` write no media signals.
 * The caller runs `pipeline.after('extract')` (the demand gate) when `advanced`; extraction is
 * never re-enqueued from here.
 */
export async function saveExtractionResult(
  tx: Transaction,
  sender: JobSender,
  outcome: ExtractionOutcome,
): Promise<SaveExtractionResult> {
  assertOutcome(outcome);
  const { articleId, expectedRevision: revision } = outcome;
  const locked = await tx.execute<{
    revision: string;
    pipeline_state: string;
    lang: string | null;
  }>(
    sql`
    SELECT content_revision::text AS revision, pipeline_state, lang
      FROM articles WHERE id = ${articleId}::bigint FOR UPDATE`,
  );
  const article = locked.rows[0];
  if (article === undefined) return { status: 'missing' };
  if (article.revision !== revision)
    return { status: 'stale_revision', revision: article.revision };

  const stale = article.pipeline_state === 'stale';
  const stored = await getArticleBody(tx, articleId);
  const extractedBefore =
    stored !== null &&
    stored.articleRevision === revision &&
    stored.extractorVersion !== FEED_BODY_EXTRACTOR;
  const keep = keepsStoredBody(stored, revision, outcome.body);

  if (article.pipeline_state === 'ingested' || (stale && !extractedBefore)) {
    // The pending extraction of this revision: no model result depends on its body yet.
    if (!keep) await upsertArticleBody(tx, articleId, revision, outcome.body);
    // `word_count` counts the body `article_bodies` holds once this commits, the text that
    // `body_image_count` describes (spec 03 §6.4): a kept body, also one of an older revision,
    // instead of the excerpt the result was counted on.
    const keptText = keep && stored !== null ? stored.bodyText : null;
    const wordCount = keptText === null ? outcome.wordCount : countWords(keptText);
    await setLanguage(tx, articleId, outcome, wordCount, !stale);
    await applyMediaSignals(
      tx,
      sender,
      articleId,
      extractionMedia(outcome, keep ? 'kept' : 'result', stored),
    );
    return { status: 'saved', revision, advanced: !stale, reset: false };
  }

  // A re-extraction of an already processed revision: only an explicit upgrade may change it.
  if (outcome.upgrade !== true || keep) return { status: 'unchanged', revision };
  const current = stored !== null && stored.articleRevision === revision ? stored : null;
  const bodyChanged =
    hasContent(outcome.body) &&
    (current === null ||
      current.bodyText !== outcome.body.bodyText ||
      current.bodyHtml !== outcome.body.bodyHtml);
  const langChanged = article.lang !== outcome.lang.lang;
  if (!bodyChanged && !langChanged) return { status: 'unchanged', revision };

  const reset = await resetArticleAnswers(tx, sender, articleId, {
    reason: bodyChanged ? 'body_changed' : 'lang_changed',
    nextState: 'extracted',
    expectedRevision: revision,
    ...(bodyChanged ? { installBody: outcome.body } : { keepBody: true }),
  });
  if (reset.status !== 'reset') {
    throw new Error(`article ${articleId} changed under its row lock (${reset.status})`);
  }
  await setLanguage(tx, articleId, outcome, outcome.wordCount, false);
  await applyMediaSignals(
    tx,
    sender,
    articleId,
    extractionMedia(outcome, bodyChanged ? 'result' : 'kept', stored),
  );
  return { status: 'saved', revision: reset.revision, advanced: !reset.stale, reset: true };
}

export type AliasResult =
  | { status: 'added' | 'exists' }
  | { status: 'owned_by_other'; ownerId: string }
  /** `content_revision` is not the expected revision: nothing was written. */
  | { status: 'stale_revision'; revision: string }
  /** The article no longer exists (merged away or deleted): nothing was written. */
  | { status: 'missing' };

/** The article a url_key names: `articles` first, then `article_aliases`; null when unowned. */
async function urlKeyOwner(tx: Transaction, urlKey: string): Promise<string | null> {
  const result = await tx.execute<{ owner: string }>(sql`
    SELECT owner FROM (
      SELECT id::text AS owner, 0 AS rank FROM articles WHERE url_key = ${urlKey}
      UNION ALL
      SELECT article_id::text, 1 FROM article_aliases WHERE url_key = ${urlKey}) o
     ORDER BY rank LIMIT 1`);
  return result.rows[0]?.owner ?? null;
}

/**
 * Record another url_key that resolves to the article (spec 03 §8.1 steps 4–5), under the same
 * sorted url_key advisory locks as ingestion (pg_advisory_xact_lock(hashtextextended('url_key:' ||
 * key, 0))), rechecking articles AND article_aliases; a key owned by another article returns
 * owned_by_other (the caller merges, §8.4). Global identity is one namespace (spec 02 §3.3): a key
 * never names one article in `articles` and another in `article_aliases`, and an existing owner is
 * never overwritten or silently dropped.
 *
 * Lock order, as in ingestion (spec 03 §7 "Concurrency"): url_key advisory locks first, in one
 * lexical (code-unit) batch covering the new key and the article's own identity keys (its
 * `url_key` and aliases), so a merge that follows (`owned_by_other`, spec 03 §8.4) finds the
 * source's key locks already held instead of taking them after a row lock; then the article row
 * `FOR UPDATE` (a concurrent merge that deleted it: `missing`). That is the mode
 * {@link saveExtractionResult} takes, so an extraction transaction never upgrades its article lock
 * (a weaker lock, even the alias insert's foreign-key `FOR KEY SHARE`, upgraded later can deadlock
 * with a concurrent upgrader such as a source-update reset). Call it before `saveExtractionResult`
 * in the same transaction. A merge still takes its user locks after this row lock, which can
 * deadlock with a concurrent reader action (PostgreSQL detects it, 40P01, and `retryTransaction`
 * re-runs the transaction).
 *
 * `expectedRevision` fences the evidence like {@link saveExtractionResult} fences a result (spec
 * 03 §2.1): the revision whose page produced it. Under the row lock, a different
 * `content_revision` is `stale_revision` and nothing is written, so a page fetched for a revision
 * that a source update replaced meanwhile never aliases or merges the article's newer identity.
 * The row lock is held until the transaction ends, so a later merge in it sees the same revision.
 */
export async function addArticleAlias(
  tx: Transaction,
  articleId: string,
  urlKey: string,
  source: 'redirect' | 'rel_canonical',
  options: { expectedRevision?: string } = {},
): Promise<AliasResult> {
  if (!DECIMAL_ID.test(articleId)) throw new TypeError('articleId must be a decimal string');
  if (typeof urlKey !== 'string' || urlKey.length === 0) {
    throw new TypeError('urlKey must be a non-empty string');
  }
  const { expectedRevision } = options;
  if (expectedRevision !== undefined && !DECIMAL_ID.test(expectedRevision)) {
    throw new TypeError('expectedRevision must be a positive decimal string');
  }
  const identity = await tx.execute<{ url_key: string }>(sql`
    SELECT url_key FROM articles WHERE id = ${articleId}::bigint
    UNION
    SELECT url_key FROM article_aliases WHERE article_id = ${articleId}::bigint`);
  const keys = [...new Set([urlKey, ...identity.rows.map((row) => row.url_key)])].sort();
  for (const key of keys) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('url_key:' || ${key}::text, 0))`,
    );
  }
  const article = await tx.execute<{ revision: string }>(
    sql`SELECT content_revision::text AS revision FROM articles
         WHERE id = ${articleId}::bigint FOR UPDATE`,
  );
  const row = article.rows[0];
  if (row === undefined) return { status: 'missing' };
  if (expectedRevision !== undefined && row.revision !== expectedRevision) {
    return { status: 'stale_revision', revision: row.revision };
  }

  const owner = await urlKeyOwner(tx, urlKey);
  if (owner !== null) {
    return owner === articleId
      ? { status: 'exists' }
      : { status: 'owned_by_other', ownerId: owner };
  }
  const inserted = await tx.execute(sql`
    INSERT INTO article_aliases (url_key, article_id, source)
    VALUES (${urlKey}, ${articleId}::bigint, ${source})
    ON CONFLICT (url_key) DO NOTHING
    RETURNING url_key`);
  if (inserted.rows.length > 0) return { status: 'added' };
  // Under the url_key lock only a writer outside that protocol can have inserted the key since the
  // recheck: this is its conflict path, reporting the owner (never dropping or overwriting it).
  const raced = await urlKeyOwner(tx, urlKey);
  if (raced === null) throw new Error('article alias conflict without an owner');
  return raced === articleId ? { status: 'exists' } : { status: 'owned_by_other', ownerId: raced };
}
