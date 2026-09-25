import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { buildJobIntent, EngineCircuitSchema, QUEUES } from '@bantoozi/shared';
import {
  decryptProviderSecret,
  encryptProviderSecret,
  ProviderKeyring,
  type CredentialEnvelope,
  type CredentialProvider,
} from '@bantoozi/shared/server/credential-crypto';
import { createCard, createUser, type CardFixture } from '@bantoozi/testing';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asTenant, setupDbTest, sqlStateOf, type DbTestContext } from './support/test-db.js';

/**
 * Provider-credential, publication-consent and library-version SECURITY DEFINER functions
 * (drizzle 0003; spec 02 §2.1, §3.6, §6, §8 items 10–11; spec 04 §1.2; spec 05 §8), called as the
 * real API login `bantoozi_app`. Fixtures and assertions use `bantoozi_owner`; the worker's own
 * steps (validation leases, erasure of evidence) run as `bantoozi_worker`.
 */

let ctx: DbTestContext;
/** An active administrator and an ordinary member. */
let admin: string;
let member: string;

beforeAll(async () => {
  ctx = await setupDbTest();
  admin = (await createUser(ctx.owner, { role: 'admin' })).id;
  member = (await createUser(ctx.owner)).id;
});

afterAll(async () => {
  await ctx.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

type Id = number | string;
type Row = Record<string, unknown>;

function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error('expected exactly one row');
  return row;
}

/** One statement as `bantoozi_app` in a tenant transaction (`null`: no `app.user_id`). */
const asApp = <R extends QueryResultRow = Row>(
  userId: string | null,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<R>> =>
  asTenant(ctx.appPool, userId, (client) => client.query<R>(text, values));

/** The single row a statement returns as `bantoozi_app`. */
const appRow = async <R extends QueryResultRow = Row>(
  userId: string | null,
  text: string,
  values: unknown[] = [],
): Promise<R> => only((await asApp<R>(userId, text, values)).rows);

/** Fixture/assertion queries as `bantoozi_owner`. */
const ownerRows = async <R extends QueryResultRow = Row>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> => (await ctx.owner.query<R>(text, values)).rows;
const ownerRow = async <R extends QueryResultRow = Row>(
  text: string,
  values: unknown[] = [],
): Promise<R> => only(await ownerRows<R>(text, values));

/** Never rejects: 'ok', or the SQLSTATE the statement failed with. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `unexpected: ${String(error)}`;
  }
}

async function errorOf(promise: Promise<unknown>): Promise<{ code?: unknown; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: unknown; message: string };
  }
  throw new Error('expected a database error');
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

/** `column` formatted the way evidence records timestamps (ISO-8601 UTC, microseconds). */
const iso = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const cardRow = (id: string) =>
  ownerRow(
    `SELECT visibility, slug, title, text_hash, i18n, creator_user_id, publication_veto_at
       FROM interest_cards WHERE id = $1`,
    [id],
  );

/** Wait until backend `pid` is blocked on a lock held by another session. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await ctx.adminPool.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
      [pid],
    );
    if (rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${pid} never waited for a lock`);
}

interface Statement {
  userId: string;
  text: string;
  values: unknown[];
}

/**
 * Two app connections: `holder` runs in an open transaction, `waiter` must then block on the
 * holder's lock, and the holder commits. Returns how the waiter settled ('ok' or its SQLSTATE).
 */
async function afterConcurrentCommit(holder: Statement, waiter: Statement): Promise<string> {
  const first = await ctx.appPool.connect();
  const second = await ctx.appPool.connect();
  let clean = false;
  try {
    await first.query('BEGIN');
    await first.query("SELECT set_config('app.user_id', $1, true)", [holder.userId]);
    await first.query(holder.text, holder.values);
    const { pid } = only(
      (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows,
    );
    await second.query('BEGIN');
    await second.query("SELECT set_config('app.user_id', $1, true)", [waiter.userId]);
    const settled = outcome(second.query(waiter.text, waiter.values));
    await waitUntilBlocked(pid);
    await first.query('COMMIT');
    const result = await settled;
    await second.query(result === 'ok' ? 'COMMIT' : 'ROLLBACK');
    clean = true;
    return result;
  } finally {
    // A failed run discards both connections, and with them any open transaction.
    first.release(!clean);
    second.release(!clean);
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────────────────────────

describe('admin function definitions (spec 02 §6)', () => {
  const CREDENTIAL_FUNCTIONS = [
    'admin_provider_credentials_metadata()',
    'admin_stage_provider_credential(text,bigint,jsonb)',
    'admin_validate_provider_credential(text,bigint,bigint)',
    'admin_activate_provider_credential(text,bigint,bigint)',
    'admin_set_provider_enabled(text,bigint,boolean)',
  ];
  const PUBLICATION_FUNCTIONS = [
    'admin_request_card_publication(bigint,jsonb,timestamp with time zone)',
    'admin_list_card_publication_requests(text)',
    'respond_card_publication(bigint,bigint,boolean)',
    'admin_promote_card(bigint,bigint)',
    'admin_publish_library_card_version(text,bigint,integer)',
  ];

  it('are SECURITY DEFINER owner functions with a pinned search path, executable by the API role', async () => {
    const all = [...CREDENTIAL_FUNCTIONS, ...PUBLICATION_FUNCTIONS];
    const rows = await ownerRows<{ signature: string; worker: boolean }>(
      `SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS secdef, p.proconfig AS config,
              pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('bantoozi_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('bantoozi_worker', p.oid, 'EXECUTE') AS worker,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                                            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
                AS public_execute
         FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`,
      [all],
    );
    expect(rows.map((r) => r.signature).sort()).toEqual([...all].sort());
    for (const row of rows) {
      expect(row, row.signature).toMatchObject({
        secdef: true,
        config: ['search_path=pg_catalog, public, pg_temp'],
        owner: 'bantoozi_owner',
        app: true,
        public_execute: false,
      });
      // The credential functions are granted to bantoozi_app only.
      if (CREDENTIAL_FUNCTIONS.includes(row.signature))
        expect(row.worker, row.signature).toBe(false);
    }
  });
});

// ── Provider credentials ─────────────────────────────────────────────────────────────────────────

describe('provider credential admin functions (spec 02 §2.1, §6; spec 04 §1.2)', () => {
  const SECRET = 'itest-provider-api-key-7c21f0';
  const KEY_ID = 'itest-master-1';

  const newKeyring = (): ProviderKeyring => {
    const keys = JSON.stringify({ [KEY_ID]: randomBytes(32).toString('base64') });
    const parsed = ProviderKeyring.parse(KEY_ID, keys);
    if (!parsed.ok) throw new Error(`keyring: ${parsed.reason}`);
    return parsed.keyring;
  };
  const ring = newKeyring();

  /** The admin service encrypts locally for the exact next revision (the AAD binds it). */
  const sealFor = (provider: CredentialProvider, version: number): CredentialEnvelope =>
    encryptProviderSecret({ keyring: ring, provider, secretVersion: `${version}`, secret: SECRET });

  /** `value` holds neither the plaintext key nor any binary field of the envelopes. */
  const expectNoSecret = (value: unknown, ...envelopes: CredentialEnvelope[]): void => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const material = envelopes.flatMap((e) => [
      ...[e.ciphertext, e.nonce, e.tag],
      ...[e.wrapped_key.ciphertext, e.wrapped_key.nonce, e.wrapped_key.tag],
    ]);
    for (const secret of [SECRET, ...material]) expect(text).not.toContain(secret);
  };

  const stage = (userId: string | null, provider: string | null, expected: Id, envelope: unknown) =>
    appRow(userId, 'SELECT * FROM admin_stage_provider_credential($1, $2, $3::jsonb)', [
      provider,
      expected,
      json(envelope),
    ]);
  const requestValidation = (userId: string, provider: string, candidate: Id, expected: Id) =>
    appRow(userId, 'SELECT admin_validate_provider_credential($1, $2, $3)', [
      provider,
      candidate,
      expected,
    ]);
  const activate = (userId: string, provider: string, expected: Id, candidate: Id) =>
    appRow(userId, 'SELECT * FROM admin_activate_provider_credential($1, $2, $3)', [
      provider,
      expected,
      candidate,
    ]);
  const setEnabled = (userId: string, provider: string, expected: Id, enabled: boolean | null) =>
    appRow(userId, 'SELECT * FROM admin_set_provider_enabled($1, $2, $3)', [
      provider,
      expected,
      enabled,
    ]);

  const credential = async (provider: CredentialProvider): Promise<Row | undefined> =>
    (await ownerRows('SELECT * FROM provider_credentials WHERE provider = $1', [provider]))[0];
  const outboxCount = async (queue: string | null = null): Promise<number> =>
    (
      await ownerRow<{ n: number }>(
        'SELECT count(*)::int AS n FROM job_outbox WHERE $1::text IS NULL OR queue = $1',
        [queue],
      )
    ).n;
  const circuit = () =>
    ownerRow("SELECT value, updated_by FROM settings WHERE key = 'engine.circuit'");
  const seedCircuit = (value: object) =>
    ctx.owner.query("INSERT INTO settings (key, value) VALUES ('engine.circuit', $1)", [
      JSON.stringify(value),
    ]);

  /** The worker's validation lease (CAS on the exact candidate): its token, or null. */
  async function claimValidation(provider: CredentialProvider, candidate: Id) {
    const token = randomUUID();
    const { rowCount } = await ctx.workerPool.query(
      `UPDATE provider_credentials
          SET candidate_status = 'validating', validation_token = $3,
              validation_until = now() + interval '5 minutes'
        WHERE provider = $1 AND candidate_version = $2
          AND candidate_status IN ('pending', 'valid', 'invalid')`,
      [provider, candidate, token],
    );
    return rowCount === 1 ? token : null;
  }

  /** The worker's valid result, validated `age` ago, under its lease (CAS on version + token). */
  async function completeValidation(
    provider: CredentialProvider,
    candidate: Id,
    token: string,
    age = '0 seconds',
  ): Promise<number> {
    const { rowCount } = await ctx.workerPool.query(
      `UPDATE provider_credentials
          SET candidate_status = 'valid', validated_at = now() - $4::interval,
              candidate_validation = '{"model": "itest-model", "attempts": 1}',
              validation_token = NULL, validation_until = NULL
        WHERE provider = $1 AND candidate_version = $2 AND validation_token = $3`,
      [provider, candidate, token, age],
    );
    return rowCount ?? 0;
  }

  async function validateAsWorker(provider: CredentialProvider, candidate: Id, age?: string) {
    const token = await claimValidation(provider, candidate);
    if (token === null) throw new Error('the worker could not lease the candidate');
    expect(await completeValidation(provider, candidate, token, age)).toBe(1);
  }

  /** Stage, validate and activate a fresh envelope, starting from `revision`. */
  async function activateFresh(provider: CredentialProvider, revision: number) {
    const version = revision + 1;
    const envelope = sealFor(provider, version);
    expect(await stage(admin, provider, revision, envelope)).toEqual({
      revision: `${version}`,
      candidate_version: `${version}`,
    });
    await validateAsWorker(provider, version);
    expect(await activate(admin, provider, version, version)).toEqual({
      revision: `${version + 1}`,
      active_version: `${version}`,
    });
    return { envelope, revision: version + 1 };
  }

  beforeEach(async () => {
    await ctx.owner.query('DELETE FROM provider_credentials');
    await ctx.owner.query("DELETE FROM job_outbox WHERE queue = 'provider.validate'");
    await ctx.owner.query("DELETE FROM settings WHERE key = 'engine.circuit'");
  });

  it('gives the API role no direct access to credential rows, outbox rows or internal helpers', async () => {
    await activateFresh('typesafe', 0);
    for (const statement of [
      'SELECT provider FROM provider_credentials',
      'SELECT active_envelope FROM provider_credentials',
      "UPDATE provider_credentials SET enabled = false WHERE provider = 'typesafe'",
      "INSERT INTO provider_credentials (provider) VALUES ('ollama')",
      'DELETE FROM provider_credentials',
      'SELECT payload FROM job_outbox',
      'SELECT require_admin_session()',
      'SELECT admin_context_allowed()',
      "SELECT valid_credential_envelope('{}')",
      "SELECT check_credential_provider('typesafe')",
    ]) {
      expect(await outcome(asApp(admin, statement)), statement).toBe('42501');
    }
  });

  it('rejects every credential function without an active administrator session (42501)', async () => {
    const deletedAdmin = (await createUser(ctx.owner, { role: 'admin', deletedAt: new Date() })).id;
    const calls: [string, unknown[]][] = [
      ['SELECT * FROM admin_provider_credentials_metadata()', []],
      [
        'SELECT * FROM admin_stage_provider_credential($1, $2, $3::jsonb)',
        ['typesafe', 0, json(sealFor('typesafe', 1))],
      ],
      ['SELECT admin_validate_provider_credential($1, $2, $3)', ['typesafe', 1, 1]],
      ['SELECT * FROM admin_activate_provider_credential($1, $2, $3)', ['typesafe', 1, 1]],
      ['SELECT * FROM admin_set_provider_enabled($1, $2, $3)', ['typesafe', 0, false]],
    ];
    for (const [text, values] of calls) {
      for (const tenant of [member, deletedAdmin, randomUUID(), null]) {
        expect(await outcome(asApp(tenant, text, values)), `${text} as ${tenant}`).toBe('42501');
      }
      expect(await outcome(ctx.workerPool.query(text, values)), `${text} as worker`).toBe('42501');
    }
    expect(await credential('typesafe')).toBeUndefined();
  });

  it('stages an envelope as the exact next revision, queues nothing and keeps the active key', async () => {
    const outboxBefore = await outboxCount();
    const first = sealFor('typesafe', 1);
    expect(await stage(admin, 'typesafe', 0, first)).toEqual({
      revision: '1',
      candidate_version: '1',
    });
    expect(await credential('typesafe')).toMatchObject({
      revision: '1',
      enabled: false,
      active_version: null,
      active_envelope: null,
      candidate_version: '1',
      candidate_envelope: first,
      candidate_status: 'pending',
      candidate_validation: {},
      validation_token: null,
      validated_at: null,
      updated_by: admin,
    });
    expect(await outboxCount()).toBe(outboxBefore);

    // A stale (or future) expected revision changes nothing.
    expect(await sqlStateOf(stage(admin, 'typesafe', 0, sealFor('typesafe', 1)))).toBe('BZ409');
    expect(await sqlStateOf(stage(admin, 'typesafe', 2, sealFor('typesafe', 3)))).toBe('BZ409');
    expect(await credential('typesafe')).toMatchObject({
      revision: '1',
      candidate_envelope: first,
    });

    // Staging over an active key keeps it usable (rotation).
    await validateAsWorker('typesafe', 1);
    await activate(admin, 'typesafe', 1, 1);
    const next = sealFor('typesafe', 3);
    expect(await stage(admin, 'typesafe', 2, next)).toEqual({
      revision: '3',
      candidate_version: '3',
    });
    expect(await credential('typesafe')).toMatchObject({
      enabled: true,
      active_version: '1',
      active_envelope: first,
      candidate_version: '3',
      candidate_envelope: next,
      candidate_status: 'pending',
    });
    expect(await outboxCount()).toBe(outboxBefore);
  });

  it('rejects malformed envelopes and unknown providers (22023) without echoing the envelope', async () => {
    const good = sealFor('typesafe', 1);
    const { wrapped_key: wrapped, ...withoutWrappedKey } = good;
    const b64 = (bytes: number): string => randomBytes(bytes).toString('base64');
    const malformed: [string, unknown][] = [
      ['an extra top-level key', { ...good, provider: 'typesafe' }],
      ['a missing wrapped_key', withoutWrappedKey],
      ['an extra wrapped_key field', { ...good, wrapped_key: { ...wrapped, key_id: KEY_ID } }],
      ['a wrapped_key without tag', { ...good, wrapped_key: { ...wrapped, tag: undefined } }],
      ['format 2', { ...good, format: 2 }],
      ['format "1" as a string', { ...good, format: '1' }],
      ['an 11-byte nonce', { ...good, nonce: b64(11) }],
      ['a 15-byte tag', { ...good, tag: b64(15) }],
      ['an empty ciphertext', { ...good, ciphertext: '' }],
      ['a ciphertext over 4 KiB', { ...good, ciphertext: b64(4097) }],
      ['a 31-byte wrapped data key', { ...good, wrapped_key: { ...wrapped, ciphertext: b64(31) } }],
      ['a 13-byte wrapping nonce', { ...good, wrapped_key: { ...wrapped, nonce: b64(13) } }],
      ['a non-base64 nonce', { ...good, nonce: '!!not*base64!!' }],
      ['an invalid key id', { ...good, key_id: '../master' }],
      ['an array', [good]],
      ['a string', good.ciphertext],
      ['SQL NULL', null],
    ];
    for (const [label, envelope] of malformed) {
      const error = await errorOf(stage(admin, 'typesafe', 0, envelope));
      expect(error.code, label).toBe('22023');
      expectNoSecret(`${error.message} ${JSON.stringify(error)}`, good);
    }
    for (const provider of ['openai', 'TYPESAFE', '', null]) {
      expect(await outcome(stage(admin, provider, 0, good)), `provider ${provider}`).toBe('22023');
    }
    expect(await ownerRows('SELECT 1 FROM provider_credentials')).toEqual([]);
  });

  it('returns metadata only: no envelope column and no envelope material', async () => {
    const { envelope: active, revision } = await activateFresh('typesafe', 0);
    const candidate = sealFor('typesafe', revision + 1);
    await stage(admin, 'typesafe', revision, candidate);

    const result = await asApp(admin, 'SELECT * FROM admin_provider_credentials_metadata()');
    const columns = result.fields.map((f) => f.name);
    expect(columns).toEqual([
      ...['provider', 'revision', 'enabled', 'active_version', 'candidate_version'],
      ...['candidate_status', 'candidate_validation', 'updated_at', 'activated_at'],
      ...['validated_at', 'last_error_code'],
    ]);
    expect(
      columns.filter((c) => /envelope|cipher|nonce|tag|wrap|key|token|secret/.test(c)),
    ).toEqual([]);
    expect(only(result.rows)).toMatchObject({
      provider: 'typesafe',
      revision: '3',
      enabled: true,
      active_version: '1',
      candidate_version: '3',
      candidate_status: 'pending',
      candidate_validation: {},
      last_error_code: null,
    });
    expectNoSecret(result.rows, active, candidate);
  });

  it('queues exactly one secret-free provider.validate intent per explicit request', async () => {
    const envelope = sealFor('typesafe', 1);
    await stage(admin, 'typesafe', 0, envelope);
    expect(await outboxCount('provider.validate')).toBe(0);

    await requestValidation(admin, 'typesafe', 1, 1);
    await requestValidation(admin, 'typesafe', 1, 1); // a repeated click coalesces while pending
    const intent = await ownerRow(
      `SELECT payload, dedupe_key, user_id, delivered_at FROM job_outbox
        WHERE queue = 'provider.validate'`,
    );
    const expected = buildJobIntent('provider.validate', {
      provider: 'typesafe',
      candidateVersion: '1',
    });
    expect(intent).toEqual({
      payload: { provider: 'typesafe', candidateVersion: '1' },
      dedupe_key: expected.dedupeKey,
      user_id: admin,
      delivered_at: null,
    });
    expect(QUEUES['provider.validate'].payload.safeParse(intent['payload']).success).toBe(true);
    expectNoSecret(intent, envelope);
    expect(await credential('typesafe')).toMatchObject({
      revision: '1',
      candidate_status: 'pending',
    });

    expect(await sqlStateOf(requestValidation(admin, 'typesafe', 1, 0))).toBe('BZ409'); // stale
    expect(await sqlStateOf(requestValidation(admin, 'typesafe', 2, 1))).toBe('BZ409'); // wrong candidate
    expect(await claimValidation('typesafe', 1)).not.toBeNull();
    expect(await sqlStateOf(requestValidation(admin, 'typesafe', 1, 1))).toBe('BZ409'); // validating
    expect(await sqlStateOf(requestValidation(admin, 'ollama', 1, 0))).toBe('BZ404'); // no row
    expect(await sqlStateOf(requestValidation(admin, 'openai', 1, 0))).toBe('22023');
    expect(await outboxCount('provider.validate')).toBe(1);
  });

  it('never lets a late validation of a replaced candidate mark or activate the newer one', async () => {
    await stage(admin, 'typesafe', 0, sealFor('typesafe', 1));
    const staleLease = await claimValidation('typesafe', 1);
    if (staleLease === null) throw new Error('lease not granted');
    await stage(admin, 'typesafe', 1, sealFor('typesafe', 2)); // replaces candidate 1 and its lease

    expect(await completeValidation('typesafe', 1, staleLease)).toBe(0);
    expect(await credential('typesafe')).toMatchObject({
      revision: '2',
      candidate_version: '2',
      candidate_status: 'pending',
      validation_token: null,
      validated_at: null,
    });
    expect(await sqlStateOf(activate(admin, 'typesafe', 1, 1))).toBe('BZ409');
    expect(await sqlStateOf(activate(admin, 'typesafe', 2, 2))).toBe('BZ409');
  });

  it('activates only the exact candidate validated within 24 h and resets its auth breaker', async () => {
    expect(await sqlStateOf(activate(admin, 'typesafe', 0, 1))).toBe('BZ404'); // nothing staged
    const envelope = sealFor('typesafe', 1);
    await stage(admin, 'typesafe', 0, envelope);
    expect(await sqlStateOf(activate(admin, 'typesafe', 1, 1))).toBe('BZ409'); // still pending

    await validateAsWorker('typesafe', 1, '24 hours 1 minute');
    expect(await sqlStateOf(activate(admin, 'typesafe', 1, 1))).toBe('BZ409'); // validation too old
    await validateAsWorker('typesafe', 1, '23 hours 59 minutes');
    expect(await sqlStateOf(activate(admin, 'typesafe', 0, 1))).toBe('BZ409'); // stale revision
    expect(await sqlStateOf(activate(admin, 'typesafe', 1, 2))).toBe('BZ409'); // wrong candidate

    const breakers = {
      typesafe: { state: 'auth', openedAt: '2026-09-20T10:00:00.000Z', reopenCount: 2 },
      llm: { state: 'auth', openedAt: '2026-09-20T11:00:00.000Z', reopenCount: 1 },
      resetRequested: {},
    };
    await seedCircuit(breakers);

    expect(await activate(admin, 'typesafe', 1, 1)).toEqual({ revision: '2', active_version: '1' });
    const row = await credential('typesafe');
    expect(row).toMatchObject({
      revision: '2',
      enabled: true,
      active_version: '1',
      active_envelope: envelope,
      candidate_version: null,
      candidate_envelope: null,
      candidate_status: null,
      candidate_validation: {},
      validation_token: null,
      validation_until: null,
      updated_by: admin,
    });
    expect(row?.['activated_at']).toBeInstanceOf(Date);

    // Only this provider's auth breaker is invalidated, to a schema-valid closed breaker.
    const settings = await circuit();
    expect(settings).toEqual({
      value: { ...breakers, typesafe: { state: 'closed', reopenCount: 0 } },
      updated_by: admin,
    });
    expect(EngineCircuitSchema.safeParse(settings['value']).success).toBe(true);

    // The stored envelope decrypts at its version with the external keyring only.
    const stored = {
      provider: 'typesafe' as const,
      secretVersion: '1',
      envelope: row?.['active_envelope'],
    };
    expect(decryptProviderSecret({ keyring: ring, ...stored })).toBe(SECRET);
    expect(() => decryptProviderSecret({ keyring: newKeyring(), ...stored })).toThrow();

    // The candidate was consumed: activation cannot be replayed.
    expect(await sqlStateOf(activate(admin, 'typesafe', 2, 1))).toBe('BZ409');
  });

  it('maps ollama to the llm breaker and leaves a non-auth breaker alone', async () => {
    const breakers = {
      typesafe: {
        state: 'open',
        openedAt: '2026-09-25T08:00:00.000Z',
        openUntil: '2026-09-25T08:05:00.000Z',
        reopenCount: 1,
      },
      llm: { state: 'auth', openedAt: '2026-09-25T07:00:00.000Z', reopenCount: 3 },
      resetRequested: {},
    };
    await seedCircuit(breakers);
    await activateFresh('ollama', 0);
    expect((await circuit())['value']).toEqual({
      ...breakers,
      llm: { state: 'closed', reopenCount: 0 },
    });
  });

  it('never enables without an active key; disable leaves a tombstone that no stale call revives', async () => {
    // Without a row, enabling conflicts and persists nothing, while disabling writes a tombstone
    // that blocks the environment fallback.
    expect(await sqlStateOf(setEnabled(admin, 'ollama', 0, true))).toBe('BZ409');
    expect(await credential('ollama')).toBeUndefined();
    expect(await sqlStateOf(setEnabled(admin, 'ollama', 0, null))).toBe('22023');
    expect(await setEnabled(admin, 'ollama', 0, false)).toEqual({ revision: '1', enabled: false });
    expect(await credential('ollama')).toMatchObject({
      revision: '1',
      enabled: false,
      active_version: null,
    });

    // An active key (enabling it is a CAS write too), then a candidate under a validation lease.
    const { revision } = await activateFresh('typesafe', 0);
    expect(await setEnabled(admin, 'typesafe', revision, true)).toEqual({
      revision: '3',
      enabled: true,
    });
    await stage(admin, 'typesafe', 3, sealFor('typesafe', 4));
    const lease = await claimValidation('typesafe', 4);
    if (lease === null) throw new Error('lease not granted');

    expect(await sqlStateOf(setEnabled(admin, 'typesafe', 3, false))).toBe('BZ409'); // stale
    expect(await setEnabled(admin, 'typesafe', 4, false)).toEqual({
      revision: '5',
      enabled: false,
    });
    expect(await credential('typesafe')).toMatchObject({
      revision: '5',
      enabled: false,
      active_version: null,
      active_envelope: null,
      candidate_version: null,
      candidate_envelope: null,
      candidate_status: null,
      candidate_validation: {},
      validation_token: null,
      validation_until: null,
    });

    // Nothing revives the revoked candidate: the late lease, a stale or current activation, enable.
    expect(await completeValidation('typesafe', 4, lease)).toBe(0);
    expect(await sqlStateOf(activate(admin, 'typesafe', 4, 4))).toBe('BZ409');
    expect(await sqlStateOf(activate(admin, 'typesafe', 5, 4))).toBe('BZ409');
    expect(await sqlStateOf(setEnabled(admin, 'typesafe', 5, true))).toBe('BZ409');
    expect(await credential('typesafe')).toMatchObject({ revision: '5', enabled: false });

    // Only a newly staged, validated and activated key enables the provider again.
    await activateFresh('typesafe', 5);
    expect(await credential('typesafe')).toMatchObject({
      revision: '7',
      enabled: true,
      active_version: '6',
    });
  });
});

// ── Publication consent ──────────────────────────────────────────────────────────────────────────

describe('publication consent (spec 02 §3.6, §6; spec 05 §8.1)', () => {
  /** A proposal and PostgreSQL's normalized jsonb text of it (keys by length, then bytes). */
  const PAYLOAD = {
    title: 'Rust programming',
    topic_ids: [],
    i18n: { sk: { title: 'Programovanie v Ruste' } },
  };
  const PAYLOAD_TEXT =
    '{"i18n": {"sk": {"title": "Programovanie v Ruste"}}, "title": "Rust programming", "topic_ids": []}';
  const PAYLOAD_SHA = sha256(PAYLOAD_TEXT);

  const requestPublication = (
    userId: string | null,
    cardId: string,
    payload: unknown,
    expiresAt: Date | null = null,
  ) =>
    appRow<{ request_id: string; version: string }>(
      userId,
      'SELECT * FROM admin_request_card_publication($1, $2::jsonb, $3)',
      [cardId, json(payload), expiresAt],
    );
  const respond = (userId: string | null, requestId: string, expected: Id, approve: boolean) =>
    appRow(userId, 'SELECT * FROM respond_card_publication($1, $2, $3)', [
      requestId,
      expected,
      approve,
    ]);
  const promote = (userId: string | null, requestId: string, expected: Id) =>
    appRow(userId, 'SELECT * FROM admin_promote_card($1, $2)', [requestId, expected]);
  const listRequests = async (userId: string | null, status: string | null = null) =>
    (
      await asApp<{ id: string; creator_known: boolean }>(
        userId,
        'SELECT * FROM admin_list_card_publication_requests($1)',
        [status],
      )
    ).rows;

  interface RequestRow extends Row {
    responded_iso: string | null;
    promoted_iso: string | null;
    authorization_evidence: Row | null;
  }
  const requestRow = (id: string) =>
    ownerRow<RequestRow>(
      `SELECT user_id, card_id, requested_by, status, version, card_text_hash, publication_payload,
              publication_payload::text AS payload_text, publication_sha,
              ${iso('responded_at')} AS responded_iso, ${iso('promoted_at')} AS promoted_iso,
              promoted_by, authorization_kind, authorization_evidence
         FROM card_publication_requests WHERE id = $1`,
      [id],
    );
  const activityOf = (userId: string) =>
    ownerRow(
      `SELECT ${iso('last_active_at')} AS last_active, ${iso('created_at')} AS created
         FROM users WHERE id = $1`,
      [userId],
    );
  /** checkedAt − anchorAt of inactivity evidence: at least 720 h, under a minute of drift. */
  const inactivitySpan = (requestId: string) =>
    ownerRow(
      `SELECT span >= interval '720 hours' AS full, span < interval '720 hours 1 minute' AS bounded
         FROM (SELECT (authorization_evidence->>'checkedAt')::timestamptz
                      - (authorization_evidence->>'anchorAt')::timestamptz AS span
                 FROM card_publication_requests WHERE id = $1) x`,
      [requestId],
    );

  /** Last activity `ago` before the database clock (`null` clears it). */
  const setLastActive = (userId: string, ago: string | null) =>
    ctx.owner.query(
      'UPDATE users SET last_active_at = clock_timestamp() - $2::interval WHERE id = $1',
      [userId, ago],
    );

  async function addHolders(
    cardId: string,
    count: number,
    options: { kind?: 'interest' | 'label'; deleted?: boolean } = {},
  ): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const holder = await createUser(ctx.owner, options.deleted ? { deletedAt: new Date() } : {});
      await ctx.owner.query(
        options.kind === 'label'
          ? "INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Saved')"
          : "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
        [holder.id, cardId],
      );
    }
  }

  const sharedCard = (creatorUserId: string | null, kind: 'interest' | 'label' = 'interest') =>
    createCard(ctx.owner, { kind, visibility: 'shared', origin: 'user', creatorUserId });

  /** A shared card by a fresh (just created, hence active) creator, its holders and an open request. */
  async function proposal(
    options: { holders?: number; kind?: 'interest' | 'label'; payload?: object } = {},
  ): Promise<{ creator: string; card: CardFixture; requestId: string }> {
    const creator = (await createUser(ctx.owner)).id;
    const card = await sharedCard(creator, options.kind);
    await addHolders(card.id, options.holders ?? 3, { kind: options.kind ?? 'interest' });
    const created = await requestPublication(admin, card.id, options.payload ?? PAYLOAD);
    expect(created.version).toBe('1');
    return { creator, card, requestId: created.request_id };
  }

  it('derives the creator from the card and stores the exact text and proposal hashes', async () => {
    const creator = (await createUser(ctx.owner)).id;
    await setLastActive(creator, '60 days'); // inactivity does not prevent asking for a response
    const card = await sharedCard(creator);
    for (const tenant of [creator, member, null]) {
      expect(await outcome(requestPublication(tenant, card.id, PAYLOAD)), `${tenant}`).toBe(
        '42501',
      );
    }

    const expiresAt = new Date(Date.now() + 14 * 86_400_000);
    const created = await requestPublication(admin, card.id, PAYLOAD, expiresAt);
    expect(created.version).toBe('1');
    expect(await requestRow(created.request_id)).toMatchObject({
      user_id: creator,
      card_id: card.id,
      requested_by: admin,
      status: 'pending',
      version: '1',
      card_text_hash: card.textHash,
      publication_payload: PAYLOAD,
      payload_text: PAYLOAD_TEXT,
      publication_sha: PAYLOAD_SHA,
      responded_iso: null,
      authorization_kind: null,
      authorization_evidence: null,
    });

    // The creator reads the exact proposal for informed consent (tenant RLS); others see nothing.
    const visible =
      'SELECT id, card_text_hash, publication_payload, status FROM card_publication_requests';
    expect((await asApp(creator, visible)).rows).toEqual([
      {
        id: created.request_id,
        card_text_hash: card.textHash,
        publication_payload: PAYLOAD,
        status: 'pending',
      },
    ]);
    expect((await asApp(member, visible)).rows).toEqual([]);

    // At most one open request per card.
    expect(await sqlStateOf(requestPublication(admin, card.id, { title: 'Other' }))).toBe('BZ409');
  });

  it('refuses private, creator-less, library, missing or deleted-creator cards and malformed payloads', async () => {
    const creator = (await createUser(ctx.owner)).id;
    const deletedCreator = (await createUser(ctx.owner, { deletedAt: new Date() })).id;
    const refused = [
      await createCard(ctx.owner, { visibility: 'private', ownerUserId: creator }),
      await sharedCard(null),
      await createCard(ctx.owner, { visibility: 'public', origin: 'library' }),
      await sharedCard(deletedCreator),
    ];
    for (const card of refused) {
      expect(await outcome(requestPublication(admin, card.id, PAYLOAD)), card.id).toBe('BZ409');
    }
    expect(await sqlStateOf(requestPublication(admin, '999999999', PAYLOAD))).toBe('BZ404');

    const card = await sharedCard(creator);
    const payloads: unknown[] = [
      { ...PAYLOAD, owner_user_id: admin },
      { visibility: 'public' },
      [PAYLOAD],
      'Rust programming',
      null,
      { title: 'x'.repeat(17_000) },
    ];
    for (const payload of payloads) {
      const label = `${json(payload)}`.slice(0, 40);
      expect(await outcome(requestPublication(admin, card.id, payload)), label).toBe('22023');
    }
    // A label's title is hashed card text: a proposal cannot rename it (refused up front, 22023).
    const label = await createCard(ctx.owner, {
      kind: 'label',
      title: 'Deep reads',
      creatorUserId: creator,
    });
    expect(await outcome(requestPublication(admin, label.id, { title: 'Longreads' }))).toBe(
      '22023',
    );
    const cardIds = [...refused, card, label].map((c) => c.id);
    expect(
      await ownerRows(
        'SELECT id FROM card_publication_requests WHERE card_id = ANY($1::bigint[])',
        [cardIds],
      ),
    ).toEqual([]);
    // The same title (or none) is fine for a label.
    expect(await outcome(requestPublication(admin, label.id, { title: 'Deep reads' }))).toBe('ok');
  });

  it('lets only the authenticated creator respond: approval bumps the version, a withdrawal vetoes', async () => {
    const { creator, card, requestId } = await proposal();
    const outsider = (await createUser(ctx.owner)).id;
    expect(await sqlStateOf(respond(outsider, requestId, 1, true))).toBe('BZ404');
    expect(await sqlStateOf(respond(admin, requestId, 1, true))).toBe('BZ404'); // no impersonation
    expect(await sqlStateOf(respond(null, requestId, 1, true))).toBe('42501');
    expect(await sqlStateOf(respond(creator, '999999999', 1, true))).toBe('BZ404');
    expect(await sqlStateOf(respond(creator, requestId, 2, true))).toBe('BZ409'); // stale version
    expect(await requestRow(requestId)).toMatchObject({
      status: 'pending',
      version: '1',
      responded_iso: null,
    });

    expect(await respond(creator, requestId, 1, true)).toEqual({
      status: 'approved',
      version: '2',
    });
    expect((await requestRow(requestId)).responded_iso).not.toBeNull();
    expect((await cardRow(card.id))['publication_veto_at']).toBeNull();
    expect(await sqlStateOf(respond(creator, requestId, 2, true))).toBe('BZ409'); // already approved

    // Consent can be withdrawn before promotion; the decline is final and a durable veto.
    expect(await respond(creator, requestId, 2, false)).toEqual({
      status: 'rejected',
      version: '3',
    });
    expect((await cardRow(card.id))['publication_veto_at']).toBeInstanceOf(Date);
    expect(await sqlStateOf(respond(creator, requestId, 3, true))).toBe('BZ409');
    expect(await sqlStateOf(promote(admin, requestId, 3))).toBe('BZ409');
  });

  it('keeps a decline veto through a fresh admin request until the creator approves again', async () => {
    const { creator, card, requestId: first } = await proposal();
    await setLastActive(creator, '40 days'); // inactivity alone would otherwise authorize promotion
    expect(await respond(creator, first, 1, false)).toEqual({ status: 'rejected', version: '2' });
    const veto = (await cardRow(card.id))['publication_veto_at'];
    expect(veto).toBeInstanceOf(Date);

    const second = (await requestPublication(admin, card.id, { title: 'Rust, again' })).request_id;
    expect((await cardRow(card.id))['publication_veto_at']).toEqual(veto);
    expect(await sqlStateOf(promote(admin, second, 1))).toBe('BZ409');
    expect((await cardRow(card.id))['visibility']).toBe('shared');

    expect(await respond(creator, second, 1, true)).toEqual({ status: 'approved', version: '2' });
    expect((await cardRow(card.id))['publication_veto_at']).toBeNull();
    expect(await requestRow(first)).toMatchObject({ status: 'rejected', version: '2' }); // audit kept
    expect(await promote(admin, second, 2)).toEqual({
      card_id: card.id,
      authorization_kind: 'creator_approval',
    });
  });

  it('needs three active holders and records genuine approval evidence atomically with publication', async () => {
    const { creator, card, requestId } = await proposal({ holders: 2 });
    await addHolders(card.id, 1, { deleted: true }); // a soft-deleted holder does not count
    expect(await respond(creator, requestId, 1, true)).toMatchObject({ version: '2' });
    expect(await sqlStateOf(promote(member, requestId, 2))).toBe('42501');
    expect(await sqlStateOf(promote(null, requestId, 2))).toBe('42501');
    expect(await sqlStateOf(promote(admin, requestId, 2))).toBe('BZ409');
    expect((await cardRow(card.id))['visibility']).toBe('shared');

    await addHolders(card.id, 1);
    expect(await sqlStateOf(promote(admin, requestId, 1))).toBe('BZ409'); // stale version
    expect(await promote(admin, requestId, 2)).toEqual({
      card_id: card.id,
      authorization_kind: 'creator_approval',
    });

    const row = await requestRow(requestId);
    expect(row).toMatchObject({
      status: 'promoted',
      version: '2',
      promoted_by: admin,
      authorization_kind: 'creator_approval',
    });
    expect(row.responded_iso).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect(row.authorization_evidence).toEqual({
      policyVersion: 1,
      creatorUserId: creator,
      cardTextHash: card.textHash,
      publicationSha: PAYLOAD_SHA,
      requestVersion: '2',
      respondedAt: row.responded_iso,
      approvedVersion: '2',
    });
    expect(await cardRow(card.id)).toMatchObject({
      visibility: 'public',
      title: PAYLOAD.title,
      i18n: PAYLOAD.i18n,
      text_hash: card.textHash,
      creator_user_id: creator,
    });

    // A replay conflicts and never rewrites the recorded basis.
    expect(await sqlStateOf(promote(admin, requestId, 2))).toBe('BZ409');
    expect(await requestRow(requestId)).toEqual(row);
  });

  it('counts label holders as well', async () => {
    const { creator, requestId } = await proposal({ kind: 'label', payload: {} });
    await setLastActive(creator, '40 days');
    expect(await promote(admin, requestId, 1)).toMatchObject({
      authorization_kind: 'creator_inactive_30d',
    });
  });

  it('promotes on 720 h of creator inactivity but not a minute earlier, without faking a response', async () => {
    const { creator, card, requestId } = await proposal();
    await setLastActive(creator, '719 hours 59 minutes');
    expect(await sqlStateOf(promote(admin, requestId, 1))).toBe('BZ409');
    expect((await cardRow(card.id))['visibility']).toBe('shared');

    await setLastActive(creator, '720 hours');
    expect(await promote(admin, requestId, 1)).toEqual({
      card_id: card.id,
      authorization_kind: 'creator_inactive_30d',
    });
    const row = await requestRow(requestId);
    expect(row).toMatchObject({
      status: 'promoted',
      version: '1',
      responded_iso: null,
      promoted_by: admin,
      authorization_kind: 'creator_inactive_30d',
    });
    expect(row.authorization_evidence).toEqual({
      policyVersion: 1,
      creatorUserId: creator,
      cardTextHash: card.textHash,
      publicationSha: PAYLOAD_SHA,
      requestVersion: '1',
      anchorSource: 'last_active_at',
      anchorAt: (await activityOf(creator))['last_active'],
      checkedAt: row.promoted_iso,
    });
    expect(await inactivitySpan(requestId)).toEqual({ full: true, bounded: true });
    expect((await cardRow(card.id))['visibility']).toBe('public');
  });

  it("anchors inactivity on the creator's created_at only when last_active_at is null", async () => {
    // Recent activity wins over an old account.
    const recent = await proposal();
    await ctx.owner.query(
      "UPDATE users SET created_at = clock_timestamp() - interval '2000 hours' WHERE id = $1",
      [recent.creator],
    );
    await setLastActive(recent.creator, '1 hour');
    expect(await sqlStateOf(promote(admin, recent.requestId, 1))).toBe('BZ409');

    const { creator, card, requestId } = await proposal();
    const setCreatedAt = (ago: string) =>
      ctx.owner.query(
        `UPDATE users SET last_active_at = NULL, created_at = clock_timestamp() - $2::interval
          WHERE id = $1`,
        [creator, ago],
      );
    await setCreatedAt('719 hours 59 minutes');
    expect(await sqlStateOf(promote(admin, requestId, 1))).toBe('BZ409');
    await setCreatedAt('720 hours');
    expect(await promote(admin, requestId, 1)).toMatchObject({
      authorization_kind: 'creator_inactive_30d',
    });
    const row = await requestRow(requestId);
    expect(row.responded_iso).toBeNull();
    expect(row.authorization_evidence).toEqual({
      policyVersion: 1,
      creatorUserId: creator,
      cardTextHash: card.textHash,
      publicationSha: PAYLOAD_SHA,
      requestVersion: '1',
      anchorSource: 'created_at',
      anchorAt: (await activityOf(creator))['created'],
      checkedAt: row.promoted_iso,
    });
    expect(await inactivitySpan(requestId)).toEqual({ full: true, bounded: true });
  });

  it('serializes promotion behind concurrent creator activity, which removes the inactivity basis', async () => {
    const { creator, card, requestId } = await proposal();
    await setLastActive(creator, '40 days');
    const promotion = await afterConcurrentCommit(
      {
        userId: creator,
        text: 'UPDATE users SET last_active_at = now() WHERE id = $1',
        values: [creator],
      },
      { userId: admin, text: 'SELECT * FROM admin_promote_card($1, $2)', values: [requestId, 1] },
    );
    expect(promotion).toBe('BZ409');
    expect(await requestRow(requestId)).toMatchObject({
      status: 'pending',
      authorization_kind: null,
    });
    expect((await cardRow(card.id))['visibility']).toBe('shared');
  });

  it('holds promotion for a soft-deleted creator, a retired card, an expired request or a changed hash', async () => {
    // Soft-deleted creator: on hold (and no session to respond); restoring the account lifts it.
    const deleted = await proposal();
    await setLastActive(deleted.creator, '40 days');
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deleted.creator]);
    expect(await sqlStateOf(promote(admin, deleted.requestId, 1))).toBe('BZ409');
    expect(await sqlStateOf(respond(deleted.creator, deleted.requestId, 1, true))).toBe('42501');
    await ctx.owner.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [deleted.creator]);
    expect(await promote(admin, deleted.requestId, 1)).toMatchObject({
      authorization_kind: 'creator_inactive_30d',
    });

    const retired = await proposal();
    await setLastActive(retired.creator, '40 days');
    await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [
      retired.card.id,
    ]);
    expect(await sqlStateOf(promote(admin, retired.requestId, 1))).toBe('BZ409');

    const expired = await proposal();
    await setLastActive(expired.creator, '40 days');
    await ctx.owner.query(
      `UPDATE card_publication_requests SET expires_at = requested_at + interval '1 microsecond'
        WHERE id = $1`,
      [expired.requestId],
    );
    expect(await sqlStateOf(promote(admin, expired.requestId, 1))).toBe('BZ409');
    expect(await sqlStateOf(respond(expired.creator, expired.requestId, 1, true))).toBe('BZ409');

    // A new proposal version whose text hash no longer matches the card.
    const changed = await proposal();
    await setLastActive(changed.creator, '40 days');
    await ctx.owner.query(
      'UPDATE card_publication_requests SET card_text_hash = $2, version = version + 1 WHERE id = $1',
      [changed.requestId, 'f'.repeat(64)],
    );
    expect(await sqlStateOf(promote(admin, changed.requestId, 1))).toBe('BZ409'); // stale version
    expect(await sqlStateOf(promote(admin, changed.requestId, 2))).toBe('BZ409'); // hash mismatch
    expect(await sqlStateOf(respond(changed.creator, changed.requestId, 2, true))).toBe('BZ409');

    for (const { card } of [retired, expired, changed]) {
      expect((await cardRow(card.id))['visibility']).toBe('shared');
    }
  });

  it('does not reuse an approval after the proposal changed', async () => {
    const { creator, card, requestId } = await proposal();
    expect(await respond(creator, requestId, 1, true)).toMatchObject({ version: '2' });

    // A metadata change is a new pending version awaiting a fresh response.
    const revised = '{"title": "Rust, revised"}';
    await ctx.owner.query(
      `UPDATE card_publication_requests
          SET publication_payload = $2::jsonb, publication_sha = $3, status = 'pending',
              responded_at = NULL, version = version + 1
        WHERE id = $1`,
      [requestId, revised, sha256(revised)],
    );
    expect(await sqlStateOf(promote(admin, requestId, 2))).toBe('BZ409'); // the approved version
    expect(await sqlStateOf(promote(admin, requestId, 3))).toBe('BZ409'); // active, not approved

    expect(await respond(creator, requestId, 3, true)).toEqual({
      status: 'approved',
      version: '4',
    });
    expect(await promote(admin, requestId, 4)).toMatchObject({
      authorization_kind: 'creator_approval',
    });
    expect((await requestRow(requestId)).authorization_evidence).toMatchObject({
      publicationSha: sha256(revised),
      requestVersion: '4',
      approvedVersion: '4',
    });
    expect((await cardRow(card.id))['title']).toBe('Rust, revised');
  });

  it('lists requests for administrators only', async () => {
    const { creator, card, requestId } = await proposal();
    for (const tenant of [member, creator, null]) {
      expect(await outcome(listRequests(tenant)), `${tenant}`).toBe('42501');
    }
    const listed = (await listRequests(admin, 'pending')).find((r) => r.id === requestId);
    expect(listed).toMatchObject({
      card_id: card.id,
      card_title: (await cardRow(card.id))['title'],
      card_text_hash: card.textHash,
      status: 'pending',
      version: '1',
      responded_at: null,
      publication_payload: PAYLOAD,
      publication_sha: PAYLOAD_SHA,
      creator_known: true,
      creator_last_active_at: null,
      holders: 3,
      vetoed: false,
      authorization_kind: null,
      promoted_at: null,
    });
    expect((await listRequests(admin, 'promoted')).some((r) => r.id === requestId)).toBe(false);
    expect((await listRequests(admin)).some((r) => r.id === requestId)).toBe(true);
  });

  it("keeps the audit trail through the creator's erasure and never promotes or answers such requests", async () => {
    const NULL_CREATOR = `UPDATE card_publication_requests
        SET authorization_evidence = jsonb_set(authorization_evidence, '{creatorUserId}', 'null')
      WHERE id = $1`;
    const published = await proposal();
    const { creator } = published;
    await setLastActive(creator, '40 days');
    await promote(admin, published.requestId, 1);
    const pendingCard = await sharedCard(creator);
    await addHolders(pendingCard.id, 3);
    const pendingId = (await requestPublication(admin, pendingCard.id, PAYLOAD)).request_id;
    const before = await requestRow(published.requestId);
    const evidence = before.authorization_evidence;
    if (evidence === null) throw new Error('the promotion recorded no evidence');

    // While the creator exists, published evidence is immutable, even for the worker.
    expect(await outcome(ctx.workerPool.query(NULL_CREATOR, [published.requestId]))).toBe('23514');

    await ctx.owner.query('DELETE FROM users WHERE id = $1', [creator]);

    expect(await requestRow(published.requestId)).toEqual({ ...before, user_id: null });
    expect(await requestRow(pendingId)).toMatchObject({ user_id: null, status: 'pending' });
    expect(await cardRow(published.card.id)).toMatchObject({
      visibility: 'public',
      creator_user_id: null,
    });
    expect((await cardRow(pendingCard.id))['creator_user_id']).toBeNull();

    // The erasure step may null creatorUserId in the evidence, and nothing else.
    const rewrite = `UPDATE card_publication_requests
        SET authorization_evidence = authorization_evidence || '{"cardTextHash": "x"}' WHERE id = $1`;
    expect(await outcome(ctx.workerPool.query(rewrite, [published.requestId]))).toBe('23514');
    expect((await ctx.workerPool.query(NULL_CREATOR, [published.requestId])).rowCount).toBe(1);
    expect((await requestRow(published.requestId)).authorization_evidence).toEqual({
      ...evidence,
      creatorUserId: null,
    });

    // An erased creator's request can never be promoted or answered; the card stays on hold.
    expect(await sqlStateOf(promote(admin, pendingId, 1))).toBe('BZ409');
    for (const tenant of [admin, member]) {
      expect(await outcome(respond(tenant, pendingId, 1, true)), tenant).toBe('BZ404');
    }
    expect(await sqlStateOf(respond(creator, pendingId, 1, true))).toBe('42501'); // no account
    expect(await sqlStateOf(requestPublication(admin, pendingCard.id, PAYLOAD))).toBe('BZ409');
    const listed = (await listRequests(admin)).filter(
      (r) => r.id === published.requestId || r.id === pendingId,
    );
    expect(listed.map((r) => r.creator_known)).toEqual([false, false]);
  });
});

// ── Library versions ─────────────────────────────────────────────────────────────────────────────

describe('library versions (spec 02 §3.6; spec 05 §8)', () => {
  const PUBLISH = 'SELECT admin_publish_library_card_version($1, $2, $3) AS version';
  const publish = (
    userId: string | null,
    slug: string | null,
    cardId: string,
    expected: number | null,
  ) => appRow(userId, PUBLISH, [slug, cardId, expected]);
  const libraryCard = () => createCard(ctx.owner, { visibility: 'public', origin: 'library' });
  const versions = (slug: string) =>
    ownerRows(
      `SELECT version, card_id, previous_card_id FROM library_card_versions
        WHERE library_slug = $1 ORDER BY version`,
      [slug],
    );

  it('appends consecutive versions, moves the slug alias and never re-points holdings', async () => {
    const v1 = await libraryCard();
    const v2 = await libraryCard();
    const holder = (await createUser(ctx.owner)).id;
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength, title_override)
       VALUES ($1, $2, 'love', 'Mine')`,
      [holder, v1.id],
    );
    const v1Before = await cardRow(v1.id);

    expect(await publish(admin, 'ev-batteries', v1.id, null)).toEqual({ version: 1 });
    expect((await cardRow(v1.id))['slug']).toBe('ev-batteries');
    expect(await publish(admin, 'ev-batteries', v2.id, 1)).toEqual({ version: 2 });

    expect(await versions('ev-batteries')).toEqual([
      { version: 1, card_id: v1.id, previous_card_id: null },
      { version: 2, card_id: v2.id, previous_card_id: v1.id },
    ]);
    expect(await cardRow(v1.id)).toEqual({ ...v1Before, slug: null });
    expect((await cardRow(v2.id))['slug']).toBe('ev-batteries');
    expect(
      await ownerRows(
        'SELECT card_id, strength, title_override FROM user_cards WHERE user_id = $1',
        [holder],
      ),
    ).toEqual([{ card_id: v1.id, strength: 'love', title_override: 'Mine' }]);
  });

  it('rejects stale expected versions, invalid slugs and callers without an admin session', async () => {
    const base = await libraryCard();
    const next = await libraryCard();
    expect(await publish(admin, 'rust-lang', base.id, null)).toEqual({ version: 1 });
    for (const expected of [null, 0, 2]) {
      expect(await outcome(publish(admin, 'rust-lang', next.id, expected)), `${expected}`).toBe(
        'BZ409',
      );
    }
    expect(await sqlStateOf(publish(admin, 'fresh-slug', next.id, 1))).toBe('BZ409');
    for (const slug of [
      'Rust-Lang',
      '-rust',
      'rust lang',
      'rust_lang',
      '',
      'r'.repeat(101),
      null,
    ]) {
      expect(await outcome(publish(admin, slug, next.id, 1)), `${slug}`).toBe('22023');
    }
    for (const tenant of [member, null]) {
      expect(await outcome(publish(tenant, 'rust-lang', next.id, 1)), `${tenant}`).toBe('42501');
    }
    expect(await versions('rust-lang')).toHaveLength(1);
    expect(await versions('fresh-slug')).toEqual([]);
    expect((await cardRow(next.id))['slug']).toBeNull();
  });

  it('serializes concurrent publishers: the second one sees the new version and conflicts', async () => {
    const base = await libraryCard();
    const x = await libraryCard();
    const y = await libraryCard();
    await publish(admin, 'space-launches', base.id, null);
    const second = await afterConcurrentCommit(
      { userId: admin, text: PUBLISH, values: ['space-launches', x.id, 1] },
      { userId: admin, text: PUBLISH, values: ['space-launches', y.id, 1] },
    );
    expect(second).toBe('BZ409');
    expect(await versions('space-launches')).toEqual([
      { version: 1, card_id: base.id, previous_card_id: null },
      { version: 2, card_id: x.id, previous_card_id: base.id },
    ]);
    expect((await cardRow(y.id))['slug']).toBeNull();
  });

  it('accepts only public cards as versions, so user material cannot bypass publication consent', async () => {
    // Spec 02 §3.6 / spec 05 §8, §8.1: library versions are public library content; a shared user
    // card needs the publication authorization first and a private fork is never published.
    const creator = (await createUser(ctx.owner)).id;
    const userCards = {
      shared: () =>
        createCard(ctx.owner, { visibility: 'shared', origin: 'user', creatorUserId: creator }),
      private: () => createCard(ctx.owner, { visibility: 'private', ownerUserId: creator }),
    };
    const refusal = (state: string) => (state === 'BZ404' || state === 'BZ409' ? 'refused' : state);
    const observed: Record<string, string> = {};
    const attempted: string[] = [];
    for (const [kind, make] of Object.entries(userCards)) {
      const base = await libraryCard();
      await publish(admin, `consent-${kind}`, base.id, null);
      const asNext = await make();
      const asFirst = await make();
      attempted.push(asNext.id, asFirst.id);
      observed[`${kind} card as version 2`] = refusal(
        await outcome(publish(admin, `consent-${kind}`, asNext.id, 1)),
      );
      observed[`${kind} card as version 1`] = refusal(
        await outcome(publish(admin, `consent-${kind}-own`, asFirst.id, null)),
      );
    }
    expect(observed).toEqual({
      'shared card as version 2': 'refused',
      'shared card as version 1': 'refused',
      'private card as version 2': 'refused',
      'private card as version 1': 'refused',
    });
    expect(
      await ownerRows(
        `SELECT c.id, c.slug, v.library_slug FROM interest_cards c
           LEFT JOIN library_card_versions v ON v.card_id = c.id
          WHERE c.id = ANY($1::bigint[]) AND (c.slug IS NOT NULL OR v.card_id IS NOT NULL)`,
        [attempted],
      ),
    ).toEqual([]);
  });
});
