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

const laya = (value: unknown): Set<string> =>
  new Set((value as { enrich?: string[] } | undefined)?.enrich ?? []);
const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((item) => b.has(item));

/**
 * The house queues the server queued work on for a saved key (spec 08 §9, mirroring PATCH
 * /admin/settings); none when the save changed nothing or queued nothing. `previous` is the value the
 * editor showed before the save. `ranker.thresholds` is left out: `user.rank` is busy with every
 * user's own work, so it never drains.
 */
export function savedQueues(
  key: string,
  result: AdminSettingsPatchResult,
  previous?: unknown,
): readonly string[] | undefined {
  if (!result.changed.includes(key as never)) return undefined;
  const next = result.values as Record<string, unknown>;
  const queues: string[] = [];
  switch (key) {
    case 'question_sets.active': {
      // Only a new enrich or match set re-processes articles; a new suggest set queues nothing.
      const before = previous as { enrich?: unknown; match?: unknown } | undefined;
      const after = next[key] as { enrich?: unknown; match?: unknown };
      if (before === undefined || before.enrich !== after.enrich) queues.push('house.reenrich');
      if (before === undefined || before.match !== after.match) queues.push('house.rematch');
      break;
    }
    case 'card_text_mode':
      queues.push('house.rematch');
      if (next[key] === 'english') queues.push('house.translate-cards');
      break;
    case 'engine.prefilter_enabled':
      queues.push('house.rematch');
      break;
    case 'engine.prefilter_min_cards':
      // The server rematches for a new minimum only while the prefilter is on.
      if (next['engine.prefilter_enabled'] === true) queues.push('house.rematch');
      break;
    case 'language_modes':
      queues.push('house.reenrich');
      break;
    case 'engine.laya':
      // Only a change of the languages enriched with Laya re-processes articles.
      if (previous === undefined || !sameSet(laya(previous), laya(next[key]))) {
        queues.push('house.reenrich');
      }
      break;
  }
  return queues.length === 0 ? undefined : queues;
}

interface Watch {
  queues: readonly string[];
  startedAt: number;
  /** When a read last showed the queues holding work (the start until one does). */
  lastWorkAt: number;
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
  if (now - watch.startedAt >= QUEUE_WATCH_CAP_MS) return true;
  // Only a read taken after the request and after the last work seen can say the queues drained.
  if (updatedAt <= watch.lastWorkAt || backlog(data, watch.queues) > 0) return false;
  return now - watch.lastWorkAt >= QUEUE_GRACE_MS;
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
  // The watch as the query function sees it: it records each read that still shows work.
  const current = useRef<Watch | null>(null);
  current.current = watch;

  const query = useQuery({
    queryKey: adminKey('overview'),
    queryFn: async ({ signal }) => {
      const data = await api.call(routes.adminOverview, undefined, { signal });
      const active = current.current;
      if (active !== null && backlog(data, active.queues) > 0) {
        const at = Date.now();
        setWatch((w) => (w === active ? { ...w, lastWorkAt: at } : w));
      }
      return data;
    },
    enabled: watch !== null,
    refetchInterval: (q) =>
      watch !== null && !isDone(q.state.data, q.state.dataUpdatedAt, watch, Date.now())
        ? QUEUE_POLL_MS
        : false,
  });

  const busy = watch !== null && !isDone(query.data, query.dataUpdatedAt, watch, now);

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
      setWatch({ queues, startedAt, lastWorkAt: startedAt });
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
