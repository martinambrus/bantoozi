import {
  auc,
  baselineScore,
  eligibleRows,
  feedAgreement,
  groupedBootstrapCi,
  sampleFeedIds,
  type FeedAgreementStatus,
  type ReadonlyRankerConfig,
  type TrainingSample,
} from '@bantoozi/ranker';
import { compareBigIntStrings } from '@bantoozi/shared';

import type { RunData } from '../report/run-data.js';
import { buildRaterSamples, type LearningArticle } from '../learning-curve/samples.js';

/** The cards' agreement with a feed's ratings that came after the feed first turned ready. */
export interface LaterAgreement {
  auc: number | null;
  aucLow: number | null;
  n: number;
}

/** One feed of one rater: when the agreement rule first said ready and how it held up. */
export interface FeedReplay {
  feedId: string;
  ratings: number;
  likes: number;
  dislikes: number;
  /** The number of the feed's ratings so far when it first became ready. */
  firstReadyAt: number | null;
  finalStatus: FeedAgreementStatus;
  finalAuc: number | null;
  finalAucLow: number | null;
  later: LaterAgreement | null;
  falseAlarm: boolean | null;
}

export interface RaterAgreement {
  raterId: string;
  participantKey: string;
  feeds: FeedReplay[];
}

export interface AgreementReplay {
  raters: RaterAgreement[];
}

function ratingTime(sample: TrainingSample): number {
  return sample.feedbackAt.getTime();
}

function laterAgreement(
  feed: readonly TrainingSample[],
  readyAt: number,
  config: ReadonlyRankerConfig,
  seed: string,
): LaterAgreement {
  const after = new Set(feed.slice(readyAt).map((s) => s.articleId));
  const last = feed[feed.length - 1];
  const { rows } = eligibleRows(feed, {
    now: last === undefined ? new Date(0) : last.feedbackAt,
    historyDays: config.model.historyDays,
    ratingSha: last?.features?.ratingSha ?? null,
  });
  const mine = rows.filter((r) => r.s.explicit && after.has(r.s.articleId));
  const scores = mine.map((r) => baselineScore(r, config));
  const y = mine.map((r) => r.s.y);
  return {
    auc: auc(scores, y),
    aucLow:
      groupedBootstrapCi(
        mine.map((r) => r.s.groupId),
        (m) => auc(scores, y, m),
        seed,
      )?.[0] ?? null,
    n: mine.length,
  };
}

function replayFeed(
  feedId: string,
  feed: readonly TrainingSample[],
  config: ReadonlyRankerConfig,
  seed: string,
): FeedReplay {
  const ratingSha = feed[0]?.features?.ratingSha ?? null;
  const at = (k: number): ReturnType<typeof feedAgreement> & { sha: string | null } => {
    const prefix = feed.slice(0, k);
    const last = prefix[prefix.length - 1];
    const { rows } = eligibleRows(prefix, {
      now: last === undefined ? new Date(0) : last.feedbackAt,
      historyDays: config.model.historyDays,
      ratingSha,
    });
    return { ...feedAgreement(rows, feedId, config, `${seed}|${k}`), sha: ratingSha };
  };
  let firstReadyAt: number | null = null;
  let final = at(0);
  for (let k = 1; k <= feed.length; k += 1) {
    final = at(k);
    if (firstReadyAt === null && final.status === 'ready') firstReadyAt = k;
  }
  const later =
    firstReadyAt === null ? null : laterAgreement(feed, firstReadyAt, config, `${seed}|later`);
  return {
    feedId,
    ratings: feed.length,
    likes: final.likes,
    dislikes: final.dislikes,
    firstReadyAt,
    finalStatus: final.status,
    finalAuc: final.auc,
    finalAucLow: final.aucLow,
    later,
    falseAlarm: later === null || later.auc === null ? null : later.auc < config.model.minCvAuc,
  };
}

/**
 * Replay every rater's stored ratings per feed in rating order (development and test together) and
 * report when the per-feed agreement rule would first say ready and whether the cards kept agreeing
 * on that feed's later ratings. Pure: it reads the run and the parsed samples only.
 */
export function replayAgreement(input: {
  run: RunData;
  articles: ReadonlyMap<string, LearningArticle>;
  config: ReadonlyRankerConfig;
  seedBase: string;
}): AgreementReplay {
  const { run, articles, config, seedBase } = input;
  const raters: RaterAgreement[] = [];
  for (const rater of run.config.raters) {
    const built = buildRaterSamples({ run, raterId: rater.raterId, articles });
    const ordered = [...built.dev, ...built.test].sort(
      (a, b) => ratingTime(a) - ratingTime(b) || compareBigIntStrings(a.articleId, b.articleId),
    );
    const byFeed = new Map<string, TrainingSample[]>();
    for (const sample of ordered) {
      for (const feedId of new Set(sampleFeedIds(sample.features))) {
        byFeed.set(feedId, [...(byFeed.get(feedId) ?? []), sample]);
      }
    }
    const feeds = [...byFeed.entries()]
      .sort(([a], [b]) => compareBigIntStrings(a, b))
      .map(([feedId, feed]) =>
        replayFeed(feedId, feed, config, `${seedBase}|${rater.raterId}|${feedId}`),
      );
    raters.push({ raterId: rater.raterId, participantKey: built.participantKey, feeds });
  }
  return { raters };
}
