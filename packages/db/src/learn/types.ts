/** Training-sample types of the learn loader (spec 06 §8.2). */

export type LearnSignal = 'rating' | 'bookmark' | 'dwell' | 'bounce' | 'read';

/** The raw-v1 event-time snapshot (D-128), structurally equal to what the API stores. */
export interface FeatureSnapshotV1 {
  specSha: string;
  ratingSha: string;
  snapshotAt: string;
  cards: { id: string; strength: string; p: number | null; engine: string | null }[];
  values: {
    facets: Record<string, number> | null;
    facetsEngine: string | null;
    clusterId: string | null;
    [key: string]: unknown;
  };
  sourceManifest?: Record<string, unknown>;
}

/** One effective training sample per (user, article) (spec 06 §8.2). */
export interface LearnSample {
  articleId: string;
  eventId: string;
  signal: LearnSignal;
  y: 0 | 1;
  weight: number;
  explicit: boolean;
  feedbackAt: Date;
  groupId: string;
  features: FeatureSnapshotV1 | null;
}

export interface LearnSamples {
  samples: LearnSample[];
  /** The highest `feedback_events.id` considered (decimal string), null without events. */
  cutoffEventId: string | null;
}

/** A `feedback_events` row of the kinds the reducer reads. */
export interface LearnEvent {
  id: string;
  articleId: string;
  kind: string;
  value: Record<string, unknown>;
  createdAt: Date;
}

/** The reader-state columns the reduction is anchored on. */
export interface LearnReaderState {
  rating: number | null;
  ratedAt: Date | null;
  bookmarkedAt: Date | null;
  readAt: Date | null;
}

/** A completed analysis result as far as the completion of selected snapshots needs it. */
export interface LearnAnalysisResult {
  inputSha: string;
  facets: Record<string, number> | null;
  cardP: Map<string, number>;
  /** The request's valid frozen input, when it could be read. */
  frozen?: LearnFrozenInput;
}

/** The frozen input of a completed request, as far as a derived raw snapshot needs it. */
export interface LearnFrozenInput {
  feedId: string;
  cards: { id: string; strength: string }[];
  article: {
    wordCount: number | null;
    lang: string | null;
    author: string | null;
    firstSeenAt: Date;
    publishedAt: Date | null;
    hasImage: boolean;
    hasVideo: boolean | null;
    bodyImageCount: number | null;
    storyClusterId: string | null;
    clusterSize: number;
  };
}
