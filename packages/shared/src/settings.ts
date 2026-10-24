import { z } from 'zod';

import { readerSchema } from './setting-readers.js';

import { IdSchema, UuidSchema } from './ids.js';
import { HOUSE_PROGRESS_JOBS, isQueueName } from './jobs.js';
import { JsonObjectSchema, JsonValueSchema } from './json.js';
import { JEV_LATEST_ALIAS, MODEL_ID_PATTERN, isConcreteJevModel } from './model-id.js';
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
    /** Start of the current failing streak: the first trip since the breaker was last closed or reset. */
    failingSince: iso.optional(),
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
    alias: z.literal(JEV_LATEST_ALIAS).optional(),
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

const modelId = z.string().regex(MODEL_ID_PATTERN, 'invalid model id');
const concreteJevModel = z.string().refine(isConcreteJevModel, 'not a concrete Jev release');

/**
 * Where the alias `jev-latest` currently points (visible-learning §4.1): the concrete release, when
 * it changed and when it was last confirmed, and the release it replaced.
 */
export const EngineModelResolutionSchema = z
  .object({
    alias: z.literal(JEV_LATEST_ALIAS),
    model: concreteJevModel,
    resolvedAt: iso,
    checkedAt: iso,
    previous: z.object({ model: concreteJevModel, until: iso }).strict().optional(),
  })
  .strict();
export type EngineModelResolution = z.infer<typeof EngineModelResolutionSchema>;

/**
 * What a model probe learned about one requested id (visible-learning §4.1): `ok` when an alias
 * resolved to a concrete id, or a concrete id was answered as itself. `answered` is the id the
 * provider named, when it named one; `error` is a short code, set whenever `ok` is false.
 */
export const EngineModelProbeSchema = z
  .object({
    requested: modelId,
    answered: modelId.optional(),
    ok: z.boolean(),
    at: iso,
    error: z.string().min(1).max(200).optional(),
  })
  .strict();
export type EngineModelProbe = z.infer<typeof EngineModelProbeSchema>;

/** `settings['engine.model_probe']` keeps the newest results, one per requested id. */
export const ENGINE_MODEL_PROBES_MAX = 10;
export const EngineModelProbesSchema = z
  .record(modelId, EngineModelProbeSchema)
  .refine((probes) => Object.keys(probes).length <= ENGINE_MODEL_PROBES_MAX, 'too many probes');
export type EngineModelProbes = z.infer<typeof EngineModelProbesSchema>;

/** Undelivered upgrade mails are given up after this many delivery attempts. */
export const MODEL_NOTICE_MAX_ATTEMPTS = 8;

/**
 * `settings['engine.model_watch']`, written by the worker's `house.model-watch`,
 * `observeModelCandidate`, `requestModelWatch` and `writePendingNotice` (visible-learning §4.1):
 * when the retired-model trigger last queued a check (its 10-minute rate limit), how the newest
 * check ended, and the adoption whose mail is still to be delivered (`major`: the new release is
 * of another major, so personal models restart). Readers tolerate future fields; writers validate
 * their known state strictly and preserve stored extensions.
 */
export const EngineModelWatchSchema = z
  .object({
    triggeredAt: iso.optional(),
    lastCheck: z
      .object({ at: iso, ok: z.boolean(), error: z.string().min(1).max(200).optional() })
      .strict()
      .optional(),
    notice: z
      .object({
        from: concreteJevModel,
        to: concreteJevModel,
        at: iso,
        major: z.boolean(),
        attempts: z.number().int().min(0).max(MODEL_NOTICE_MAX_ATTEMPTS),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EngineModelWatch = z.infer<typeof EngineModelWatchSchema>;

/**
 * `settings['engine.model_candidate']`, written by the worker's `observeModelCandidate` and
 * `retryModelCandidate`, and cleared by `house.model-watch`: the release awaiting confirmation,
 * its first sighting and attempt count. Null means no candidate. A separate key preserves the
 * strict watch row for older workers, which ignore this key.
 */
export const EngineModelCandidateSchema = z
  .object({ model: concreteJevModel, firstSeenAt: iso, count: z.number().int().min(1) })
  .strict();
export type EngineModelCandidate = z.infer<typeof EngineModelCandidateSchema>;

/**
 * `settings['engine.model_impact']`, written only by the worker together with every model probe
 * (visible-learning §4.1, JEV-5): how many users hold an active personal model when the probe was
 * recorded, always refreshed by the committing recorder. `at` keeps the newer stored or probe
 * timestamp, ignoring a stored timestamp more than 60 seconds ahead of the writer's clock.
 * The API cannot count other tenants' `user_models` under row-level security, and the
 * Admin → Settings confirmation of a model change in another family says how many of them restart.
 */
export const EngineModelImpactSchema = z
  .object({ at: iso, activeModels: z.number().int().min(0) })
  .strict();
export type EngineModelImpact = z.infer<typeof EngineModelImpactSchema>;

/** Key of the worker-written registry of rating fingerprints (JEV-4). */
export const RATING_FINGERPRINTS_KEY = 'engine.rating_fingerprints';
/** The registry keeps at most this many fingerprints. */
export const RATING_FINGERPRINTS_MAX = 64;
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** One registered exact rating fingerprint: its family sha, effective settings and first sighting. */
export const RatingFingerprintEntrySchema = z
  .object({ family: sha256Hex, settings: JsonObjectSchema, firstSeenAt: iso })
  .strict();
export type RatingFingerprintEntry = z.infer<typeof RatingFingerprintEntrySchema>;
/** `settings['engine.rating_fingerprints']`: exact rating sha to its entry. */
export const RatingFingerprintsSchema = z.record(sha256Hex, RatingFingerprintEntrySchema);
export type RatingFingerprints = z.infer<typeof RatingFingerprintsSchema>;

const houseProgressEntry = z
  .object({
    cursor: JsonValueSchema.optional(),
    updatedAt: iso,
    version: z.number().int().min(0),
    completedAt: iso.optional(),
  })
  .strict();

// Express the job whitelist structurally so the common reader can strip future job keys.
// Reject explicitly undefined entries to keep the original record writer's contract.
export const HouseProgressSchema = z
  .object(
    Object.fromEntries(HOUSE_PROGRESS_JOBS.map((job) => [job, houseProgressEntry.optional()])),
  )
  .strict()
  .superRefine((value, ctx) => {
    for (const [job, entry] of Object.entries(value)) {
      if (entry === undefined) {
        ctx.addIssue({ code: 'custom', path: [job], message: 'a housekeeping entry is required' });
      }
    }
  }) as z.ZodType<Record<string, z.output<typeof houseProgressEntry>>>;

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
      /**
       * The effective runtime values and problems of the process (M8b-T5 fills it): unknown-shaped
       * until M8b-T1/T5 define it. Never carries secrets.
       */
      runtime: z.record(z.string(), JsonValueSchema).optional(),
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

/** Live runtime settings (M8b-T1): null or no row = the env default. */
const runtimeModelName = z.string().min(1).max(200);
const runtimeModel = runtimeModelName.nullable();
const runtimeInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable();
const runtimeUrl = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'must be an http(s) URL without credentials')
  .nullable();
const noDefault = () => undefined;
/** The live runtime keys are admin-writable (M8b-T2); `null` resets one to its environment value. */
const runtimeWriters = ['admin'] as const;

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
  'engine.model_resolution': def({
    schema: EngineModelResolutionSchema,
    defaultValue: () => undefined,
    writers: ['worker'],
  }),
  'engine.model_probe': def({
    schema: EngineModelProbesSchema,
    defaultValue: () => undefined,
    writers: ['worker'],
  }),
  'engine.model_watch': def({
    schema: EngineModelWatchSchema,
    defaultValue: () => undefined,
    writers: ['worker'],
  }),
  'engine.model_candidate': def({
    schema: EngineModelCandidateSchema.nullable(),
    defaultValue: () => undefined,
    writers: ['worker'],
  }),
  'engine.model_impact': def({
    schema: EngineModelImpactSchema,
    defaultValue: () => undefined,
    writers: ['worker'],
  }),
  [RATING_FINGERPRINTS_KEY]: def({
    schema: RatingFingerprintsSchema,
    defaultValue: () => ({}),
    writers: ['worker'],
  }),
  'engine.typesafe_model': def({
    schema: runtimeModel,
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.typesafe_base_url': def({
    schema: runtimeUrl,
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.typesafe_price_per_mtok_usd': def({
    schema: z.number().finite().min(0).max(10).nullable(),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.concurrency': def({
    schema: runtimeInt(1, 64),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.llm_fallback_enabled': def({
    schema: z.boolean().nullable(),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.ollama_models': def({
    schema: z.object({ fast: runtimeModelName, strong: runtimeModelName }).strict().nullable(),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.ollama_base_url': def({
    schema: runtimeUrl,
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.ollama_max_concurrency': def({
    schema: runtimeInt(1, 64),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.prefilter_min_cards': def({
    schema: runtimeInt(1, 10_000),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'engine.auto_analysis_daily_cap': def({
    schema: runtimeInt(0, 1_000_000),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'ingest.max_age_days': def({
    schema: runtimeInt(1, 365),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'fetch.limits': def({
    schema: z
      .object({
        timeoutMs: z.number().int().min(1_000).max(120_000),
        maxBytes: z
          .number()
          .int()
          .min(65_536)
          .max(50 * 1024 * 1024),
      })
      .strict()
      .nullable(),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'api.rate_limits_enabled': def({
    schema: z.boolean().nullable(),
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  'translate.libretranslate_url': def({
    schema: runtimeUrl,
    defaultValue: noDefault,
    writers: runtimeWriters,
  }),
  /**
   * First-run setup state (M8b-T6): only the keyed digest of the token, never the token. Never
   * admin-patchable and never listed by `GET /admin/settings`.
   */
  'auth.setup': def({
    schema: z
      .object({
        /** `HMAC-SHA256(SESSION_PEPPER, token)` as 64 hex characters; absent once consumed. */
        digest: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        createdAt: iso,
        consumedAt: iso.optional(),
        userId: UuidSchema.optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.consumedAt === undefined
            ? v.digest !== undefined && v.userId === undefined
            : v.digest === undefined && v.userId !== undefined,
        'an open setup has a digest only; a consumed one has consumedAt and userId only',
      ),
    defaultValue: noDefault,
    writers: ['api', 'worker'],
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
          /** The alert title the incident was mailed under (absent on entries stored before M8-F1). */
          title: z.string().max(200).optional(),
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

/** Parse a stored row, stripping unknown object fields while validating known values. */
export function parseStoredSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return readerSchema(SETTINGS[key].schema).parse(value) as SettingValue<K>;
}

/** Reader schema for registered and dynamic settings. */
export function settingReaderSchema(key: string): z.ZodType {
  return readerSchema(settingSchema(key));
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
  return parseStoredSetting(key, stored);
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
