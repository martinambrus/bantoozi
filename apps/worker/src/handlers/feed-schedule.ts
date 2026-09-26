import { dueFeedIds, workerOutbox } from '@bantoozi/db';
import { enqueueFetch } from '@bantoozi/shared';

import type { QueueHandler } from './index.js';
import type { WorkerDeps } from './deps.js';

/**
 * `feed.schedule` (spec 03 §3), every minute: record a `feed.fetch` intent for each due feed
 * (subscribed, active or quarantined, `next_fetch_at` reached; at most 300, oldest first) in one
 * transaction. Queue keys only deduplicate; the fetch handler's per-feed lock and its re-read of
 * `next_fetch_at` make a stale or duplicate job a no-op.
 */
export function createFeedScheduleHandler(deps: WorkerDeps): QueueHandler<'feed.schedule'> {
  return async () => {
    const feedIds = await dueFeedIds(deps.db);
    if (feedIds.length === 0) return;
    await deps.db.transaction(async (tx) => {
      const sender = workerOutbox(tx);
      for (const feedId of feedIds) await enqueueFetch(sender, { feedId });
    });
  };
}
