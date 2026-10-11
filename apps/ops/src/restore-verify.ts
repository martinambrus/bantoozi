import { randomUUID } from 'node:crypto';

import { createDatabase, readActiveCredentialSecret } from '@bantoozi/db';
import { decryptProviderSecret, ProviderKeyring } from '@bantoozi/shared/server/credential-crypto';
import { FAKE_TYPESAFE_PATH, startFakeTypeSafe } from '@bantoozi/testing';
import type pg from 'pg';

/**
 * Verification of a restored database (spec 11 §4, "Weekly restore test"), run by
 * `restore-test.sh` against the throwaway Postgres. Every check throws a `VerifyError` that names
 * the check and carries no row content; the lines it returns are the machine-readable report.
 * Nothing here makes a network request except to the in-process fake provider on loopback, and no
 * check fetches a publisher: saved text is read from the restored rows only.
 */

export class VerifyError extends Error {
  readonly check: string;

  constructor(check: string, detail: string) {
    super(`check ${check} failed: ${detail}`);
    this.name = 'VerifyError';
    this.check = check;
  }
}

export const EXPECTED_SCHEMAS = ['public', 'pgboss', 'eval', 'drizzle'] as const;
export const EXPECTED_EXTENSIONS = ['citext', 'pg_trgm', 'pgcrypto'] as const;
export const EXPECTED_ROLES = ['bantoozi_owner', 'bantoozi_app', 'bantoozi_worker'] as const;
/** Cold bookmark snapshots checked in one run (the first ones by id). */
export const MAX_SNAPSHOTS_CHECKED = 500;
/** Snapshot checksum lines printed individually. */
const SNAPSHOT_LINES = 5;

const quoteIdent = (name: string): string => `"${name.replace(/"/gu, '""')}"`;

async function scalar<T>(
  db: pg.Pool | pg.PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const result = await db.query(text, values);
  return (result.rows[0] as Record<string, T>)[
    Object.keys(result.rows[0] as object)[0] as string
  ] as T;
}

/** Schemas, extensions and the migration count (`SCHEMA_VERSION`). */
export async function checkSchema(pool: pg.Pool, expectedVersion?: number): Promise<string[]> {
  const schemas = (
    await pool.query<{ nspname: string }>('SELECT nspname FROM pg_namespace')
  ).rows.map((r) => r.nspname);
  const missing = EXPECTED_SCHEMAS.filter((s) => !schemas.includes(s));
  if (missing.length > 0) throw new VerifyError('schemas', `missing ${missing.join(',')}`);
  const extensions = (
    await pool.query<{ extname: string }>('SELECT extname FROM pg_extension')
  ).rows.map((r) => r.extname);
  const noExt = EXPECTED_EXTENSIONS.filter((e) => !extensions.includes(e));
  if (noExt.length > 0) throw new VerifyError('extensions', `missing ${noExt.join(',')}`);
  const version = Number(
    await scalar<string>(pool, 'SELECT count(*) FROM drizzle.__drizzle_migrations'),
  );
  if (version === 0) throw new VerifyError('migrations', 'no migration is recorded');
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new VerifyError(
      'migrations',
      `restored version ${version} differs from the manifest ${expectedVersion}`,
    );
  }
  return [
    `SCHEMA_VERSION=${version}`,
    `CHECK schemas=ok (${EXPECTED_SCHEMAS.join(',')}) extensions=ok (${EXPECTED_EXTENSIONS.join(',')})`,
  ];
}

/** Every foreign key is validated. */
export async function checkForeignKeys(pool: pg.Pool): Promise<string[]> {
  const total = Number(
    await scalar<string>(pool, "SELECT count(*) FROM pg_constraint WHERE contype = 'f'"),
  );
  const bad = Number(
    await scalar<string>(
      pool,
      "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated",
    ),
  );
  if (bad > 0) throw new VerifyError('foreign_keys', `${bad} foreign keys are not validated`);
  return [`CHECK foreign_keys=ok (${total} validated)`];
}

/** Every identity/serial sequence is at or beyond the largest id of its column. */
export async function checkSequences(pool: pg.Pool): Promise<string[]> {
  const owned = await pool.query<{
    schema: string;
    table: string;
    column: string;
    seq_schema: string;
    seq: string;
  }>(`
    SELECT tn.nspname AS schema, t.relname AS table, a.attname AS column, sn.nspname AS seq_schema, s.relname AS seq
      FROM pg_class s
      JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
     WHERE s.relkind = 'S' AND tn.nspname NOT IN ('pg_catalog', 'information_schema')`);
  for (const row of owned.rows) {
    const last = await scalar<string | null>(
      pool,
      `SELECT last_value::text FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
      [row.seq_schema, row.seq],
    );
    const max = await scalar<string | null>(
      pool,
      `SELECT max(${quoteIdent(row.column)})::text FROM ${quoteIdent(row.schema)}.${quoteIdent(row.table)}`,
    );
    if (max !== null && (last === null || BigInt(last) < BigInt(max))) {
      throw new VerifyError(
        'sequences',
        `${row.schema}.${row.table}.${row.column} is ahead of ${row.seq}`,
      );
    }
  }
  return [`CHECK sequences=ok (${owned.rows.length} sequences at or beyond their column maximum)`];
}

/** The active question sets named in settings exist (the seeds were restored with the data). */
export async function checkActiveSets(pool: pg.Pool): Promise<string[]> {
  const setting = await pool.query<{ value: unknown }>(
    "SELECT value FROM settings WHERE key = 'question_sets.active'",
  );
  const active = (setting.rows[0]?.value ?? {}) as Record<string, number | string>;
  const kinds = Object.entries(active);
  for (const [kind, id] of kinds) {
    const found = await pool.query('SELECT 1 FROM question_sets WHERE id = $1 AND kind = $2', [
      String(id),
      kind,
    ]);
    if (found.rowCount === 0)
      throw new VerifyError('active_sets', `the active ${kind} set is missing`);
  }
  const sets = Number(await scalar<string>(pool, 'SELECT count(*) FROM question_sets'));
  if (kinds.length === 0 && sets > 0)
    throw new VerifyError('active_sets', 'question sets exist but none is active');
  return [`CHECK active_sets=ok (${kinds.length} active of ${sets} question sets)`];
}

/**
 * Row counts stay near the numbers the manifest recorded when the backup began. Rows come and go
 * while a dump runs, so the allowance is the larger of 5 rows and 10 %.
 */
export async function checkBounds(
  pool: pg.Pool,
  bounds: Record<string, number>,
): Promise<string[]> {
  for (const [table, recorded] of Object.entries(bounds)) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(table)) throw new VerifyError('bounds', 'invalid table name');
    const count = Number(
      await scalar<string>(pool, `SELECT count(*) FROM public.${quoteIdent(table)}`),
    );
    const allowance = Math.max(5, Math.ceil(recorded * 0.1));
    if (Math.abs(count - recorded) > allowance) {
      throw new VerifyError(
        'bounds',
        `${table} has ${count} rows, the manifest recorded ${recorded}`,
      );
    }
  }
  return [`CHECK bounds=ok (${Object.keys(bounds).length} tables within the recorded range)`];
}

/** The three roles exist; the application role can neither bypass row-level security nor administer. */
export async function checkRoles(pool: pg.Pool): Promise<string[]> {
  const roles = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
    [[...EXPECTED_ROLES]],
  );
  for (const name of EXPECTED_ROLES) {
    const role = roles.rows.find((r) => r.rolname === name);
    if (role === undefined) throw new VerifyError('roles', `${name} was not restored`);
    if (role.rolsuper) throw new VerifyError('roles', `${name} is a superuser`);
  }
  const app = roles.rows.find((r) => r.rolname === 'bantoozi_app');
  if (app?.rolbypassrls === true)
    throw new VerifyError('roles', 'bantoozi_app bypasses row-level security');
  return ['CHECK roles=ok (owner, app, worker restored; app is bound by row-level security)'];
}

/** Two fixture tenants, as `bantoozi_app`, see only their own rows; no tenant context sees none. */
export async function checkRowLevelSecurity(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = randomUUID();
    const b = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'fixture a'), ($3, $4, 'fixture b')`,
      [a, `fixture-a-${a}@restore-fixture.invalid`, b, `fixture-b-${b}@restore-fixture.invalid`],
    );
    const feed = await client.query<{ id: string }>(
      `INSERT INTO feeds (url, fetch_url, title, status)
       VALUES ($1, $1, 'restore fixture', 'active') RETURNING id::text AS id`,
      [`https://restore-fixture.invalid/${a}/feed.xml`],
    );
    const feedId = feed.rows[0]?.id as string;
    await client.query('INSERT INTO subscriptions (user_id, feed_id) VALUES ($1, $3), ($2, $3)', [
      a,
      b,
      feedId,
    ]);
    await client.query('SET LOCAL ROLE bantoozi_app');
    for (const [tenant, other] of [
      [a, b],
      [b, a],
    ] as const) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [tenant]);
      const seen = await client.query<{ user_id: string }>(
        'SELECT user_id::text AS user_id FROM subscriptions WHERE feed_id = $1',
        [feedId],
      );
      if (
        seen.rowCount !== 1 ||
        seen.rows[0]?.user_id !== tenant ||
        seen.rows[0]?.user_id === other
      ) {
        throw new VerifyError('rls', 'a fixture tenant does not see exactly its own rows');
      }
    }
    await client.query("SELECT set_config('app.user_id', '', true)");
    const none = await client.query('SELECT 1 FROM subscriptions WHERE feed_id = $1', [feedId]);
    if (none.rowCount !== 0) throw new VerifyError('rls', 'rows are visible without a tenant');
    return ['CHECK rls=ok (two fixture tenants see only their own rows as bantoozi_app)'];
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Cold bookmarked snapshots, read the way the application reads them (as `bantoozi_app`, bound to
 * the bookmark's owner, so row-level security applies): the stored checksum equals the checksum
 * recomputed from the decompressed text and HTML, and another tenant cannot read the row. No
 * fetch happens; the restored database is the only source.
 */
export async function checkColdBookmarks(pool: pg.Pool): Promise<string[]> {
  const candidates = await pool.query<{ user_id: string; snapshot_id: string }>(
    `SELECT ua.user_id::text AS user_id, s.id::text AS snapshot_id
       FROM user_article ua JOIN article_snapshots s ON s.id = ua.bookmark_snapshot_id
      WHERE ua.bookmarked_at IS NOT NULL AND s.cold_at IS NOT NULL
      ORDER BY s.id, ua.user_id LIMIT $1`,
    [MAX_SNAPSHOTS_CHECKED],
  );
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.rows) {
    if (seen.has(candidate.snapshot_id)) continue;
    seen.add(candidate.snapshot_id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE bantoozi_app');
      await client.query("SELECT set_config('app.user_id', $1, true)", [candidate.user_id]);
      // Reading the full text and HTML as the owner decompresses them exactly as an authorized read
      // or export does; the lengths are compared with the recomputation below.
      const read = await client.query<{
        content_sha256: string;
        text_chars: string;
        html_chars: string;
      }>(
        `SELECT content_sha256, char_length(body_text)::text AS text_chars, char_length(body_html)::text AS html_chars
           FROM article_snapshots WHERE id = $1`,
        [candidate.snapshot_id],
      );
      const row = read.rows[0];
      if (row === undefined)
        throw new VerifyError('cold_bookmark', 'the owner cannot read the snapshot');
      await client.query("SELECT set_config('app.user_id', $1, true)", [randomUUID()]);
      const other = await client.query('SELECT 1 FROM article_snapshots WHERE id = $1', [
        candidate.snapshot_id,
      ]);
      if (other.rowCount !== 0)
        throw new VerifyError('cold_bookmark', 'another tenant can read the snapshot');
      await client.query('RESET ROLE');
      // Recomputed inside the database: no value passes through a client type that could round it.
      const recomputed = await client.query<{
        matches: boolean;
        text_chars: string;
        html_chars: string;
      }>(
        `SELECT snapshot_content_sha256(title, author, published_at, source_url, body_text, body_html) = content_sha256 AS matches,
                char_length(body_text)::text AS text_chars, char_length(body_html)::text AS html_chars
           FROM article_snapshots WHERE id = $1`,
        [candidate.snapshot_id],
      );
      const check = recomputed.rows[0];
      if (
        check?.matches !== true ||
        check.text_chars !== row.text_chars ||
        check.html_chars !== row.html_chars
      ) {
        throw new VerifyError(
          'cold_bookmark',
          `snapshot ${candidate.snapshot_id} no longer matches its checksum`,
        );
      }
      if (lines.length < SNAPSHOT_LINES) {
        lines.push(
          `cold bookmark snapshot verified match content_sha256=${row.content_sha256} refetch=0`,
        );
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  if (seen.size > lines.length)
    lines.push(`cold bookmark snapshots verified match count=${seen.size} refetch=0`);
  if (seen.size === 0)
    lines.push('cold bookmark snapshots checked=0 (none in this backup) refetch=0');
  return lines;
}

export interface KeyringInput {
  keyId: string | undefined;
  keysJson: string | undefined;
}

/**
 * The stored provider keys decrypt with the separately recovered master keys, and the TypeSafe key
 * is accepted by the in-process fake provider (production inference is never contacted).
 */
export async function checkProviderCredentials(
  pool: pg.Pool,
  keys: KeyringInput,
): Promise<string[]> {
  const rows = await pool.query<{ provider: 'typesafe' | 'ollama' }>(
    `SELECT provider FROM provider_credentials WHERE active_envelope IS NOT NULL ORDER BY provider`,
  );
  if (rows.rowCount === 0) return ['PROVIDER_CREDENTIAL none stored'];
  const parsed = ProviderKeyring.parse(keys.keyId, keys.keysJson);
  if (!parsed.ok)
    throw new VerifyError('provider_credential', `master keys unavailable (${parsed.reason})`);
  const lines: string[] = [];
  for (const { provider } of rows.rows) {
    const stored = await readActiveCredentialSecret(createDatabase(pool), provider);
    if (stored.state !== 'present' || stored.activeVersion === null) {
      throw new VerifyError('provider_credential', `${provider} has no active version`);
    }
    let secret: string;
    try {
      secret = decryptProviderSecret({
        keyring: parsed.keyring,
        provider,
        secretVersion: stored.activeVersion,
        envelope: stored.envelope,
      });
    } catch {
      throw new VerifyError(
        'provider_credential',
        `${provider} does not decrypt with the supplied master keys`,
      );
    }
    let fake = 'n/a';
    if (provider === 'typesafe') {
      fake = (await fakeProviderAccepts(secret)) ? 'ok' : 'rejected';
      if (fake !== 'ok')
        throw new VerifyError('provider_credential', 'the fake provider did not accept the key');
    }
    lines.push(
      `PROVIDER_CREDENTIAL ${provider} version=${stored.activeVersion} decrypt=ok fake_provider=${fake}`,
    );
  }
  return lines;
}

/** A request with the key succeeds and one with another key is refused by the fake. */
async function fakeProviderAccepts(secret: string): Promise<boolean> {
  const fake = await startFakeTypeSafe({ apiKey: secret });
  try {
    const body = JSON.stringify({
      model: 'jev-fake',
      state: { article: { title: 'restore check', excerpt: 'restore check' } },
      questions: { q: { type: 'noul', instructions: { interest: 'restore check' } } },
    });
    const call = (token: string) =>
      fetch(`${fake.url}${FAKE_TYPESAFE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      });
    const good = await call(secret);
    await good.arrayBuffer();
    const bad = await call(`${secret}x`);
    await bad.arrayBuffer();
    return good.status === 200 && bad.status === 401;
  } finally {
    await fake.close();
  }
}

export interface VerifyOptions {
  expectedSchemaVersion?: number;
  bounds?: Record<string, number>;
  keys: KeyringInput;
}

/** All checks, in report order. Throws the first failure. */
export async function verifyRestore(pool: pg.Pool, options: VerifyOptions): Promise<string[]> {
  return [
    ...(await checkSchema(pool, options.expectedSchemaVersion)),
    ...(await checkForeignKeys(pool)),
    ...(await checkSequences(pool)),
    ...(await checkActiveSets(pool)),
    ...(await checkBounds(pool, options.bounds ?? {})),
    ...(await checkRoles(pool)),
    ...(await checkRowLevelSecurity(pool)),
    ...(await checkColdBookmarks(pool)),
    ...(await checkProviderCredentials(pool, options.keys)),
  ];
}
