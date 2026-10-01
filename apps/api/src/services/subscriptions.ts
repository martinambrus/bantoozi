import {
  assertQuotaRoom,
  ensureFeed,
  getSubscription,
  insertSubscription,
  readOwnUser,
  recordFirstFetch,
  recordRankIntents,
  refreshFeedMaterializations,
  reviveDeadFeed,
  subscribedFeedIds,
  subscriptionUnreadCounts,
  type SubscriptionRow,
  type TenantTx,
  type UnreadCounts,
} from '@bantoozi/db';
import {
  discoverFeed,
  type DiscoverDeps,
  type DiscoverySuccess,
  type FeedCandidate,
} from '@bantoozi/feeds';
import {
  AppError,
  effectiveImagesAllowed,
  isAppErrorCode,
  planLimits,
  readUserPreferences,
  type JobSender,
  type Subscription,
  type UserPreferences,
} from '@bantoozi/shared';

/**
 * Subscription orchestration (spec 08 §4, spec 03 §10–11): discovery before any transaction, the
 * locked subscribe transaction, and the `Subscription` DTO with its effective image policy and
 * unread counts. SQL lives in `@bantoozi/db` (`api/subscriptions.ts`).
 */

const NO_UNREAD: UnreadCounts = Object.freeze({ forYou: 0, maybe: 0, everything: 0, new: 0 });

/** The `Subscription` DTO of a row (spec 08 §4). */
export function subscriptionDto(
  row: SubscriptionRow,
  preferences: UserPreferences,
  unread: UnreadCounts | undefined,
): Subscription {
  return {
    feed: {
      id: row.feed.id,
      url: row.feed.url,
      siteUrl: row.feed.siteUrl,
      title: row.feed.title,
      iconUrl: row.feed.iconUrl,
      status: row.feed.status,
      lastSuccessAt: row.feed.lastSuccessAt?.toISOString() ?? null,
      lastErrorCode: row.feed.lastErrorCode,
      lastErrorAt: row.feed.lastErrorAt?.toISOString() ?? null,
    },
    titleOverride: row.titleOverride,
    folder: row.folder,
    allowDuplicates: row.allowDuplicates,
    hidden: row.hidden,
    inferenceMode: row.inferenceMode,
    inferenceVersion: row.inferenceVersion,
    inferenceActivatedAt: row.inferenceActivatedAt?.toISOString() ?? null,
    imagePolicy: row.imagePolicy,
    effectiveImagesAllowed: effectiveImagesAllowed(row.imagePolicy, preferences.loadRemoteImages),
    unread: { ...(unread ?? NO_UNREAD) },
  };
}

/** The user's preferences with defaults (spec 08 §3.1). */
export async function ownPreferences(tx: TenantTx): Promise<UserPreferences> {
  return readUserPreferences((await readOwnUser(tx)).preferences);
}

/** One owned subscription as its DTO (committed state), or `404` for any other feed id. */
export async function loadSubscriptionDto(
  tx: TenantTx,
  feedId: string,
  asOf: Date,
): Promise<Subscription> {
  const row = await getSubscription(tx, feedId);
  if (row === null) throw new AppError('NOT_FOUND', 'Subscription not found');
  const preferences = await ownPreferences(tx);
  const unread = await subscriptionUnreadCounts(tx, {
    asOf,
    minTier: preferences.defaultTier,
    feedIds: [feedId],
  });
  return subscriptionDto(row, preferences, unread.get(feedId));
}

/**
 * Feed discovery (spec 03 §10), always before any transaction is opened (spec 08 §1): no pooled
 * connection is held during network I/O. A discovery failure is its `FEED_*` code (`422`); an
 * injected dependency failure is an internal error.
 */
export async function discover(
  url: string,
  deps: DiscoverDeps,
  signal?: AbortSignal,
): Promise<DiscoverySuccess> {
  const result = await discoverFeed(url, signal === undefined ? deps : { ...deps, signal });
  if (result.ok) return result;
  if (result.code.startsWith('FEED_') && isAppErrorCode(result.code)) {
    throw new AppError(result.code, result.message, {
      details: {
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt.toISOString() }),
      },
    });
  }
  throw new Error(result.message, { cause: result.cause });
}

/**
 * The subscribe transaction (spec 08 §4, spec 03 §10 steps 5–6), run inside `request.mutate`:
 * lock the user row, find or create the live feed and lock it, then for a new subscription check
 * `maxFeeds` under the user lock, insert it with inference `off`, refresh both materializations,
 * record the first `feed.fetch` (local fetch/parse only: no inference, no card backfill) and a full
 * rank intent. An existing subscription is returned unchanged: no quota, folder unchanged. A reused
 * `dead` feed is revived, since discovery has just validated it.
 */
export async function subscribe(
  tx: TenantTx,
  outbox: JobSender,
  input: {
    candidate: FeedCandidate;
    title: string | null;
    folder: string | null;
    asOf: Date;
  },
): Promise<{ created: boolean; subscription: Subscription }> {
  const user = await readOwnUser(tx, { lock: true });
  const feed = await ensureFeed(tx, {
    url: input.candidate.canonicalUrl,
    fetchUrl: input.candidate.url,
    title: input.title,
  });
  const existing = (await subscribedFeedIds(tx, [feed.feedId])).has(feed.feedId);
  if (!existing) await assertQuotaRoom(tx, 'maxFeeds', planLimits(user.plan).maxFeeds);
  const revived = feed.status === 'dead' ? await reviveDeadFeed(tx, feed.feedId) : false;
  const created =
    !existing && (await insertSubscription(tx, { feedId: feed.feedId, folder: input.folder }));
  if (created || revived) {
    await refreshFeedMaterializations(tx, [feed.feedId]);
    await recordFirstFetch(outbox, feed.feedId);
  }
  if (created) {
    await recordRankIntents(tx, outbox, [user.id], { reason: 'subscription', full: true });
  }
  return { created, subscription: await loadSubscriptionDto(tx, feed.feedId, input.asOf) };
}
