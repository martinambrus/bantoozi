import { mergeRankerConfig, RankerThresholdsSchema } from '@bantoozi/ranker';
import { CardTextModeSchema, IdSchema, LanguageModesSchema } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';
import { z } from 'zod';

/**
 * `apps/eval/config/g1.json` (spec 10 §1): the gate's decision file. Settings fields are validated
 * with the same schemas as the settings registry (and `ranker_thresholds` must merge into a valid
 * `RankerConfig`); the rest is evidence kept in git and in the report. Bigint ids are decimal
 * strings; participant counts are numbers. `dryRun` marks an artifact of `eval dry-run`, which can
 * never authorize settings outside the dry-run database (spec 10 §1).
 */
const sha = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 hex digest');

export const G1Schema = z
  .object({
    language_modes: LanguageModesSchema,
    card_text_mode: CardTextModeSchema,
    ranker_thresholds: RankerThresholdsSchema.superRefine((value, ctx) => {
      try {
        mergeRankerConfig(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'does not merge into a valid RankerConfig' });
      }
    }),
    recommended_daily_budget_usd: z.number().finite().min(1).max(10_000),
    translate_tier2_daily_cap: z.union([z.literal(300), z.literal(1000)]),
    laya_track_recommended: z.boolean(),
    runs: z.record(z.string().regex(/^[A-Za-z0-9-]{1,16}$/), IdSchema),
    notes: z.string().max(20_000),
    dataset: z.object({ version: z.string().min(1), snapshotSha: sha, splitSha: sha }).strict(),
    selection: z
      .object({
        developmentRunIds: z.array(IdSchema),
        lockedAt: z.iso.datetime({ offset: true }),
        configSha: sha,
      })
      .strict(),
    gate: z
      .object({
        profile: z.enum(['owner_pilot', 'multi_person_beta']),
        participants: z.number().int().min(0),
        status: z.enum(['pass', 'fail', 'needs_more_data']),
        reportSha: sha,
      })
      .strict(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type G1File = z.output<typeof G1Schema>;

/**
 * The fields the selection lock covers: every applied setting plus the evidence they rest on, and
 * the dry-run mark of a synthetic artifact.
 */
export function g1ConfigSha(
  g1: Pick<
    G1File,
    | 'language_modes'
    | 'card_text_mode'
    | 'ranker_thresholds'
    | 'recommended_daily_budget_usd'
    | 'translate_tier2_daily_cap'
    | 'laya_track_recommended'
    | 'runs'
    | 'dataset'
    | 'dryRun'
  > & { profile: G1File['gate']['profile'] },
): string {
  return canonicalSha256({
    language_modes: g1.language_modes,
    card_text_mode: g1.card_text_mode,
    ranker_thresholds: g1.ranker_thresholds,
    recommended_daily_budget_usd: g1.recommended_daily_budget_usd,
    translate_tier2_daily_cap: g1.translate_tier2_daily_cap,
    laya_track_recommended: g1.laya_track_recommended,
    runs: g1.runs,
    dataset: g1.dataset,
    profile: g1.profile,
    // A dry-run artifact hashes the flag, so stripping it breaks the hash. A real artifact
    // omits the key, so its hash is unchanged from before (D-108).
    ...(g1.dryRun === true ? { dryRun: true } : {}),
  });
}

export function parseG1(value: unknown): G1File {
  return G1Schema.parse(value);
}
