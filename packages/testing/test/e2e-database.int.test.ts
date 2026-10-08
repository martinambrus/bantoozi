import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createE2eDatabase,
  dropE2eDatabase,
  E2E_STALE_AFTER_MS,
  parseCreatedComment,
  sweepStaleE2eDatabases,
} from '../src/e2e/database.js';
import {
  ensureTemplate,
  quoteIdent,
  roleUrl,
  templateDatabaseName,
  testDbEnv,
} from '../src/index.js';

// Real Postgres from infra/compose.test.yml (pnpm db:test:up). The template is synthetic (random
// hash, a marker table instead of the migrations); this file drops everything it creates.
const env = testDbEnv();
const HOUR_MS = 3_600_000;

const databases = new Set<string>();
const clients: pg.Client[] = [];
let template: string;

const e2eName = (): string => {
  const name = `bantoozi_e2e_${randomBytes(4).toString('hex')}`;
  databases.add(name);
  return name;
};

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: env.adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function exists(name: string): Promise<boolean> {
  return admin(
    async (client) =>
      (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1,
  );
}

async function comment(name: string): Promise<string | null> {
  return admin(async (client) => {
    const { rows } = await client.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
      [name],
    );
    return rows[0]?.comment ?? null;
  });
}

async function connect(name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: roleUrl(env, 'postgres', name) });
  client.on('error', () => undefined);
  await client.connect();
  clients.push(client);
  return client;
}

beforeAll(async () => {
  template = await ensureTemplate({
    hash: randomBytes(6).toString('hex'),
    env,
    migrate: async (ownerUrl) => {
      const client = new pg.Client({ connectionString: ownerUrl });
      await client.connect();
      try {
        await client.query('CREATE TABLE migrated_marker (id int PRIMARY KEY)');
        await client.query('INSERT INTO migrated_marker VALUES (1)');
      } finally {
        await client.end();
      }
    },
  });
  databases.add(template);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
  await admin(async (client) => {
    for (const name of databases) {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    }
  });
});

describe('createE2eDatabase', () => {
  it('clones the template for the owner, grants CONNECT to the app roles only, and stamps the time', async () => {
    const name = e2eName();
    const now = new Date('2026-03-10T12:00:00.000Z');
    await createE2eDatabase({ env, name, template, now });

    const db = await admin(async (client) => {
      const { rows } = await client.query<{ owner: string; acl: string[] | null }>(
        `SELECT pg_get_userbyid(datdba) AS owner, datacl::text[] AS acl
           FROM pg_database WHERE datname = $1`,
        [name],
      );
      return rows[0];
    });
    expect(db?.owner).toBe('bantoozi_owner');
    const grantees = (db?.acl ?? []).map((entry) => entry.split('=')[0]);
    expect(grantees).toContain('bantoozi_app');
    expect(grantees).toContain('bantoozi_worker');
    expect(grantees).not.toContain('');
    expect(parseCreatedComment(await comment(name))).toEqual(now);

    for (const role of ['bantoozi_app', 'bantoozi_worker'] as const) {
      const client = new pg.Client({ connectionString: roleUrl(env, role, name) });
      await client.connect();
      try {
        expect((await client.query('SELECT current_user AS u')).rows[0]).toEqual({ u: role });
      } finally {
        await client.end();
      }
    }
    const clone = await connect(name);
    expect((await clone.query('SELECT id FROM migrated_marker')).rows).toEqual([{ id: 1 }]);
  });

  it('stamps the current time by default', async () => {
    const name = e2eName();
    const before = Date.now();
    await createE2eDatabase({ env, name, template });
    const at = parseCreatedComment(await comment(name));
    expect(at?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(at?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('never adopts a database that already exists', async () => {
    const name = e2eName();
    await createE2eDatabase({ env, name, template });
    await expect(createE2eDatabase({ env, name, template })).rejects.toThrow(/already exists/);
  });

  it.each([
    'postgres',
    'template1',
    'bantoozi_e2e_ABCD1234',
    'bantoozi_e2e_abcd123',
    'bantoozi_e2e_abcd1234; DROP DATABASE postgres',
    'bantoozi_template_0123456789ab',
  ])('refuses the name %j before touching the server', async (name) => {
    await expect(createE2eDatabase({ env, name, template })).rejects.toThrow(
      /refusing to touch database/,
    );
  });

  it('refuses a template that is invalid, missing or not ready', async () => {
    const name = e2eName();
    await expect(createE2eDatabase({ env, name, template: 'postgres' })).rejects.toThrow(
      /invalid template/,
    );
    const missing = templateDatabaseName(randomBytes(6).toString('hex'));
    await expect(createE2eDatabase({ env, name, template: missing })).rejects.toThrow(
      /is not ready/,
    );

    const unfinished = templateDatabaseName(randomBytes(6).toString('hex'));
    databases.add(unfinished);
    await admin((client) => client.query(`CREATE DATABASE ${quoteIdent(unfinished)}`));
    await expect(createE2eDatabase({ env, name, template: unfinished })).rejects.toThrow(
      /is not ready/,
    );
    expect(await exists(name)).toBe(false);
  });
});

describe('dropE2eDatabase', () => {
  it('drops the database even while a session is connected, and again without an error', async () => {
    const name = e2eName();
    await createE2eDatabase({ env, name, template });
    const session = await connect(name);
    await session.query('SELECT 1');

    await dropE2eDatabase(env, name);
    expect(await exists(name)).toBe(false);
    await expect(dropE2eDatabase(env, name)).resolves.toBeUndefined();
  });

  it.each(['postgres', 'template1', 'bantoozi_e2e_ABCD1234', 'bantoozi_e2e_abcd1234" --'])(
    'refuses the name %j',
    async (name) => {
      await expect(dropE2eDatabase(env, name)).rejects.toThrow(/refusing to touch database/);
    },
  );

  it('leaves the template and the other databases alone', async () => {
    await expect(dropE2eDatabase(env, template)).rejects.toThrow(/refusing to touch database/);
    expect(await exists(template)).toBe(true);
    expect(await exists('postgres')).toBe(true);
  });
});

describe('sweepStaleE2eDatabases', () => {
  it('drops only unconnected, uncommented-as-recent E2E databases older than six hours', async () => {
    const now = new Date();
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const old = e2eName();
    const justOver = e2eName();
    const justUnder = e2eName();
    const fresh = e2eName();
    const connected = e2eName();
    const kept = e2eName();
    await createE2eDatabase({ env, name: old, template, now: ago(7 * HOUR_MS) });
    await createE2eDatabase({
      env,
      name: justOver,
      template,
      now: ago(E2E_STALE_AFTER_MS + 60_000),
    });
    await createE2eDatabase({
      env,
      name: justUnder,
      template,
      now: ago(E2E_STALE_AFTER_MS - 60_000),
    });
    await createE2eDatabase({ env, name: fresh, template, now });
    await createE2eDatabase({ env, name: connected, template, now: ago(9 * HOUR_MS) });
    await createE2eDatabase({ env, name: kept, template, now: ago(9 * HOUR_MS) });
    await (await connect(connected)).query('SELECT 1');

    const uncommented = e2eName();
    const lookalike = 'bantoozi_e2e_not_a_run_id';
    databases.add(lookalike);
    await admin(async (client) => {
      await client.query(`CREATE DATABASE ${quoteIdent(uncommented)}`);
      await client.query(`CREATE DATABASE ${quoteIdent(lookalike)}`);
      await client.query(
        `COMMENT ON DATABASE ${quoteIdent(lookalike)} IS 'bantoozi-e2e created ${ago(30 * HOUR_MS).toISOString()}'`,
      );
    });

    const result = await sweepStaleE2eDatabases({ env, keep: kept, now });

    expect(result.dropped).toEqual(expect.arrayContaining([old, justOver]));
    for (const name of [justUnder, fresh, connected, kept, uncommented, lookalike, template]) {
      expect(result.dropped).not.toContain(name);
    }
    expect(result.failed.filter((failure) => databases.has(failure.name))).toEqual([]);
    expect(await exists(old)).toBe(false);
    expect(await exists(justOver)).toBe(false);
    for (const name of [justUnder, fresh, connected, kept, uncommented, lookalike, template]) {
      expect(await exists(name)).toBe(true);
    }
  });

  it('honours the age limit it is given', async () => {
    const name = e2eName();
    const now = new Date();
    await createE2eDatabase({ env, name, template, now: new Date(now.getTime() - 2 * HOUR_MS) });
    const keep = e2eName();
    const result = await sweepStaleE2eDatabases({ env, keep, now, maxAgeMs: HOUR_MS });
    expect(result.dropped).toContain(name);
    expect(await exists(name)).toBe(false);
  });
});
