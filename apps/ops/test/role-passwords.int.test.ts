import { randomBytes } from 'node:crypto';

import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatRolePasswords, setRolePasswords } from '../src/role-passwords.js';

/**
 * `recovery:role-passwords` (spec 11 §4 step 3): a restored cluster has its roles without passwords;
 * the command sets them from the environment. The shared test cluster's real roles are not touched:
 * three scratch roles stand in, created without a password like a `--no-role-passwords` restore.
 */

let testDb: TestDatabase;
let admin: pg.Pool;
const suffix = randomBytes(4).toString('hex');
const roles = ['owner', 'app', 'worker'].map(
  (kind) => [`rp_${suffix}_${kind}`, `RP_${kind.toUpperCase()}_PASSWORD`] as const,
);
const envNames = roles.map(([, name]) => name);

function loginUrl(role: string, password: string): string {
  const url = new URL(testDb.urls.admin);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function canLogin(role: string, password: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: loginUrl(role, password) });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

let testDatabase = '';

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'ops',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  admin = new pg.Pool({ connectionString: testDb.urls.admin, max: 2 });
  const database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]
    ?.db;
  testDatabase = database ?? '';
  for (const [role] of roles) {
    await admin.query(`CREATE ROLE "${role}" LOGIN`);
    await admin.query(`GRANT CONNECT ON DATABASE "${testDatabase}" TO "${role}"`);
  }
});

afterAll(async () => {
  // A role that still holds a privilege on the test database cannot be dropped (2BP01).
  for (const [role] of roles) {
    await admin
      .query(`REVOKE CONNECT ON DATABASE "${testDatabase}" FROM "${role}"`)
      .catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  }
  await admin.end();
  await dropCreatedTestDatabases();
});

describe('recovery:role-passwords', () => {
  it('fails on a missing value and changes nothing', async () => {
    const env = { [envNames[0] as string]: 'first-pass', [envNames[1] as string]: 'second-pass' };
    await expect(setRolePasswords(admin, env, roles)).rejects.toThrow(envNames[2] as string);
    const empty = { ...env, [envNames[2] as string]: '' };
    await expect(setRolePasswords(admin, empty, roles)).rejects.toThrow(envNames[2] as string);
    const set = await admin.query(
      'SELECT count(*)::int AS n FROM pg_authid WHERE rolname = ANY($1) AND rolpassword IS NOT NULL',
      [roles.map(([role]) => role)],
    );
    expect(set.rows[0]).toEqual({ n: 0 });
    expect(await canLogin(roles[0]?.[0] as string, 'first-pass')).toBe(false);
  });

  it('rolls everything back when a role is missing', async () => {
    const env = Object.fromEntries(envNames.map((name) => [name, `pw-${name}`]));
    const withGhost = [...roles, [`rp_${suffix}_ghost`, envNames[0] as string]] as const;
    await expect(setRolePasswords(admin, env, withGhost)).rejects.toThrow('does not exist');
    expect(await canLogin(roles[0]?.[0] as string, `pw-${envNames[0]}`)).toBe(false);
  });

  it('sets all three passwords so each role logs in over TCP, and a wrong one is refused', async () => {
    const env = Object.fromEntries(
      envNames.map((name) => [name, `it's "quoted" $1 \\ ${randomBytes(6).toString('hex')}`]),
    );
    // Same password for owner and app would hide a mix-up: they differ.
    expect(new Set(Object.values(env)).size).toBe(3);
    const count = await setRolePasswords(admin, env, roles);
    expect(formatRolePasswords(count)).toBe('ROLE_PASSWORDS set=3');
    for (const [role, name] of roles) {
      expect(await canLogin(role, env[name] as string)).toBe(true);
      expect(await canLogin(role, `${env[name]}x`)).toBe(false);
    }
  });
});
