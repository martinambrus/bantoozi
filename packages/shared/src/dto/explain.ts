import { z } from 'zod';

import { BigIntStringSchema } from '../ids.js';

/** Ranking lanes (spec 06 §6.1). */
export const LaneSchema = z.enum(['new', 'for_you', 'maybe', 'everything', 'hidden']);
export type Lane = z.infer<typeof LaneSchema>;

/** Card strengths (spec 02 `user_cards.strength`). */
export const StrengthSchema = z.enum(['must', 'love', 'like', 'never']);
export type Strength = z.infer<typeof StrengthSchema>;

export const ScoreSourceSchema = z.enum(['cards', 'model', 'degraded', 'none']);
export type ScoreSource = z.infer<typeof ScoreSourceSchema>;

const probability = z.number().finite().min(0).max(1);

/**
 * `user_article.explain`, version 1 (spec 06 §6.2). Labels use English names; the web client
 * localizes topic ids.
 */
export const ExplainSchema = z
  .object({
    v: z.literal(1),
    inputs: z
      .object({
        contentRevision: BigIntStringSchema,
        rankRevision: BigIntStringSchema,
        contextSha: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    source: ScoreSourceSchema,
    p: probability.nullable(),
    lane: LaneSchema,
    tier: z.number().int().min(1).max(5).nullable(),
    /** Source `cards`: the card achieving the card score (spec 08 §5.1 topReason). */
    decidingCardId: BigIntStringSchema.optional(),
    /** The user's cards with answers, by p descending, at most 10. */
    cards: z
      .array(
        z
          .object({
            id: BigIntStringSchema,
            title: z.string().max(200),
            strength: StrengthSchema,
            p: probability,
            engine: z.string().max(40),
          })
          .strict(),
      )
      .max(10),
    facets: z
      .object({
        contentType: z.object({ choice: z.string().max(64), p: probability }).strict(),
        topic: z
          .object({ l1: z.string().max(64), p: probability, l2: z.string().max(64).optional() })
          .strict(),
        depth: probability,
        clickbait: probability,
        promotional: probability,
        timeSensitive: probability,
        evergreen: probability,
      })
      .strict()
      .optional(),
    /** Ids let the UI offer "undo". */
    rules: z
      .array(
        z
          .object({
            code: z.string().min(1).max(64),
            ruleId: BigIntStringSchema.optional(),
            cardId: BigIntStringSchema.optional(),
            detail: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(50),
    /** Top 3 features by |contribution|. */
    model: z
      .object({
        version: z.number().int().min(1),
        top: z
          .array(
            z
              .object({
                feature: z.string().max(200),
                label: z.string().max(200),
                contribution: z.number().finite(),
              })
              .strict(),
          )
          .max(3),
      })
      .strict()
      .optional(),
    translation: z
      .object({ engine: z.string().max(40), quality: z.string().max(40) })
      .strict()
      .optional(),
    cluster: z
      .object({ id: BigIntStringSchema, size: z.number().int().min(0) })
      .strict()
      .optional(),
  })
  .strict();

export type Explain = z.infer<typeof ExplainSchema>;
