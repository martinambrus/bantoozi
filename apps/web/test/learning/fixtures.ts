import type { LearningFeedAgreement, LearningStatus } from '@bantoozi/shared';

import { json } from '../api/fake-fetch.js';
import type { ApiRouteHandler } from '../support/app.js';

export const LEARNING = 'GET /me/learning';

/** A schema-valid status: no ratings yet, no model, no feed in training. */
export function makeLearning(
  model: Partial<LearningStatus['model']> = {},
  feeds: LearningFeedAgreement[] = [],
): LearningStatus {
  return {
    model: {
      thresholds: { minExplicit: 40, minEachClass: 10, minCvAuc: 0.6 },
      counts: { explicit: 0, likes: 0, dislikes: 0 },
      active: null,
      lastAttempt: null,
      deactivated: null,
      ...model,
    },
    feeds,
  };
}

export function makeAgreement(
  feedId: string,
  status: LearningFeedAgreement['status'],
  over: Partial<LearningFeedAgreement> = {},
): LearningFeedAgreement {
  return {
    feedId,
    status,
    likes: 0,
    dislikes: 0,
    auc: null,
    aucLow: null,
    ratedHigh: { total: 0, liked: 0 },
    ratedLow: { total: 0, disliked: 0 },
    articlesPerWeek: null,
    ...over,
  };
}

/** A feed whose analysis agrees with the reader: 8 of 10 rated high liked, 7 of 9 rated low disliked. */
export const readyAgreement = (feedId: string, over: Partial<LearningFeedAgreement> = {}) =>
  makeAgreement(feedId, 'ready', {
    likes: 12,
    dislikes: 9,
    auc: 0.81,
    aucLow: 0.7,
    ratedHigh: { total: 10, liked: 8 },
    ratedLow: { total: 9, disliked: 7 },
    articlesPerWeek: 14,
    ...over,
  });

export const learningRoute =
  (status: () => LearningStatus = () => makeLearning()): ApiRouteHandler =>
  () =>
    json(200, status());
