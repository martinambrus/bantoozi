import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, ENV_VARS, loadConfig } from '../src/server/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every variable of spec 01 §3, transcribed from the spec table. */
const SPEC_01_VARIABLES = [
  'NODE_ENV',
  'DATABASE_URL',
  'DATABASE_URL_WORKER',
  'DATABASE_URL_MIGRATE',
  'TEST_ADMIN_DATABASE_URL',
  'PG_TEST_PORT',
  'PG_DEV_PORT',
  'LT_DEV_PORT',
  'POSTGRES_PASSWORD',
  'BANTOOZI_OWNER_PASSWORD',
  'BANTOOZI_APP_PASSWORD',
  'BANTOOZI_WORKER_PASSWORD',
  'PUBLIC_BASE_URL',
  'API_PORT',
  'API_HOST',
  'SESSION_COOKIE_NAME',
  'SESSION_TTL_DAYS',
  'SESSION_PEPPER',
  'MAIL_TRANSPORT',
  'SMTP_URL',
  'MAIL_FROM',
  'SIGNUP_MODE',
  'RATE_LIMITS_ENABLED',
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  'TYPESAFE_BASE_URL',
  'TYPESAFE_PRICE_PER_MTOK_USD',
  'ENGINE_CONCURRENCY',
  'DAILY_BUDGET_USD',
  'OLLAMA_API_KEY',
  'PROVIDER_MASTER_KEY_ID',
  'PROVIDER_MASTER_KEYS',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL_FAST',
  'OLLAMA_MODEL_STRONG',
  'OLLAMA_MAX_CONCURRENCY',
  'LLM_FALLBACK_ENABLED',
  'LIBRETRANSLATE_URL',
  'LANGUAGE_MODES',
  'FETCH_USER_AGENT',
  'FETCH_MAX_BYTES',
  'FETCH_TIMEOUT_MS',
  'FETCH_ALLOW_PRIVATE',
  'INGEST_MAX_AGE_DAYS',
  'PREFILTER_MIN_CARDS',
  'EVAL_INGEST_ONLY',
  'EVAL_PUBLIC_URL',
  'EVAL_CACHE_DIR',
  'WORKER_QUEUES',
  'LOG_LEVEL',
  'METRICS_TOKEN',
  'WORKER_METRICS_PORT',
  'WORKER_METRICS_HOST',
  'WORKER_SELF_RESTART',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'ADMIN_EMAILS',
  'PROVIDER_HOST_ALLOWLIST',
  'DELETION_LEDGER_PATH',
  'DELETION_LEDGER_RECIPIENT',
  'DELETION_HMAC_KEY',
];

const APP_URL = 'postgres://bantoozi_app:app-secret@localhost:5433/bantoozi';
const WORKER_URL = 'postgres://bantoozi_worker:worker-secret@localhost:5433/bantoozi';
const api = { DATABASE_URL: APP_URL, SESSION_PEPPER: 'pepper' };

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe('loadConfig (spec 01 §3)', () => {
  it('registers every variable of the spec table, and .env.example lists exactly those once', () => {
    expect(ENV_VARS.map((v) => v.name)).toEqual(SPEC_01_VARIABLES);
    const example = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
    const listed = example
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf('=')));
    expect([...listed].sort()).toEqual([...SPEC_01_VARIABLES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('fails for the worker when DATABASE_URL_WORKER is missing, and passes for the api', () => {
    expect(problemsOf(() => loadConfig({ process: 'worker', env: {} }))).toContain(
      'DATABASE_URL_WORKER: required for process "worker"',
    );
    expect(problemsOf(() => loadConfig({ process: 'eval', env: {} }))).toContain(
      'DATABASE_URL_WORKER: required for process "eval"',
    );
    const config = loadConfig({ process: 'api', env: api });
    expect(config.databaseUrl).toBe(APP_URL);
    expect(config.databaseUrlWorker).toBeUndefined();
  });

  it('requires DATABASE_URL and SESSION_PEPPER for the api and DATABASE_URL_MIGRATE for migrate', () => {
    expect(problemsOf(() => loadConfig({ process: 'api', env: {} }))).toEqual([
      'DATABASE_URL: required for process "api"',
      'SESSION_PEPPER: required for process "api"',
    ]);
    expect(problemsOf(() => loadConfig({ process: 'migrate', env: {} }))).toEqual([
      'DATABASE_URL_MIGRATE: required for process "migrate"',
    ]);
    expect(problemsOf(() => loadConfig({ process: 'test', env: {} }))).toEqual([
      'DATABASE_URL: required for process "test"',
    ]);
  });

  it('refuses FETCH_ALLOW_PRIVATE=true with NODE_ENV=production', () => {
    for (const process of ['api', 'worker', 'eval'] as const) {
      const env = {
        ...api,
        DATABASE_URL_WORKER: WORKER_URL,
        NODE_ENV: 'production',
        FETCH_ALLOW_PRIVATE: 'true',
        SESSION_PEPPER: 'p'.repeat(32),
        SMTP_URL: 'smtp://mail.example.com:587',
        PUBLIC_BASE_URL: 'https://bantoozi.example',
      };
      expect(problemsOf(() => loadConfig({ process, env }))).toContain(
        'FETCH_ALLOW_PRIVATE: must not be true when NODE_ENV=production',
      );
    }
    expect(
      loadConfig({ process: 'api', env: { ...api, NODE_ENV: 'test', FETCH_ALLOW_PRIVATE: 'true' } })
        .fetchAllowPrivate,
    ).toBe(true);
  });

  it('gives the api the Jev model it freezes into analysis requests (D-150)', () => {
    expect(loadConfig({ process: 'api', env: api }).typesafeModel).toBe('jev-1.13.0');
    expect(
      loadConfig({ process: 'api', env: { ...api, TYPESAFE_MODEL: 'jev-1.14.0' } }).typesafeModel,
    ).toBe('jev-1.14.0');
    const prod = {
      ...api,
      NODE_ENV: 'production',
      SESSION_PEPPER: 'p'.repeat(32),
      SMTP_URL: 'smtp://mail.example.com:587',
      PUBLIC_BASE_URL: 'https://bantoozi.example',
      TYPESAFE_MODEL: 'jev-latest',
    };
    expect(problemsOf(() => loadConfig({ process: 'api', env: prod }))).toEqual([
      'TYPESAFE_MODEL: must be a pinned version (e.g. jev-1.13.0) in production',
    ]);
  });

  it('refuses RATE_LIMITS_ENABLED=false in production and allows it only with NODE_ENV=test', () => {
    const prod = {
      ...api,
      NODE_ENV: 'production',
      RATE_LIMITS_ENABLED: 'false',
      SESSION_PEPPER: 'p'.repeat(32),
      SMTP_URL: 'smtp://mail.example.com:587',
      PUBLIC_BASE_URL: 'https://bantoozi.example',
    };
    expect(problemsOf(() => loadConfig({ process: 'api', env: prod }))).toEqual([
      'RATE_LIMITS_ENABLED: false is allowed only with NODE_ENV=test',
    ]);
    expect(
      problemsOf(() =>
        loadConfig({ process: 'api', env: { ...api, RATE_LIMITS_ENABLED: 'false' } }),
      ),
    ).toEqual(['RATE_LIMITS_ENABLED: false is allowed only with NODE_ENV=test']);
    expect(
      loadConfig({
        process: 'api',
        env: { ...api, NODE_ENV: 'test', RATE_LIMITS_ENABLED: 'false' },
      }).rateLimitsEnabled,
    ).toBe(false);
  });

  it('applies the documented defaults', () => {
    const c = loadConfig({ process: 'worker', env: { DATABASE_URL_WORKER: WORKER_URL } });
    expect(c.nodeEnv).toBe('development');
    expect(c.testAdminDatabaseUrl).toBe('postgres://postgres:postgres@localhost:5433/postgres');
    expect(c.publicBaseUrl).toBe('http://localhost:5173');
    expect(c.fetchUserAgent).toBe('BantooziBot/1.0 (+http://localhost:5173/bot)');
    expect(c.mailTransport).toBe('log');
    expect(c.mailFrom).toBe('Bantoozi <no-reply@localhost>');
    expect(c.typesafeModel).toBe('jev-1.13.0');
    expect(c.typesafeBaseUrl).toBe('https://api.typesafe.ai');
    expect(c.typesafePricePerMtokUsd).toBe(0.042);
    expect(c.engineConcurrency).toBe(8);
    expect(c.dailyBudgetUsd).toBe(2);
    expect(c.ollamaBaseUrl).toBe('https://ollama.com');
    expect(c.ollamaModelFast).toBe('glm-5.3-flash');
    expect(c.ollamaModelStrong).toBe('glm-5.3');
    expect(c.ollamaMaxConcurrency).toBe(1);
    expect(c.llmFallbackEnabled).toBe(false);
    expect(c.libretranslateUrl).toBe('http://libretranslate:5000');
    expect(c.languageModes).toEqual({ en: 'native', sk: 'native', cs: 'native' });
    expect(c.fetchMaxBytes).toBe(5242880);
    expect(c.fetchTimeoutMs).toBe(20000);
    expect(c.fetchAllowPrivate).toBe(false);
    expect(c.ingestMaxAgeDays).toBe(14);
    expect(c.prefilterMinCards).toBe(60);
    expect(c.evalIngestOnly).toBe(false);
    expect(c.workerQueues).not.toContain('article.enrich.laya');
    expect(c.workerQueues).not.toContain('analysis.process.laya');
    expect(c.workerQueues).toContain('feed.fetch');
    expect(c.logLevel).toBe('info');
    expect(c.workerMetricsPort).toBe(9101);
    expect(c.workerMetricsHost).toBe('127.0.0.1');
    expect(c.adminEmails).toEqual([]);

    const a = loadConfig({ process: 'api', env: api });
    expect(a.apiPort).toBe(3000);
    expect(a.apiHost).toBe('127.0.0.1');
    expect(a.sessionCookieName).toBe('bantoozi_sid');
    expect(a.sessionTtlDays).toBe(60);
    expect(a.signupMode).toBe('invite');
    expect(a.rateLimitsEnabled).toBe(true);

    const e = loadConfig({
      process: 'eval',
      env: { DATABASE_URL_WORKER: WORKER_URL, PG_TEST_PORT: '6543' },
    });
    expect(e.evalPublicUrl).toBe('http://localhost:5180');
    expect(e.evalCacheDir).toBe(path.join(homedir(), '.cache/bantoozi-eval'));
    expect(e.testAdminDatabaseUrl).toBe('postgres://postgres:postgres@localhost:6543/postgres');
  });

  it('parses typed values', () => {
    const c = loadConfig({
      process: 'worker',
      env: {
        DATABASE_URL_WORKER: WORKER_URL,
        LANGUAGE_MODES: '{"en":"native","sk":"translate"}',
        WORKER_QUEUES: 'feed.fetch, article.extract',
        LLM_FALLBACK_ENABLED: 'TRUE',
        ADMIN_EMAILS: ' Admin@Example.com ,ops@example.com',
        PUBLIC_BASE_URL: 'https://bantoozi.example/',
      },
    });
    expect(c.languageModes).toEqual({ en: 'native', sk: 'translate' });
    expect(c.workerQueues).toEqual(['feed.fetch', 'article.extract']);
    expect(c.llmFallbackEnabled).toBe(true);
    expect(c.adminEmails).toEqual(['admin@example.com', 'ops@example.com']);
    expect(c.publicBaseUrl).toBe('https://bantoozi.example');
    expect(c.fetchUserAgent).toBe('BantooziBot/1.0 (+https://bantoozi.example/bot)');
  });

  it('rejects malformed values with readable messages', () => {
    const problems = problemsOf(() =>
      loadConfig({
        process: 'worker',
        env: {
          DATABASE_URL_WORKER: WORKER_URL,
          ENGINE_CONCURRENCY: 'many',
          LANGUAGE_MODES: '{"en":"auto"}',
          WORKER_QUEUES: 'feed.fetch,no.such.queue',
          NODE_ENV: 'staging',
        },
      }),
    );
    expect(problems.map((p) => p.split(':')[0])).toEqual([
      'NODE_ENV',
      'ENGINE_CONCURRENCY',
      'LANGUAGE_MODES',
      'WORKER_QUEUES',
    ]);
  });

  it('never echoes supplied values in errors, and redacts secrets when serialized', () => {
    const problems = problemsOf(() =>
      loadConfig({
        process: 'api',
        env: {
          DATABASE_URL: 'mysql://root:TopSecret123@db/x',
          SESSION_PEPPER: 'pepper-value-xyz',
          SMTP_URL: 'http://user:MailSecret456@mail',
        },
      }),
    );
    expect(problems.join('\n')).not.toMatch(/TopSecret123|MailSecret456|pepper-value-xyz|root/);
    expect(problems.map((p) => p.split(':')[0])).toEqual(['DATABASE_URL', 'SMTP_URL']);

    const config = loadConfig({
      process: 'api',
      env: { ...api, SESSION_PEPPER: 'pepper-value-xyz' },
    });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('pepper-value-xyz');
    expect(serialized).not.toContain('app-secret');
    expect(serialized).toContain('"sessionPepper":"[redacted]"');
    expect(config.sessionPepper).toBe('pepper-value-xyz');
  });

  it('refuses a production worker without the deletion ledger path, recipient or HMAC key (R2)', () => {
    const prodWorker = {
      NODE_ENV: 'production',
      DATABASE_URL_WORKER: WORKER_URL,
      SMTP_URL: 'smtp://mail.example.com:587',
      PUBLIC_BASE_URL: 'https://bantoozi.example',
      DELETION_LEDGER_PATH: '/var/lib/bantoozi/ledger/deletion-ledger.age',
      ADMIN_EMAILS: 'admin@bantoozi.example',
      DELETION_LEDGER_RECIPIENT: 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      DELETION_HMAC_KEY: 'k'.repeat(32),
    };
    expect(problemsOf(() => loadConfig({ process: 'worker', env: prodWorker }))).toEqual([]);
    for (const name of [
      'DELETION_LEDGER_PATH',
      'DELETION_LEDGER_RECIPIENT',
      'DELETION_HMAC_KEY',
    ] as const) {
      const { [name]: _omitted, ...rest } = prodWorker;
      expect(problemsOf(() => loadConfig({ process: 'worker', env: rest }))).toEqual([
        `${name}: required in production (erasure would be skipped without it)`,
      ]);
    }
    const { DELETION_HMAC_KEY: _key, ...development } = { ...prodWorker, NODE_ENV: 'development' };
    expect(problemsOf(() => loadConfig({ process: 'worker', env: development }))).toEqual([]);
  });

  it('refuses a production worker whose ledger path is off the persistent volume and accepts an empty admin list (R15, M8b-T7)', () => {
    const prodWorker = {
      NODE_ENV: 'production',
      DATABASE_URL_WORKER: WORKER_URL,
      SMTP_URL: 'smtp://mail.example.com:587',
      PUBLIC_BASE_URL: 'https://bantoozi.example',
      DELETION_LEDGER_PATH: '/var/lib/bantoozi/ledger/deletion-ledger.age',
      DELETION_LEDGER_RECIPIENT: 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      DELETION_HMAC_KEY: 'k'.repeat(32),
      ADMIN_EMAILS: 'admin@bantoozi.example',
    };
    const problems = (extra: Record<string, string>) =>
      problemsOf(() => loadConfig({ process: 'worker', env: { ...prodWorker, ...extra } }));
    expect(problems({})).toEqual([]);
    expect(problems({ DELETION_LEDGER_PATH: '/var/lib/bantoozi/ledger/sub/l.age' })).toEqual([]);
    const offVolume =
      'DELETION_LEDGER_PATH: must be inside /var/lib/bantoozi/ledger/ (the persistent ledger volume) in production';
    expect(problems({ DELETION_LEDGER_PATH: '/tmp/deletion-ledger.age' })).toEqual([offVolume]);
    expect(
      problems({ DELETION_LEDGER_PATH: '/var/lib/bantoozi/ledger/../../../tmp/l.age' }),
    ).toEqual([offVolume]);
    expect(problems({ DELETION_LEDGER_PATH: 'ledger/deletion-ledger.age' })).toEqual([offVolume]);
    expect(problems({ DELETION_LEDGER_PATH: '/var/lib/bantoozi/ledger' })).toEqual([offVolume]);
    expect(problems({ DELETION_LEDGER_PATH: '/var/lib/bantoozi/ledger-other/l.age' })).toEqual([
      offVolume,
    ]);
    // M8b-T7 (owner 2026-10-13): ADMIN_EMAILS is bootstrap only; production no longer requires it
    // (D-202 (2) is superseded). Alerts go to the active admins, ADMIN_EMAILS is the fallback.
    expect(problems({ ADMIN_EMAILS: '' })).toEqual([]);
    expect(problems({ ADMIN_EMAILS: ' , ' })).toEqual([]);
    const { ADMIN_EMAILS: _a, ...noVar } = prodWorker;
    expect(problemsOf(() => loadConfig({ process: 'worker', env: noVar }))).toEqual([]);
    expect(loadConfig({ process: 'worker', env: noVar }).adminEmails).toEqual([]);
    // Negative control: the other production rules stay enforced without the list.
    expect(
      problemsOf(() =>
        loadConfig({
          process: 'worker',
          env: { ...noVar, DELETION_LEDGER_PATH: '/tmp/deletion-ledger.age' },
        }),
      ),
    ).toEqual([offVolume]);
    // Development keeps both optional; the API does not need the list.
    expect(
      problemsOf(() =>
        loadConfig({
          process: 'worker',
          env: { ...noVar, NODE_ENV: 'development', DELETION_LEDGER_PATH: '/tmp/x.age' },
        }),
      ),
    ).toEqual([]);
  });

  it('applies production safety rules', () => {
    const prodWorker = {
      NODE_ENV: 'production',
      DATABASE_URL_WORKER: WORKER_URL,
      SMTP_URL: 'smtp://mail.example.com:587',
      PUBLIC_BASE_URL: 'https://bantoozi.example',
      DELETION_LEDGER_PATH: '/var/lib/bantoozi/ledger/deletion-ledger.age',
      ADMIN_EMAILS: 'admin@bantoozi.example',
      DELETION_LEDGER_RECIPIENT: 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      DELETION_HMAC_KEY: 'k'.repeat(32),
    };
    expect(problemsOf(() => loadConfig({ process: 'worker', env: prodWorker }))).toEqual([]);
    expect(loadConfig({ process: 'worker', env: prodWorker }).workerMetricsHost).toBe('0.0.0.0');
    expect(
      loadConfig({ process: 'worker', env: { ...prodWorker, WORKER_METRICS_HOST: '10.0.0.5' } })
        .workerMetricsHost,
    ).toBe('10.0.0.5');
    expect(loadConfig({ process: 'worker', env: prodWorker }).mailTransport).toBe('smtp');
    expect(
      problemsOf(() => loadConfig({ process: 'worker', env: { ...prodWorker, SMTP_URL: '' } })),
    ).toEqual(['SMTP_URL: required in production']);
    expect(
      problemsOf(() =>
        loadConfig({ process: 'worker', env: { ...prodWorker, MAIL_TRANSPORT: 'log' } }),
      ),
    ).toEqual(['MAIL_TRANSPORT: "log" would print login codes; not allowed in production']);
    expect(
      problemsOf(() =>
        loadConfig({ process: 'worker', env: { ...prodWorker, TYPESAFE_MODEL: 'jev-latest' } }),
      ),
    ).toEqual(['TYPESAFE_MODEL: must be a pinned version (e.g. jev-1.13.0) in production']);
    expect(
      problemsOf(() =>
        loadConfig({
          process: 'worker',
          env: { ...prodWorker, OLLAMA_BASE_URL: 'http://ollama.com' },
        }),
      ),
    ).toEqual(['OLLAMA_BASE_URL: must use https in production']);
    expect(
      problemsOf(() =>
        loadConfig({
          process: 'api',
          env: {
            ...api,
            NODE_ENV: 'production',
            SMTP_URL: 'smtp://m:587',
            PUBLIC_BASE_URL: 'https://b.example',
          },
        }),
      ),
    ).toEqual(['SESSION_PEPPER: too short or too small']);
  });

  it('loads a production api config without ADMIN_EMAILS (M8b-T7: bootstrap only, never required)', () => {
    const env = {
      ...api,
      NODE_ENV: 'production',
      SESSION_PEPPER: 'p'.repeat(32),
      SMTP_URL: 'smtp://mail.example.com:587',
      PUBLIC_BASE_URL: 'https://bantoozi.example',
    };
    expect(problemsOf(() => loadConfig({ process: 'api', env }))).toEqual([]);
    expect(loadConfig({ process: 'api', env }).adminEmails).toEqual([]);
    // Negative control: the production rules still apply to the same env.
    expect(
      problemsOf(() => loadConfig({ process: 'api', env: { ...env, SESSION_PEPPER: 'short' } })),
    ).toEqual(['SESSION_PEPPER: too short or too small']);
  });

  it('ignores variables that the process does not use', () => {
    const c = loadConfig({
      process: 'api',
      env: { ...api, DAILY_BUDGET_USD: 'not-a-number', WORKER_QUEUES: 'bogus' },
    });
    expect(c.dailyBudgetUsd).toBe(2);
  });
});
