import { homedir } from 'node:os';
import { inspect } from 'node:util';

import { z } from 'zod';

import { resolveWorkerQueues, type QueueName } from '../jobs.js';
import {
  LanguageModesSchema,
  SignupModeSchema,
  type LanguageModes,
  type SignupMode,
} from '../settings.js';

/**
 * Per-process configuration (spec 01 §3). Bootstrap and host-secret configuration comes from
 * environment variables, parsed once at startup with zod. "Required" means required for the
 * processes listed under "Used by". Validation errors name variables, never their values.
 */
export const PROCESS_KINDS = ['api', 'worker', 'eval', 'migrate', 'test'] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

type Consumer = ProcessKind | 'all' | 'compose' | 'init.sh' | 'scripts';

export interface EnvVarSpec {
  readonly name: string;
  readonly usedBy: readonly Consumer[];
  /** Documented default (as in spec 01 §3); computed defaults are described in words. */
  readonly defaultValue?: string;
  readonly secret?: boolean;
  /** Database bootstrap only (compose / init.sh): never read by the apps. */
  readonly bootstrapOnly?: boolean;
}

/** Every variable of spec 01 §3, in table order. `.env.example` lists exactly these. */
export const ENV_VARS: readonly EnvVarSpec[] = [
  { name: 'NODE_ENV', usedBy: ['all'], defaultValue: 'development' },
  { name: 'DATABASE_URL', usedBy: ['api', 'test'], secret: true },
  { name: 'DATABASE_URL_WORKER', usedBy: ['worker', 'eval'], secret: true },
  { name: 'DATABASE_URL_MIGRATE', usedBy: ['migrate'], secret: true },
  {
    name: 'TEST_ADMIN_DATABASE_URL',
    usedBy: ['test', 'eval'],
    defaultValue: 'postgres://postgres:postgres@localhost:${PG_TEST_PORT}/postgres',
    secret: true,
  },
  { name: 'PG_TEST_PORT', usedBy: ['compose', 'test'], defaultValue: '5433' },
  { name: 'PG_DEV_PORT', usedBy: ['compose'], defaultValue: '5432' },
  { name: 'LT_DEV_PORT', usedBy: ['compose'], defaultValue: '5000' },
  { name: 'POSTGRES_PASSWORD', usedBy: ['compose', 'init.sh'], secret: true, bootstrapOnly: true },
  {
    name: 'BANTOOZI_OWNER_PASSWORD',
    usedBy: ['compose', 'init.sh'],
    secret: true,
    bootstrapOnly: true,
  },
  {
    name: 'BANTOOZI_APP_PASSWORD',
    usedBy: ['compose', 'init.sh'],
    secret: true,
    bootstrapOnly: true,
  },
  {
    name: 'BANTOOZI_WORKER_PASSWORD',
    usedBy: ['compose', 'init.sh'],
    secret: true,
    bootstrapOnly: true,
  },
  {
    name: 'PUBLIC_BASE_URL',
    usedBy: ['api', 'worker', 'eval'],
    defaultValue: 'http://localhost:5173',
  },
  { name: 'API_PORT', usedBy: ['api'], defaultValue: '3000' },
  { name: 'SESSION_COOKIE_NAME', usedBy: ['api'], defaultValue: 'bantoozi_sid' },
  { name: 'SESSION_TTL_DAYS', usedBy: ['api'], defaultValue: '60' },
  { name: 'SESSION_PEPPER', usedBy: ['api'], secret: true },
  {
    name: 'MAIL_TRANSPORT',
    usedBy: ['api', 'worker'],
    defaultValue: 'smtp (log in development/test)',
  },
  { name: 'SMTP_URL', usedBy: ['api', 'worker'], secret: true },
  { name: 'MAIL_FROM', usedBy: ['api', 'worker'], defaultValue: 'Bantoozi <no-reply@localhost>' },
  { name: 'SIGNUP_MODE', usedBy: ['api'], defaultValue: 'invite' },
  { name: 'RATE_LIMITS_ENABLED', usedBy: ['api'], defaultValue: 'true' },
  { name: 'TYPESAFE_API_KEY', usedBy: ['worker', 'eval'], secret: true },
  { name: 'TYPESAFE_MODEL', usedBy: ['worker', 'eval'], defaultValue: 'jev-1.13.0' },
  {
    name: 'TYPESAFE_BASE_URL',
    usedBy: ['worker', 'eval'],
    defaultValue: 'https://api.typesafe.ai',
  },
  { name: 'TYPESAFE_PRICE_PER_MTOK_USD', usedBy: ['worker', 'eval'], defaultValue: '0.042' },
  { name: 'ENGINE_CONCURRENCY', usedBy: ['worker', 'eval'], defaultValue: '8' },
  { name: 'DAILY_BUDGET_USD', usedBy: ['worker'], defaultValue: '2.00' },
  { name: 'OLLAMA_API_KEY', usedBy: ['worker', 'eval'], secret: true },
  { name: 'PROVIDER_MASTER_KEY_ID', usedBy: ['api', 'worker', 'eval'] },
  { name: 'PROVIDER_MASTER_KEYS', usedBy: ['api', 'worker', 'eval'], secret: true },
  { name: 'OLLAMA_BASE_URL', usedBy: ['worker', 'eval'], defaultValue: 'https://ollama.com' },
  { name: 'OLLAMA_MODEL_FAST', usedBy: ['worker', 'eval'], defaultValue: 'glm-5.3-flash' },
  { name: 'OLLAMA_MODEL_STRONG', usedBy: ['worker', 'eval'], defaultValue: 'glm-5.3' },
  { name: 'OLLAMA_MAX_CONCURRENCY', usedBy: ['worker', 'eval'], defaultValue: '1' },
  { name: 'LLM_FALLBACK_ENABLED', usedBy: ['worker'], defaultValue: 'false' },
  {
    name: 'LIBRETRANSLATE_URL',
    usedBy: ['api', 'worker', 'eval'],
    defaultValue: 'http://libretranslate:5000',
  },
  {
    name: 'LANGUAGE_MODES',
    usedBy: ['worker'],
    defaultValue: '{"en":"native","sk":"native","cs":"native"}',
  },
  {
    name: 'FETCH_USER_AGENT',
    usedBy: ['api', 'worker', 'eval'],
    defaultValue: 'BantooziBot/1.0 (+${PUBLIC_BASE_URL}/bot)',
  },
  { name: 'FETCH_MAX_BYTES', usedBy: ['api', 'worker', 'eval'], defaultValue: '5242880' },
  { name: 'FETCH_TIMEOUT_MS', usedBy: ['api', 'worker', 'eval'], defaultValue: '20000' },
  { name: 'FETCH_ALLOW_PRIVATE', usedBy: ['api', 'worker', 'eval'], defaultValue: 'false' },
  { name: 'INGEST_MAX_AGE_DAYS', usedBy: ['worker'], defaultValue: '14' },
  { name: 'PREFILTER_MIN_CARDS', usedBy: ['worker'], defaultValue: '60' },
  { name: 'EVAL_INGEST_ONLY', usedBy: ['worker'], defaultValue: 'false' },
  { name: 'EVAL_PUBLIC_URL', usedBy: ['eval'], defaultValue: 'http://localhost:5180' },
  { name: 'EVAL_CACHE_DIR', usedBy: ['eval'], defaultValue: '~/.cache/bantoozi-eval' },
  { name: 'WORKER_QUEUES', usedBy: ['worker'], defaultValue: '*' },
  { name: 'LOG_LEVEL', usedBy: ['all'], defaultValue: 'info' },
  { name: 'METRICS_TOKEN', usedBy: ['api', 'worker', 'scripts'], secret: true },
  { name: 'WORKER_METRICS_PORT', usedBy: ['worker'], defaultValue: '9101' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', usedBy: ['all'] },
  { name: 'ADMIN_EMAILS', usedBy: ['api', 'worker'] },
];

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type MailTransport = 'smtp' | 'log';

export interface Config {
  readonly process: ProcessKind;
  readonly nodeEnv: NodeEnv;
  readonly databaseUrl: string | undefined;
  readonly databaseUrlWorker: string | undefined;
  readonly databaseUrlMigrate: string | undefined;
  readonly testAdminDatabaseUrl: string;
  readonly pgTestPort: number;
  readonly pgDevPort: number;
  readonly publicBaseUrl: string;
  readonly apiPort: number;
  readonly sessionCookieName: string;
  readonly sessionTtlDays: number;
  readonly sessionPepper: string | undefined;
  readonly mailTransport: MailTransport;
  readonly smtpUrl: string | undefined;
  readonly mailFrom: string;
  readonly signupMode: SignupMode;
  readonly rateLimitsEnabled: boolean;
  readonly typesafeApiKey: string | undefined;
  readonly typesafeModel: string;
  readonly typesafeBaseUrl: string;
  readonly typesafePricePerMtokUsd: number;
  readonly engineConcurrency: number;
  readonly dailyBudgetUsd: number;
  readonly ollamaApiKey: string | undefined;
  /** Id of the active wrapping key; the keyring itself is parsed by credential-crypto. */
  readonly providerMasterKeyId: string | undefined;
  /** Raw JSON keyring (secret). Malformed values disable credential features, not the process. */
  readonly providerMasterKeys: string | undefined;
  readonly ollamaBaseUrl: string;
  readonly ollamaModelFast: string;
  readonly ollamaModelStrong: string;
  readonly ollamaMaxConcurrency: number;
  readonly llmFallbackEnabled: boolean;
  readonly libretranslateUrl: string;
  readonly languageModes: LanguageModes;
  readonly fetchUserAgent: string;
  readonly fetchMaxBytes: number;
  readonly fetchTimeoutMs: number;
  readonly fetchAllowPrivate: boolean;
  readonly ingestMaxAgeDays: number;
  readonly prefilterMinCards: number;
  readonly evalIngestOnly: boolean;
  readonly evalPublicUrl: string;
  readonly evalCacheDir: string;
  readonly workerQueues: readonly QueueName[];
  readonly logLevel: LogLevel;
  readonly metricsToken: string | undefined;
  readonly workerMetricsPort: number;
  readonly otelExporterOtlpEndpoint: string | undefined;
  readonly adminEmails: readonly string[];
}

/** Fields that are required (non-undefined) for each process. */
interface RequiredFields {
  api: 'databaseUrl' | 'sessionPepper';
  worker: 'databaseUrlWorker';
  eval: 'databaseUrlWorker';
  migrate: 'databaseUrlMigrate';
  test: 'databaseUrl';
}

export type ProcessConfig<P extends ProcessKind> = Config & { readonly process: P } & {
  readonly [K in RequiredFields[P]]: string;
};

const REQUIRED_VARS: Record<ProcessKind, readonly string[]> = {
  api: ['DATABASE_URL', 'SESSION_PEPPER'],
  worker: ['DATABASE_URL_WORKER'],
  eval: ['DATABASE_URL_WORKER'],
  migrate: ['DATABASE_URL_MIGRATE'],
  test: ['DATABASE_URL'],
};

const SECRET_FIELDS = new Set<keyof Config>([
  'databaseUrl',
  'databaseUrlWorker',
  'databaseUrlMigrate',
  'testAdminDatabaseUrl',
  'sessionPepper',
  'smtpUrl',
  'typesafeApiKey',
  'ollamaApiKey',
  'providerMasterKeys',
  'metricsToken',
]);

/** A readable configuration error that never contains supplied values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(processKind: ProcessKind, problems: readonly string[]) {
    super(`Invalid configuration for process "${processKind}":\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions<P extends ProcessKind> {
  process: P;
  /** Defaults to `process.env`. */
  env?: Env;
}

export function loadConfig<P extends ProcessKind>(options: LoadConfigOptions<P>): ProcessConfig<P> {
  const env = options.env ?? globalThis.process.env;
  const kind = options.process;
  const problems: string[] = [];
  const relevant = (name: string): boolean => {
    const spec = ENV_VARS.find((v) => v.name === name);
    if (spec === undefined) throw new Error(`unregistered variable ${name}`);
    return spec.usedBy.includes('all') || spec.usedBy.includes(kind);
  };
  const raw = (name: string): string | undefined => {
    if (!relevant(name)) return undefined;
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  };
  const read = <T>(
    name: string,
    schema: z.ZodType<T>,
    fallback: string | undefined,
  ): T | undefined => {
    const value = raw(name) ?? fallback;
    if (value === undefined) return undefined;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    problems.push(`${name}: ${describe(result.error)}`);
    return undefined;
  };

  const nodeEnv =
    read('NODE_ENV', z.enum(['development', 'test', 'production']), 'development') ?? 'development';
  const production = nodeEnv === 'production';

  // PG_TEST_PORT also feeds the TEST_ADMIN_DATABASE_URL default, which eval uses too.
  const pgTestPort =
    kind === 'eval'
      ? (portSchema.safeParse(env['PG_TEST_PORT']?.trim() || '5433').data ?? 5433)
      : (read('PG_TEST_PORT', portSchema, '5433') ?? 5433);
  const publicBaseUrl =
    read('PUBLIC_BASE_URL', httpUrl, 'http://localhost:5173') ?? 'http://localhost:5173';
  const mailTransport =
    read('MAIL_TRANSPORT', z.enum(['smtp', 'log']), nodeEnv === 'production' ? 'smtp' : 'log') ??
    'smtp';

  const config: Config = {
    process: kind,
    nodeEnv,
    databaseUrl: read('DATABASE_URL', postgresUrl, undefined),
    databaseUrlWorker: read('DATABASE_URL_WORKER', postgresUrl, undefined),
    databaseUrlMigrate: read('DATABASE_URL_MIGRATE', postgresUrl, undefined),
    testAdminDatabaseUrl:
      read('TEST_ADMIN_DATABASE_URL', postgresUrl, undefined) ??
      `postgres://postgres:postgres@localhost:${pgTestPort}/postgres`,
    pgTestPort,
    pgDevPort: read('PG_DEV_PORT', portSchema, '5432') ?? 5432,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    apiPort: read('API_PORT', portSchema, '3000') ?? 3000,
    sessionCookieName:
      read('SESSION_COOKIE_NAME', z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), 'bantoozi_sid') ??
      'bantoozi_sid',
    sessionTtlDays: read('SESSION_TTL_DAYS', intIn(1, 3650), '60') ?? 60,
    sessionPepper: read('SESSION_PEPPER', z.string().min(production ? 32 : 1), undefined),
    mailTransport,
    smtpUrl: read('SMTP_URL', smtpUrl, undefined),
    mailFrom: read('MAIL_FROM', z.string().min(3).max(320), 'Bantoozi <no-reply@localhost>') ?? '',
    signupMode: read('SIGNUP_MODE', SignupModeSchema, 'invite') ?? 'invite',
    rateLimitsEnabled: read('RATE_LIMITS_ENABLED', booleanSchema, 'true') ?? true,
    typesafeApiKey: read('TYPESAFE_API_KEY', apiKeySchema, undefined),
    typesafeModel: read('TYPESAFE_MODEL', modelIdSchema, 'jev-1.13.0') ?? 'jev-1.13.0',
    typesafeBaseUrl: read('TYPESAFE_BASE_URL', httpUrl, 'https://api.typesafe.ai') ?? '',
    typesafePricePerMtokUsd: read('TYPESAFE_PRICE_PER_MTOK_USD', nonNegative, '0.042') ?? 0.042,
    engineConcurrency: read('ENGINE_CONCURRENCY', intIn(1, 256), '8') ?? 8,
    dailyBudgetUsd: read('DAILY_BUDGET_USD', nonNegative, '2.00') ?? 2,
    ollamaApiKey: read('OLLAMA_API_KEY', apiKeySchema, undefined),
    providerMasterKeyId: read('PROVIDER_MASTER_KEY_ID', z.string().min(1).max(200), undefined),
    providerMasterKeys: raw('PROVIDER_MASTER_KEYS'),
    ollamaBaseUrl: read('OLLAMA_BASE_URL', httpUrl, 'https://ollama.com') ?? '',
    ollamaModelFast: read('OLLAMA_MODEL_FAST', modelIdSchema, 'glm-5.3-flash') ?? 'glm-5.3-flash',
    ollamaModelStrong: read('OLLAMA_MODEL_STRONG', modelIdSchema, 'glm-5.3') ?? 'glm-5.3',
    ollamaMaxConcurrency: read('OLLAMA_MAX_CONCURRENCY', intIn(1, 64), '1') ?? 1,
    llmFallbackEnabled: read('LLM_FALLBACK_ENABLED', booleanSchema, 'false') ?? false,
    libretranslateUrl: read('LIBRETRANSLATE_URL', httpUrl, 'http://libretranslate:5000') ?? '',
    languageModes:
      read('LANGUAGE_MODES', languageModesJson, '{"en":"native","sk":"native","cs":"native"}') ??
      {},
    fetchUserAgent:
      read('FETCH_USER_AGENT', z.string().min(1).max(512), undefined) ??
      `BantooziBot/1.0 (+${publicBaseUrl.replace(/\/+$/, '')}/bot)`,
    fetchMaxBytes: read('FETCH_MAX_BYTES', intIn(1024, 1024 ** 3), '5242880') ?? 5242880,
    fetchTimeoutMs: read('FETCH_TIMEOUT_MS', intIn(100, 600_000), '20000') ?? 20000,
    fetchAllowPrivate: read('FETCH_ALLOW_PRIVATE', booleanSchema, 'false') ?? false,
    ingestMaxAgeDays: read('INGEST_MAX_AGE_DAYS', intIn(1, 3650), '14') ?? 14,
    prefilterMinCards: read('PREFILTER_MIN_CARDS', intIn(1, 1_000_000), '60') ?? 60,
    evalIngestOnly: read('EVAL_INGEST_ONLY', booleanSchema, 'false') ?? false,
    evalPublicUrl: read('EVAL_PUBLIC_URL', httpUrl, 'http://localhost:5180') ?? '',
    evalCacheDir: expandHome(
      read('EVAL_CACHE_DIR', z.string().min(1), '~/.cache/bantoozi-eval') ?? '',
    ),
    workerQueues: read('WORKER_QUEUES', workerQueuesSchema, '*') ?? [],
    logLevel:
      read(
        'LOG_LEVEL',
        z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
        'info',
      ) ?? 'info',
    metricsToken: read('METRICS_TOKEN', z.string().min(production ? 32 : 1), undefined),
    workerMetricsPort: read('WORKER_METRICS_PORT', portSchema, '9101') ?? 9101,
    otelExporterOtlpEndpoint: read('OTEL_EXPORTER_OTLP_ENDPOINT', httpUrl, undefined),
    adminEmails: read('ADMIN_EMAILS', emailListSchema, undefined) ?? [],
  };

  for (const name of REQUIRED_VARS[kind]) {
    if (raw(name) === undefined) problems.push(`${name}: required for process "${kind}"`);
  }

  // Safety refusals (spec 01 §3, spec 03 §4, spec 08 §11).
  if (config.fetchAllowPrivate && production) {
    problems.push('FETCH_ALLOW_PRIVATE: must not be true when NODE_ENV=production');
  }
  if (relevant('RATE_LIMITS_ENABLED') && !config.rateLimitsEnabled && nodeEnv !== 'test') {
    problems.push('RATE_LIMITS_ENABLED: false is allowed only with NODE_ENV=test');
  }
  if (production && (kind === 'api' || kind === 'worker')) {
    if (config.mailTransport === 'log') {
      problems.push('MAIL_TRANSPORT: "log" would print login codes; not allowed in production');
    } else if (config.smtpUrl === undefined) {
      problems.push('SMTP_URL: required in production');
    }
  }
  if (production && relevant('TYPESAFE_MODEL') && !PINNED_MODEL.test(config.typesafeModel)) {
    problems.push('TYPESAFE_MODEL: must be a pinned version (e.g. jev-1.13.0) in production');
  }
  if (production) {
    for (const [name, url] of [
      ['TYPESAFE_BASE_URL', config.typesafeBaseUrl],
      ['OLLAMA_BASE_URL', config.ollamaBaseUrl],
      ['PUBLIC_BASE_URL', config.publicBaseUrl],
    ] as const) {
      if (relevant(name) && url !== '' && !url.startsWith('https://')) {
        problems.push(`${name}: must use https in production`);
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(kind, problems);
  return redactable(config) as ProcessConfig<P>;
}

/** Serialize a config for logs/diagnostics with every secret replaced. */
export function redactConfig(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [
      k,
      SECRET_FIELDS.has(k as keyof Config) && v !== undefined ? '[redacted]' : v,
    ]),
  );
}

function redactable(config: Config): Config {
  const frozen = { ...config };
  Object.defineProperty(frozen, 'toJSON', { value: () => redactConfig(config), enumerable: false });
  Object.defineProperty(frozen, inspect.custom, {
    value: () => redactConfig(config),
    enumerable: false,
  });
  return Object.freeze(frozen);
}

// ── field schemas ────────────────────────────────────────────────────────────────────────────

const PINNED_MODEL = /^[a-z][a-z0-9.-]*-\d+\.\d+\.\d+$/;

const intIn = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const portSchema = intIn(1, 65535);
const nonNegative = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative number')
  .transform(Number)
  .pipe(z.number().finite().min(0));
const booleanSchema = z
  .string()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0']))
  .transform((v) => v === 'true' || v === '1');
const httpUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === ''
    );
  } catch {
    return false;
  }
}, 'must be an http(s) URL without credentials');
const postgresUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'postgres:' || u.protocol === 'postgresql:';
  } catch {
    return false;
  }
}, 'must be a postgres:// URL');
const smtpUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'smtp:' || u.protocol === 'smtps:';
  } catch {
    return false;
  }
}, 'must be an smtp:// or smtps:// URL');
// eslint-disable-next-line no-control-regex -- API keys must not contain CR/LF/NUL (spec 04 §1.2)
const NO_CR_LF_NUL = /^[^\r\n\u0000]+$/;
const apiKeySchema = z.string().max(4096).regex(NO_CR_LF_NUL, 'must not contain CR, LF or NUL');
const modelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/, 'invalid model id');
const languageModesJson = z
  .string()
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be JSON' });
      return z.NEVER;
    }
  })
  .pipe(LanguageModesSchema);
const workerQueuesSchema = z.string().transform((s, ctx) => {
  try {
    return resolveWorkerQueues(s);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});
const emailListSchema = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  )
  .pipe(z.array(z.email()).max(100));

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p;
}

/** Issue messages without the offending input (zod messages may echo values). */
function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      switch (issue.code) {
        case 'invalid_value':
          return `invalid value${where}`;
        case 'invalid_type':
          return `invalid type${where}`;
        case 'too_small':
          return `too short or too small${where}`;
        case 'too_big':
          return `too long or too large${where}`;
        default:
          return `${issue.message}${where}`;
      }
    })
    .join('; ');
}

export type { LanguageModes };
