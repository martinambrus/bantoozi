/**
 * Named SQL hooks of the E2E control API (`POST /sql/:hook`). Specs reach database state that no
 * HTTP endpoint exposes (pipeline states, simulated inactivity, …) only through the whitelisted
 * statements below. Each hook validates its parameters, binds them as query parameters and runs as
 * the superuser on the run's own database (several tables are FORCE row-level security, so the
 * application roles see nothing there).
 */

import { ADMIN_HOOKS } from './hooks-admin.js';
import {
  httpUrl,
  record,
  runner,
  type Hook,
  type HookDb,
  type HookRunner,
  type NamedHook,
} from './hooks-kit.js';
import { PWA_HOOKS } from './hooks-pwa.js';
import { READER_HOOKS } from './hooks-reader.js';

export { HookParamsError, type HookDb } from './hooks-kit.js';

export class UnknownHookError extends Error {
  override readonly name = 'UnknownHookError';
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

/** The hooks by name; a name listed twice is a mistake that must not pick one silently. */
export function hookMap(hooks: readonly NamedHook[]): ReadonlyMap<string, HookRunner> {
  const map = new Map<string, HookRunner>();
  for (const [name, run] of hooks) {
    if (map.has(name)) throw new Error(`SQL hook "${name}" is listed twice`);
    map.set(name, run);
  }
  return map;
}

const HOOKS = hookMap([
  ['articleStates', runner(articleStates)],
  ...READER_HOOKS,
  ...ADMIN_HOOKS,
  ...PWA_HOOKS,
]);

export function sqlHookNames(): string[] {
  return [...HOOKS.keys()];
}

/** Validates `params` for the hook `name` and runs it. */
export async function runSqlHook(db: HookDb, name: string, params: unknown): Promise<unknown> {
  const run = HOOKS.get(name);
  if (run === undefined) throw new UnknownHookError(`unknown SQL hook "${name}"`);
  return run(db, params);
}
