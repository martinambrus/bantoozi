/**
 * Ports, run id and database name of the Playwright E2E environment (spec 09 §9). Playwright cannot
 * resolve workspace packages, so `apps/web/e2e/support/env.ts` keeps its own copy of the port table;
 * a test keeps the two equal.
 */

export const E2E_FEED_KEYS = ['tech', 'science', 'culture'] as const;
export type E2eFeedKey = (typeof E2E_FEED_KEYS)[number];

export function isE2eFeedKey(value: unknown): value is E2eFeedKey {
  return typeof value === 'string' && (E2E_FEED_KEYS as readonly string[]).includes(value);
}

export interface E2ePorts {
  readonly base: number;
  readonly preview: number;
  readonly api: number;
  readonly control: number;
  readonly feeds: Readonly<Record<E2eFeedKey, number>>;
  readonly fake: number;
  /** Nothing listens here: the Ollama and LibreTranslate URLs point at it. */
  readonly dead: number;
}

const DEFAULT_PORTS = {
  preview: 4173,
  api: 3101,
  control: 4600,
  feeds: { tech: 4601, science: 4602, culture: 4603 },
  fake: 4610,
  dead: 4619,
} as const;

const MIN_PORT = 1024;
const MAX_PORT = 65_535;

type Env = Readonly<Record<string, string | undefined>>;

/** The port table, every port shifted by `E2E_PORT_BASE` (default 0) so worktrees can run side by side. */
export function e2ePorts(env: Env = process.env): E2ePorts {
  const raw = env['E2E_PORT_BASE']?.trim() ?? '';
  if (raw !== '' && !/^-?\d+$/.test(raw)) {
    throw new Error(`E2E_PORT_BASE must be an integer (got "${raw}")`);
  }
  const base = raw === '' ? 0 : Number(raw);
  const shift = (port: number): number => {
    const shifted = port + base;
    if (shifted < MIN_PORT || shifted > MAX_PORT) {
      throw new Error(
        `E2E_PORT_BASE ${base} moves port ${port} to ${shifted}, outside ${MIN_PORT}-${MAX_PORT}`,
      );
    }
    return shifted;
  };
  return {
    base,
    preview: shift(DEFAULT_PORTS.preview),
    api: shift(DEFAULT_PORTS.api),
    control: shift(DEFAULT_PORTS.control),
    feeds: {
      tech: shift(DEFAULT_PORTS.feeds.tech),
      science: shift(DEFAULT_PORTS.feeds.science),
      culture: shift(DEFAULT_PORTS.feeds.culture),
    },
    fake: shift(DEFAULT_PORTS.fake),
    dead: shift(DEFAULT_PORTS.dead),
  };
}

const RUN_ID = /^[0-9a-f]{8}$/;

/** `E2E_RUN_ID`: 8 lower-case hex digits, chosen once per `pnpm e2e` run by playwright.config.ts. */
export function requireRunId(env: Env = process.env): string {
  const runId = env['E2E_RUN_ID'];
  if (runId === undefined || !RUN_ID.test(runId)) {
    throw new Error('E2E_RUN_ID must be 8 lower-case hex digits (set by playwright.config.ts)');
  }
  return runId;
}

/** Every database this environment creates or drops has a name of this shape, and no other does. */
export const E2E_DATABASE_NAME = /^bantoozi_e2e_[0-9a-f]{8}$/;

export function isE2eDatabaseName(name: string): boolean {
  return E2E_DATABASE_NAME.test(name);
}

export function assertE2eDatabaseName(name: string): string {
  if (!isE2eDatabaseName(name)) {
    throw new Error(`refusing to touch database "${name}": not a bantoozi_e2e_<runId> name`);
  }
  return name;
}

export function e2eDatabaseName(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error('run id must be 8 lower-case hex digits');
  return `bantoozi_e2e_${runId}`;
}
