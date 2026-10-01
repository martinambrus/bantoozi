import { z } from 'zod';

import { IdSchema } from '../ids.js';
import { IsoTimestampSchema } from './common.js';

/** Rule DTOs (spec 08 §8; semantics in spec 06 §3). */

export const RULE_KINDS = [
  'mute_keyword',
  'mute_story',
  'block_feed',
  'block_domain',
  'block_author',
  'boost_feed',
  'boost_domain',
] as const;
export const RuleKindSchema = z.enum(RULE_KINDS);
export type RuleKind = z.infer<typeof RuleKindSchema>;

/** "Mute this story for N days" (spec 06 §3.1): the only allowed expiries. */
export const RULE_EXPIRY_DAYS = [1, 3, 7, 30] as const;
export const RuleExpiryDaysSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(7),
  z.literal(30),
]);
export type RuleExpiryDays = z.infer<typeof RuleExpiryDaysSchema>;

/** Keyword rules hold 2–100 characters (spec 08 §8). */
export const RULE_KEYWORD_MIN = 2;
export const RULE_KEYWORD_MAX = 100;
/** Bound of every other rule value (author names, domains, ids). */
export const RULE_VALUE_MAX = 200;

/**
 * `POST /rules`. `value` is validated per kind by the API (the feed id of a subscription, the cluster
 * id of a story the user can see, domain syntax, keyword length). `mute_story` requires
 * `expiresInDays`; other kinds may omit it. A `null` expiry is rejected by this schema.
 */
export const CreateRuleBodySchema = z
  .object({
    kind: RuleKindSchema,
    value: z.string().min(1).max(RULE_VALUE_MAX),
    expiresInDays: RuleExpiryDaysSchema.optional(),
  })
  .strict();
export type CreateRuleBody = z.infer<typeof CreateRuleBodySchema>;

/** One rule (`GET /rules`, `POST /rules`); `displayValue` names a feed or story instead of its id. */
export const RuleSchema = z
  .object({
    id: IdSchema,
    kind: RuleKindSchema,
    value: z.string(),
    displayValue: z.string(),
    createdAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type RuleDto = z.infer<typeof RuleSchema>;
export const RuleListSchema = z.array(RuleSchema);

/** `POST /rules` → `201 {rule}` (spec 08 §8), the shape `/articles/:id/mute-story` also returns. */
export const CreateRuleResponseSchema = z.object({ rule: RuleSchema }).strict();

export const RuleIdParamsSchema = z.object({ id: IdSchema }).strict();
