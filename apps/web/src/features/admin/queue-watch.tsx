import type { AdminOverview, AdminSettingsPatchResult } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Spinner } from '../../components/spinner.js';
import { useAdminKey } from './use-admin.js';

/** How often the queue counts are read while queued work is running. */
export const QUEUE_POLL_MS = 3000;
/** Queued work that has not drained after this long is left alone. */
export const QUEUE_WATCH_CAP_MS = 600_000;
/** The outbox relays an intent to its queue a moment after the request: an empty queue this soon proves nothing. */
export const QUEUE_GRACE_MS = 15_000;

/**
 * The house queues a saved setting makes the server queue work on (spec 08 §9). `ranker.thresholds`
 * is left out: `user.rank` is busy with every user's own work, so it never drains.
 */
export const SETTING_QUEUES: Readonly<Record<string, readonly string[]>> = {
  'question_sets.active': ['house.reenrich', 'house.rematch'],
  card_text_mode: ['house.rematch', 'house.translate-cards'],
  'engine.prefilter_enabled': ['house.rematch'],
  'engine.prefilter_min_cards': ['house.rematch'],
  language_modes: ['house.reenrich'],
  'engine.laya': ['house.reenrich'],
};

/** The queues the server queued work on for a saved key; none when the save changed nothing or queued nothing. */
export function savedQueues(
  key: string,
  result: AdminSettingsPatchResult,
): readonly string[] | undefined {
  if (!result.changed.includes(key as never)) return undefined;
  // The server rematches for a new minimum only while the prefilter is on.
  if (key === 'engine.prefilter_min_cards' && result.values['engine.prefilter_enabled'] !== true) {
    return undefined;
  }
  return SETTING_QUEUES[key];
}

interface Watch {
  queues: readonly string[];
  startedAt: number;
  /** Some of the queues was seen holding work since the watch began. */
  seen: boolean;
}

function backlog(data: AdminOverview | undefined, queues: readonly string[]): number {
  return (
    (data?.queues ?? [])
      .filter((row) => queues.includes(row.queue))
      // A job waiting for another attempt after a transient failure is not done either.
      .reduce((sum, row) => sum + row.created + row.retry + row.active, 0)
  );
}

function isDone(
  data: AdminOverview | undefined,
  updatedAt: number,
  watch: Watch,
  now: number,
): boolean {
  const elapsed = now - watch.startedAt;
  if (elapsed >= QUEUE_WATCH_CAP_MS) return true;
  // Only a read taken after the request can say the queues drained.
  if (updatedAt < watch.startedAt || backlog(data, watch.queues) > 0) return false;
  return watch.seen || elapsed >= QUEUE_GRACE_MS;
}

/**
 * Follows background work a request only queued: `busy` holds from `start` until the named queues
 * hold nothing waiting or running (read from the overview), or the cap passes.
 */
export function useQueueWatch() {
  const api = useApi();
  const adminKey = useAdminKey();
  const [watch, setWatch] = useState<Watch | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const query = useQuery({
    queryKey: adminKey('overview'),
    queryFn: ({ signal }) => api.call(routes.adminOverview, undefined, { signal }),
    enabled: watch !== null,
    refetchInterval: (q) =>
      watch !== null && !isDone(q.state.data, q.state.dataUpdatedAt, watch, Date.now())
        ? QUEUE_POLL_MS
        : false,
  });

  const busy = watch !== null && !isDone(query.data, query.dataUpdatedAt, watch, now);
  const holdsWork =
    watch !== null &&
    query.dataUpdatedAt >= watch.startedAt &&
    backlog(query.data, watch.queues) > 0;

  useEffect(() => {
    if (holdsWork)
      setWatch((current) =>
        current === null || current.seen ? current : { ...current, seen: true },
      );
  }, [holdsWork]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  return {
    busy,
    start: (queues: readonly string[]) => {
      const startedAt = Date.now();
      setNow(startedAt);
      setWatch({ queues, startedAt, seen: false });
    },
  };
}

/** A status line with a spinner for work that goes on in the background. */
export function BackgroundWork({ label, status = true }: { label: string; status?: boolean }) {
  return (
    <p
      {...(status ? { role: 'status' } : {})}
      className="flex items-center gap-2 text-sm font-medium"
    >
      <Spinner className="size-4" />
      {label}
    </p>
  );
}

/** Re-renders every second while `active`, so a time limit is noticed without any new data. */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
