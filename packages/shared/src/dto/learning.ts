import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';

/** Personal learning progress and per-feed card agreement (`GET /me/learning`). */

const count = z.number().int().min(0);

/** The word-estimate model's quality on one feed's ratings. */
export const FeedEstimateSchema = z.object({ n: count, auc: z.number().nullable() }).strict();
export type FeedEstimate = z.infer<typeof FeedEstimateSchema>;

export const LearningFeedAgreementSchema = z
  .object({
    feedId: z.string(),
    status: z.enum(['collecting', 'ready', 'not_yet', 'one_sided']),
    likes: count,
    dislikes: count,
    auc: z.number().nullable(),
    aucLow: z.number().nullable(),
    ratedHigh: z.object({ total: count, liked: count }).strict(),
    ratedLow: z.object({ total: count, disliked: count }).strict(),
    /**
     * Liked articles that every card scored below Maybe (D-241): how many, whether that is enough to
     * suggest a new card, and the most recent ones (newest first) to draft it from.
     */
    uncovered: z
      .object({
        count,
        suggest: z.boolean(),
        articles: z.array(z.object({ id: z.string(), title: z.string() }).strict()),
      })
      .strict(),
    /**
     * Topical dislikes no Never card caught: how many, whether that is enough to suggest a Never
     * card, and the most recent ones (newest first) to draft it from.
     */
    unwanted: z
      .object({
        count,
        suggest: z.boolean(),
        articles: z.array(z.object({ id: z.string(), title: z.string() }).strict()),
      })
      .strict(),
    articlesPerWeek: count.nullable(),
    estimate: FeedEstimateSchema.nullable().default(null),
  })
  .strict();
export type LearningFeedAgreement = z.infer<typeof LearningFeedAgreementSchema>;

/** A followed feed outside Training that has word-estimate metrics but no card agreement. */
export const LearningFeedEstimateSchema = z
  .object({ feedId: z.string(), estimate: FeedEstimateSchema })
  .strict();
export type LearningFeedEstimate = z.infer<typeof LearningFeedEstimateSchema>;

export type LearningFeedEntry = LearningFeedAgreement | LearningFeedEstimate;

export function hasAgreement(entry: LearningFeedEntry): entry is LearningFeedAgreement {
  return 'status' in entry;
}

/** Whether analysis of new articles is paused for everyone, and why (global, not per user). */
export const ClassificationStatusSchema = z
  .object({
    state: z.enum(['ok', 'paused']),
    since: IsoTimestampSchema.nullable(),
    reason: z.enum(['engine_unavailable', 'model_upgrade']).nullable(),
  })
  .strict();
export type ClassificationStatus = z.infer<typeof ClassificationStatusSchema>;

/**
 * The reader's word estimates (visible-learning §4.4): the stored model's size and quality and what
 * its latest refresh moved. Independent of `prefs.estimates`; null while no usable model is stored.
 */
export const EstimatesStatusSchema = z
  .object({
    /** Ratings the stored model was trained on. */
    n: count,
    /** Pooled out-of-fold AUC; null when undefined. */
    auc: z.number().nullable(),
    trainedAt: IsoTimestampSchema,
    /** The latest refresh: the unread rows whose tier rose or fell. */
    lastRun: z
      .object({
        at: IsoTimestampSchema,
        movedUp: count,
        movedDown: count,
        /** The refresh followed new ratings (not window ageing or a sweep). */
        fromRatings: z.boolean().default(false),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type EstimatesStatus = z.infer<typeof EstimatesStatusSchema>;

export const LearningStatusSchema = z
  .object({
    model: z
      .object({
        thresholds: z
          .object({ minExplicit: count, minEachClass: count, minCvAuc: z.number() })
          .strict(),
        counts: z.object({ explicit: count, likes: count, dislikes: count }).strict(),
        active: z.object({ version: count, since: IsoTimestampSchema }).strict().nullable(),
        lastAttempt: z
          .object({
            at: IsoTimestampSchema,
            status: z.enum(['activated', 'rejected']),
            reasons: z.array(z.string()),
            cvAuc: z.number().nullable(),
            baselineAuc: z.number().nullable(),
          })
          .strict()
          .nullable(),
        deactivated: z
          .object({ at: IsoTimestampSchema, reason: z.enum(['incompatible', 'lost_evidence']) })
          .strict()
          .nullable(),
      })
      .strict(),
    feeds: z.array(z.union([LearningFeedAgreementSchema, LearningFeedEstimateSchema])),
    classification: ClassificationStatusSchema.default({ state: 'ok', since: null, reason: null }),
    estimates: EstimatesStatusSchema.nullable().default(null),
    /** Ratings still missing to open the word-estimate gate (0 once a model exists or the gate is open). */
    estimateGate: z.object({ needed: count }).strict().default({ needed: 0 }),
  })
  .strict();
export type LearningStatus = z.infer<typeof LearningStatusSchema>;

/** The cheap estimate status (`GET /me/learning/estimates`). */
export const LearningEstimatesSchema = LearningStatusSchema.pick({
  estimates: true,
  estimateGate: true,
});
export type LearningEstimates = z.infer<typeof LearningEstimatesSchema>;

export const LearningHistoryItemSchema = z
  .object({
    at: IsoTimestampSchema,
    kind: z.enum(['model', 'estimate']),
    n: count,
    auc: z.number().nullable(),
    baselineAuc: z.number().nullable(),
    activated: z.boolean().nullable(),
    turnedOn: z.boolean().nullable(),
    engineModel: z.string().nullable(),
  })
  .strict();
export type LearningHistoryItem = z.infer<typeof LearningHistoryItemSchema>;

/** Learning milestones, oldest first (`GET /me/learning/history`). */
export const LearningHistorySchema = z
  .object({
    items: z.array(LearningHistoryItemSchema),
    truncated: z.object({ model: z.boolean(), estimate: z.boolean() }).strict(),
  })
  .strict();
export type LearningHistory = z.infer<typeof LearningHistorySchema>;
