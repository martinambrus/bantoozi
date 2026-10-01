import { Writable } from 'node:stream';

import { createLogger } from '@bantoozi/shared/server';
import { createFeed, createSubscription, createUser } from '@bantoozi/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import { authTiming } from '../src/services/auth.js';
import {
  apiClient,
  createApiHarness,
  createCapturingMailer,
  createTestSession,
  createTestUser,
  testConfig,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T2 (spec 08 §2.1): the request-code decision table, code storage, TTL and attempt limits,
 * signup/login/restore on verify and the races between them, over the `bantoozi_app` role.
 */

const ADMIN = 'boss@example.test';
let h: ApiHarness;
let seq = 0;

const nextEmail = (prefix = 'reader') => `${prefix}-${++seq}@example.test`;
const anon = () => apiClient(h.server);

beforeAll(async () => {
  authTiming.minResponseMs = 0;
  h = await createApiHarness({ env: { ADMIN_EMAILS: ADMIN, SIGNUP_MODE: 'invite' } });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

afterEach(async () => {
  h.mailer.failing = false;
  await h.owner.query(`DELETE FROM settings WHERE key = 'signup_mode'`);
});

async function setStoredMode(mode: 'open' | 'invite' | 'closed'): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('signup_mode', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(mode)],
  );
}

function mailsTo(email: string) {
  return h.mailer.sent.filter((m) => m.to === email);
}

function lastCode(email: string): string {
  const mail = mailsTo(email).at(-1);
  const match = mail?.text.match(/\b(\d{6})\b/);
  if (match?.[1] === undefined) throw new Error(`no code mailed to ${email}`);
  return match[1];
}

async function requestCode(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const res = await anon().post('/auth/request-code', body, { headers });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ next: 'check_email' });
  return res;
}

function verify(email: string, code: string, headers: Record<string, string> = {}) {
  return anon().post('/auth/verify', { email, code }, { headers });
}

async function createInvite(
  overrides: { email?: string; expiresAt?: string; usedAt?: string; code?: string } = {},
): Promise<string> {
  const code = overrides.code ?? `${String(++seq).padStart(4, '0')}ABCDEF`.slice(0, 10);
  await h.owner.query(
    `INSERT INTO invites (code, email, expires_at, used_at)
     VALUES ($1, $2, coalesce($3::timestamptz, now() + interval '30 days'), $4)`,
    [code, overrides.email ?? null, overrides.expiresAt ?? null, overrides.usedAt ?? null],
  );
  return code;
}

async function userRow(email: string) {
  const { rows } = await h.owner.query<{
    id: string;
    role: string;
    locale: string;
    invites_left: number;
    deleted_at: Date | null;
    last_active_at: Date | null;
    rank_revision: string;
  }>(
    `SELECT id::text, role, locale, invites_left, deleted_at, last_active_at,
            rank_revision::text FROM users WHERE email = $1`,
    [email],
  );
  return rows[0];
}

async function codeRows(email: string) {
  const { rows } = await h.owner.query<{
    id: string;
    purpose: string;
    code_hash: string;
    challenge_nonce: string;
    invite_code: string | null;
    locale: string | null;
    attempts: number;
    consumed_at: Date | null;
    requested_ip: string | null;
  }>(
    `SELECT id::text, purpose, code_hash, challenge_nonce::text, invite_code, locale, attempts,
            consumed_at, host(requested_ip) AS requested_ip
       FROM login_codes WHERE email = $1 ORDER BY id`,
    [email],
  );
  return rows;
}

function sessionCookieOf(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header.join('\n') : String(header ?? '');
  const match = value.match(new RegExp(`${h.config.sessionCookieName}=([^;]*)`));
  if (match?.[1] === undefined || match[1] === '') throw new Error('no session cookie');
  return match[1];
}

function asUser(res: LightMyRequestResponse, email: string): TestUser {
  const token = sessionCookieOf(res);
  const body = res.json<{ user: { id: string } }>();
  return {
    id: body.user.id,
    email,
    sessionId: '',
    token,
    cookie: `${h.config.sessionCookieName}=${token}`,
  };
}

async function sessionsOf(userId: string): Promise<number> {
  const { rows } = await h.owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

describe('request-code decision table (spec 08 §2.1)', () => {
  it('an existing user gets a login code; verify signs in and returns Me', async () => {
    const user = await createUser(h.owner, { email: nextEmail() });
    await requestCode({ email: `  ${user.email.toUpperCase()} ` });
    const mail = mailsTo(user.email).at(-1);
    expect(mail?.subject).toBe('Your Bantoozi sign-in code');
    expect(mail?.html).toContain(lastCode(user.email));
    const [row] = await codeRows(user.email);
    expect(row?.purpose).toBe('login');

    const res = await verify(user.email, lastCode(user.email));
    expect(res.statusCode).toBe(200);
    const body = res.json<{ user: { id: string; email: string; role: string } }>();
    expect(body.user).toMatchObject({ id: user.id, email: user.email, role: 'user' });
    expect(await sessionsOf(user.id)).toBe(1);
    expect((await userRow(user.email))?.last_active_at).not.toBeNull();
  });

  it('a soft-deleted (not purged) user gets a login code too', async () => {
    const user = await createUser(h.owner, {
      email: nextEmail(),
      deletedAt: new Date(Date.now() - 86_400_000),
    });
    await requestCode({ email: user.email });
    expect(mailsTo(user.email).at(-1)?.subject).toBe('Your Bantoozi sign-in code');
    expect((await codeRows(user.email))[0]?.purpose).toBe('login');
  });

  it('admin bootstrap: an ADMIN_EMAILS address signs up with an empty invites table', async () => {
    await h.owner.query('DELETE FROM waitlist');
    await h.owner.query('DELETE FROM invites');
    const { rows } = await h.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM invites');
    expect(rows[0]?.n).toBe(0);
    await requestCode({ email: ADMIN.toUpperCase() });
    expect(mailsTo(ADMIN).at(-1)?.subject).toBe('Confirm your Bantoozi account');
    const res = await verify(ADMIN, lastCode(ADMIN));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { role: string } }>().user.role).toBe('admin');
    expect((await userRow(ADMIN))?.role).toBe('admin');
  });

  it('admin bootstrap does not apply while the mode is closed', async () => {
    const h2 = await h.buildAnother({
      env: { ADMIN_EMAILS: 'closed-admin@example.test', SIGNUP_MODE: 'closed' },
    });
    const before = h.mailer.sent.length;
    const res = await apiClient(h2).post('/auth/request-code', {
      email: 'closed-admin@example.test',
    });
    expect(res.statusCode).toBe(202);
    expect(h.mailer.sent.length).toBe(before);
    expect(await codeRows('closed-admin@example.test')).toEqual([]);
  });

  it('open mode: an unknown email gets a signup code', async () => {
    await setStoredMode('open');
    const email = nextEmail('open');
    await requestCode({ email });
    expect(mailsTo(email).at(-1)?.subject).toBe('Confirm your Bantoozi account');
    const res = await verify(email, lastCode(email));
    expect(res.statusCode).toBe(200);
    const row = await userRow(email);
    expect(row).toMatchObject({ role: 'user', invites_left: 3 });
    // UUID v7
    expect(row?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('invite mode with a valid invite: signup code, invite remembered on the code row, consumed on verify', async () => {
    const email = nextEmail('invited');
    const code = await createInvite({ email });
    // Typed loosely: lower case with a separator.
    await requestCode({ email, inviteCode: `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}` });
    expect(mailsTo(email).at(-1)?.subject).toBe('Confirm your Bantoozi account');
    expect((await codeRows(email))[0]).toMatchObject({ purpose: 'signup', invite_code: code });

    const res = await verify(email, lastCode(email));
    expect(res.statusCode).toBe(200);
    const userId = res.json<{ user: { id: string } }>().user.id;
    const { rows } = await h.owner.query<{ used_by: string | null; used_at: Date | null }>(
      'SELECT used_by::text, used_at FROM invites WHERE code = $1',
      [code],
    );
    expect(rows[0]?.used_by).toBe(userId);
    expect(rows[0]?.used_at).not.toBeNull();
  });

  it('invite mode without a usable invite: "invite-only" email with a waitlist link, no code', async () => {
    const other = nextEmail('other');
    const cases: (string | undefined)[] = [
      undefined,
      'not-a-code!',
      'ZZZZZZZZZZ', // unknown
      await createInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      await createInvite({ usedAt: new Date().toISOString() }),
      await createInvite({ email: other }),
    ];
    for (const inviteCode of cases) {
      const email = nextEmail('uninvited');
      await requestCode(inviteCode === undefined ? { email } : { email, inviteCode });
      const mail = mailsTo(email).at(-1);
      expect(mail?.subject).toBe('Bantoozi is invite-only');
      expect(mail?.text).toContain('http://localhost:5173/waitlist');
      expect(mail?.html).toContain('href="http://localhost:5173/waitlist"');
      expect(mail?.text).not.toMatch(/\b\d{6}\b/);
      expect(await codeRows(email)).toEqual([]);
    }
  });

  it('closed mode: nothing is sent, still 202', async () => {
    await setStoredMode('closed');
    const email = nextEmail('closed');
    const before = h.mailer.sent.length;
    await requestCode({ email, inviteCode: await createInvite() });
    expect(h.mailer.sent.length).toBe(before);
    expect(await codeRows(email)).toEqual([]);
  });

  it('the stored signup_mode overrides SIGNUP_MODE for the request and the verification', async () => {
    // SIGNUP_MODE=invite, stored open: an uninvited signup code is issued…
    await setStoredMode('open');
    const email = nextEmail('switch');
    await requestCode({ email });
    expect(mailsTo(email).at(-1)?.subject).toBe('Confirm your Bantoozi account');
    // …but the mode in effect at verification decides: closed creates no account.
    await setStoredMode('closed');
    const res = await verify(email, lastCode(email));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
    expect(await userRow(email)).toBeUndefined();

    // SIGNUP_MODE=open on another instance, stored invite: the stored mode wins.
    const openServer = await h.buildAnother({ env: { ADMIN_EMAILS: ADMIN, SIGNUP_MODE: 'open' } });
    await setStoredMode('invite');
    const email2 = nextEmail('switch');
    const r2 = await apiClient(openServer).post('/auth/request-code', { email: email2 });
    expect(r2.statusCode).toBe(202);
    expect(mailsTo(email2).at(-1)?.subject).toBe('Bantoozi is invite-only');

    // With no stored row, SIGNUP_MODE=open applies.
    await h.owner.query(`DELETE FROM settings WHERE key = 'signup_mode'`);
    const email3 = nextEmail('switch');
    await apiClient(openServer).post('/auth/request-code', { email: email3 });
    expect(mailsTo(email3).at(-1)?.subject).toBe('Confirm your Bantoozi account');
    // A signup code issued under open is refused when the stored mode becomes invite.
    await setStoredMode('invite');
    const r3 = await apiClient(openServer).post('/auth/verify', {
      email: email3,
      code: lastCode(email3),
    });
    expect(r3.statusCode).toBe(400);
    expect(await userRow(email3)).toBeUndefined();
  });

  it('validates the body strictly', async () => {
    for (const body of [
      {},
      { email: 'not-an-email' },
      { email: `${'a'.repeat(250)}@example.test` },
      { email: 'a@example.test', extra: 1 },
      { email: 'a@example.test', locale: 'not a tag!' },
      { email: 'a@example.test', inviteCode: 'x'.repeat(65) },
    ]) {
      const res = await anon().post('/auth/request-code', body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    for (const body of [
      { email: 'a@example.test' },
      { email: 'a@example.test', code: '12345' },
      { email: 'a@example.test', code: 'abcdef' },
      { email: 'a@example.test', code: '123456', extra: true },
    ]) {
      expect((await anon().post('/auth/verify', body)).statusCode).toBe(400);
    }
  });
});

describe('codes (spec 08 §2.1 "Codes")', () => {
  it('stores only an HMAC with a fresh challenge nonce, the locale and the requesting IP', async () => {
    await setStoredMode('open');
    const email = nextEmail('stored');
    await requestCode({ email, locale: 'sk-SK' });
    const code = lastCode(email);
    expect(mailsTo(email).at(-1)?.subject).toBe('Potvrďte svoj účet v Bantoozi');
    const [row] = await codeRows(email);
    expect(row?.locale).toBe('sk');
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).not.toContain(code);
    expect(row?.challenge_nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.requested_ip).toBe('127.0.0.1');

    // The locale on the code row wins over Accept-Language at signup.
    const res = await verify(email, code, { 'accept-language': 'en-US' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { locale: string } }>().user.locale).toBe('sk');
  });

  it('without a requested locale, the signup uses Accept-Language and the row stays null', async () => {
    await setStoredMode('open');
    const email = nextEmail('al');
    await requestCode({ email }, { 'accept-language': 'de-DE,sk;q=0.8,en;q=0.5' });
    expect(mailsTo(email).at(-1)?.subject).toBe('Potvrďte svoj účet v Bantoozi');
    expect((await codeRows(email))[0]?.locale).toBeNull();
    const res = await verify(email, lastCode(email), { 'accept-language': 'sk' });
    expect(res.json<{ user: { locale: string } }>().user.locale).toBe('sk');
    // Unsupported locales fall back to en.
    const email2 = nextEmail('al');
    await requestCode({ email: email2, locale: 'de' });
    expect((await codeRows(email2))[0]?.locale).toBe('en');
  });

  it('expires after its TTL', async () => {
    const user = await createUser(h.owner, { email: nextEmail('ttl') });
    await requestCode({ email: user.email });
    const code = lastCode(user.email);
    await h.owner.query(
      `UPDATE login_codes SET created_at = now() - interval '11 minutes',
                              expires_at = now() - interval '1 minute' WHERE email = $1`,
      [user.email],
    );
    const res = await verify(user.email, code);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
    // The TTL is 10 minutes.
    await requestCode({ email: user.email });
    const { rows } = await h.owner.query<{ ttl: number }>(
      `SELECT extract(epoch FROM expires_at - created_at)::int AS ttl FROM login_codes
        WHERE email = $1 AND consumed_at IS NULL`,
      [user.email],
    );
    expect(rows[0]?.ttl).toBe(600);
  });

  it('allows at most 5 attempts, and every failed attempt commits', async () => {
    const user = await createUser(h.owner, { email: nextEmail('attempts') });
    await requestCode({ email: user.email });
    const code = lastCode(user.email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 5; i += 1) {
      const res = await verify(user.email, wrong);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
      expect((await codeRows(user.email))[0]?.attempts).toBe(i);
    }
    const res = await verify(user.email, code);
    expect(res.statusCode).toBe(400);
    expect(await sessionsOf(user.id)).toBe(0);
  });

  it('uses the same generic error for wrong, expired, consumed and unknown codes', async () => {
    const user = await createUser(h.owner, { email: nextEmail('generic') });
    await requestCode({ email: user.email });
    const code = lastCode(user.email);
    const wrong = await verify(user.email, code === '999999' ? '999998' : '999999');
    expect((await verify(user.email, code)).statusCode).toBe(200);
    const consumed = await verify(user.email, code);
    const unknown = await verify(nextEmail('nobody'), '123456');
    for (const res of [wrong, consumed, unknown]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: { code: 'INVALID_CODE', message: 'Invalid or expired code' },
      });
    }
  });

  it('a new request invalidates the older unconsumed code', async () => {
    const user = await createUser(h.owner, { email: nextEmail('resend') });
    await requestCode({ email: user.email });
    const first = lastCode(user.email);
    await requestCode({ email: user.email });
    const second = lastCode(user.email);
    const rows = await codeRows(user.email);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.consumed_at).not.toBeNull();
    expect(rows[1]?.consumed_at).toBeNull();
    if (first !== second) expect((await verify(user.email, first)).statusCode).toBe(400);
    expect((await verify(user.email, second)).statusCode).toBe(200);
  });

  it('two simultaneous verifications of one code yield exactly one session', async () => {
    const user = await createUser(h.owner, { email: nextEmail('race') });
    await requestCode({ email: user.email });
    const code = lastCode(user.email);
    const results = await Promise.all([
      verify(user.email, code),
      verify(user.email, code),
      verify(user.email, code),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400, 400]);
    expect(await sessionsOf(user.id)).toBe(1);
  });

  it('a verification racing a resend never leaves two live codes or reuses the old one', async () => {
    for (let round = 0; round < 3; round += 1) {
      const user = await createUser(h.owner, { email: nextEmail('resend-race') });
      await requestCode({ email: user.email });
      const old = lastCode(user.email);
      const [verified] = await Promise.all([
        verify(user.email, old),
        anon().post('/auth/request-code', { email: user.email }),
      ]);
      // Serialized either way: verify-then-resend (200, new live code) or resend-then-verify
      // (old code invalidated, 400). Exactly one live code remains and the old one is consumed.
      const rows = await codeRows(user.email);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.consumed_at === null)).toHaveLength(1);
      expect(rows[0]?.consumed_at).not.toBeNull();
      expect(await sessionsOf(user.id)).toBe(verified.statusCode === 200 ? 1 : 0);
      // The old code is dead either way.
      expect((await verify(user.email, old)).statusCode).toBe(400);
    }
  });

  it('a login code whose user was purged meanwhile does not authorize a signup', async () => {
    await setStoredMode('open');
    const user = await createUser(h.owner, { email: nextEmail('purged') });
    await requestCode({ email: user.email });
    const code = lastCode(user.email);
    await h.worker.query('DELETE FROM users WHERE id = $1', [user.id]);
    const res = await verify(user.email, code);
    expect(res.statusCode).toBe(400);
    expect(await userRow(user.email)).toBeUndefined();
  });
});

describe('signup and verify side effects (spec 08 §2.1)', () => {
  it('two signups racing for one invite: exactly one wins', async () => {
    const invite = await createInvite();
    const a = nextEmail('race-a');
    const b = nextEmail('race-b');
    await requestCode({ email: a, inviteCode: invite });
    await requestCode({ email: b, inviteCode: invite });
    expect(mailsTo(a).at(-1)?.subject).toBe('Confirm your Bantoozi account');
    expect(mailsTo(b).at(-1)?.subject).toBe('Confirm your Bantoozi account');
    const results = await Promise.all([verify(a, lastCode(a)), verify(b, lastCode(b))]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const created = [await userRow(a), await userRow(b)].filter((u) => u !== undefined);
    expect(created).toHaveLength(1);
    const { rows } = await h.owner.query<{ used_by: string }>(
      'SELECT used_by::text FROM invites WHERE code = $1',
      [invite],
    );
    expect(rows[0]?.used_by).toBe(created[0]?.id);
  });

  it('an invite used after the code was issued no longer authorizes the signup', async () => {
    const invite = await createInvite();
    const email = nextEmail('late');
    await requestCode({ email, inviteCode: invite });
    await h.owner.query('UPDATE invites SET used_at = now() WHERE code = $1', [invite]);
    expect((await verify(email, lastCode(email))).statusCode).toBe(400);
    expect(await userRow(email)).toBeUndefined();
  });

  it('signup deletes the matching waitlist row in the same transaction', async () => {
    await setStoredMode('open');
    const email = nextEmail('waiting');
    const res = await anon().post('/waitlist', { email: email.toUpperCase(), note: 'hi' });
    expect(res.statusCode).toBe(202);
    const before = await h.owner.query('SELECT 1 FROM waitlist WHERE email = $1', [email]);
    expect(before.rowCount).toBe(1);
    await requestCode({ email });
    expect((await verify(email, lastCode(email))).statusCode).toBe(200);
    const after = await h.owner.query('SELECT 1 FROM waitlist WHERE email = $1', [email]);
    expect(after.rowCount).toBe(0);
  });

  it('re-applies the admin role from ADMIN_EMAILS on every verify', async () => {
    const admin = (await userRow(ADMIN)) ?? (await createUser(h.owner, { email: ADMIN }));
    await h.owner.query(`UPDATE users SET role = 'user' WHERE email = $1`, [ADMIN]);
    await requestCode({ email: ADMIN });
    const res = await verify(ADMIN, lastCode(ADMIN));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { role: string } }>().user.role).toBe('admin');
    expect((await userRow(ADMIN))?.role).toBe('admin');
    expect(admin).toBeDefined();
  });

  it('restores a soft-deleted account within 7 days: feeds refreshed, full rank enqueued', async () => {
    const user = await createUser(h.owner, {
      email: nextEmail('restore'),
      deletedAt: new Date(Date.now() - 3 * 86_400_000),
    });
    const feed = await createFeed(h.owner);
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
    // As after DELETE /me: the deleted user no longer counts as a subscriber.
    await h.owner.query(
      `UPDATE feeds SET subscriber_count = 0, min_interval_s = 900 WHERE id = $1`,
      [feed.id],
    );
    const before = await userRow(user.email);

    await requestCode({ email: user.email });
    const res = await verify(user.email, lastCode(user.email));
    expect(res.statusCode).toBe(200);

    const after = await userRow(user.email);
    expect(after?.deleted_at).toBeNull();
    expect(BigInt(after?.rank_revision ?? '0')).toBe(BigInt(before?.rank_revision ?? '0') + 1n);
    const feeds = await h.owner.query<{ subscriber_count: number }>(
      'SELECT subscriber_count FROM feeds WHERE id = $1',
      [feed.id],
    );
    expect(feeds.rows[0]?.subscriber_count).toBe(1);
    const jobs = await h.owner.query<{ payload: { userId: string; full?: boolean } }>(
      `SELECT payload FROM job_outbox WHERE queue = 'user.rank' AND user_id = $1`,
      [user.id],
    );
    expect(jobs.rows.map((r) => r.payload)).toEqual([
      { userId: user.id, reason: 'account.restore', full: true },
    ]);
  });

  it('does not restore after the 7-day window', async () => {
    const deletedAt = new Date(Date.now() - 8 * 86_400_000);
    const user = await createUser(h.owner, { email: nextEmail('too-late'), deletedAt });
    await requestCode({ email: user.email });
    const res = await verify(user.email, lastCode(user.email));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
    expect((await userRow(user.email))?.deleted_at?.getTime()).toBe(deletedAt.getTime());
    expect(await sessionsOf(user.id)).toBe(0);
    const jobs = await h.owner.query('SELECT 1 FROM job_outbox WHERE user_id = $1', [user.id]);
    expect(jobs.rowCount).toBe(0);
  });

  it('an ordinary login enqueues no full rank', async () => {
    const user = await createUser(h.owner, { email: nextEmail('plain') });
    await requestCode({ email: user.email });
    expect((await verify(user.email, lastCode(user.email))).statusCode).toBe(200);
    const jobs = await h.owner.query('SELECT 1 FROM job_outbox WHERE user_id = $1', [user.id]);
    expect(jobs.rowCount).toBe(0);
  });
});

describe('sessions and cookies (spec 08 §2.1 "Session cookie")', () => {
  it('sets the cookie with HttpOnly, SameSite=Lax, Path=/ and Max-Age = SESSION_TTL_DAYS', async () => {
    const user = await createUser(h.owner, { email: nextEmail('cookie') });
    await requestCode({ email: user.email });
    const res = await verify(user.email, lastCode(user.email), { 'user-agent': 'cookie-test' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(new RegExp(`^${h.config.sessionCookieName}=[A-Za-z0-9_-]{43};`));
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
    expect(Math.abs(maxAge - h.config.sessionTtlDays * 86_400)).toBeLessThan(5);
    expect(cookie).not.toContain('Secure'); // NODE_ENV=test; production adds Secure (T1)
    expect(res.headers['cache-control']).toBe('private, no-store');

    const me = asUser(res, user.email);
    const list = await apiClient(h.server, me).get('/auth/sessions');
    expect(list.statusCode).toBe(200);
    const sessions = list.json<{ id: string; userAgent: string; current: boolean }[]>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ userAgent: 'cookie-test', current: true });
    expect(sessions[0]?.id).toMatch(/^\d+$/);
  });

  it('slides the session at most every 5 minutes with a refreshed cookie', async () => {
    const user = await createTestUser(h, { email: nextEmail('slide') });
    const client = apiClient(h.server, user);
    const fresh = await client.get('/auth/sessions');
    expect(fresh.headers['set-cookie']).toBeUndefined();
    await h.owner.query(
      `UPDATE sessions SET last_seen_at = now() - interval '10 minutes',
                           expires_at = now() + interval '1 day' WHERE id = $1`,
      [user.sessionId],
    );
    const slid = await client.get('/auth/sessions');
    expect(String(slid.headers['set-cookie'])).toContain(`${user.token}`);
    const { rows } = await h.owner.query<{ days: number }>(
      `SELECT round(extract(epoch FROM expires_at - now()) / 86400)::int AS days FROM sessions
        WHERE id = $1`,
      [user.sessionId],
    );
    expect(rows[0]?.days).toBe(h.config.sessionTtlDays);
  });

  it('logout revokes the session, clears the cookie, and the old cookie is refused', async () => {
    const user = await createTestUser(h, { email: nextEmail('logout') });
    const client = apiClient(h.server, user);
    // CSRF applies to logout.
    expect((await client.post('/auth/logout', undefined, { client: null })).statusCode).toBe(403);
    // No Idempotency-Key needed (authFlow).
    const res = await client.post('/auth/logout', undefined, { idempotencyKey: null });
    expect(res.statusCode).toBe(204);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toBe(
      `${h.config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    expect((await client.get('/auth/sessions')).statusCode).toBe(401);
    expect((await client.post('/auth/logout')).statusCode).toBe(401);
  });

  it('DELETE /auth/sessions/:id revokes my other session; foreign ids are 404', async () => {
    const user = await createTestUser(h, { email: nextEmail('multi') });
    const other = await createTestSession(h, user);
    const stranger = await createTestUser(h, { email: nextEmail('stranger') });
    const client = apiClient(h.server, user);

    const list = (await client.get('/auth/sessions')).json<{ id: string; current: boolean }[]>();
    expect(list.map((s) => [s.id, s.current]).sort()).toEqual(
      [
        [user.sessionId, true],
        [other.sessionId, false],
      ].sort(),
    );
    expect(list.some((s) => s.id === stranger.sessionId)).toBe(false);

    expect((await client.delete(`/auth/sessions/${stranger.sessionId}`)).statusCode).toBe(404);
    expect((await apiClient(h.server, stranger).get('/auth/sessions')).statusCode).toBe(200);
    expect((await client.delete('/auth/sessions/not-an-id')).statusCode).toBe(400);
    expect(
      (await client.delete(`/auth/sessions/${other.sessionId}`, { idempotencyKey: null }))
        .statusCode,
    ).toBe(400);
    expect(
      (await client.delete(`/auth/sessions/${other.sessionId}`, { client: null })).statusCode,
    ).toBe(403);

    const res = await client.delete(`/auth/sessions/${other.sessionId}`);
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await apiClient(h.server, other).get('/auth/sessions')).statusCode).toBe(401);
    expect((await client.get('/auth/sessions')).statusCode).toBe(200);

    // Revoking the current session also clears its cookie.
    const self = await client.delete(`/auth/sessions/${user.sessionId}`);
    expect(self.statusCode).toBe(204);
    expect(String(self.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await client.get('/auth/sessions')).statusCode).toBe(401);
  });

  it('sessions require authentication; auth mutations require the CSRF header', async () => {
    expect((await anon().get('/auth/sessions')).statusCode).toBe(401);
    for (const url of ['/auth/request-code', '/auth/verify', '/waitlist']) {
      const res = await anon().post(
        url,
        { email: 'a@example.test', code: '123456' },
        { client: null },
      );
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('privacy, timing and limits (spec 08 §1, §2.1, §11)', () => {
  it('never writes the plaintext code or the email to logs or job_outbox', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      name: 'auth-privacy',
      level: 'trace',
      destination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });
    const mailer = createCapturingMailer();
    const server = await buildServer({
      db: h.appDb,
      config: testConfig({ ADMIN_EMAILS: ADMIN, SIGNUP_MODE: 'invite' }, h.db.urls.app),
      mailer,
      logger,
      libreTranslate: null,
    });
    await server.ready();
    try {
      const user = await createUser(h.owner, {
        email: nextEmail('private'),
        deletedAt: new Date(Date.now() - 86_400_000),
      });
      const client = apiClient(server);
      expect((await client.post('/auth/request-code', { email: user.email })).statusCode).toBe(202);
      const code = mailer.sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? '';
      expect(code).toMatch(/^\d{6}$/);
      const wrong = code === '000000' ? '000001' : '000000';
      expect(
        (await client.post('/auth/verify', { email: user.email, code: wrong })).statusCode,
      ).toBe(400);
      expect((await client.post('/auth/verify', { email: user.email, code })).statusCode).toBe(200);
      // A failing SMTP delivery is logged without the address.
      mailer.failing = true;
      const uninvited = nextEmail('smtp-down');
      expect((await client.post('/auth/request-code', { email: uninvited })).statusCode).toBe(202);

      const log = lines.join('');
      expect(log).toContain('email delivery failed');
      expect(log).not.toContain(code);
      expect(log).not.toContain(user.email);
      expect(log).not.toContain(uninvited);
      const outbox = await h.owner.query<{ payload: string }>(
        'SELECT payload::text AS payload FROM job_outbox',
      );
      expect(outbox.rows.length).toBeGreaterThan(0); // the restore's user.rank intent
      for (const row of outbox.rows) {
        expect(row.payload).not.toContain(code);
        expect(row.payload).not.toContain(user.email);
      }
    } finally {
      await server.close();
    }
  });

  it('pads request-code answers to the same minimum duration whatever the outcome', async () => {
    authTiming.minResponseMs = 150;
    try {
      await setStoredMode('closed');
      for (const email of [nextEmail('timing'), (await createUser(h.owner)).email]) {
        const started = performance.now();
        await requestCode({ email });
        expect(performance.now() - started).toBeGreaterThanOrEqual(145);
      }
    } finally {
      authTiming.minResponseMs = 0;
    }
  });

  describe('with rate limits enabled', () => {
    let limited: FastifyInstance;
    beforeAll(async () => {
      limited = await h.buildAnother({
        env: { ADMIN_EMAILS: ADMIN, SIGNUP_MODE: 'invite', RATE_LIMITS_ENABLED: 'true' },
      });
    });

    const post = (url: string, ip: string, payload: Record<string, unknown>) =>
      limited.inject({
        method: 'POST',
        url: `/api/v1${url}`,
        remoteAddress: ip,
        headers: { 'x-bantoozi-client': 'web' },
        payload,
      });

    it('throttles one email to 5 codes per hour while still answering 202', async () => {
      const user = await createUser(h.owner, { email: nextEmail('throttled') });
      for (let i = 0; i < 7; i += 1) {
        const res = await post('/auth/request-code', '10.9.0.1', { email: user.email });
        expect(res.statusCode).toBe(202);
        expect(res.json()).toEqual({ next: 'check_email' });
      }
      expect(mailsTo(user.email)).toHaveLength(5);
      expect(await codeRows(user.email)).toHaveLength(5);
      // The bucket key is a keyed hash, never the address.
      const buckets = await h.owner.query<{ key: string }>('SELECT key FROM rate_limit_buckets');
      expect(buckets.rows.some((b) => b.key.includes(user.email))).toBe(false);
      expect(buckets.rows.some((b) => /^auth-request-code:email:[0-9a-f]{64}$/.test(b.key))).toBe(
        true,
      );
    });

    it('limits request-code to 20 per hour per IP with 429', async () => {
      for (let i = 0; i < 20; i += 1) {
        const res = await post('/auth/request-code', '10.9.0.2', { email: nextEmail('ip') });
        expect(res.statusCode).toBe(202);
      }
      const email = nextEmail('ip');
      const res = await post('/auth/request-code', '10.9.0.2', { email });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(mailsTo(email)).toHaveLength(0);
      expect((await post('/auth/request-code', '10.9.0.3', { email })).statusCode).toBe(202);
    });

    it('limits verify to 10 per 10 minutes per IP', async () => {
      for (let i = 0; i < 10; i += 1) {
        const res = await post('/auth/verify', '10.9.0.4', {
          email: nextEmail('v'),
          code: '123456',
        });
        expect(res.statusCode).toBe(400);
      }
      const res = await post('/auth/verify', '10.9.0.4', { email: nextEmail('v'), code: '123456' });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    });
  });
});
