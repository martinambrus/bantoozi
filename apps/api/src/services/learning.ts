import {
  accessibleArticleTitles,
  listTrainingFeeds,
  loadLearnSamples,
  loadModelState,
  readRatingFingerprint,
  readStoredSettings,
  tenantUserId,
  type RatingDefaults,
  type TenantTx,
} from '@bantoozi/db';
import {
  eligibleRows,
  feedAgreement,
  learningCounts,
  resolveRankerSettings,
  type TrainingSample,
} from '@bantoozi/ranker';
import type { LearningStatus } from '@bantoozi/shared';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The personal model's progress and, for every training subscription, how well the interest-card
 * score agrees with the user's explicit ratings of that feed (computed live, nothing is stored).
 * `defaults` are the rating-fingerprint defaults the API stamps into snapshots.
 */
export async function loadLearningStatus(
  tx: TenantTx,
  now: Date,
  defaults: RatingDefaults,
): Promise<LearningStatus> {
  const userId = tenantUserId(tx);
  const stored = await readStoredSettings(tx, ['ranker.thresholds', 'ranker.settings_version']);
  const { config } = resolveRankerSettings({
    thresholds: stored.get('ranker.thresholds'),
    settingsVersion: stored.get('ranker.settings_version'),
  });
  const ratingSha = await readRatingFingerprint(tx, defaults);
  const { samples } = await loadLearnSamples(tx, { userId, now });
  const { rows } = eligibleRows(samples as unknown as TrainingSample[], {
    now,
    historyDays: config.model.historyDays,
    ratingSha,
  });
  const state = await loadModelState(tx, userId);

  const attempt = state.latestTerminal;
  const attemptStatus = attempt?.metrics['status'];
  const lastAttempt =
    attempt !== null && (attemptStatus === 'activated' || attemptStatus === 'rejected')
      ? {
          at: text(attempt.metrics['attemptAt']) ?? attempt.trainedAt.toISOString(),
          status: attemptStatus === 'activated' ? ('activated' as const) : ('rejected' as const),
          reasons: (text(attempt.metrics['reason']) ?? '').split(',').filter((r) => r !== ''),
          cvAuc: num(attempt.metrics['cvAuc']),
          baselineAuc: num(attempt.metrics['baselineAuc']),
        }
      : null;

  const reason = state.latest?.metrics['deactivatedReason'];
  const deactivatedAt = text(state.latest?.metrics['deactivatedAt']);
  const deactivated =
    state.active === null &&
    deactivatedAt !== null &&
    (reason === 'incompatible' || reason === 'lost_evidence')
      ? {
          at: deactivatedAt,
          reason:
            reason === 'incompatible' ? ('incompatible' as const) : ('lost_evidence' as const),
        }
      : null;

  const agreements = (await listTrainingFeeds(tx)).map((feed) => ({
    feed,
    agreement: feedAgreement(rows, feed.feedId, config, `agreement|${userId}|${feed.feedId}`),
  }));
  const titles = await accessibleArticleTitles(
    tx,
    agreements.flatMap(({ agreement }) => agreement.uncovered.articleIds),
  );
  const feeds = agreements.map(({ feed, agreement: { uncovered, ...agreement } }) => {
    const articles = uncovered.articleIds.flatMap((id) => {
      const title = titles.get(id);
      return title === undefined ? [] : [{ id, title }];
    });
    return {
      feedId: feed.feedId,
      ...agreement,
      uncovered: {
        count: uncovered.count,
        suggest: uncovered.suggest && articles.length > 0,
        articles,
      },
      articlesPerWeek: feed.items7d === null ? null : Math.round(feed.items7d),
    };
  });

  return {
    model: {
      thresholds: {
        minExplicit: config.model.minExplicit,
        minEachClass: config.model.minEachClass,
        minCvAuc: config.model.minCvAuc,
      },
      counts: learningCounts(rows),
      active:
        state.active === null
          ? null
          : { version: state.active.version, since: state.active.trainedAt.toISOString() },
      lastAttempt,
      deactivated,
    },
    feeds,
  };
}
