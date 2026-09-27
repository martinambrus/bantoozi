import { readStoredSetting, retryTransaction, workerOutbox, type Database } from '@bantoozi/db';
import {
  HOUSE_CRON_SCHEDULES,
  enqueueHouse,
  readSetting,
  type HouseCronQueue,
  type HouseCronSchedule,
  type QueueName,
  type SettingEnvDefaults,
} from '@bantoozi/shared';

/**
 * Startup catch-up (spec 11 §6): cron does not replay runs missed while no worker was up, so each
 * scheduled housekeeping job this worker consumes is enqueued once, through the outbox, when its
 * last recorded run (`settings['house.progress'][job].updatedAt`) is missing or older than its
 * period. The queue's singleton policy keeps duplicates from several workers to one job. Returns
 * the jobs enqueued.
 */
export async function enqueueOverdueHousekeeping(
  db: Database,
  consuming: readonly QueueName[],
  env: SettingEnvDefaults,
  now: Date,
): Promise<HouseCronQueue[]> {
  const progress =
    readSetting('house.progress', await readStoredSetting(db, 'house.progress'), env) ?? {};
  const schedules = Object.entries(HOUSE_CRON_SCHEDULES) as Array<
    [HouseCronQueue, HouseCronSchedule]
  >;
  const overdue = schedules
    .filter(([queue, schedule]) => {
      if (!consuming.includes(queue)) return false;
      const last = progress[queue]?.updatedAt;
      return last === undefined || now.getTime() - Date.parse(last) >= schedule.everyMs;
    })
    .map(([queue]) => queue);
  if (overdue.length > 0) {
    await retryTransaction(db, async (tx) => {
      for (const queue of overdue) await enqueueHouse(workerOutbox(tx), queue);
    });
  }
  return overdue;
}
