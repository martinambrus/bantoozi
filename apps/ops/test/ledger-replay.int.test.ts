import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  deletionLedgerEntryId,
  runMigrations,
} from '@bantoozi/db';
import { deletionEmailHmac } from '@bantoozi/shared/server';
import {
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import { Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  decryptLedgerLines,
  formatReplay,
  replayLedger,
  type LedgerEntry,
} from '../src/ledger-replay.js';

/**
 * Replaying the deletion ledger on a restore (spec 11 §4.1, §5.1): an erasure made after the backup
 * removes the user, the waitlist row and the e-mail-bound invites, including those of a person who
 * only signed up after the backup (found by `emailHmac`); bystanders stay.
 */

const HMAC_KEY = 'ledger-test-hmac-key-0123456789abcdef0123';
let testDb: TestDatabase;
let pool: pg.Pool;
let identity: string;
let recipient: string;
const ids = { erased: '', late: '', bystander: '' };

async function ledgerLine(entry: LedgerEntry): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return `${Buffer.from(await encrypter.encrypt(JSON.stringify(entry))).toString('base64')}\n`;
}

const entryFor = (userId: string, email: string): LedgerEntry => ({
  id: deletionLedgerEntryId(userId),
  userId,
  deletedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  emailHmac: deletionEmailHmac(email, HMAC_KEY),
});

beforeAll(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
  testDb = await setupTestDatabase({
    pkg: 'ops',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  pool = new pg.Pool({ connectionString: testDb.urls.admin, max: 3 });
  const admin = await createUser(pool, { role: 'admin', email: 'admin@example.test' });
  const erased = await createUser(pool, { email: 'Erased@Example.Test' });
  const bystander = await createUser(pool, { email: 'bystander@example.test' });
  ids.erased = erased.id;
  ids.bystander = bystander.id;
  ids.late = '00000000-0000-4000-8000-0000000000d1'; // signed up after the backup: no users row here
  await pool.query(
    `INSERT INTO waitlist (email, locale) VALUES ('erased@example.test','en'), ('late@example.test','sk'), ('bystander2@example.test','en')`,
  );
  await pool.query(
    `INSERT INTO invites (code, created_by, email, expires_at) VALUES
       ('INV-ERASED', $1, 'erased@example.test', now() + interval '20 days'),
       ('INV-LATE', $1, 'late@example.test', now() + interval '20 days'),
       ('INV-OTHER', $1, 'bystander2@example.test', now() + interval '20 days'),
       ('INV-OPEN', $1, NULL, now() + interval '20 days')`,
    [admin.id],
  );
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'ledger-test-token-hash', now() + interval '5 days')`,
    [bystander.id],
  );
  await pool.query(
    `INSERT INTO login_codes (email, challenge_nonce, code_hash, purpose, login_user_id, expires_at)
     VALUES ('bystander@example.test', gen_random_uuid(), 'hash', 'login', $1, now() + interval '10 minutes')`,
    [bystander.id],
  );
});

afterAll(async () => {
  await pool.end();
  await dropCreatedTestDatabases();
});

describe('deletion-ledger replay', () => {
  it('removes the erased user, both waitlist rows and both bound invites, and nothing else', async () => {
    const lines = (
      await Promise.all([
        ledgerLine(entryFor(ids.erased, 'erased@example.test')),
        ledgerLine(entryFor(ids.late, 'late@example.test')),
      ])
    )
      .join('')
      .split('\n');
    const entries = await decryptLedgerLines([identity], [...lines, ...lines]); // overlapping copies
    expect(entries).toHaveLength(2);
    const result = await replayLedger(pool, entries, HMAC_KEY);
    expect(formatReplay(result)).toMatch(
      /^REPLAY entries=2 users=1 waitlist=2 invites=2 sessions_revoked=1 login_codes_deleted=1 mismatched=0$/u,
    );
    expect(
      (await pool.query("SELECT email::text FROM users WHERE email = 'erased@example.test'"))
        .rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT email::text FROM waitlist ORDER BY email')).rows.map(
        (r) => r.email,
      ),
    ).toEqual(['bystander2@example.test']);
    expect(
      (await pool.query('SELECT code FROM invites ORDER BY code')).rows.map((r) => r.code),
    ).toEqual(['INV-OPEN', 'INV-OTHER']);
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [ids.bystander])).rowCount).toBe(
      1,
    );
  });

  it('revokes restored sessions and deletes login codes', async () => {
    const live = await pool.query('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL');
    expect(Number(live.rows[0].n)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) AS n FROM sessions')).rows[0].n)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) AS n FROM login_codes')).rows[0].n)).toBe(0);
  });

  it('is idempotent: a second replay changes nothing and reports no users', async () => {
    const entries = await decryptLedgerLines(
      [identity],
      [await ledgerLine(entryFor(ids.erased, 'erased@example.test'))],
    );
    const result = await replayLedger(pool, entries, HMAC_KEY);
    expect(result).toMatchObject({ entries: 1, users: 0, waitlist: 0, invites: 0 });
  });

  it('skips and counts an entry whose e-mail hash or id does not match the restored user (R2)', async () => {
    const victim = await createUser(pool, { email: 'victim@example.test' });
    const wrongHmac = entryFor(victim.id, 'someone-else@example.test');
    const wrongId: LedgerEntry = {
      ...entryFor(victim.id, 'victim@example.test'),
      id: 'f'.repeat(64),
    };
    const entries = await decryptLedgerLines(
      [identity],
      [await ledgerLine(wrongHmac), await ledgerLine(wrongId)],
    );
    const result = await replayLedger(pool, entries, HMAC_KEY);
    expect(result).toMatchObject({ entries: 2, users: 0, mismatched: 2 });
    expect(formatReplay(result)).toMatch(
      /^REPLAY entries=2 users=0 waitlist=0 invites=0 sessions_revoked=\d+ login_codes_deleted=\d+ mismatched=2$/u,
    );
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [victim.id])).rowCount).toBe(1);

    // The matching entry still erases the same user.
    const good = await decryptLedgerLines(
      [identity],
      [await ledgerLine(entryFor(victim.id, 'victim@example.test'))],
    );
    expect(await replayLedger(pool, good, HMAC_KEY)).toMatchObject({ users: 1, mismatched: 0 });
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [victim.id])).rowCount).toBe(0);
  });

  it('refuses a ledger it cannot decrypt', async () => {
    const other = await generateIdentity();
    await expect(
      decryptLedgerLines([other], [await ledgerLine(entryFor(ids.erased, 'x@example.test'))]),
    ).rejects.toThrow(/does not decrypt/u);
  });

  it('refuses a malformed entry', async () => {
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const bad = Buffer.from(await encrypter.encrypt(JSON.stringify({ id: 'x' }))).toString(
      'base64',
    );
    await expect(decryptLedgerLines([identity], [bad])).rejects.toThrow(/malformed/u);
  });
});
