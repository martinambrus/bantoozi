import {
  deleteMetricsSnapshotsBefore,
  metricsRatingEvents,
  metricsRecovery,
  retryTransaction,
  updateSettingLocked,
} from '@bantoozi/db';
import { metricsDailyKey, settingSchema, utcDay, type MetricsSnapshot } from '@bantoozi/shared';

import { dayBounds, effectiveRatings, laneStats, windowStart } from '../metrics/compute.js';
import { nowOf, type WorkerDeps } from './deps.js';
import { recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.metrics' as const;
/** Daily snapshots kept, the newest day included (spec 10 §7). */
export const METRICS_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * `house.metrics` (daily 00:10 UTC, spec 10 §7, spec 11 §6): writes `settings['metrics.daily.<day>']`
 * for the previous UTC day, from feedback-time `before` lanes: the like-rate per lane, and the
 * observed recovery from Everything/Hidden with its eligible denominator, for the day and the
 * trailing 7 and 30 days. Replaces a rerun's snapshot and deletes those older than 90 days.
 */
export function createMetricsHandler(deps: WorkerDeps): QueueHandler<'house.metrics'> {
  return async () => {
    const now = nowOf(deps);
    const day = utcDay(new Date(now.getTime() - DAY_MS));
    const { start, end } = dayBounds(day);
    const ratings = effectiveRatings(
      await metricsRatingEvents(deps.db, new Date(windowStart(start, 30)), new Date(end)),
    );
    const window = async (days: number) => ({
      lanes: laneStats(ratings, windowStart(start, days), end),
      regret: await metricsRecovery(deps.db, new Date(windowStart(start, days)), new Date(end)),
    });
    const snapshot: MetricsSnapshot = {
      ...(await window(1)),
      windows: { d7: await window(7), d30: await window(30) },
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
