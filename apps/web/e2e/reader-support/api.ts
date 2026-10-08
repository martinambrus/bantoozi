import type { APIRequestContext } from '@playwright/test';

import { callJson } from '../support/api.js';
import type { Control } from '../support/control.js';
import { expect } from '../support/test.js';

/**
 * The parts of the HTTP API the scenarios use to arrange or to check what the UI cannot show. The
 * wire shapes are spec 08 (packages/shared/src/dto); only the fields the scenarios read are typed.
 */

export interface SubscriptionView {
  feed: { id: string; url: string; title: string | null };
  inferenceMode: 'off' | 'training' | 'active';
  /** Decimal string; the compare-and-swap token of mode changes and analysis requests. */
  inferenceVersion: string;
  imagePolicy: 'inherit' | 'allow' | 'block';
  effectiveImagesAllowed: boolean;
}

export interface BookmarkCaptureView {
  status: 'pending' | 'saved' | 'partial' | 'failed';
  snapshotId: string | null;
  errorCode: string | null;
}

export interface ArticleView {
  id: string;
  title: string;
  url: string | null;
  lane: string;
  stateVersion: string;
  contentRevision: string;
  imageUrl: string | null;
  mediaPolicyFeedId: string | null;
  effectiveImagesAllowed: boolean;
  readAt: string | null;
  bookmarkedAt: string | null;
  analysis: {
    mode: 'off' | 'training' | 'active';
    status: 'not_requested' | 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
    requestId: string | null;
  };
  bookmarkCapture: BookmarkCaptureView | null;
}

export interface SavedSnapshotView {
  id: string;
  sourceUrl: string | null;
  title: string;
  completeness: 'complete' | 'partial';
  text: string;
  html: string | null;
  mediaPolicyFeedId: string | null;
  effectiveImagesAllowed: boolean;
}

export interface ArticleDetailView extends ArticleView {
  bookmarkSnapshot: SavedSnapshotView | null;
}

export async function subscribe(
  user: APIRequestContext,
  feedUrl: string,
): Promise<SubscriptionView> {
  const created = await callJson<{ subscription: SubscriptionView }>(
    user,
    'POST',
    '/api/v1/subscriptions',
    { data: { url: feedUrl }, expected: 201 },
  );
  return created.subscription;
}

export function subscriptionsOf(user: APIRequestContext): Promise<SubscriptionView[]> {
  return callJson<SubscriptionView[]>(user, 'GET', '/api/v1/subscriptions');
}

export interface MeView {
  preferences: { loadRemoteImages: boolean; markReadOnExpand: boolean };
}

export function meOf(user: APIRequestContext): Promise<MeView> {
  return callJson<MeView>(user, 'GET', '/api/v1/me');
}

/** What the person remembered for one feed, whether or not they still follow it (spec 08 §4.2). */
export interface FeedPreferenceView {
  feedId: string;
  imagePolicy: 'inherit' | 'allow' | 'block';
  effectiveImagesAllowed: boolean;
}

export function feedPreferencesOf(user: APIRequestContext): Promise<FeedPreferenceView[]> {
  return callJson<FeedPreferenceView[]>(user, 'GET', '/api/v1/feed-preferences');
}

/** Articles of a lane (`status: 'all'` includes the ones already read). */
export async function listArticles(
  user: APIRequestContext,
  lane: string,
  status: 'unread' | 'all' = 'unread',
): Promise<ArticleView[]> {
  const list = await callJson<{ items: ArticleView[] }>(user, 'GET', '/api/v1/articles', {
    params: { lane, status, limit: 100 },
  });
  return list.items;
}

export async function articleByTitle(
  user: APIRequestContext,
  title: string,
  lane = 'all',
): Promise<ArticleView> {
  const found = (await listArticles(user, lane, 'all')).find((item) => item.title === title);
  if (found === undefined) throw new Error(`"${title}" is not in the ${lane} lane`);
  return found;
}

export function articleDetail(
  user: APIRequestContext,
  articleId: string,
  saved = false,
): Promise<ArticleDetailView> {
  return callJson<ArticleDetailView>(user, 'GET', `/api/v1/articles/${articleId}`, {
    params: saved ? { view: 'saved' } : {},
  });
}

/** Waits until the worker has extracted at least `count` pages of the feed. */
export async function waitForExtraction(
  control: Control,
  feedUrl: string,
  count: number,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await control.articleStates(feedUrl)).filter(
          (state) => state.pipelineState === 'extracted',
        ).length,
      {
        message: `${count} extracted pages of ${feedUrl}`,
        timeout: 45_000,
        intervals: [500, 1_000],
      },
    )
    .toBeGreaterThanOrEqual(count);
}
