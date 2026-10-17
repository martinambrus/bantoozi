import { originOf } from '@bantoozi/feeds';
import {
  pendingFeedReleases,
  readerReleaseClock,
  readerReleaseWindow,
  readerSourcePolicies,
  subscriptionReleasedThrough,
  type SubscriptionRow,
  type TenantTx,
} from '@bantoozi/db';
import { ROBOTS_FAST_FEED_FLOOR_S, releaseWindow, type FeedInfo } from '@bantoozi/shared';

export type FeedUpdateInfo = Pick<
  FeedInfo,
  'lastSuccessAt' | 'lastErrorAt' | 'nextUpdateAt' | 'updateIntervalS' | 'intervalReason'
>;

/** Account-visible timing for every subscription, with one read of the shared source policies. */
export async function feedUpdates(
  tx: TenantTx,
  rows: readonly SubscriptionRow[],
  now: Date,
): Promise<Map<string, FeedUpdateInfo>> {
  const clock = await readerReleaseClock(tx, now);
  const origins = rows.map((row) => originOf(new URL(row.feed.fetchUrl ?? row.feed.url)));
  const sources = await readerSourcePolicies(tx, origins);
  const pending = await pendingFeedReleases(
    tx,
    rows.map((row) => row.feed.id),
    clock,
  );
  const floor = Math.max(clock.intervalS ?? 0, clock.planIntervalS);
  const accountNext = releaseWindow(clock.now, clock.timezone, floor).nextReleaseAt!.getTime();
  return new Map(
    rows.map((row, index) => {
      const policy = sources.get(origins[index]!);
      // A fast feed that robots.txt disallows is polled at the slower floor (D-267).
      const source = Math.max(
        policy?.intervalS ?? 0,
        row.feed.robotsSlow === true ? ROBOTS_FAST_FEED_FLOOR_S : 0,
      );
      const publisher = row.feed.publisherIntervalS ?? 0;
      const interval = Math.max(floor, source, publisher);
      const visibleUntil = subscriptionReleasedThrough(clock, row.createdAt).getTime();
      const bound = (value: Date | null) =>
        value === null ? null : new Date(Math.min(value.getTime(), visibleUntil)).toISOString();
      const graceUntil = row.createdAt.getTime() + 900000;
      const grace = graceUntil > clock.now.getTime();
      const immediate = !clock.intervalS || grace;
      const sourceCandidate = Math.max(
        clock.now.getTime() + (immediate ? 30000 : 1),
        policy?.nextStartAt?.getTime() ?? 0,
        (row.feed.lastSuccessAt?.getTime() ?? 0) + publisher * 1000,
        row.feed.nextFetchAt?.getTime() ?? clock.now.getTime() + interval * 1000,
      );
      // Forecast this account's cadence, even when a faster subscriber shares the source. Only
      // arrivals inside the original introduction window bypass its floor.
      const candidate = new Date(
        sourceCandidate <= graceUntil ? sourceCandidate : Math.max(sourceCandidate, accountNext),
      );
      const next =
        candidate.getTime() <= graceUntil
          ? { releasedAt: candidate, nextReleaseAt: null }
          : readerReleaseWindow(clock, candidate);
      const fetchedAt =
        next.nextReleaseAt === null || next.releasedAt.getTime() === candidate.getTime()
          ? candidate
          : next.nextReleaseAt;
      const nextAt =
        pending.has(row.feed.id) && clock.nextReleaseAt !== null
          ? new Date(Math.min(clock.nextReleaseAt.getTime(), fetchedAt.getTime()))
          : fetchedAt;
      return [
        row.feed.id,
        {
          lastSuccessAt: bound(row.feed.lastSuccessAt),
          lastErrorAt: bound(row.feed.lastErrorAt),
          nextUpdateAt:
            row.feed.status === 'dead' || row.feed.status === 'paused'
              ? null
              : nextAt.toISOString(),
          updateIntervalS: Math.ceil(interval),
          intervalReason:
            publisher > floor && publisher >= source
              ? 'publisher'
              : source > floor
                ? 'source'
                : 'plan',
        },
      ];
    }),
  );
}
