import type { JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { FEED_BODY_EXTRACTOR } from './bodies.js';
import { carrierSubscriberIds } from './demand.js';
import { recordRankIntents } from './rank-intents.js';

/**
 * Media signals of an article (spec 03 §6.4, revision R2): `articles.has_video`,
 * `body_image_count` and `media_revision`. Ingestion (§7 step 6), extraction (§8.1 step 6) and the
 * article merge (§8.4) compute the new values; {@link applyMediaSignals} is their one writer.
 */

/** Rank reason recorded when a media signal changes (spec 03 §6.4 "Re-ranking"). */
export const MEDIA_RANK_REASON = 'media';

/**
 * `article_bodies.completeness_reason` of a row that holds only the feed excerpt (a linkless
 * article's extraction without a publisher body, spec 02 §3): it is not a body in the sense of
 * §6.4, so it has no in-body image count and proves nothing about video.
 */
export const EXCERPT_ONLY_REASON = 'excerpt_only';

/** A media-signal write (spec 03 §6.4). An omitted field is left unchanged. */
export interface MediaSignalUpdate {
  /**
   * `true` on video evidence: `has_video` becomes true, whatever it was. `false` when a feed or
   * page body was examined without evidence: `has_video` becomes false only while it is null
   * (unknown). `has_video` is monotonic: no write sets it from true back to false or to null
   * (spec 03 §7 step 6).
   */
  hasVideo?: boolean;
  /**
   * The §6.4 in-body image count of the body `article_bodies` holds once this transaction commits
   * (the text `word_count` counts), or null when no body with content is stored (excerpt only).
   */
  bodyImageCount?: number | null;
}

/** The media columns of an article. */
export interface ArticleMediaSignals {
  hasVideo: boolean | null;
  bodyImageCount: number | null;
  /** `articles.media_revision`. */
  mediaRevision: string;
}

export type MediaSignalResult =
  | { status: 'missing' }
  /** The write stored the values the article already had: nothing was written or recorded. */
  | { status: 'unchanged'; signals: ArticleMediaSignals }
  | {
      status: 'changed';
      signals: ArticleMediaSignals;
      /** Active subscribers of the article's current carriers, each given an incremental rank. */
      rankedUserIds: string[];
    };

const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
const MAX_INT4 = 2_147_483_647;

/** Whether `count` is a valid `body_image_count`: null or an int4 ≥ 0. */
function isImageCount(count: unknown): count is number | null {
  return (
    count === null ||
    (typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= MAX_INT4)
  );
}

/**
 * Throws unless `count` is a valid in-body image count or null (`body_image_count` is an int4
 * with CHECK >= 0).
 */
export function assertImageCount(name: string, count: unknown): asserts count is number | null {
  if (!isImageCount(count)) {
    throw new RangeError(`${name} must be a non-negative integer or null`);
  }
}

/**
 * Whether a body row is a body in the sense of spec 03 §6.4: readable content (non-blank text or
 * HTML) that is not only the excerpt ({@link EXCERPT_ONLY_REASON}).
 */
export function isMediaBody(body: {
  bodyText: string | null;
  bodyHtml: string | null;
  completenessReason: string | null;
}): boolean {
  const content =
    (body.bodyText !== null && /\S/u.test(body.bodyText)) ||
    (body.bodyHtml !== null && /\S/u.test(body.bodyHtml));
  return content && body.completenessReason !== EXCERPT_ONLY_REASON;
}

/** Whether `body` is a publisher body taken from the feed (`feed-v1`), not the excerpt. */
export function isFeedMediaBody(body: {
  bodyText: string | null;
  bodyHtml: string | null;
  completenessReason: string | null;
  extractorVersion: string;
}): boolean {
  return body.extractorVersion === FEED_BODY_EXTRACTOR && isMediaBody(body);
}

/**
 * Apply new media signals to an article (spec 03 §6.4) in the caller's transaction. The caller
 * already holds the article row `FOR UPDATE` (ingestion, extraction and merges lock it before any
 * write); this re-asserts that lock, which never upgrades a weaker one because every caller holds
 * `FOR UPDATE`, and writes nothing else before it. Then:
 * - the new values follow {@link MediaSignalUpdate}: `has_video` only moves from null to a value or
 *   to true, and an omitted field keeps its value;
 * - when either value changes (`IS DISTINCT FROM`, so null → false counts), `media_revision` is
 *   incremented once and an incremental `user.rank` (reason {@link MEDIA_RANK_REASON}) is recorded
 *   through the outbox for the active subscribers of **every** current carrier, because such a
 *   change arrives without a `content_hash` change or a new `feed_items` row, which alone would
 *   re-rank the article (a rank run compares the media revision it recorded, spec 06 §6.2, §7);
 * - when nothing changes, nothing is written and nothing is recorded.
 * A `missing` article (merged away or purged) writes nothing.
 */
export async function applyMediaSignals(
  tx: Transaction,
  sender: JobSender,
  articleId: string,
  update: MediaSignalUpdate,
): Promise<MediaSignalResult> {
  if (!DECIMAL_ID.test(articleId)) throw new TypeError('articleId must be a decimal string');
  if (update.hasVideo !== undefined && typeof update.hasVideo !== 'boolean') {
    throw new TypeError('hasVideo must be a boolean when given');
  }
  if (update.bodyImageCount !== undefined)
    assertImageCount('bodyImageCount', update.bodyImageCount);

  const locked = await tx.execute<{
    has_video: boolean | null;
    body_image_count: number | null;
    media_revision: string;
  }>(sql`
    SELECT has_video, body_image_count, media_revision::text AS media_revision
      FROM articles WHERE id = ${articleId}::bigint FOR UPDATE`);
  const current = locked.rows[0];
  if (current === undefined) return { status: 'missing' };

  const hasVideo =
    update.hasVideo === true || current.has_video === true
      ? true
      : update.hasVideo === false
        ? false
        : current.has_video;
  const bodyImageCount =
    update.bodyImageCount === undefined ? current.body_image_count : update.bodyImageCount;
  if (hasVideo === current.has_video && bodyImageCount === current.body_image_count) {
    return {
      status: 'unchanged',
      signals: {
        hasVideo: current.has_video,
        bodyImageCount: current.body_image_count,
        mediaRevision: current.media_revision,
      },
    };
  }

  const updated = await tx.execute<{ media_revision: string }>(sql`
    UPDATE articles
       SET has_video = ${hasVideo}::boolean, body_image_count = ${bodyImageCount}::int,
           media_revision = media_revision + 1, updated_at = now()
     WHERE id = ${articleId}::bigint
    RETURNING media_revision::text AS media_revision`);
  const mediaRevision = updated.rows[0]?.media_revision;
  if (mediaRevision === undefined) {
    // Unreachable: the row is locked by this transaction.
    throw new Error(`applyMediaSignals: article ${articleId} vanished under its row lock`);
  }
  const rankedUserIds = await carrierSubscriberIds(tx, articleId);
  await recordRankIntents(tx, sender, rankedUserIds, { reason: MEDIA_RANK_REASON });
  return {
    status: 'changed',
    signals: { hasVideo, bodyImageCount, mediaRevision },
    rankedUserIds,
  };
}
