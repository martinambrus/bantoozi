import { z } from 'zod';

import { IdSchema, UuidSchema } from './ids.js';
import { HOUSE_PROGRESS_JOBS, isQueueName } from './jobs.js';
import { JsonObjectSchema, JsonValueSchema } from './json.js';
import { RankerThresholdsSchema } from './ranker-config.js';

/**
 * Settings key registry (spec 02 §2). Every key has a zod schema; readers fall back to the listed
 * default when the row is missing. Only keys marked admin-writable may be written through
 * `PATCH /admin/settings`. Values are validated strictly on write (finite numbers, size limits,
 * unknown keys rejected).
 */

const iso = z.iso.datetime({ offset: true });
const LANG = /^[a-z]{2}$/;

export const LanguageModeSchema = z.enum(['native', 'translate']);
export type LanguageMode = z.infer<typeof LanguageModeSchema>;

/** `{[lang]: 'native'|'translate'}` keyed by ISO 639-1 codes. */
export const LanguageModesSchema = z
  .record(z.string().regex(LANG, 'ISO 639-1 code'), LanguageModeSchema)
  .refine((m) => Object.keys(m).length <= 50, 'too many languages');
export type LanguageModes = z.infer<typeof LanguageModesSchema>;

export const SignupModeSchema = z.enum(['invite', 'open', 'closed']);
export type SignupMode = z.infer<typeof SignupModeSchema>;

export const CardTextModeSchema = z.enum(['as_written', 'english']);
export type CardTextMode = z.infer<typeof CardTextModeSchema>;

/** Circuit breaker state (spec 02 §2 `engine.circuit`, spec 04 §5). */
export const BreakerStateSchema = z
  .object({
    state: z.enum(['closed', 'open', 'half_open', 'auth']),
    openedAt: iso.optional(),
    openUntil: iso.optional(),
    reopenCount: z.number().int().min(0),
    probeToken: UuidSchema.optional(),
    probeUntil: iso.optional(),
  })
  .strict();
export type BreakerState = z.infer<typeof BreakerStateSchema>;

export const EngineCircuitSchema = z
  .object({
    typesafe: BreakerStateSchema,
    llm: BreakerStateSchema,
    resetRequested: z.object({ typesafe: iso.optional(), llm: iso.optional() }).strict(),
  })
  .strict();
export type EngineCircuit = z.infer<typeof EngineCircuitSchema>;

export const EngineModelPinSchema = z
  .object({
    model: z.string().min(1).max(200),
    llm: z
      .object({ fast: z.string().min(1).max(200), strong: z.string().min(1).max(200) })
      .strict()
      .optional(),
    laya: z
      .object({
        checkpointSha: z.string().regex(/^[0-9a-f]{64}$/),
        calibrationVersion: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
    since: iso,
  })
  .strict();
export type EngineModelPin = z.infer<typeof EngineModelPinSchema>;

const houseProgressEntry = z
  .object({
    cursor: JsonValueSchema.optional(),
    updatedAt: iso,
    version: z.number().int().min(0),
    completedAt: iso.optional(),
  })
  .strict();

export const HouseProgressSchema = z
  .record(z.string(), houseProgressEntry)
  .superRefine((value, ctx) => {
    for (const job of Object.keys(value)) {
      if (!(HOUSE_PROGRESS_JOBS as readonly string[]).includes(job)) {
        ctx.addIssue({ code: 'custom', path: [job], message: 'unknown housekeeping job' });
      }
    }
  });

export const WorkerHeartbeatSchema = z.record(
  z.string().min(1).max(200),
  z
    .object({
      at: iso,
      /** When this worker process started: the grace anchor of the overdue-housekeeping alert (R5). */
      startedAt: iso.optional(),
      queues: z
        .array(z.string())
        .max(100)
        .refine((qs) => qs.every(isQueueName), 'unknown queue'),
      evalIngestOnly: z.boolean(),
      envCredentials: z.array(z.enum(['typesafe', 'ollama'])).max(2),
      /** The worker's database pool at the beat: clients in total, idle and waiting for a connection (S17). */
      pool: z
        .object({
          total: z.number().int().min(0).max(100_000),
          idle: z.number().int().min(0).max(100_000),
          waiting: z.number().int().min(0).max(1_000_000),
        })
        .strict()
        .optional(),
    })
    .strict(),
);

export const QuestionSetsActiveSchema = z
  .object({
    enrich: IdSchema.optional(),
    match: IdSchema.optional(),
    cluster: IdSchema.optional(),
    suggest: IdSchema.optional(),
  })
  .strict();
export type QuestionSetsActive = z.infer<typeof QuestionSetsActiveSchema>;

export const OPS_EVENTS_MAX = 50;

/** Everything a default may depend on (env fallbacks, spec 02 §2). */
export interface SettingEnvDefaults {
  dailyBudgetUsd: number;
  languageModes: LanguageModes;
  signupMode: SignupMode;
}

/** Who may write a key. `admin` keys are writable through `PATCH /admin/settings`. */
export type SettingWriter =
  'admin' | 'admin-reset-request' | 'apply-g1' | 'seed' | 'api' | 'worker' | 'house' | 'ops-event';

interface SettingDefinition<S extends z.ZodType> {
  schema: S;
  /** `undefined` means "no default: a missing row is absent". */
  defaultValue: (env: SettingEnvDefaults) => z.output<S> | undefined;
  writers: readonly SettingWriter[];
}

const def = <S extends z.ZodType>(d: SettingDefinition<S>): SettingDefinition<S> => d;

const closedBreaker: BreakerState = { state: 'closed', reopenCount: 0 };

export const SETTINGS = {
  'engine.daily_budget_usd': def({
    schema: z.number().finite().min(0).max(10_000),
    defaultValue: (env) => env.dailyBudgetUsd,
    writers: ['admin', 'apply-g1'],
  }),
  'engine.llm_daily_cap': def({
    schema: z.number().int().min(0).max(1_000_000),
    defaultValue: () => 200,
    writers: ['admin'],
  }),
  'engine.prefilter_enabled': def({
    schema: z.boolean(),
    defaultValue: () => false,
    writers: ['admin'],
  }),
  'engine.circuit': def({
    schema: EngineCircuitSchema,
    defaultValue: () => ({
      typesafe: { ...closedBreaker },
      llm: { ...closedBreaker },
      resetRequested: {},
    }),
    writers: ['worker', 'admin-reset-request'],
  }),
  'engine.budget_alerts': def({
    schema: z
      .object({
        day: z.iso.date(),
        p80At: iso.optional(),
        p100At: iso.optional(),
      })
      .strict(),
    defaultValue: () => undefined,
    writers: ['worker'],
  }),
  'engine.laya': def({
    schema: z.object({ enrich: z.array(z.string().regex(LANG)).max(50).optional() }).strict(),
    defaultValue: () => ({}),
    writers: ['admin'],
  }),
  'engine.model_pin': def({
    schema: EngineModelPinSchema,
    defaultValue: () => undefined,
    writers: ['seed', 'worker'],
  }),
  language_modes: def({
    schema: LanguageModesSchema,
    defaultValue: (env) => ({ ...env.languageModes }),
    writers: ['seed', 'admin', 'apply-g1'],
  }),
  card_text_mode: def({
    schema: CardTextModeSchema,
    defaultValue: () => 'as_written' as const,
    writers: ['admin', 'apply-g1'],
  }),
  'translate.tier2_daily_cap': def({
    schema: z.number().int().min(0).max(1_000_000),
    defaultValue: () => 300,
    writers: ['admin', 'apply-g1'],
  }),
  'ranker.thresholds': def({
    schema: RankerThresholdsSchema,
    defaultValue: () => ({}),
    writers: ['admin', 'apply-g1'],
  }),
  'ranker.settings_version': def({
    schema: z.number().int().min(0),
    defaultValue: () => 0,
    writers: ['api', 'apply-g1'],
  }),
  'question_sets.active': def({
    schema: QuestionSetsActiveSchema,
    defaultValue: () => ({}),
    writers: ['seed', 'admin'],
  }),
  signup_mode: def({
    schema: SignupModeSchema,
    defaultValue: (env) => env.signupMode,
    writers: ['admin'],
  }),
  'ops.events': def({
    schema: z
      .array(
        z
          .object({
            kind: z.string().min(1).max(64),
            detail: z.string().max(2000),
            at: iso,
          })
          .strict(),
      )
      .max(OPS_EVENTS_MAX),
    defaultValue: () => [],
    writers: ['ops-event'],
  }),
  'house.progress': def({
    schema: HouseProgressSchema,
    defaultValue: () => ({}),
    writers: ['house'],
  }),
  'alerts.state': def({
    schema: z.record(
      z.string().min(1).max(200),
      z
        .object({
          firstAt: iso,
          lastSentAt: iso.nullable(),
          active: z.boolean(),
          failures: z.number().int().min(0).max(1_000_000).optional(),
          /** Consecutive samples a streak rule has counted (a `memo.*` entry, never an incident). */
          streak: z.number().int().min(0).max(1_000_000).optional(),
        })
        .strict(),
    ),
    defaultValue: () => ({}),
    writers: ['house'],
  }),
  'worker.heartbeat': def({
    schema: WorkerHeartbeatSchema,
    defaultValue: () => ({}),
    writers: ['worker'],
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;

/** `metrics.daily.<YYYY-MM-DD>`: bounded aggregate metrics JSON (spec 10 §7), written by `house.metrics`. */
export const METRICS_DAILY_PREFIX = 'metrics.daily.';
const METRICS_DAILY_KEY = /^metrics\.daily\.\d{4}-\d{2}-\d{2}$/;
export const MetricsDailySchema = JsonObjectSchema.refine(
  (v) => JSON.stringify(v).length <= 64 * 1024,
  'metrics snapshot too large',
);

const MetricsLaneSchema = z
  .object({ likeRate: z.number().min(0).max(1).nullable(), rated: z.number().int().min(0) })
  .strict();
const MetricsRegretSchema = z
  .object({ numerator: z.number().int().min(0), denominator: z.number().int().min(0) })
  .strict();
const MetricsLanesSchema = z.record(z.string(), MetricsLaneSchema);
/** `{<bucket>: {<lane>: {likeRate, rated}}}`: a like-rate split (source, language, origin). */
const MetricsSplitSchema = z.record(z.string(), MetricsLanesSchema);
const Count = z.number().int().min(0);
const Rate = z.number().min(0).max(1).nullable();
const MetricsModelsSchema = z
  .object({
    activation: z.object({ attempts: Count, activated: Count, rate: Rate }).strict(),
    samples: z.object({ explicit: Count }).strict(),
    skipped: z.record(z.string(), Count),
    paired: Count,
    pairedLogloss: Count,
    medianDeltaAuc: z.number().nullable(),
    medianDeltaLogloss: z.number().nullable(),
    invalidation: z.object({ invalidated: Count, rate: Rate }).strict(),
    cardsOnly: z.object({ hours: z.number().min(0), users: Count }).strict(),
  })
  .strict();
const MetricsEngineSchema = z
  .object({
    calls: Count,
    errors: Count,
    coverage: Rate,
    latencyMs: z
      .object({ p50: z.number().min(0).nullable(), p95: z.number().min(0).nullable() })
      .strict(),
    articles: z.object({ firstSeen: Count, degraded: Count }).strict(),
    degradedShare: Rate,
    billedUsdPerDay: z.number().min(0),
    usd: z
      .object({ active: z.number().min(0), training: z.number().min(0), other: z.number().min(0) })
      .strict(),
    offFeedCalls: Count,
    cache: z.object({ requests: Count, hits: Count, savedUsd: z.number().min(0) }).strict(),
  })
  .strict();
const MetricsWindowSchema = z
  .object({
    lanes: MetricsLanesSchema,
    regret: MetricsRegretSchema,
    bySource: MetricsSplitSchema.optional(),
    byLanguage: MetricsSplitSchema.optional(),
    byOrigin: MetricsSplitSchema.optional(),
    hides: z
      .object({ byReason: z.record(z.string(), Count), unhides: Count })
      .strict()
      .optional(),
    models: MetricsModelsSchema.optional(),
    engine: MetricsEngineSchema.optional(),
  })
  .strict();
/** State as of the run (not a window): reader-policy Maybe share, source mix and the queues. */
const MetricsCurrentSchema = z
  .object({
    maybeShare: z.object({ maybe: Count, scored: Count, share: Rate }).strict(),
    sourceMix: z.object({ cards: Count, model: Count, degraded: Count }).strict(),
    classifyingBacklog: Count,
    trainingQueue: z.object({ pending: Count, oldestAgeSeconds: Count.nullable() }).strict(),
  })
  .strict();

/**
 * The shape `house.metrics` writes to `metrics.daily.<date>`: per-lane like-rate and regret for the
 * day; for the trailing 7 and 30 days also the source/language/origin splits, hide reasons, personal
 * model, engine aggregates; and the state `current` as of the run (spec 10 §7).
 */
export const MetricsSnapshotSchema = MetricsWindowSchema.extend({
  windows: z.object({ d7: MetricsWindowSchema, d30: MetricsWindowSchema }).strict(),
  current: MetricsCurrentSchema.optional(),
}).strict();
export type MetricsSnapshot = z.infer<typeof MetricsSnapshotSchema>;

export function metricsDailyKey(day: string): string {
  const key = `${METRICS_DAILY_PREFIX}${day}`;
  if (!METRICS_DAILY_KEY.test(key)) throw new RangeError('day must be YYYY-MM-DD');
  return key;
}

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export function isKnownSettingKey(key: string): boolean {
  return isSettingKey(key) || METRICS_DAILY_KEY.test(key);
}

/** The zod schema of any registered key (including the dynamic `metrics.daily.<date>` keys). */
export function settingSchema(key: string): z.ZodType {
  if (isSettingKey(key)) return SETTINGS[key].schema;
  if (METRICS_DAILY_KEY.test(key)) return MetricsDailySchema;
  throw new RangeError(`unknown setting key: ${key}`);
}

/** Validate a value for a key (strict on write). Throws a ZodError. */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return SETTINGS[key].schema.parse(value) as SettingValue<K>;
}

/** The default used when the row is missing; `undefined` means the key has no default. */
export function settingDefault<K extends SettingKey>(
  key: K,
  env: SettingEnvDefaults,
): SettingValue<K> | undefined {
  return SETTINGS[key].defaultValue(env) as SettingValue<K> | undefined;
}

/**
 * Effective value: the stored row wins over the env default. A stored value that no longer parses
 * is reported (never silently replaced) so an operator can fix it.
 */
export function readSetting<K extends SettingKey>(
  key: K,
  stored: unknown,
  env: SettingEnvDefaults,
): SettingValue<K> | undefined {
  if (stored === undefined) return settingDefault(key, env);
  return parseSetting(key, stored);
}

/** Keys that `PATCH /admin/settings` may write (spec 02 §2 "admin"). */
export const ADMIN_SETTING_KEYS = (Object.keys(SETTINGS) as SettingKey[]).filter((k) =>
  SETTINGS[k].writers.some((w) => w === 'admin' || w === 'admin-reset-request'),
);

/** Keys the seed inserts when missing (spec 02 §2). */
export const SEEDED_SETTING_KEYS = [
  'card_text_mode',
  'question_sets.active',
  'language_modes',
] as const;
