import {
  FEED_BODY_EXTRACTOR,
  applyPermanentRedirect,
  deferFeedFetch,
  feedItems7d,
  feedRecentPublishedAt,
  ingestItem,
  loadFeedForFetch,
  recordFeedFetch,
  refreshFeedLangHint,
  resolveLiveFeedId,
  retryTransaction,
  tryLockFeedForFetch,
  workerOutbox,
  type ArticleBodyInput,
  type FeedFetchLock,
  type FeedForFetch,
  type IngestItemInput,
} from '@bantoozi/db';
import {
  bodyLead,
  canonicalizeUrl,
  computeContentHash,
  decodeBody,
  linklessUrlKey,
  nextSchedule,
  parseCacheMaxAge,
  parseFeed,
  recentGapsS,
  sameRequestUrl,
  urlKey,
  validateFeedUrl,
  type FetchOutcome,
  type NormalizedItem,
  type ParsedFeed,
  type SafeFetchResult,
  type ScheduleFeed,
} from '@bantoozi/feeds';

import { after, afterNewCarrier } from '../pipeline.js';
import { fetchWith, nowOf, pipelineContext, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/**
 * `feed.fetch {feedId, force?}` (spec 03 §3, §4, §7, §9): fetch, parse and ingest one feed.
 * - Resolves a merged feed to its live survivor; holds the per-feed session advisory lock on a
 *   dedicated connection for the whole fetch (another process fetching it makes this a no-op) and
 *   re-reads the feed after acquiring it: a paused, dead, unsubscribed or not-yet-due feed is a
 *   no-op unless `force` (a manual refresh still observes origin cooldowns). A lost lock stops the
 *   fetch: its connection failure aborts the HTTP request, every item checks the lock first, and
 *   every transaction that records the fetch checks it in PostgreSQL, so nothing is written for a
 *   feed that another process may be fetching (`FeedFetchLockLostError`).
 * - Conditional GET with the stored validators on `fetch_url`; a 304 without established
 *   validators is retried once unconditionally.
 * - Each item is ingested in its own short transaction (retried on identity races), which also
 *   records extraction for a new or revised non-stale article and the new-carrier continuation, so
 *   a crash after an item commit loses no work.
 * - After the items, one transaction updates the schedule (spec 03 §9), validators, metadata,
 *   publication gaps and the language hint. A permanent redirect of a successful fetch renames the
 *   feed or merges it into the feed that already owns the new URL.
 */
export function createFeedFetchHandler(deps: WorkerDeps): QueueHandler<'feed.fetch'> {
  return async ({ feedId, force }) => {
    const liveId = await resolveLiveFeedId(deps.db, feedId);
    if (liveId === null) {
      deps.logger.warn({ feedId }, 'feed.fetch for a missing feed or a corrupt merge chain');
      return;
    }
    const lock = await tryLockFeedForFetch(deps.lockPool, liveId);
    if (lock === null) return;
    try {
      await fetchFeed(deps, liveId, force === true, lock);
    } finally {
      await lock.release();
    }
  };
}

async function fetchFeed(
  deps: WorkerDeps,
  feedId: string,
  force: boolean,
  lock: FeedFetchLock,
): Promise<void> {
  const feed = await loadFeedForFetch(deps.db, feedId);
  if (feed === null || feed.mergedIntoId !== null) return;
  if (feed.status === 'dead' || feed.status === 'paused' || feed.subscriberCount === 0) return;
  const now = nowOf(deps);
  if (!force && feed.nextFetchAt.getTime() > now.getTime()) return;

  const hadValidators = feed.etag !== null || feed.lastModified !== null;
  let result = await fetchFeedBody(deps, feed, hadValidators, lock.signal);
  // A 304 to a request without validators is FEED_HTTP_304; without established validators it is
  // retried once unconditionally before it counts as an error (spec 03 §9).
  if (!hadValidators && !result.ok && result.status === 304) {
    result = await fetchFeedBody(deps, feed, false, lock.signal);
  }

  if (!result.ok) {
    if (result.code === 'FEED_ORIGIN_COOLDOWN') {
      // Our own politeness deferral, not a feed error: fetch again when the origin is free.
      await deps.db.transaction(async (tx) => {
        await lock.assertHeld(tx);
        await deferFeedFetch(tx, feedId, result.retryAt ?? new Date(now.getTime() + 60_000));
      });
      return;
    }
    await recordOutcome(deps, lock, feed, feedId, errorOutcome(result, now), now);
    return;
  }
  if (result.status === 304) {
    // safeFetch reports a 304 only for the conditional request, which went to `fetch_url`, so its
    // validators belong there (a 304 from a redirect target is FEED_HTTP_304, handled above).
    await recordOutcome(
      deps,
      lock,
      feed,
      feedId,
      {
        kind: 'not_modified',
        ...(result.headers['etag'] === undefined ? {} : { etag: result.headers['etag'] }),
        ...(result.headers['last-modified'] === undefined
          ? {}
          : { lastModified: result.headers['last-modified'] }),
      },
      now,
      result.headers['cache-control'],
    );
    return;
  }

  const contentType = result.headers['content-type'];
  const decoded = decodeBody(result.bodyBytes, contentType);
  if (!decoded.ok) {
    await recordOutcome(
      deps,
      lock,
      feed,
      feedId,
      { kind: 'error', code: decoded.code, message: decoded.message },
      now,
    );
    return;
  }
  const parsed = await parseFeed(decoded.text, {
    url: result.finalUrl,
    ...(contentType === undefined ? {} : { contentType }),
    now,
  });
  if (!parsed.ok) {
    // A parse error never installs the response's validators (spec 03 §9).
    await recordOutcome(
      deps,
      lock,
      feed,
      feedId,
      { kind: 'error', code: parsed.code, message: parsed.message },
      now,
    );
    return;
  }

  // A permanent redirect of a successful fetch renames the feed or merges it (spec 03 §9).
  let targetId = feedId;
  if (result.permanentRedirect) {
    targetId = await followPermanentRedirect(deps, lock, feedId, feed, result.finalUrl);
    // After a merge the rest of this fetch works on the survivor, so it must hold the survivor's
    // fetch lock too; when the survivor's own fetch is running, that fetch ingests this content.
    if (targetId !== feedId && !(await lock.tryExtend(targetId))) return;
  }

  let nNew = 0;
  let failed = 0;
  for (const item of parsed.items) {
    await lock.assertHeld();
    const input = ingestInput(targetId, item);
    try {
      const outcome = await retryTransaction(deps.db, async (tx) => {
        const sender = workerOutbox(tx);
        const context = pipelineContext(deps, tx, sender);
        const r = await ingestItem(tx, sender, input, { maxAgeDays: deps.ingestMaxAgeDays });
        if (r.needsExtraction) {
          await after('fetch', r.articleId, { status: 'ok', revision: r.revision }, context);
        }
        if (r.newAssociation) await afterNewCarrier(r.articleId, targetId, context);
        return r;
      });
      if (outcome.newAssociation) nNew += 1;
      if (outcome.outcome === 'identity_conflict') {
        // URL and GUID identity name different articles: the URL owner is kept, nothing merges.
        deps.logger.warn(
          { feedId: targetId, itemIndex: item.sourceIndex, articleId: outcome.articleId },
          'feed item identity conflict',
        );
      }
    } catch (error) {
      failed += 1;
      deps.logger.error(
        { feedId: targetId, itemIndex: item.sourceIndex, code: errorCode(error) },
        'feed item ingestion failed',
      );
    }
  }

  // After a permanent redirect, the renamed feed or the survivor as it is now (its `fetch_url`).
  const target = result.permanentRedirect
    ? ((await loadFeedForFetch(deps.db, targetId)) ?? feed)
    : feed;
  const gaps = recentGapsS(await feedRecentPublishedAt(deps.db, targetId));
  const items7d = await feedItems7d(deps.db, targetId);
  // Validators are stored only where the next poll sends them back (spec 03 §9, D-18): safeFetch
  // sends them to `fetch_url` alone, so a response from any other URL (a temporary redirect
  // target, a rejected permanent one, or a URL that is not the survivor's `fetch_url`) installs
  // none, since that URL could answer a foreign ETag or date with 304 and hide the new updates.
  // Nor does a fetch in which an item failed to ingest (its retries exhausted): the item must be
  // offered again, and a conditional request could answer 304 and hide it for good. Without
  // validators the next poll is unconditional.
  const keepValidators = failed === 0 && sameRequestUrl(result.finalUrl, target.fetchUrl);
  const schedule = nextSchedule(
    scheduleFeed(target, gaps),
    {
      kind: 'success',
      nNew,
      etag: keepValidators ? (result.headers['etag'] ?? null) : null,
      lastModified: keepValidators ? (result.headers['last-modified'] ?? null) : null,
    },
    now,
    scheduleHints(parsed, result),
  );
  await deps.db.transaction(async (tx) => {
    await lock.assertHeld(tx);
    await recordFeedFetch(tx, targetId, {
      schedule,
      meta: {
        title: parsed.feed.title,
        siteUrl: parsed.feed.siteUrl,
        description: parsed.feed.description,
        iconUrl: parsed.feed.iconUrl,
        ...(parsed.feed.langHint === null ? {} : { langHint: parsed.feed.langHint }),
      },
      recentGapsS: gaps,
      items7d,
    });
    if (parsed.feed.langHint === null) await refreshFeedLangHint(tx, targetId);
  });
  if (failed > 0 || parsed.itemErrorCount > 0 || parsed.itemsTruncated) {
    deps.logger.warn(
      {
        feedId: targetId,
        failedItems: failed,
        invalidItems: parsed.itemErrorCount,
        itemsTruncated: parsed.itemsTruncated,
      },
      'feed fetched with skipped items',
    );
  }
}

function fetchFeedBody(
  deps: WorkerDeps,
  feed: FeedForFetch,
  conditional: boolean,
  signal: AbortSignal,
): Promise<SafeFetchResult> {
  return fetchWith(deps, feed.fetchUrl, {
    purpose: 'feed',
    signal,
    ...(feed.userAgent === null ? {} : { userAgent: feed.userAgent }),
    ...(conditional ? { conditional: { etag: feed.etag, lastModified: feed.lastModified } } : {}),
  });
}

/**
 * Record a fetch that ingested nothing: an error, or a valid 304 (with its Cache-Control hint).
 * A 304 of a feed without `lang_hint` also infers it (spec 03 §8.3): the unchanged feed still has
 * no `<language>`, and its articles' languages come from extractions that run after the 200 that
 * brought them, so a feed that answers 304 from then on would otherwise never get its hint.
 */
async function recordOutcome(
  deps: WorkerDeps,
  lock: FeedFetchLock,
  feed: FeedForFetch,
  feedId: string,
  outcome: FetchOutcome,
  now: Date,
  cacheControl?: string,
): Promise<void> {
  const schedule = nextSchedule(scheduleFeed(feed, feed.recentGapsS), outcome, now, {
    cacheMaxAgeS: parseCacheMaxAge(cacheControl),
  });
  await deps.db.transaction(async (tx) => {
    await lock.assertHeld(tx);
    await recordFeedFetch(tx, feedId, { schedule });
    if (outcome.kind === 'not_modified' && feed.langHint === null) {
      await refreshFeedLangHint(tx, feedId);
    }
  });
}

function errorOutcome(result: Extract<SafeFetchResult, { ok: false }>, now: Date): FetchOutcome {
  const retryAfterS =
    result.retryAt === undefined
      ? undefined
      : Math.max(0, Math.ceil((result.retryAt.getTime() - now.getTime()) / 1000));
  return {
    kind: 'error',
    code: result.code,
    message: result.message,
    ...(result.status === undefined ? {} : { httpStatus: result.status }),
    ...(retryAfterS === undefined ? {} : { retryAfterS }),
  };
}

/**
 * A permanent redirect of the feed URL (spec 03 §9): the target becomes `fetch_url`, and its
 * canonical form the feed's identity (a rename, or a merge into the feed that owns it), even when
 * that identity is unchanged, so later polls stop following the redirect. The target must pass the
 * same public-feed checks as a subscribed URL (`validateFeedUrl`: no credentials or credential
 * parameters, a canonical identity of at most 2,048 bytes, D-11); a rejected target is not
 * adopted and the feed keeps its URLs.
 */
async function followPermanentRedirect(
  deps: WorkerDeps,
  lock: FeedFetchLock,
  feedId: string,
  feed: FeedForFetch,
  finalUrl: string,
): Promise<string> {
  const target = validateFeedUrl(finalUrl, { allowPrivate: deps.fetch.allowPrivate });
  if (!target.ok) {
    deps.logger.warn(
      { feedId, reason: target.reason },
      'permanent feed redirect target rejected; the feed keeps its URLs',
    );
    return feedId;
  }
  if (target.canonicalUrl === feed.url && target.fetchUrl === feed.fetchUrl) return feedId;
  return retryTransaction(deps.db, async (tx) => {
    await lock.assertHeld(tx);
    const sender = workerOutbox(tx);
    const redirect = await applyPermanentRedirect(tx, sender, feedId, {
      canonicalUrl: target.canonicalUrl,
      fetchUrl: target.fetchUrl,
    });
    if (redirect.kind !== 'merged') return feedId;
    const context = pipelineContext(deps, tx, sender);
    for (const articleId of redirect.movedArticleIds) {
      await afterNewCarrier(articleId, redirect.survivorId, context);
    }
    return redirect.survivorId;
  });
}

/** One normalized item as the ingestion repository's input (identity keys per spec 03 §5). */
export function ingestInput(feedId: string, item: NormalizedItem): IngestItemInput {
  const canonical = item.link === null ? null : canonicalizeUrl(item.link);
  const linked = canonical !== null && canonical.ok;
  const key = linked
    ? urlKey(canonical.url)
    : linklessUrlKey(feedId, {
        guid: item.guid,
        title: item.title,
        publishedAt: item.publishedAt,
        excerpt: item.excerpt,
      });
  return {
    feedId,
    urlKey: key,
    canonicalUrl: linked ? canonical.url : key,
    url: linked ? item.link : null,
    guid: item.guid,
    title: item.title,
    titleNorm: item.titleNorm,
    author: item.author,
    categories: item.categories,
    excerpt: item.excerpt,
    excerptHtml: item.excerptHtml,
    imageUrl: item.imageUrl,
    publishedAt: item.publishedAt,
    // The hash covers the canonical link, so a feed that rotates tracking parameters in its links
    // on every poll does not look like an edit and reset the article's answers (spec 03 §6.2, §7).
    contentHash:
      linked && canonical.url !== item.link
        ? computeContentHash({
            title: item.title,
            excerpt: item.excerpt,
            author: item.author,
            categories: item.categories,
            link: canonical.url,
            feedBodyText: item.feedBodyText,
          })
        : item.contentHash,
    feedBody: feedBody(item, linked),
    media: { videoEvidence: item.videoEvidence, feedBodyImageCount: item.feedBodyImageCount },
  };
}

/**
 * The publisher's own full text as the revisioned `feed-v1` body fallback (spec 03 §7 step 6). A
 * linkless item has no page, so its feed text is all there is; a linked item's feed text stays
 * partial until page extraction replaces it, and a body cut at a safety limit is never complete
 * (spec 03 §8.1 step 6).
 */
function feedBody(item: NormalizedItem, linked: boolean): ArticleBodyInput | null {
  if (item.feedBodyText === null || item.feedBodyText.trim() === '') return null;
  const complete = !linked && !item.feedBodyTruncated;
  return {
    status: 'ok',
    resolvedUrl: null,
    httpStatus: null,
    bodyText: item.feedBodyText,
    bodyHtml: item.feedBodyHtml,
    completeness: complete ? 'complete' : 'partial',
    completenessReason: complete ? null : item.feedBodyTruncated ? 'truncated' : 'feed_content',
    bodyLead: bodyLead(item.feedBodyText),
    extractorVersion: FEED_BODY_EXTRACTOR,
    error: null,
  };
}

function scheduleFeed(feed: FeedForFetch, gaps: readonly number[]): ScheduleFeed {
  return {
    id: feed.id,
    createdAt: feed.createdAt,
    status: feed.status,
    fetchIntervalS: feed.fetchIntervalS,
    minIntervalS: feed.minIntervalS,
    consecutiveErrors: feed.consecutiveErrors,
    consecutiveEmpty: feed.consecutiveEmpty,
    quarantineCount: feed.quarantineCount,
    totalFetches: feed.totalFetches,
    totalErrors: feed.totalErrors,
    totalEmpty: feed.totalEmpty,
    lastNewItemAt: feed.lastNewItemAt,
    firstErrorAt: feed.firstErrorAt,
    quarantinedUntil: feed.quarantinedUntil,
    lastSuccessAt: feed.lastSuccessAt,
    lastErrorCode: feed.lastErrorCode,
    lastError: feed.lastError,
    lastErrorAt: feed.lastErrorAt,
    etag: feed.etag,
    lastModified: feed.lastModified,
    recentGapsS: gaps,
  };
}

function scheduleHints(parsed: ParsedFeed, result: Extract<SafeFetchResult, { ok: true }>) {
  return {
    ttlMinutes: parsed.feed.ttlMinutes,
    syUpdatePeriod: parsed.feed.syUpdatePeriod,
    syUpdateFrequency: parsed.feed.syUpdateFrequency,
    cacheMaxAgeS: parseCacheMaxAge(result.headers['cache-control']),
  };
}

/** A bounded, redacted error code for logs (never a payload, URL query or message text). */
export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name}:${code}` : error.name;
  }
  return 'error';
}
