import {
  readerReleaseClock,
  readerSourcePolicies,
  subscriptionReleasedThrough,
  type SubscriptionRow,
  type TenantTx,
} from '@bantoozi/db';
import { releaseWindow, type FeedInfo } from '@bantoozi/shared';

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
  const origins = rows.map((row) => new URL(row.feed.fetchUrl ?? row.feed.url).origin);
  const sources = await readerSourcePolicies(tx, origins);
  return new Map(
    rows.map((row, index) => {
      const floor = clock.intervalS || clock.planIntervalS;
      const policy = sources.get(origins[index]!);
      const source = policy?.intervalS ?? 0;
      const publisher = row.feed.publisherIntervalS ?? 0;
      const interval = Math.max(floor, source, publisher);
      const visibleUntil = subscriptionReleasedThrough(clock, row.createdAt).getTime();
      const bound = (value: Date | null) =>
        value === null ? null : new Date(Math.min(value.getTime(), visibleUntil)).toISOString();
      const candidate = new Date(
        Math.max(
          clock.now.getTime() + 1,
          policy?.nextStartAt?.getTime() ?? 0,
          (row.feed.lastSuccessAt?.getTime() ?? 0) + publisher * 1000,
          row.feed.nextFetchAt?.getTime() ?? clock.now.getTime() + interval * 1000,
        ),
      );
      const grace = row.createdAt.getTime() + 900000 > clock.now.getTime();
      const next = releaseWindow(candidate, clock.timezone, grace ? null : clock.intervalS);
      const nextAt =
        next.nextReleaseAt === null || next.releasedAt.getTime() === candidate.getTime()
          ? candidate
          : next.nextReleaseAt;
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
