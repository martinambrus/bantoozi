/** What every SQL hook module of the E2E control API shares (see hooks.ts). */

/** The part of `pg.Pool` the hooks use. */
export interface HookDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export class HookParamsError extends Error {
  override readonly name = 'HookParamsError';
}

export interface Hook<P> {
  parse(params: unknown): P;
  run(db: HookDb, params: P): Promise<unknown>;
}

export type HookRunner = (db: HookDb, params: unknown) => Promise<unknown>;

/** A hook by its name, as a hook module lists it. */
export type NamedHook = readonly [name: string, run: HookRunner];

export function runner<P>(hook: Hook<P>): HookRunner {
  return (db, params) => hook.run(db, hook.parse(params));
}

/** The parameters as an object with no keys but `allowed`. */
export function record(params: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new HookParamsError('parameters must be a JSON object');
  }
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new HookParamsError(`unknown parameter: ${unknown.join(', ')}`);
  return params as Record<string, unknown>;
}

export function httpUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new HookParamsError(`${name} must be a URL of at most 2048 characters`);
  }
  const url = URL.parse(value);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new HookParamsError(`${name} must be an http(s) URL`);
  }
  return value;
}
