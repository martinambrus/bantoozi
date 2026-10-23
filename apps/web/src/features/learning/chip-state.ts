import {
  hasAgreement,
  type LearningFeedAgreement,
  type LearningFeedEntry,
  type LearningStatus,
  type Subscription,
} from '@bantoozi/shared';

/** Scored ratings a feed needs before its estimate quality is worth showing. */
export const QUALITY_MIN_RATINGS = 30;

export type EstimateSegment =
  | { kind: 'off' }
  | { kind: 'gate'; needed: number }
  | { kind: 'starting' }
  | {
      kind: 'on';
      /** Ratings of this feed the estimate was checked on, when the API has a figure for the feed. */
      ratedHere: number | null;
      /** Ratings of the whole account the estimates were trained on. */
      total: number;
      quality: number | null;
    };

export type CardsSegment =
  | { kind: 'ready' }
  | { kind: 'agree'; value: number; threshold: number }
  | { kind: 'weak' }
  | { kind: 'none' };

export type ChipState =
  | { kind: 'paused'; classification: LearningStatus['classification'] }
  | { kind: 'shown'; estimate: EstimateSegment; cards: CardsSegment };

export interface ChipInput {
  learning: LearningStatus;
  feedId: string;
  inferenceMode: Subscription['inferenceMode'];
  estimatesPreference: 'on' | 'off';
}

function cardsSegment(
  inferenceMode: Subscription['inferenceMode'],
  agreement: LearningFeedAgreement | undefined,
  threshold: number,
): CardsSegment {
  if (inferenceMode !== 'training' || agreement === undefined) return { kind: 'none' };
  if (agreement.status === 'ready') return { kind: 'ready' };
  if (agreement.status !== 'not_yet') return { kind: 'none' };
  return agreement.aucLow === null
    ? { kind: 'weak' }
    : { kind: 'agree', value: agreement.aucLow, threshold };
}

/** What the header chip of a feed says (visible-learning §4.5): a pure reading of the learning status. */
export function chipState({
  learning,
  feedId,
  inferenceMode,
  estimatesPreference,
}: ChipInput): ChipState {
  if (learning.classification.state === 'paused') {
    return { kind: 'paused', classification: learning.classification };
  }
  const entry: LearningFeedEntry | undefined = learning.feeds.find(
    (feed) => feed.feedId === feedId,
  );
  const agreement = entry !== undefined && hasAgreement(entry) ? entry : undefined;
  const cards = cardsSegment(inferenceMode, agreement, learning.model.thresholds.minCvAuc);

  if (estimatesPreference === 'off') return { kind: 'shown', estimate: { kind: 'off' }, cards };
  const { estimates, estimateGate } = learning;
  if (estimates === null) {
    const estimate: EstimateSegment =
      estimateGate.needed > 0
        ? { kind: 'gate', needed: estimateGate.needed }
        : { kind: 'starting' };
    return { kind: 'shown', estimate, cards };
  }
  // The quality belongs to the feed's own scored ratings: the account's pooled figure says little
  // about a feed with few ratings of its own.
  const own = entry?.estimate ?? null;
  return {
    kind: 'shown',
    estimate: {
      kind: 'on',
      ratedHere: own === null ? null : own.n,
      total: estimates.n,
      quality: own !== null && own.n >= QUALITY_MIN_RATINGS ? own.auc : null,
    },
    cards,
  };
}
