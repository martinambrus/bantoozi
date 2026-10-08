import type { AnalysisRequestStatus, AnalyzeResponse, ArticleListItem } from '@bantoozi/shared';

/** How often the progress of the selected articles is asked for while some are still running. */
export const POLL_MS = 5_000;
/** The round of articles to rate opens once this many of the selected ones are analyzed. */
export const ROUND_AFTER_ANALYZED = 10;
/** The round opens this long after the submission whatever has happened. */
export const ROUND_AFTER_MS = 60_000;

/** The articles of one feed that were sent to be analyzed, and when. */
export interface Batch {
  feedId: string;
  startedAt: number;
  /** The status each article had when the API accepted it. */
  accepted: ReadonlyMap<string, AnalysisRequestStatus>;
}

export interface BatchSummary {
  /** How many articles were selected. */
  total: number;
  analyzed: number;
  /** Whether any request is still waiting or running. */
  running: boolean;
}

/** More articles of the same feed join its batch; articles of another feed start a new one. */
export function joinBatch(
  batch: Batch | null,
  feedId: string,
  requests: AnalyzeResponse['requests'],
  now: number,
): Batch {
  const same = batch !== null && batch.feedId === feedId;
  const accepted = new Map(same ? batch.accepted : []);
  for (const request of requests) accepted.set(request.articleId, request.status);
  return { feedId, startedAt: same ? batch.startedAt : now, accepted };
}

/**
 * The status of each selected article. The list is newer than the answer to the submission, except
 * while it still shows the article as not requested; an article that has left the list is unknown.
 */
export function statusesOf(
  batch: Batch,
  items: readonly ArticleListItem[] | undefined,
): Map<string, AnalysisRequestStatus | null> {
  const statuses = new Map<string, AnalysisRequestStatus | null>();
  for (const [id, accepted] of batch.accepted) {
    if (items === undefined) {
      statuses.set(id, accepted);
      continue;
    }
    const listed = items.find((item) => item.id === id)?.analysis.status;
    statuses.set(id, listed === undefined ? null : listed === 'not_requested' ? accepted : listed);
  }
  return statuses;
}

export function summarize(
  statuses: ReadonlyMap<string, AnalysisRequestStatus | null>,
): BatchSummary {
  const all = [...statuses.values()];
  return {
    total: all.length,
    analyzed: all.filter((status) => status === 'complete').length,
    running: all.some((status) => status === 'pending' || status === 'running'),
  };
}

/** Whether the round of articles to rate should be offered. */
export function roundIsDue(summary: BatchSummary | null, waited: boolean): boolean {
  if (summary === null) return false;
  return summary.analyzed >= ROUND_AFTER_ANALYZED || !summary.running || waited;
}
