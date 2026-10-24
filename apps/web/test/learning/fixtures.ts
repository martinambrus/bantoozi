import type {
  EstimatesStatus,
  LearningFeedAgreement,
  LearningFeedEntry,
  LearningFeedEstimate,
  LearningHistory,
  LearningHistoryItem,
  LearningStatus,
} from '@bantoozi/shared';

import { json } from '../api/fake-fetch.js';
import type { ApiRouteHandler } from '../support/app.js';

export const LEARNING = 'GET /me/learning';
export const LEARNING_ESTIMATES = 'GET /me/learning/estimates';
export const LEARNING_HISTORY = 'GET /me/learning/history';

/** A schema-valid status: no ratings yet, no model, no feed in training. */
export function makeLearning(
  model: Partial<LearningStatus['model']> = {},
  feeds: LearningFeedEntry[] = [],
  over: Partial<LearningStatus> = {},
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
    classification: { state: 'ok', since: null, reason: null },
    estimates: null,
    estimateGate: { needed: 0 },
    ...over,
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
    uncovered: { count: 0, suggest: false, articles: [] },
    unwanted: { count: 0, suggest: false, articles: [] },
    articlesPerWeek: null,
    estimate: null,
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

export const makeEstimates = (over: Partial<EstimatesStatus> = {}): EstimatesStatus => ({
  n: 23,
  auc: 0.71,
  trainedAt: '2026-10-20T08:30:00.000Z',
  lastRun: null,
  ...over,
});

export const makeFeedEstimate = (
  feedId: string,
  n: number,
  auc: number | null,
): LearningFeedEstimate => ({ feedId, estimate: { n, auc } });

export const makeHistoryItem = (over: Partial<LearningHistoryItem> = {}): LearningHistoryItem => ({
  at: '2026-10-20T08:30:00.000Z',
  kind: 'estimate',
  n: 20,
  auc: 0.7,
  baselineAuc: null,
  activated: false,
  turnedOn: false,
  engineModel: null,
  ...over,
});

export const makeHistory = (
  items: LearningHistoryItem[] = [],
  truncated: Partial<LearningHistory['truncated']> = {},
): LearningHistory => ({ items, truncated: { model: false, estimate: false, ...truncated } });

export const learningHistoryRoute =
  (history: () => LearningHistory = () => makeHistory()): ApiRouteHandler =>
  () =>
    json(200, history());

export const learningEstimatesRoute =
  (status: () => LearningStatus = () => makeLearning()): ApiRouteHandler =>
  () => {
    const { estimates, estimateGate } = status();
    return json(200, { estimates, estimateGate });
  };
