import { z } from 'zod';

/**
 * `RankerConfig` defaults (spec 06 §11). `settings['ranker.thresholds']` holds a deep partial that
 * overrides them; gate G1 writes it. The ranker imports/re-exports these (no shared→ranker cycle).
 */
export const DEFAULT_RANKER_CONFIG = {
  lanes: { forYou: 0.65, maybe: 0.35 },
  tiers: [0.25, 0.45, 0.65, 0.85],
  strengthWeights: { must: 1.0, love: 1.0, like: 0.8 },
  never: { hide: 0.7, soft: 0.5 },
  mustFloor: 0.5,
  llmForYouMin: 0.85,
  demotion: {
    factor: 0.6,
    clickbait: 0.8,
    promotional: 0.8,
    shallowDepth: 0.25,
    staleTimeSensitive: 0.7,
    staleAgeHours: 72,
    autoMinDislikes: 3,
    autoWindowDays: 90,
  },
  labelSuggest: 0.8,
  model: {
    lambda: 1.0,
    minExplicit: 30,
    minEachClass: 5,
    minCvAuc: 0.6,
    maxBaselineDrop: 0.02,
    retrainEvery: 10,
    historyDays: 180,
    keepVersions: 3,
  },
  bm25: { k1: 1.2, b: 0.75, scale: 3 },
} as const;

/**
 * Not a setting: the API list window (spec 08 §5.1), the rank dirty set, the BM25 corpus and
 * degraded recovery must share it, so only a release changes it.
 */
export const RANK_WINDOW_DAYS = 14;

const unit = z.number().finite().min(0).max(1);
const positiveInt = (max: number) => z.number().int().min(1).max(max);
const positive = z.number().finite().positive();

const tiersSchema = z
  .tuple([unit, unit, unit, unit])
  .refine(
    ([a, b, c, d]) => a > 0 && a < b && b < c && c < d && d < 1,
    'tiers must be four strictly increasing values in (0,1)',
  );

const shape = {
  lanes: z.object({ forYou: unit, maybe: unit }).strict(),
  tiers: tiersSchema,
  strengthWeights: z.object({ must: unit, love: unit, like: unit }).strict(),
  never: z.object({ hide: unit, soft: unit }).strict(),
  mustFloor: unit,
  llmForYouMin: unit,
  demotion: z
    .object({
      factor: unit,
      clickbait: unit,
      promotional: unit,
      shallowDepth: unit,
      staleTimeSensitive: unit,
      staleAgeHours: positiveInt(24 * 365),
      autoMinDislikes: positiveInt(1000),
      autoWindowDays: positiveInt(3650),
    })
    .strict(),
  labelSuggest: unit,
  model: z
    .object({
      lambda: positive,
      minExplicit: positiveInt(1_000_000),
      minEachClass: positiveInt(1_000_000),
      minCvAuc: unit,
      maxBaselineDrop: unit,
      retrainEvery: positiveInt(1_000_000),
      historyDays: positiveInt(3650),
      keepVersions: positiveInt(100),
    })
    .strict(),
  bm25: z.object({ k1: positive, b: unit, scale: positive }).strict(),
};

/** The fully merged config, validated (spec 06 §11). Unknown keys (e.g. `windowDays`) fail. */
export const RankerConfigSchema = z
  .object(shape)
  .strict()
  .superRefine((c, ctx) => {
    if (!(c.lanes.maybe < c.lanes.forYou)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lanes'],
        message: 'require 0 <= maybe < forYou <= 1',
      });
    }
    if (!(c.never.soft < c.never.hide)) {
      ctx.addIssue({ code: 'custom', path: ['never'], message: 'require 0 <= soft < hide <= 1' });
    }
  });

export type RankerConfig = z.infer<typeof RankerConfigSchema>;

/** `settings['ranker.thresholds']`: a strict deep partial; arrays (tiers) are replaced whole. */
export const RankerThresholdsSchema = z
  .object({
    lanes: shape.lanes.partial(),
    tiers: tiersSchema,
    strengthWeights: shape.strengthWeights.partial(),
    never: shape.never.partial(),
    mustFloor: unit,
    llmForYouMin: unit,
    demotion: shape.demotion.partial(),
    labelSuggest: unit,
    model: shape.model.partial(),
    bm25: shape.bm25.partial(),
  })
  .partial()
  .strict();
export type RankerThresholds = z.infer<typeof RankerThresholdsSchema>;

/**
 * Merge a thresholds override onto the defaults and validate the result. Throws a ZodError for an
 * invalid override, so admin updates can be rejected atomically.
 */
export function mergeRankerConfig(
  overrides: unknown,
  base: RankerConfig = DEFAULT_RANKER_CONFIG as unknown as RankerConfig,
): RankerConfig {
  const partial = RankerThresholdsSchema.parse(overrides ?? {});
  const merged: Record<string, unknown> = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof current === 'object'
        ? { ...(current as object), ...stripUndefined(value as Record<string, unknown>) }
        : value;
  }
  return RankerConfigSchema.parse(merged);
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
