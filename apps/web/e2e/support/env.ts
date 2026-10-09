/**
 * The E2E environment as the specs see it (spec 09 §9): ports, URLs and the fixture accounts.
 * Playwright does not apply the `bantoozi-source` export condition, so E2E code cannot import
 * workspace packages and this port table repeats packages/testing/src/e2e/env.ts; a unit test in
 * packages/testing keeps the two equal.
 */

export const FEED_KEYS = ['tech', 'science', 'culture'] as const;
export type FeedKey = (typeof FEED_KEYS)[number];

export interface Ports {
  base: number;
  preview: number;
  api: number;
  control: number;
  feeds: Record<FeedKey, number>;
  fake: number;
  dead: number;
}

const MIN_PORT = 1024;
const MAX_PORT = 65_535;

/** Every port shifted by `E2E_PORT_BASE` (default 0), so worktrees can run side by side. */
export function ports(env: Record<string, string | undefined> = process.env): Ports {
  const raw = env['E2E_PORT_BASE']?.trim() ?? '';
  if (raw !== '' && !/^-?\d+$/.test(raw)) {
    throw new Error(`E2E_PORT_BASE must be an integer (got "${raw}")`);
  }
  const base = raw === '' ? 0 : Number(raw);
  const shift = (port: number): number => {
    const shifted = port + base;
    if (shifted < MIN_PORT || shifted > MAX_PORT) {
      throw new Error(`E2E_PORT_BASE ${base} moves port ${port} outside ${MIN_PORT}-${MAX_PORT}`);
    }
    return shifted;
  };
  return {
    base,
    preview: shift(4173),
    api: shift(3101),
    control: shift(4600),
    feeds: { tech: shift(4601), science: shift(4602), culture: shift(4603) },
    fake: shift(4610),
    dead: shift(4619),
  };
}

export const PORTS = ports();

export const URLS = {
  /**
   * What the browser opens, Playwright's `baseURL` and the API's `PUBLIC_BASE_URL`: the API's CSRF
   * check compares a request's `Origin` with it byte for byte, so the host spelling matters.
   */
  app: `http://localhost:${PORTS.preview}`,
  api: `http://127.0.0.1:${PORTS.api}`,
  control: `http://127.0.0.1:${PORTS.control}`,
  fake: `http://127.0.0.1:${PORTS.fake}`,
  /** Nothing listens here: the Ollama and LibreTranslate URLs point at it. */
  dead: `http://127.0.0.1:${PORTS.dead}`,
  feedOrigins: {
    tech: `http://127.0.0.1:${PORTS.feeds.tech}`,
    science: `http://127.0.0.1:${PORTS.feeds.science}`,
    culture: `http://127.0.0.1:${PORTS.feeds.culture}`,
  },
} as const satisfies Record<string, unknown>;

export const EMAILS = {
  reader: 'reader@example.com',
  other: 'other@example.com',
  /** Listed in the API's and the worker's ADMIN_EMAILS: signing in gives the admin role. */
  admin: 'admin@example.com',
} as const;

/** `E2E_RUN_ID`: 8 hex digits chosen once per run by playwright.config.ts. */
export function runId(env: Record<string, string | undefined> = process.env): string {
  const id = env['E2E_RUN_ID'];
  if (id === undefined || !/^[0-9a-f]{8}$/.test(id)) {
    throw new Error('E2E_RUN_ID must be 8 lower-case hex digits (set by playwright.config.ts)');
  }
  return id;
}

/**
 * Application-role and worker-role connection strings for the run's database, built from the same
 * variables as `testDbEnv()` in packages/testing (the superuser URL gives host and port).
 */
export function databaseUrls(
  id: string,
  env: Record<string, string | undefined> = process.env,
): { app: string; worker: string } {
  const admin =
    env['TEST_ADMIN_DATABASE_URL']?.trim() ||
    `postgres://postgres:postgres@localhost:${env['PG_TEST_PORT']?.trim() || '5433'}/postgres`;
  const build = (role: string, password: string): string => {
    const url = new URL(admin);
    url.username = role;
    url.password = password;
    url.pathname = `/bantoozi_e2e_${id}`;
    return url.toString();
  };
  return {
    app: build('bantoozi_app', env['BANTOOZI_APP_PASSWORD'] || 'bantoozi_app'),
    worker: build('bantoozi_worker', env['BANTOOZI_WORKER_PASSWORD'] || 'bantoozi_worker'),
  };
}
