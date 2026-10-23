import {
  accessibleArticleTitles,
  cardHintDismissals,
  cardsMadeFromFeedArticles,
  countEstimateRatings,
  listSubscribedFeedIds,
  listTrainingFeeds,
  loadLastDeactivation,
  loadLearningHistory,
  loadEstimateState,
  loadLearnSamples,
  loadModelState,
  RATING_FINGERPRINT_STATE_KEYS,
  ratingFingerprintStateOf,
  readStoredSettings,
  tenantUserId,
  type RatingDefaults,
  type TenantTx,
} from '@bantoozi/db';
import {
  eligibleRows,
  ESTIMATE_SPEC,
  estimateGate,
  FEED_AGREEMENT,
  feedAgreement,
  learningCounts,
  resolveRankerSettings,
  uncoveredSuggests,
  type TrainingSample,
} from '@bantoozi/ranker';
import {
  EngineCircuitSchema,
  EngineModelPinSchema,
  HouseProgressSchema,
  type LearningHistory,
  type LearningStatus,
} from '@bantoozi/shared';

import { z } from 'zod';

import { classificationStatus } from './classification-status.js';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const LastRunSchema = z
  .object({
    at: z.iso.datetime({ offset: true }),
    movedUp: z.number().int().min(0),
    movedDown: z.number().int().min(0),
  })
  .strict();
const FeedMetricsSchema = z.object({
  n: z.number().int().min(0),
  auc: z.number().nullable().catch(null),
});
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
  const stored = await readStoredSettings(tx, [
    'ranker.thresholds',
    'ranker.settings_version',
    'engine.circuit',
    'engine.model_pin',
    'house.progress',
    ...RATING_FINGERPRINT_STATE_KEYS,
  ]);
  const { config } = resolveRankerSettings({
    thresholds: stored.get('ranker.thresholds'),
    settingsVersion: stored.get('ranker.settings_version'),
  });
  const fingerprint = ratingFingerprintStateOf(stored, defaults);
  const state = await loadModelState(tx, userId);
  const strict = state.latestTerminal?.metrics['strictRatingSha'] === fingerprint.sha;
  const { samples } = await loadLearnSamples(tx, { userId, now });
  const { rows } = eligibleRows(samples as unknown as TrainingSample[], {
    now,
    historyDays: config.model.historyDays,
    ratingSha: fingerprint.sha,
    familySha: fingerprint.familySha,
    families: strict ? {} : fingerprint.families,
  });
  const estimate = await loadEstimateState(tx, userId);

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

  const stamp = state.active === null ? await loadLastDeactivation(tx, userId) : null;
  const deactivated =
    stamp !== null && (stamp.reason === 'incompatible' || stamp.reason === 'lost_evidence')
      ? {
          at: stamp.at,
          reason:
            stamp.reason === 'incompatible'
              ? ('incompatible' as const)
              : ('lost_evidence' as const),
        }
      : null;

  const trainingFeeds = await listTrainingFeeds(tx);
  const acted = await cardsMadeFromFeedArticles(
    tx,
    trainingFeeds.map((feed) => feed.feedId),
  );
  const dismissed = await cardHintDismissals(
    tx,
    trainingFeeds.map((feed) => feed.feedId),
  );
  /** The later of two cutoffs (either may be absent). */
  const later = (a: Date | null | undefined, b: Date | null | undefined): Date | null =>
    a == null ? (b ?? null) : b == null || a > b ? a : b;
  // Likes rated before the user made a card from the feed's articles no longer count as uncovered,
  // nor dislikes rated before a Never card made from them as unwanted; "Not now" on a hint moves
  // its cutoff the same way (D-265).
  const agreements = trainingFeeds.map((feed) => {
    const { uncovered, unwanted, ...agreement } = feedAgreement(
      rows,
      feed.feedId,
      config,
      `agreement|${userId}|${feed.feedId}`,
    );
    const actedAt = acted.get(feed.feedId);
    const since = (items: { articleId: string; at: Date }[], cutoff: Date | null | undefined) => {
      const kept = cutoff == null ? items : items.filter((i) => i.at > cutoff);
      return {
        count: kept.length,
        articleIds: kept.slice(0, FEED_AGREEMENT.uncoveredArticles).map((i) => i.articleId),
      };
    };
    return {
      feed,
      agreement,
      uncovered: since(uncovered.items, later(actedAt?.like, dismissed.get(feed.feedId)?.interest)),
      unwanted: since(unwanted.items, later(actedAt?.never, dismissed.get(feed.feedId)?.never)),
    };
  });
  const titles = await accessibleArticleTitles(
    tx,
    agreements.flatMap(({ uncovered, unwanted }) => [
      ...uncovered.articleIds,
      ...unwanted.articleIds,
    ]),
  );
  const named = (articleIds: string[]) =>
    articleIds.flatMap((id) => {
      const title = titles.get(id);
      return title === undefined ? [] : [{ id, title }];
    });
  const current = estimate !== null && estimate.spec === ESTIMATE_SPEC ? estimate : null;
  const feedMetrics = new Map<string, { n: number; auc: number | null }>();
  const rawFeeds: unknown = current?.metrics['feeds'];
  if (typeof rawFeeds === 'object' && rawFeeds !== null && !Array.isArray(rawFeeds)) {
    for (const [feedId, value] of Object.entries(rawFeeds)) {
      const parsed = FeedMetricsSchema.safeParse(value);
      if (parsed.success) feedMetrics.set(feedId, { n: parsed.data.n, auc: parsed.data.auc });
    }
  }
  const feeds = agreements.map(({ feed, agreement, uncovered, unwanted }) => {
    const likeArticles = named(uncovered.articleIds);
    const neverArticles = named(unwanted.articleIds);
    return {
      feedId: feed.feedId,
      ...agreement,
      uncovered: {
        count: uncovered.count,
        suggest: uncoveredSuggests(uncovered.count, agreement.likes) && likeArticles.length > 0,
        articles: likeArticles,
      },
      unwanted: {
        count: unwanted.count,
        suggest: uncoveredSuggests(unwanted.count, agreement.dislikes) && neverArticles.length > 0,
        articles: neverArticles,
      },
      articlesPerWeek: feed.items7d === null ? null : Math.round(feed.items7d),
      estimate: feedMetrics.get(feed.feedId) ?? null,
    };
  });
  const training = new Set(trainingFeeds.map((feed) => feed.feedId));
  const estimateOnly = (await listSubscribedFeedIds(tx)).flatMap((feedId) => {
    const metrics = feedMetrics.get(feedId);
    return training.has(feedId) || metrics === undefined ? [] : [{ feedId, estimate: metrics }];
  });
  const needed =
    current === null
      ? estimateGate(
          await countEstimateRatings(
            tx,
            userId,
            new Date(now.getTime() - config.model.historyDays * 86_400_000),
          ),
          config.estimate,
        ).needed
      : 0;

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
    feeds: [...feeds, ...estimateOnly],
    classification: classificationStatus({
      circuit: EngineCircuitSchema.safeParse(stored.get('engine.circuit')).data,
      pin: EngineModelPinSchema.safeParse(stored.get('engine.model_pin')).data,
      progress: HouseProgressSchema.safeParse(stored.get('house.progress')).data,
    }),
    estimates:
      current === null
        ? null
        : {
            n: current.n,
            auc: num(current.metrics['auc']),
            trainedAt: current.trainedAt.toISOString(),
            lastRun: parsedLastRun(current.metrics),
          },
    estimateGate: { needed },
  };
}

function parsedLastRun(metrics: Record<string, unknown>) {
  const run = LastRunSchema.safeParse(metrics['lastRun']).data;
  return run === undefined ? null : { ...run, fromRatings: metrics['fromRatings'] === true };
}

/** The learning milestones, oldest first, for `GET /me/learning/history`. */
export async function loadLearningHistoryStatus(tx: TenantTx): Promise<LearningHistory> {
  const { rows, truncated } = await loadLearningHistory(tx, tenantUserId(tx));
  return {
    items: rows.map((row) => ({
      at: row.at.toISOString(),
      kind: row.kind,
      n: row.n,
      auc: row.auc,
      baselineAuc: row.baselineAuc,
      activated: row.activated,
      turnedOn: row.turnedOn,
      engineModel: row.engineModel,
    })),
    truncated,
  };
}
