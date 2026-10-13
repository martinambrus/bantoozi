import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Launch checklist item 12 (spec 11 §9, spec 11 §2 and §4, spec 02 §1.1): which credentials each
 * production container receives, checked statically on `infra/compose.yml`. Environment maps (merge
 * keys resolved) and `env_file` entries are flattened to the variable names each service gets and
 * the variables its values interpolate; no secret is read or rendered.
 */

interface ComposeService {
  environment?: Record<string, unknown> | string[];
  env_file?: string | string[] | Array<{ path: string }>;
  profiles?: string[];
}

const COMPOSE_URL = new URL('../../../infra/compose.yml', import.meta.url);
const compose = parse(readFileSync(COMPOSE_URL, 'utf8'), { merge: true }) as {
  services: Record<string, ComposeService>;
};

interface Resolved {
  /** Variable names the container sees. */
  names: string[];
  /** Name → value as written (interpolation left in place). */
  values: Record<string, string>;
  /** `${VAR}` references inside the values (host env-file variables). */
  refs: string[];
  /** Everything above, for pattern checks. */
  all: string[];
}

function resolve(name: string): Resolved {
  const service = compose.services[name];
  if (service === undefined) throw new Error(`service ${name} is not in infra/compose.yml`);
  const values: Record<string, string> = {};
  const env = service.environment;
  if (Array.isArray(env)) {
    for (const entry of env) {
      const index = entry.indexOf('=');
      values[index < 0 ? entry : entry.slice(0, index)] = index < 0 ? '' : entry.slice(index + 1);
    }
  } else if (env !== undefined) {
    for (const [key, value] of Object.entries(env)) values[key] = String(value ?? '');
  }
  // A whole env file would hand the container every host secret: none is allowed to be used here.
  expect(service.env_file, `${name} must not use env_file`).toBeUndefined();
  const refs = new Set<string>();
  for (const value of Object.values(values)) {
    for (const match of value.matchAll(/\$\{([A-Z0-9_]+)/g)) refs.add(match[1]!);
  }
  const names = Object.keys(values).sort();
  return {
    names,
    values,
    refs: [...refs].sort(),
    all: [...names, ...refs, ...Object.values(values)],
  };
}

const DB_PASSWORD_REFS = [
  'POSTGRES_PASSWORD',
  'BANTOOZI_OWNER_PASSWORD',
  'BANTOOZI_APP_PASSWORD',
  'BANTOOZI_WORKER_PASSWORD',
];
const DB_URL_NAMES = ['DATABASE_URL', 'DATABASE_URL_MIGRATE', 'DATABASE_URL_WORKER'];
const ROLE_LITERALS = ['bantoozi_owner', 'bantoozi_app', 'bantoozi_worker', 'postgres://postgres'];
/** Backup, S3 and age material (spec 11 §4): only the backup tooling holds it. */
const BACKUP_PATTERN =
  /BACKUP|(^|_)S3(_|$)|(^|_)AGE_(RECIPIENT|IDENTITY|SECRET|KEY)|AGE-SECRET-KEY|PRUNE/;

const without = (list: string[], allowed: string[]) => list.filter((n) => !allowed.includes(n));
const matching = (resolved: Resolved, pattern: RegExp) =>
  [...resolved.names, ...resolved.refs].filter((item) => pattern.test(item));
const mentions = (resolved: Resolved, literals: string[]) =>
  literals.filter((literal) => resolved.all.some((item) => item.includes(literal)));

/** The only DB credential a service holds, as a connection URL variable plus its role password. */
function expectOnlyDbCredential(name: string, urlName: string, role: string, password: string) {
  const r = resolve(name);
  expect(
    r.names.filter((n) => n.startsWith('DATABASE_URL')),
    `${name} URL variables`,
  ).toEqual([urlName]);
  const url = r.values[urlName]!;
  expect(url.startsWith(`postgres://${role}:\${${password}`), `${name} uses role ${role}`).toBe(
    true,
  );
  expect(
    without(
      r.refs.filter((ref) => DB_PASSWORD_REFS.includes(ref)),
      [password],
    ),
  ).toEqual([]);
  const otherRoles = ROLE_LITERALS.filter((literal) => literal !== role);
  expect(mentions(r, otherRoles), `${name} mentions another role`).toEqual([]);
  expect(matching(r, BACKUP_PATTERN), `${name} backup/S3/age material`).toEqual([]);
  return r;
}

describe('compose credentials (spec 11 §9 item 12)', () => {
  it('gives the api only the app role, and no owner, worker, migrate, superuser or backup secrets', () => {
    const r = expectOnlyDbCredential(
      'api',
      'DATABASE_URL',
      'bantoozi_app',
      'BANTOOZI_APP_PASSWORD',
    );
    expect(r.names).not.toContain('DATABASE_URL_MIGRATE');
    expect(r.names).not.toContain('DATABASE_URL_WORKER');
    // No deletion-ledger or provider-validation worker secrets either.
    expect(r.names.filter((n) => /^DELETION_|^TYPESAFE_API_KEY$|^OLLAMA_API_KEY$/.test(n))).toEqual(
      [],
    );
  });

  it('gives the worker (and worker-laya) only the worker role plus its own keys', () => {
    for (const name of ['worker', 'worker-laya']) {
      const r = expectOnlyDbCredential(
        name,
        'DATABASE_URL_WORKER',
        'bantoozi_worker',
        'BANTOOZI_WORKER_PASSWORD',
      );
      expect(r.names).not.toContain('SESSION_PEPPER');
      // Its own keys: provider keys, the provider master keys and the deletion-ledger material.
      expect(r.names).toEqual(
        expect.arrayContaining([
          'TYPESAFE_API_KEY',
          'OLLAMA_API_KEY',
          'PROVIDER_MASTER_KEYS',
          'DELETION_HMAC_KEY',
          'DELETION_LEDGER_RECIPIENT',
        ]),
      );
    }
  });

  it('gives migrate only the owner role', () => {
    const r = expectOnlyDbCredential(
      'migrate',
      'DATABASE_URL_MIGRATE',
      'bantoozi_owner',
      'BANTOOZI_OWNER_PASSWORD',
    );
    expect(r.names.filter((n) => /KEY|TOKEN|PEPPER|SMTP/.test(n))).toEqual([]);
  });

  it('gives seed only the worker role and worker settings (spec 11 §3: the seed runs with the worker role)', () => {
    const r = expectOnlyDbCredential(
      'seed',
      'DATABASE_URL_WORKER',
      'bantoozi_worker',
      'BANTOOZI_WORKER_PASSWORD',
    );
    expect(r.names).not.toContain('DATABASE_URL_MIGRATE');
    expect(r.names).not.toContain('DATABASE_URL');
  });

  it('gives caddy no database or backup credentials', () => {
    const r = resolve('caddy');
    expect(r.names).toEqual(['ACME_EMAIL', 'HTTPS_PORT', 'PUBLIC_HOST']);
    expect(r.names.filter((n) => DB_URL_NAMES.includes(n))).toEqual([]);
    expect(r.refs.filter((ref) => DB_PASSWORD_REFS.includes(ref))).toEqual([]);
    expect(mentions(r, ROLE_LITERALS)).toEqual([]);
    expect(matching(r, BACKUP_PATTERN)).toEqual([]);
  });

  it('keeps database passwords and backup material out of every other container', () => {
    for (const [name] of Object.entries(compose.services)) {
      if (['postgres', 'api', 'worker', 'worker-laya', 'migrate', 'seed', 'caddy'].includes(name)) {
        continue;
      }
      const r = resolve(name);
      expect(
        r.refs.filter((ref) => DB_PASSWORD_REFS.includes(ref)),
        name,
      ).toEqual([]);
      expect(
        r.names.filter((n) => DB_URL_NAMES.includes(n)),
        name,
      ).toEqual([]);
      expect(matching(r, BACKUP_PATTERN), name).toEqual([]);
    }
    // Only postgres (first start: init.sh creates the roles) receives the superuser password.
    for (const [name] of Object.entries(compose.services)) {
      const r = resolve(name);
      expect(r.refs.includes('POSTGRES_PASSWORD'), name).toBe(name === 'postgres');
    }
  });
});
