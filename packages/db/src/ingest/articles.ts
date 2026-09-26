import type { JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { upsertArticleBody, type ArticleBodyInput } from './bodies.js';
import { applyMediaSignals, assertImageCount, type MediaSignalUpdate } from './media.js';
import { resetArticleAnswers } from './reset.js';

/**
 * Item ingestion inside `feed.fetch` (spec 03 §7): exact URL and feed-scoped GUID identity, feed
 * associations, and publisher updates from an article's source feed, in one short transaction per
 * item. Identity is serialized under url_key advisory locks (spec 02 §3.3); a lost race surfaces as
 * a unique violation that the caller's `retryTransaction` turns into a re-run of the whole item.
 */

/** Prefix of the text hashed into a url_key's transaction advisory lock (spec 02 §3.3). */
export const URL_KEY_LOCK_PREFIX = 'url_key:';

/**
 * Take the transaction advisory lock of every url key in `keys` (spec 03 §7 "Concurrency", spec 02
 * §3.3): `pg_advisory_xact_lock(hashtextextended('url_key:' || key, 0))`, once per distinct key, in
 * lexical order (JavaScript code-unit order), so any two writers of overlapping key sets lock in
 * the same order. Exact keys and aliases share this one namespace: every writer of
 * `articles.url_key` or `article_aliases.url_key` locks the key first and then rechecks **both**
 * tables. Lock order across the identity code: url keys first, then article rows by ascending id.
 * The locks are released at commit or rollback; a hash collision only serializes more.
 */
export async function lockUrlKeys(tx: Transaction, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${URL_KEY_LOCK_PREFIX + key}::text, 0))`,
    );
  }
}

/** The article a url key names, through `articles.url_key` or an `article_aliases` row. */
export interface UrlKeyOwner {
  articleId: string;
  via: 'article' | 'alias';
}

/**
 * The owner of `urlKey` in the shared identity namespace (spec 03 §7 step 2), reading both identity
 * tables in one statement. Call it after {@link lockUrlKeys} to get an answer that holds until
 * commit. Should the invariant ever be broken (a key naming one article in `articles` and another
 * in `article_aliases`), the `articles` row wins.
 */
export async function findUrlKeyOwner(db: Executor, urlKey: string): Promise<UrlKeyOwner | null> {
  const result = await db.execute<{ via: 'article' | 'alias'; article_id: string }>(sql`
    SELECT 'article' AS via, id::text AS article_id FROM articles WHERE url_key = ${urlKey}
    UNION ALL
    SELECT 'alias', article_id::text FROM article_aliases WHERE url_key = ${urlKey}`);
  const row =
    result.rows.find((r) => r.via === 'article') ?? result.rows.find((r) => r.via === 'alias');
  return row === undefined ? null : { articleId: row.article_id, via: row.via };
}

/**
 * The article's source feed (spec 03 §7 step 2): the carrier with the earliest
 * `feed_items.first_seen_at`, ties broken by the lower feed id. Only this feed updates the shared
 * publisher inputs; spec 05 §3.1 picks the article's canonical feed the same way. `null` when the
 * article has no carrier.
 */
export async function articleSourceFeedId(db: Executor, articleId: string): Promise<string | null> {
  // Qualified: a bare `feed_id` in ORDER BY would sort the text output column ('10' < '9').
  const result = await db.execute<{ feed_id: string }>(sql`
    SELECT fi.feed_id::text AS feed_id FROM feed_items fi
     WHERE fi.article_id = ${articleId}::bigint
     ORDER BY fi.first_seen_at, fi.feed_id
     LIMIT 1`);
  return result.rows[0]?.feed_id ?? null;
}

/** The media signals of one feed item (spec 03 §6.4, §7 step 6), read before sanitizing. */
export interface ItemMediaSignals {
  /**
   * `video_evidence`: a §6.4 video rule holds for the item (a video enclosure, JSON Feed
   * attachment or `media:content`, a video-host link, or a `<video>` element or player embed in its
   * excerpt or body HTML).
   */
  videoEvidence: boolean;
  /**
   * `feed_body_image_count`: the §6.4 in-body image count of the item's publisher body
   * (`feed_body_html`). Non-null exactly when the item carries a publisher body, which also means
   * that body was examined for video evidence; it becomes `articles.body_image_count` only while
   * that body is the article's stored fallback body.
   */
  feedBodyImageCount: number | null;
}

/** One normalized item of a feed fetch (spec 03 §6), with its identity keys (spec 03 §5). */
export interface IngestItemInput {
  feedId: string;
  /** `urlKey(canonicalUrl)`, or `linklessUrlKey(feedId, item)` for an item without a link. */
  urlKey: string;
  /** The canonical URL (spec 03 §5); for a linkless item its URN, equal to `urlKey`. */
  canonicalUrl: string;
  /** The navigable http(s) link; null for a linkless item. */
  url: string | null;
  /** RSS guid / Atom id / JSON Feed id, scoped to this feed; null when absent. */
  guid: string | null;
  title: string;
  /** `normalizeText(title)` (spec 03 §6.1). */
  titleNorm: string;
  author: string | null;
  categories: readonly string[];
  excerpt: string | null;
  excerptHtml: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
  /** Spec 03 §6.2: fingerprints the model inputs, not the identity. */
  contentHash: string;
  /**
   * Full publisher body carried by the feed (full-content or linkless feeds), as an
   * `article_bodies` row with extractor `feed-v1` (`FEED_BODY_EXTRACTOR`), status `ok`.
   */
  feedBody: ArticleBodyInput | null;
  /** The item's media signals (spec 03 §6.4); see {@link ingestItem} for how they are stored. */
  media: ItemMediaSignals;
}

export interface IngestItemOptions {
  /** `INGEST_MAX_AGE_DAYS` (default 14): an older `published_at` inserts the article as `stale`. */
  maxAgeDays: number;
}

/**
 * How the item's identity was resolved (spec 03 §7 steps 2–5):
 * - `inserted`: a new article;
 * - `existing`: exact url_key match in `articles` or `article_aliases`;
 * - `guid_alias`: no URL match, but this feed's GUID names an article; the new URL became its
 *   `feed_link` alias (a changed URL with an unchanged GUID keeps identity);
 * - `identity_conflict`: the URL names one article and this feed's GUID another; the URL-owned
 *   article is kept, the GUID stays with its owner, nothing is merged.
 */
export type IngestItemOutcome = 'inserted' | 'existing' | 'guid_alias' | 'identity_conflict';

export interface IngestItemResult {
  articleId: string;
  outcome: IngestItemOutcome;
  /** The article's `content_revision` after this item. */
  revision: string;
  pipelineState: string;
  /**
   * A `feed_items` row was newly inserted for (feedId, articleId), a new article included: the
   * caller runs the new-carrier continuation (`newCarrierDemand`, spec 03 §7).
   */
  newAssociation: boolean;
  /**
   * This feed is the article's source and the item's classification inputs changed:
   * `resetArticleAnswers` ran (in its stale-preserving form for a stale article).
   */
  contentChanged: boolean;
  /**
   * The caller must record extraction for `revision` (through the pipeline): a newly inserted
   * non-stale article, or a reset that did not keep the article stale.
   */
  needsExtraction: boolean;
}

/** Re-resolutions allowed when the resolved article disappears (merged away) before its lock. */
const MAX_IDENTITY_ATTEMPTS = 5;

type ResolvedIdentity =
  | { kind: 'new' }
  | {
      kind: 'found';
      articleId: string;
      outcome: Exclude<IngestItemOutcome, 'inserted'>;
    };

interface LockedArticle {
  revision: string;
  pipelineState: string;
  contentHash: string;
}

/**
 * Ingest one feed item (spec 03 §7) in the caller's short worker transaction; run it through
 * `retryTransaction`, which re-runs the whole item after a unique conflict, serialization failure
 * or deadlock.
 *
 * 1. Lock the item's url key ({@link lockUrlKeys}), then resolve identity inside the transaction,
 *    rechecking `articles`, `article_aliases` and this feed's GUIDs in one statement:
 *    - URL match → that article (`existing`); if this feed's GUID names a different article, it is
 *      an `identity_conflict`: the URL-owned article is kept and associated with a NULL GUID, the
 *      other article keeps its GUID mapping, nothing is merged;
 *    - otherwise a GUID match within this feed → that article, and the new url key becomes its
 *      `feed_link` alias (`guid_alias`);
 *    - otherwise a new article: `stale` when `published_at` is older than `maxAgeDays` (an unknown
 *      date is not stale), else `ingested`, with its association and the carried feed body as the
 *      `feed-v1` fallback at revision 1.
 *    Near-duplicates (equal titles, empty excerpts, shared images) are never merged here: distinct
 *    URLs are distinct articles, and story clustering folds their presentation (step 4).
 * 2. A found article is locked (`FOR UPDATE`, the lock `resetArticleAnswers` takes) and, should a
 *    merge have deleted it meanwhile, identity is resolved again. The feed association is inserted
 *    if missing (`newAssociation`); a pair keeps its first non-null GUID, and a GUID another
 *    article of this feed owns is never taken.
 * 3. Only the source feed ({@link articleSourceFeedId}) updates the shared title, `title_norm`,
 *    author, categories, excerpts, image, publication time and `content_hash`. When its
 *    `content_hash` differs, those columns are updated and `resetArticleAnswers` runs once
 *    (installing the carried feed body at the new revision); a stale article stays stale. A
 *    non-source feed's different summary is never stored and never invalidates the article.
 * 4. Media signals (spec 03 §6.4, §7 step 6):
 *    - a new article starts with `has_video` true on video evidence, else false when the item's
 *      publisher body was examined (`feedBodyImageCount` non-null), else null (unknown), and with
 *      `body_image_count` = `feedBodyImageCount` when that body is stored as its `feed-v1`
 *      fallback, else null (excerpt only); `media_revision` stays 0 and no media rank is recorded
 *      (the new-carrier continuation ranks the feed's subscribers);
 *    - a found article, from any carrier and also when its `content_hash` is unchanged, gets
 *      `has_video = true` on video evidence; without evidence `has_video` is left as it is, and
 *      nothing sets it from true back to false;
 *    - a source update that installs the item's publisher body stores that item's
 *      `feedBodyImageCount` with it; a source update without a body keeps the stored body (at its
 *      old revision) and so its count.
 *    Changes go through {@link applyMediaSignals}, once per item: `media_revision` + 1 and an
 *    incremental rank for the subscribers of every current carrier.
 *
 * No stage work is recorded here (`apps/worker/src/pipeline.ts` decides): the result says whether
 * extraction is needed and whether the new-carrier continuation must run. The only intents written
 * are the reset's and the media writer's rank intents.
 */
export async function ingestItem(
  tx: Transaction,
  sender: JobSender,
  input: IngestItemInput,
  options: IngestItemOptions,
): Promise<IngestItemResult> {
  if (!Number.isInteger(options.maxAgeDays) || options.maxAgeDays < 1) {
    throw new RangeError('ingestItem: maxAgeDays must be a positive integer');
  }
  if (typeof input.media.videoEvidence !== 'boolean') {
    throw new TypeError('ingestItem: media.videoEvidence must be a boolean');
  }
  assertImageCount('ingestItem: media.feedBodyImageCount', input.media.feedBodyImageCount);
  await lockUrlKeys(tx, [input.urlKey]);
  for (let attempt = 1; ; attempt += 1) {
    const identity = await resolveIdentity(tx, input);
    if (identity.kind === 'new') return insertArticle(tx, input, options);
    const article = await lockArticle(tx, identity.articleId);
    if (article !== null) return ingestFound(tx, sender, input, identity, article);
    // The article was merged away after it was resolved: the survivor now owns its keys and GUIDs.
    if (attempt >= MAX_IDENTITY_ATTEMPTS) {
      throw new Error('ingestItem: the resolved article kept disappearing; retry the item later');
    }
  }
}

/** Resolve the item's identity from the url key and this feed's GUID (spec 03 §7 steps 2–3). */
async function resolveIdentity(tx: Transaction, input: IngestItemInput): Promise<ResolvedIdentity> {
  const result = await tx.execute<{ via: 'article' | 'alias' | 'guid'; article_id: string }>(sql`
    SELECT 'article' AS via, id::text AS article_id FROM articles WHERE url_key = ${input.urlKey}
    UNION ALL
    SELECT 'alias', article_id::text FROM article_aliases WHERE url_key = ${input.urlKey}
    UNION ALL
    SELECT 'guid', article_id::text FROM feed_items
     WHERE feed_id = ${input.feedId}::bigint AND guid = ${input.guid}::text`);
  const urlOwner =
    result.rows.find((r) => r.via === 'article') ?? result.rows.find((r) => r.via === 'alias');
  const guidOwner = result.rows.find((r) => r.via === 'guid');
  if (urlOwner !== undefined) {
    return {
      kind: 'found',
      articleId: urlOwner.article_id,
      outcome:
        guidOwner !== undefined && guidOwner.article_id !== urlOwner.article_id
          ? 'identity_conflict'
          : 'existing',
    };
  }
  if (guidOwner !== undefined) {
    return { kind: 'found', articleId: guidOwner.article_id, outcome: 'guid_alias' };
  }
  return { kind: 'new' };
}

/** Lock a resolved article for this item; `null` when it no longer exists. */
async function lockArticle(tx: Transaction, articleId: string): Promise<LockedArticle | null> {
  const result = await tx.execute<{
    revision: string;
    pipeline_state: string;
    content_hash: string;
  }>(sql`
    SELECT content_revision::text AS revision, pipeline_state, content_hash
      FROM articles WHERE id = ${articleId}::bigint FOR UPDATE`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { revision: row.revision, pipelineState: row.pipeline_state, contentHash: row.content_hash };
}

/**
 * Insert a new article with its first association (spec 03 §7 steps 5–6). A concurrent insert of
 * the same key by a writer that skipped the key lock raises 23505, and the caller retries.
 */
async function insertArticle(
  tx: Transaction,
  input: IngestItemInput,
  options: IngestItemOptions,
): Promise<IngestItemResult> {
  const { videoEvidence, feedBodyImageCount } = input.media;
  // Spec 03 §7 step 6: an examined publisher body without evidence makes it false, else unknown.
  const hasVideo = videoEvidence ? true : feedBodyImageCount !== null ? false : null;
  // The count describes the stored body only (spec 03 §6.4): null for an excerpt-only article.
  const bodyImageCount = input.feedBody === null ? null : feedBodyImageCount;
  const inserted = await tx.execute<{ id: string; revision: string; pipeline_state: string }>(sql`
    INSERT INTO articles (url, canonical_url, url_key, title, title_norm, author, categories,
                          excerpt, excerpt_html, image_url, published_at, content_hash,
                          pipeline_state, has_video, body_image_count)
    VALUES (${input.url}, ${input.canonicalUrl}, ${input.urlKey}, ${input.title},
            ${input.titleNorm}, ${input.author}, ${sql.param([...input.categories])}::text[],
            ${input.excerpt}, ${input.excerptHtml}, ${input.imageUrl},
            ${input.publishedAt}::timestamptz, ${input.contentHash},
            CASE WHEN ${input.publishedAt}::timestamptz
                      < now() - make_interval(days => ${options.maxAgeDays}::int)
                 THEN 'stale' ELSE 'ingested' END,
            ${hasVideo}::boolean, ${bodyImageCount}::int)
    RETURNING id::text AS id, content_revision::text AS revision, pipeline_state`);
  const article = inserted.rows[0];
  if (article === undefined) throw new Error('ingestItem: the article insert returned no row');
  await insertAssociation(tx, input.feedId, article.id, input.guid);
  if (input.feedBody !== null) {
    await upsertArticleBody(tx, article.id, article.revision, input.feedBody);
  }
  return {
    articleId: article.id,
    outcome: 'inserted',
    revision: article.revision,
    pipelineState: article.pipeline_state,
    newAssociation: true,
    contentChanged: false,
    needsExtraction: article.pipeline_state !== 'stale',
  };
}

/**
 * Insert the (feed, article) association unless it exists; `true` when it was inserted.
 * `first_seen_at` is the statement time, taken after the identity locks: a carrier that committed
 * first is also seen first, so the source feed and the activation boundary follow the order in
 * which associations were actually recorded, not the order in which their transactions started.
 * A GUID that another article of this feed took concurrently raises 23505 (the caller retries).
 */
async function insertAssociation(
  tx: Transaction,
  feedId: string,
  articleId: string,
  guid: string | null,
): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
    VALUES (${feedId}::bigint, ${articleId}::bigint, ${guid}::text, statement_timestamp())
    ON CONFLICT (feed_id, article_id) DO NOTHING`);
  return result.rowCount === 1;
}

/** Continue with a found, locked article (spec 03 §7 steps 2–3, 6). */
async function ingestFound(
  tx: Transaction,
  sender: JobSender,
  input: IngestItemInput,
  identity: Extract<ResolvedIdentity, { kind: 'found' }>,
  article: LockedArticle,
): Promise<IngestItemResult> {
  const { articleId, outcome } = identity;
  if (outcome === 'guid_alias') {
    // Guarded alias insert: the key lock and recheck found no owner, so a conflict here means a
    // writer that skipped the lock; it aborts the item (23505) instead of silently losing the key.
    await tx.execute(sql`
      INSERT INTO article_aliases (url_key, article_id, source)
      VALUES (${input.urlKey}, ${articleId}::bigint, 'feed_link')`);
  }

  // Never take a GUID another article of this feed owns (identity conflict): record the
  // association with a NULL GUID and keep the owner's mapping.
  const guid = outcome === 'identity_conflict' ? null : input.guid;
  const newAssociation = await insertAssociation(tx, input.feedId, articleId, guid);
  if (!newAssociation && guid !== null) {
    // A pair keeps its first non-null GUID; alternate GUIDs arriving with the same URL are ignored.
    await tx.execute(sql`
      UPDATE feed_items SET guid = ${guid}::text
       WHERE feed_id = ${input.feedId}::bigint AND article_id = ${articleId}::bigint
         AND guid IS NULL`);
  }

  // Video evidence from any carrier counts, also without a content change (spec 03 §7 step 6);
  // without evidence `has_video` is left as it is.
  const evidence: MediaSignalUpdate = input.media.videoEvidence ? { hasVideo: true } : {};
  const unchanged: IngestItemResult = {
    articleId,
    outcome,
    revision: article.revision,
    pipelineState: article.pipelineState,
    newAssociation,
    contentChanged: false,
    needsExtraction: false,
  };
  if (
    article.contentHash === input.contentHash ||
    (await articleSourceFeedId(tx, articleId)) !== input.feedId
  ) {
    await applyItemMedia(tx, sender, articleId, evidence);
    return unchanged;
  }

  await tx.execute(sql`
    UPDATE articles
       SET url = coalesce(${input.url}, url),
           title = ${input.title}, title_norm = ${input.titleNorm}, author = ${input.author},
           categories = ${sql.param([...input.categories])}::text[], excerpt = ${input.excerpt},
           excerpt_html = ${input.excerptHtml}, image_url = ${input.imageUrl},
           published_at = ${input.publishedAt}::timestamptz, content_hash = ${input.contentHash},
           updated_at = now()
     WHERE id = ${articleId}::bigint`);
  const reset = await resetArticleAnswers(tx, sender, articleId, {
    reason: 'source_changed',
    nextState: 'ingested',
    ...(input.feedBody === null ? {} : { installBody: input.feedBody }),
  });
  if (reset.status !== 'reset') {
    // Unreachable: the row is locked by this transaction and no revision is expected.
    throw new Error(`ingestItem: resetArticleAnswers returned ${reset.status}`);
  }
  // The installed publisher body brings its own count; without one the stored body is kept.
  await applyItemMedia(
    tx,
    sender,
    articleId,
    input.feedBody === null
      ? evidence
      : { ...evidence, bodyImageCount: input.media.feedBodyImageCount },
  );
  return {
    articleId,
    outcome,
    revision: reset.revision,
    pipelineState: reset.pipelineState,
    newAssociation,
    contentChanged: true,
    needsExtraction: !reset.stale,
  };
}

/** Write the item's media-signal changes of a found article (spec 03 §6.4), if it has any. */
async function applyItemMedia(
  tx: Transaction,
  sender: JobSender,
  articleId: string,
  update: MediaSignalUpdate,
): Promise<void> {
  if (update.hasVideo === undefined && update.bodyImageCount === undefined) return;
  await applyMediaSignals(tx, sender, articleId, update);
}
