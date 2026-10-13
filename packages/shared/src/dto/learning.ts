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
