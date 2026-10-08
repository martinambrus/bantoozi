/**
 * Named SQL hooks of the E2E control API (`POST /sql/:hook`). Specs reach database state that no
 * HTTP endpoint exposes (pipeline states, simulated inactivity, …) only through the whitelisted
 * statements below. Each hook validates its parameters, binds them as query parameters and runs as
 * the superuser on the run's own database (several tables are FORCE row-level security, so the
 * application roles see nothing there).
 */

/** The part of `pg.Pool` the hooks use. */
export interface HookDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export class HookParamsError extends Error {
  override readonly name = 'HookParamsError';
}

export class UnknownHookError extends Error {
  override readonly name = 'UnknownHookError';
}

interface Hook<P> {
  parse(params: unknown): P;
  run(db: HookDb, params: P): Promise<unknown>;
}

function record(params: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new HookParamsError('parameters must be a JSON object');
  }
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new HookParamsError(`unknown parameter: ${unknown.join(', ')}`);
  return params as Record<string, unknown>;
}

function httpUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new HookParamsError(`${name} must be a URL of at most 2048 characters`);
  }
  const url = URL.parse(value);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new HookParamsError(`${name} must be an http(s) URL`);
  }
  return value;
}

export interface ArticleState {
  id: string;
  title: string;
  pipelineState: string;
  contentRevision: string;
}

/** The articles a feed carries and how far the pipeline has taken them. */
const articleStates: Hook<{ feedUrl: string }> = {
  parse: (params) => ({ feedUrl: httpUrl(record(params, ['feedUrl'])['feedUrl'], 'feedUrl') }),
  async run(db, { feedUrl }) {
    const { rows } = await db.query(
      `SELECT a.id::text AS "id", a.title AS "title", a.pipeline_state AS "pipelineState",
              a.content_revision::text AS "contentRevision"
         FROM feeds f
         JOIN feed_items fi ON fi.feed_id = f.id
         JOIN articles a ON a.id = fi.article_id
        WHERE f.url = $1 OR f.fetch_url = $1
        ORDER BY a.id`,
      [feedUrl],
    );
    return rows as ArticleState[];
  },
};

type HookRunner = (db: HookDb, params: unknown) => Promise<unknown>;

function runner<P>(hook: Hook<P>): HookRunner {
  return (db, params) => hook.run(db, hook.parse(params));
}

const HOOKS = new Map<string, HookRunner>([['articleStates', runner(articleStates)]]);

export function sqlHookNames(): string[] {
  return [...HOOKS.keys()];
}

/** Validates `params` for the hook `name` and runs it. */
export async function runSqlHook(db: HookDb, name: string, params: unknown): Promise<unknown> {
  const run = HOOKS.get(name);
  if (run === undefined) throw new UnknownHookError(`unknown SQL hook "${name}"`);
  return run(db, params);
}
