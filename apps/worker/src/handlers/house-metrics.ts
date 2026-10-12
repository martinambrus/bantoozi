import {
  deleteMetricsSnapshotsBefore,
  metricsClassifyingBacklog,
  metricsEngine,
  metricsHides,
  metricsModels,
  METRICS_RATING_PAGE,
  metricsRatingEventsPage,
  type MetricsRatingEvent,
  metricsReaderUsers,
  metricsRecovery,
  metricsTrainingQueue,
  readerLaneMix,
  retryTransaction,
  updateSettingLocked,
  withTenants,
} from '@bantoozi/db';
import {
  UserPreferencesSchema,
  metricsDailyKey,
  settingSchema,
  utcDay,
  type MetricsSnapshot,
} from '@bantoozi/shared';

import {
  dayBounds,
  effectiveRatings,
  laneStats,
  ratingSplits,
  windowStart,
} from '../metrics/compute.js';
import { nowOf, type WorkerDeps } from './deps.js';
import { recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.metrics' as const;
/** Daily snapshots kept, the newest day included (spec 10 §7). */
export const METRICS_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const READER_PAGE = 200;
/** Readers counted per tenant-scoped transaction (M8-F10): a page of 200 is 8 transactions, not 200. */
const READER_BATCH = 25;

/**
 * Replays the rating events of `from..to` in pages of {@link METRICS_RATING_PAGE} rows (M8-F10).
 * The events of a user/article pair can straddle a page boundary, so the last pair of a page is
 * carried to the next one and replayed together with its continuation; the result equals one
 * replay over all events.
 */
async function replayRatings(deps: WorkerDeps, from: Date, to: Date) {
  const ratings: ReturnType<typeof effectiveRatings> = [];
  let carry: MetricsRatingEvent[] = [];
  let cursor: Awaited<ReturnType<typeof metricsRatingEventsPage>>['cursor'] = null;
  for (;;) {
    const page = await metricsRatingEventsPage(deps.db, from, to, cursor);
    const events = [...carry, ...page.events];
    if (page.events.length < METRICS_RATING_PAGE) {
      ratings.push(...effectiveRatings(events));
      return ratings;
    }
    const lastOf = events.at(-1);
    const pairOf = (e: MetricsRatingEvent) => `${e.userId}:${e.articleId}`;
    const split = lastOf === undefined ? 0 : events.findIndex((e) => pairOf(e) === pairOf(lastOf));
    ratings.push(...effectiveRatings(events.slice(0, split)));
    carry = events.slice(split);
    cursor = page.cursor;
  }
}

/**
 * Maybe share inputs summed over the readers (spec 10 §7): per reader the unread counts of the
 * reader's own global view (same folding, status and tier policy), so only totals are kept.
 */
async function readerMix(deps: WorkerDeps, now: Date) {
  const total = { maybe: 0, scored: 0, cards: 0, model: 0, degraded: 0 };
  let after: string | null = null;
  for (;;) {
    const page = await metricsReaderUsers(deps.db, after, READER_PAGE);
    for (let i = 0; i < page.length; i += READER_BATCH) {
      const batch = page.slice(i, i + READER_BATCH);
      const tiers = new Map(
        batch.map(({ userId, preferences }) => [
          userId,
          UserPreferencesSchema.parse(preferences ?? {}).defaultTier,
        ]),
      );
      const mixes = await withTenants(
        deps.db,
        batch.map((reader) => reader.userId),
        (tx, userId) => readerLaneMix(tx, { asOf: now, minTier: tiers.get(userId) ?? 0 }),
      );
      for (const mix of mixes) {
        total.maybe += mix.maybe;
        total.scored += mix.scored;
        total.cards += mix.bySource.cards;
        total.model += mix.bySource.model;
        total.degraded += mix.bySource.degraded;
      }
    }
    if (page.length < READER_PAGE) return total;
    after = page.at(-1)?.userId ?? null;
  }
}

/**
 * `house.metrics` (daily 00:10 UTC, spec 10 §7, spec 11 §6): writes `settings['metrics.daily.<day>']`
 * for the previous UTC day, from feedback-time `before` snapshots: the like-rate per lane (also by
 * ranking source, language and prompt vs voluntary), the observed recovery from Everything/Hidden,
 * hide reasons, personal-model and engine aggregates for the day and the trailing 7 and 30 days,
 * and `current`: Maybe share by the reader's own counting policy, source mix and queue sizes.
 * Replaces a rerun's snapshot and deletes those older than 90 days.
 */
export function createMetricsHandler(deps: WorkerDeps): QueueHandler<'house.metrics'> {
  return async () => {
    const now = nowOf(deps);
    const day = utcDay(new Date(now.getTime() - DAY_MS));
    const { start, end } = dayBounds(day);
    const ratings = await replayRatings(deps, new Date(windowStart(start, 30)), new Date(end));
    const bounds = (days: number) => ({
      from: windowStart(start, days),
      to: end,
    });
    const lanesAndRegret = async (days: number) => ({
      lanes: laneStats(ratings, windowStart(start, days), end),
      regret: await metricsRecovery(deps.db, new Date(windowStart(start, days)), new Date(end)),
    });
    const trailing = async (days: number) => {
      const { from, to } = bounds(days);
      const [fromDate, toDate] = [new Date(from), new Date(to)];
      return {
        ...(await lanesAndRegret(days)),
        ...ratingSplits(ratings, from, to),
        hides: await metricsHides(deps.db, fromDate, toDate),
        models: await metricsModels(deps.db, fromDate, toDate, now),
        engine: await metricsEngine(deps.db, fromDate, toDate, days),
      };
    };
    const mix = await readerMix(deps, now);
    const snapshot: MetricsSnapshot = {
      ...(await lanesAndRegret(1)),
      windows: { d7: await trailing(7), d30: await trailing(30) },
      current: {
        maybeShare: {
          maybe: mix.maybe,
          scored: mix.scored,
          share: mix.scored === 0 ? null : mix.maybe / mix.scored,
        },
        sourceMix: { cards: mix.cards, model: mix.model, degraded: mix.degraded },
        classifyingBacklog: await metricsClassifyingBacklog(deps.db, now),
        trainingQueue: await metricsTrainingQueue(deps.db, now),
      },
    };
    const key = metricsDailyKey(day);
    await retryTransaction(deps.db, (tx) =>
      updateSettingLocked(tx, key, snapshot, () => settingSchema(key).parse(snapshot)),
    );
    const deleted = await deleteMetricsSnapshotsBefore(
      deps.db,
      utcDay(new Date(start - (METRICS_RETENTION_DAYS - 1) * DAY_MS)),
    );
    deps.logger.info({ job: JOB, day, deleted }, 'daily metrics stored');
    await recordHouseProgress(deps, JOB, now, true);
  };
}
