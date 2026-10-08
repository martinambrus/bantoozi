import type { ArticleCounts } from '@bantoozi/shared';
import { useEffect, useRef, useState } from 'react';

import {
  ROUND_AFTER_MS,
  roundIsDue,
  statusesOf,
  summarize,
  type Batch,
  type BatchSummary,
} from './batch.js';
import { useFeedArticles, useFeedCounts } from './calibration-queries.js';

export interface BatchProgress {
  summary: BatchSummary;
  /** How many of the feed's articles are scored; absent until the counts have arrived. */
  counts: ArticleCounts | undefined;
}

/**
 * How far the analysis of the selected articles has come. The feed's articles and counts are asked
 * for again every few seconds while a request is waiting or running, and not otherwise.
 */
export function useBatchProgress(batch: Batch | null): BatchProgress | null {
  const feedId = batch?.feedId ?? null;
  const articles = useFeedArticles(feedId, (items) =>
    batch === null ? false : summarize(statusesOf(batch, items)).running,
  );
  const summary = batch === null ? null : summarize(statusesOf(batch, articles.data));
  const running = summary?.running === true;
  const counts = useFeedCounts(feedId, running);

  // The poll that finds the last request done has stopped the counts' own; they are asked once more.
  const { refetch: refetchCounts } = counts;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void refetchCounts();
    wasRunning.current = running;
  }, [running, refetchCounts]);

  return summary === null ? null : { summary, counts: counts.data };
}

/** Whether `ms` have passed since `since`, a time in milliseconds; never while there is none. */
function useElapsed(since: number | null, ms: number): boolean {
  const [elapsedSince, setElapsedSince] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const remaining = since + ms - Date.now();
    if (remaining <= 0) {
      setElapsedSince(since);
      return;
    }
    const timer = setTimeout(() => {
      setElapsedSince(since);
    }, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [since, ms]);
  return since !== null && elapsedSince === since;
}

/**
 * Whether the round of articles to rate is open. It opens when enough of the selected articles are
 * analyzed, when none is still being analyzed, or a minute after they were sent, and stays open.
 */
export function useRoundOpen(batch: Batch | null, progress: BatchProgress | null): boolean {
  const waited = useElapsed(batch?.startedAt ?? null, ROUND_AFTER_MS);
  const due = roundIsDue(progress?.summary ?? null, waited);
  const [opened, setOpened] = useState(false);
  if (due && !opened) setOpened(true);
  return opened || due;
}
