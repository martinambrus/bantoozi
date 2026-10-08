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

/** What 30-day compression does to a bookmark snapshot (house.purge-bodies, spec 11 §5.2). */
export async function markSnapshotCold(control: Control, snapshotId: string): Promise<void> {
  const done = await control.sql<{ markedCold: number; hotCopiesRemoved: number }>(
    'markSnapshotCold',
    { snapshotId },
  );
  expect(done).toEqual({ markedCold: 1, hotCopiesRemoved: 1 });
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
        return found?.pipelineState;
      },
      { message: `"${appended.title}" is extracted`, timeout: 45_000, intervals: [500, 1_000] },
    )
    .toBe('extracted');
  if (pageStatus !== undefined) {
    expect(
      (await requestsFor(control, key, pagePath)).length,
      `the worker asked for the page of "${appended.title}" and was refused`,
    ).toBeGreaterThan(0);
  }
  return { item: appended, articleId };
}
