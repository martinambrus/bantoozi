import type { APIRequestContext } from '@playwright/test';

import { articleByTitle, type SubscriptionView } from '../reader-support/api.js';
import { callJson } from '../support/api.js';
import { expect } from '../support/test.js';

/**
 * Has one article of an Off feed analyzed, as the button "Start training and analyze this article"
 * does (spec 08 §4.1), and returns once its analysis is complete. The article is one the feed
 * already has, so the fixture feeds, which every scenario of the run shares, stay as they were.
 */
export async function analyzeArticle(
  user: APIRequestContext,
  subscription: SubscriptionView,
  title: string,
): Promise<void> {
  const article = await articleByTitle(user, title);
  await callJson<unknown>(user, 'POST', `/api/v1/subscriptions/${subscription.feed.id}/analyze`, {
    data: {
      articles: [{ id: article.id, contentRevision: article.contentRevision }],
      expectedInferenceVersion: subscription.inferenceVersion,
      startTraining: true,
    },
    expected: 202,
  });
  await expect
    .poll(async () => (await articleByTitle(user, title)).analysis.status, {
      message: `the analysis of "${title}" completes`,
      timeout: 60_000,
      intervals: [500, 1_000],
    })
    .toBe('complete');
}
