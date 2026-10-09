import type { APIRequestContext } from '@playwright/test';

import { articleByTitle, subscriptionsOf } from '../reader-support/api.js';
import { callJson } from '../support/api.js';
import { expect } from '../support/test.js';

/**
 * A reader's request to analyze one article, and what became of it (spec 08 §4.1): the work that
 * needs the language model, and so a working provider key.
 */

/** Requests the analysis of the article; the first request of a feed starts its training. */
export async function requestAnalysis(
  user: APIRequestContext,
  feedId: string,
  title: string,
): Promise<void> {
  const article = await articleByTitle(user, title);
  const subscription = (await subscriptionsOf(user)).find((item) => item.feed.id === feedId);
  if (subscription === undefined) throw new Error(`the reader does not follow feed ${feedId}`);
  await callJson<unknown>(user, 'POST', `/api/v1/subscriptions/${feedId}/analyze`, {
    data: {
      articles: [{ id: article.id, contentRevision: article.contentRevision }],
      expectedInferenceVersion: subscription.inferenceVersion,
      ...(subscription.inferenceMode === 'off' ? { startTraining: true } : {}),
    },
    expected: 202,
  });
}

/** Waits for the analysis of the article to finish with a result. */
export async function expectAnalysisComplete(
  user: APIRequestContext,
  title: string,
): Promise<void> {
  await expect
    .poll(async () => (await articleByTitle(user, title)).analysis.status, {
      message: `"${title}" is analyzed`,
      timeout: 60_000,
      intervals: [250, 500, 1_000],
    })
    .toBe('complete');
}

/**
 * Switches classification of the feed off. A request that is still parked for the reader is
 * revoked at its next attempt, before it asks the model service for anything (spec 05 §1.1).
 */
export async function switchClassificationOff(
  user: APIRequestContext,
  feedId: string,
): Promise<void> {
  const subscription = (await subscriptionsOf(user)).find((item) => item.feed.id === feedId);
  if (subscription === undefined) throw new Error(`the reader does not follow feed ${feedId}`);
  await callJson<unknown>(user, 'POST', `/api/v1/subscriptions/${feedId}/inference`, {
    data: { mode: 'off', expectedVersion: subscription.inferenceVersion },
  });
  const after = (await subscriptionsOf(user)).find((item) => item.feed.id === feedId);
  expect(after?.inferenceMode, 'classification is off').toBe('off');
}
