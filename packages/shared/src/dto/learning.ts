import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';

/** Personal learning progress and per-feed card agreement (`GET /me/learning`). */

const count = z.number().int().min(0);

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
  })
  .strict();
export type LearningFeedAgreement = z.infer<typeof LearningFeedAgreementSchema>;

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
    feeds: z.array(LearningFeedAgreementSchema),
  })
  .strict();
export type LearningStatus = z.infer<typeof LearningStatusSchema>;
