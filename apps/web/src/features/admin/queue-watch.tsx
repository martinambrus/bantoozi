import type { AdminOverview, AdminSettingsPatchResult } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Spinner } from '../../components/spinner.js';
import { useAdminKey } from './use-admin.js';

/** How often the queue counts are read while queued work is running. */
export const QUEUE_POLL_MS = 3000;
/** Queued work that has not drained after this long is left alone. */
export const QUEUE_WATCH_CAP_MS = 600_000;
/**
 * The outbox relays an intent to its queue a moment after it is stored (by the request, or by a job
 * that queues follow-up work): the queues must stay empty this long after the request and after the
 * last work seen before the work counts as done.
 */
export const QUEUE_GRACE_MS = 15_000;

/**
 * The house queues a saved setting stored work for, as the server reports them (it compares with
 * the stored values, which may differ from what this screen showed); none when it queued nothing.
 * `ranker.thresholds` queues per-user rank work, which is never reported: `user.rank` never drains.
 */
export function savedQueues(result: AdminSettingsPatchResult): readonly string[] | undefined {
  return result.queued.length === 0 ? undefined : result.queued;
}

interface Watch {
  queues: readonly string[];
  startedAt: number;
}

function backlog(data: AdminOverview | undefined, queues: readonly string[]): number {
  return (
    (data?.queues ?? [])
      .filter((row) => queues.includes(row.queue))
      // A job waiting for another attempt after a transient failure is not done either.
      .reduce((sum, row) => sum + row.created + row.retry + row.active, 0)
  );
}

/**
 * `lastWorkAt`: when a read last showed the queues holding work (the start until one does). Only a
 * read taken after it can say the queues drained, and they must have stayed quiet for the grace.
 */
function isDone(
  data: AdminOverview | undefined,
  updatedAt: number,
  watch: Watch,
  lastWorkAt: number,
  now: number,
): boolean {
  if (now - watch.startedAt >= QUEUE_WATCH_CAP_MS) return true;
  if (updatedAt <= lastWorkAt || backlog(data, watch.queues) > 0) return false;
  return now - lastWorkAt >= QUEUE_GRACE_MS;
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
  // When a read last showed this watch's queues holding work. Every watch on the screen shares the
  // overview query (one request may serve them all), so each records it from the shared result.
  const lastWork = useRef(0);

  const query = useQuery({
    queryKey: adminKey('overview'),
    queryFn: ({ signal }) => api.call(routes.adminOverview, undefined, { signal }),
    enabled: watch !== null,
    refetchInterval: (q) =>
      watch !== null &&
      !isDone(q.state.data, q.state.dataUpdatedAt, watch, lastWork.current, Date.now())
        ? QUEUE_POLL_MS
        : false,
  });

  const { data, dataUpdatedAt } = query;
  useEffect(() => {
    if (watch === null || dataUpdatedAt < watch.startedAt) return;
    if (backlog(data, watch.queues) > 0) {
      lastWork.current = Math.max(lastWork.current, dataUpdatedAt);
    }
  }, [watch, data, dataUpdatedAt]);

  const busy =
    watch !== null &&
    !isDone(data, dataUpdatedAt, watch, Math.max(lastWork.current, watch.startedAt), now);

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
      lastWork.current = startedAt;
      setWatch({ queues, startedAt });
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
