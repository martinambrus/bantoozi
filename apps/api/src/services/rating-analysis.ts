import {
  checkAnalysisSelection,
  createAnalysisRequest,
  lockFeeds,
  lockSubscription,
  ratingAnalysisFeeds,
  readOwnUser,
  recordCardTranslationDemand,
  reusableAnalysisRequests,
  type TenantTx,
} from '@bantoozi/db';
import { AppError, type JobSender } from '@bantoozi/shared';

import type { ApiConfig } from '../context.js';
import { captureSelectionSnapshot, loadSnapshotConfig } from './analysis.js';

/**
 * The analysis request a rating attaches to when the client sent none (D-238): rating an article
 * of a training (or active) feed asks for its analysis, so the rating can teach once it completes.
 * Runs in the rating's transaction before the rating is applied, so the request's frozen input is
 * pre-feedback (spec 06 §8.2). A current request of the article on one of those feeds is reused;
 * otherwise one is created on the first training feed carrying it (then active ones). Returns
 * undefined, and the rating goes on without one, when no such feed carries the article, an active
 * feed analyses it on its own, the article changed since it was shown, or classification is not
 * configured.
 */
export async function analysisForRating(
  tx: TenantTx,
  input: {
    articleId: string;
    contentRevision: string;
    config: ApiConfig;
    typesafeModel: string;
    outbox: JobSender;
    now: Date;
  },
): Promise<string | undefined> {
  // The user row first, as `POST /subscriptions/:feedId/analyze` does: one lock order.
  const user = await readOwnUser(tx, { lock: true });
  const feeds = await ratingAnalysisFeeds(tx, input.articleId);
  if (feeds.length === 0 || feeds.some((feed) => feed.admitted)) return undefined;
  const article = { id: input.articleId, contentRevision: input.contentRevision };
  for (const feed of feeds) {
    const reusable = await reusableAnalysisRequests(tx, {
      feedId: feed.feedId,
      inferenceVersion: feed.version,
      articles: [article],
    });
    const existing = reusable.get(input.articleId);
    if (existing !== undefined) return existing.id;
  }

  const [chosen] = feeds;
  if (chosen === undefined) return undefined;
  await lockFeeds(tx, [chosen.feedId]);
  const current = await lockSubscription(tx, chosen.feedId);
  if (current === null || current.version !== chosen.version || current.mode === 'off') {
    return undefined;
  }
  const problems = await checkAnalysisSelection(tx, chosen.feedId, [article]);
  if (problems.size > 0) return undefined;
  let config;
  try {
    config = await loadSnapshotConfig(tx, input.config, input.typesafeModel);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONFLICT') return undefined;
    throw error;
  }
  const inputSnapshot = await captureSelectionSnapshot(tx, {
    feedId: chosen.feedId,
    articleId: input.articleId,
    config,
    capturedAt: input.now,
  });
  const request = await createAnalysisRequest(tx, {
    feedId: chosen.feedId,
    articleId: input.articleId,
    articleRevision: input.contentRevision,
    inferenceVersion: chosen.version,
    inputSnapshot,
  });
  await recordCardTranslationDemand(tx, input.outbox, user.id);
  return request.id;
}
