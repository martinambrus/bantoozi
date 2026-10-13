import {
  deleteMetricsSnapshotsBefore,
  metricsClassifyingBacklog,
  metricsEngine,
  metricsHides,
  metricsModels,
  METRICS_RATING_PAGE,
  metricsRatingEventsPage,
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
  EffectiveRatingFold,
  WindowTally,
  windowStart,
  type EffectiveRating,
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
 * Replays the rating events of `from..to` in pages of {@link METRICS_RATING_PAGE} rows (M8-F10) and
 * hands every completed user/article pair's effective rating to `sink` at once. A pair that
 * straddles a page boundary is continued by the fold, which keeps only that pair's running state
 * (ratings, not events), so neither the ratings nor a page's events outlive the page; the result
 * equals one replay over all events.
 */
export async function replayRatings(
  deps: Pick<WorkerDeps, 'db'>,
  from: Date,
  to: Date,
  sink: (rating: EffectiveRating) => void,
): Promise<void> {
  const fold = new EffectiveRatingFold(sink);
  let cursor: Awaited<ReturnType<typeof metricsRatingEventsPage>>['cursor'] = null;
  for (;;) {
    const page = await metricsRatingEventsPage(deps.db, from, to, cursor);
    fold.push(page.events);
    if (page.events.length < METRICS_RATING_PAGE) break;
    cursor = page.cursor;
  }
  fold.finish();
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
    // One pass folds each completed pair into the day, 7-day and 30-day tallies (M8-F10).
    const tallies = new Map(
      [1, 7, 30].map((days) => [days, new WindowTally(windowStart(start, days), end)]),
    );
    await replayRatings(deps, new Date(windowStart(start, 30)), new Date(end), (rating) => {
      for (const tally of tallies.values()) tally.add(rating);
    });
    const tallyOf = (days: number): WindowTally => tallies.get(days) ?? new WindowTally(0, 0);
    const bounds = (days: number) => ({
      from: windowStart(start, days),
      to: end,
    });
    const lanesAndRegret = async (days: number) => ({
      lanes: tallyOf(days).laneStats(),
      regret: await metricsRecovery(deps.db, new Date(windowStart(start, days)), new Date(end)),
    });
    const trailing = async (days: number) => {
      const { from, to } = bounds(days);
      const [fromDate, toDate] = [new Date(from), new Date(to)];
      return {
        ...(await lanesAndRegret(days)),
        ...tallyOf(days).splits(),
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
