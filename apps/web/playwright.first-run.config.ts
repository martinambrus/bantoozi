import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { databaseUrls, FEED_KEYS, PORTS, runId, URLS } from './e2e/support/env.js';

// The runner picks the id once; the test workers evaluate this file again and inherit it.
process.env['E2E_RUN_ID'] ??= randomBytes(4).toString('hex');
// Without it the offline specs cannot see or intercept the service worker's own requests.
process.env['PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS'] = '1';
// The API's output is tee'd (as plain messages, by tee-api-log.mjs) to this file so the spec can read the first-run setup token (a webServer's
// stdout reaches only the runner). Chosen once; the test workers inherit it.
process.env['E2E_API_LOG_FILE'] ??= join(
  mkdtempSync(join(tmpdir(), 'bantoozi-first-run-')),
  'api.log',
);

const database = databaseUrls(runId());

// The first-run scenario (M8b-T11): a fresh database and no ADMIN_EMAILS, so setup is open. Kept apart
// from playwright.config.ts, whose API has ADMIN_EMAILS and so a closed setup.
// Every variable that could reach a live host or a developer's database is set explicitly.
const SERVICE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  SIGNUP_MODE: 'open',
  RATE_LIMITS_ENABLED: 'false',
  FETCH_ALLOW_PRIVATE: 'true',
  MAIL_TRANSPORT: 'log',
  SESSION_PEPPER: 'test',
  TYPESAFE_API_KEY: 'test',
  TYPESAFE_BASE_URL: URLS.fake,
  TYPESAFE_MODEL: 'jev-fake',
  PUBLIC_BASE_URL: URLS.app,
  API_PORT: String(PORTS.api),
  DATABASE_URL: database.app,
  DATABASE_URL_WORKER: database.worker,
  // No admin listed (set empty so a developer's shell cannot add one): with none in the fresh
  // database, first-run setup is open.
  ADMIN_EMAILS: '',
  PROVIDER_MASTER_KEY_ID: 'k1',
  PROVIDER_MASTER_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64') }),
  OLLAMA_BASE_URL: URLS.dead,
  OLLAMA_API_KEY: '',
  LIBRETRANSLATE_URL: URLS.dead,
  LOG_LEVEL: 'warn',
};

const SHUTDOWN = { signal: 'SIGTERM', timeout: 10_000 } as const;

export default defineConfig({
  testDir: 'e2e-first-run',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 90_000,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  // A worker answers requests itself, out of reach of the routes and counters the specs rely on; a
  // spec that needs one opts in with `serviceWorkers: 'allow'`.
  use: { baseURL: URLS.app, serviceWorkers: 'block', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'fixtures',
      command:
        'pnpm --filter @bantoozi/testing e2e:prepare && pnpm --filter @bantoozi/testing fixtures:serve',
      url: `${URLS.control}/ready`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      gracefulShutdown: SHUTDOWN,
    },
    {
      name: 'api',
      command:
        'pnpm --filter @bantoozi/api exec tsx --conditions=bantoozi-source src/main.ts 2>&1 | node e2e-first-run/tee-api-log.mjs "$E2E_API_LOG_FILE"',
      url: `${URLS.api}/api/v1/readyz`,
      env: SERVICE_ENV,
      reuseExistingServer: false,
      stdout: 'pipe',
      gracefulShutdown: SHUTDOWN,
    },
    {
      // No url or port: the worker has no listener, so globalSetup waits for it through the control API.
      name: 'worker',
      command: 'pnpm --filter @bantoozi/worker exec tsx --conditions=bantoozi-source src/main.ts',
      env: SERVICE_ENV,
      reuseExistingServer: false,
      stdout: 'pipe',
      gracefulShutdown: SHUTDOWN,
    },
    {
      name: 'web',
      command: `pnpm --filter @bantoozi/web exec vite build && pnpm --filter @bantoozi/web exec vite preview --port ${PORTS.preview} --strictPort`,
      url: URLS.app,
      timeout: 180_000,
      env: {
        NODE_ENV: 'production',
        BANTOOZI_API_PROXY: URLS.api,
        BANTOOZI_PREVIEW_IMG_SRC: FEED_KEYS.map((key) => URLS.feedOrigins[key]).join(' '),
      },
      reuseExistingServer: false,
      stdout: 'pipe',
      gracefulShutdown: SHUTDOWN,
    },
  ],
});
