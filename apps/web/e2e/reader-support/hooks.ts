import type { Control, FeedItem, NewFeedItem } from '../support/control.js';
import type { FeedKey } from '../support/env.js';
import { expect } from '../support/test.js';

import { requestsFor } from './origin.js';

/**
 * Typed calls of the reader SQL hooks (packages/testing/src/e2e/hooks-reader.ts) and the one
 * routine built from them that more than one scenario needs.
 */

export interface AnalysisRequestRow {
  id: string;
  articleId: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  errorCode: string | null;
}

/** The analysis requests one account made, oldest first. */
export function analysisRequests(control: Control, email: string): Promise<AnalysisRequestRow[]> {
  return control.sql<AnalysisRequestRow[]>('analysisRequests', { email });
}

/** Queues a forced `feed.fetch`; the worker takes it up within a few seconds. */
export async function fetchFeedNow(control: Control, feedUrl: string): Promise<void> {
  const { queued } = await control.sql<{ queued: number }>('fetchFeedNow', { feedUrl });
  expect(queued, `the feed ${feedUrl} is known to the database`).toBe(1);
}

/**
 * 30-day compression of a bookmark snapshot with the real `house.purge-bodies` (spec 11 §5.2): the
 * snapshot and its article are aged by 31 days, the job is queued through the outbox and the
 * worker runs it; this returns once the snapshot is cold and the hot copy is gone.
 */
export async function runColdMaintenance(control: Control, snapshotId: string): Promise<void> {
  const aged = await control.sql<{ snapshots: number; bodies: number; articles: number }>(
    'ageForColdMaintenance',
    { snapshotId },
  );
  expect(aged).toEqual({ snapshots: 1, bodies: 1, articles: 1 });
  const { queued } = await control.sql<{ queued: number }>('runPurgeBodies', {});
  expect(queued).toBe(1);
  await expect
    .poll(() => control.sql('snapshotMaintenance', { snapshotId }), {
      message: 'the worker ran house.purge-bodies',
      timeout: 60_000,
      intervals: [500, 1_000],
    })
    .toEqual({ cold: true, hotCopy: false, snapshotHasText: true });
}

/** Leaves the article without a feed excerpt and without a stored body. */
export async function clearArticleText(control: Control, articleId: string): Promise<void> {
  const done = await control.sql<{ articles: number; bodies: number }>('clearArticleText', {
    articleId,
  });
  expect(done.articles).toBe(1);
}

export interface Arrival {
  item: FeedItem;
  articleId: string;
}

export interface ArrivalOptions {
  /** Answer the item's page with this status before the fetch (a page the worker cannot read). */
  pageStatus?: number;
}

/**
 * A new item appears in a fixture feed and the worker fetches the feed at once. When this returns
 * the item is ingested for every subscriber and its page is extracted; a page that was answered
 * with an error status is extracted from the feed's own text, and the publisher's log shows that
 * the worker asked for it.
 */
export async function arrive(
  control: Control,
  key: FeedKey,
  item: NewFeedItem,
  { pageStatus }: ArrivalOptions = {},
): Promise<Arrival> {
  const appended = await control.appendItem(key, item);
  const pagePath = new URL(appended.url).pathname;
  if (pageStatus !== undefined) {
    await control.scriptRoute(key, pagePath, pageStatus);
  }
  const { url } = await control.feed(key);
  await fetchFeedNow(control, url);
  let articleId = '';
  await expect
    .poll(
      async () => {
        const found = (await control.articleStates(url)).find(
          (state) => state.title === appended.title,
        );
        articleId = found?.id ?? '';
        return found?.pipelineState ?? 'not ingested';
      },
      { message: `"${appended.title}" is extracted`, timeout: 45_000, intervals: [500, 1_000] },
    )
    // A feed in automatic mode can take the article past `extracted` between two polls.
    .toMatch(/^(extracted|translated|enriched|matched|degraded)$/);
  if (pageStatus !== undefined) {
    expect(
      (await requestsFor(control, key, pagePath)).length,
      `the worker asked for the page of "${appended.title}" and was refused`,
    ).toBeGreaterThan(0);
  }
  return { item: appended, articleId };
}
