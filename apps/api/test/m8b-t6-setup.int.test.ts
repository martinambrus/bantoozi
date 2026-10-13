import { Writable } from 'node:stream';

import { createLogger } from '@bantoozi/shared/server';
import { createUser } from '@bantoozi/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server.js';
import {
  apiClient,
  createApiHarness,
  createCapturingMailer,
  testConfig,
  type ApiHarness,
} from './support/harness.js';

/**
 * M8b-T6 (scope §A1, one-step variant): the first-run setup token. While no active admin exists the
 * API generates a 256-bit token at start (server `ready`), stores only its keyed digest in
 * `settings.auth.setup` and logs it once; `POST /setup/complete {token, email}` creates the admin and
 * a session.
 *
 * Rules chosen here (tests below encode them):
 *  - Existing ACTIVE user with the email (any role): promoted to admin and signed in, no second row.
 *    Possession of the token is operator authority; inserting would violate email uniqueness.
 *  - A wrong token and a closed setup both answer the same generic 4xx, never 5xx, no side effects.
 *  - Setup works in every signup mode and ignores ADMIN_EMAILS/invites.
 *  - Token log line: warn level through the API logger; if LOG_LEVEL hides warn, it goes to stderr.
 */

let h: ApiHarness;
const servers: FastifyInstance[] = [];
let seq = 0;
const nextEmail = (p = 'first') => `${p}-${++seq}@example.test`;

beforeAll(async () => {
  h = await createApiHarness({ env: { SIGNUP_MODE: 'closed' } });
}, 120_000);

afterAll(async () => {
  for (const s of servers) await s.close();
  await h?.close();
});

beforeEach(async () => {
  await h.owner.query(`DELETE FROM sessions`);
  await h.owner.query(`DELETE FROM users`);
  await h.owner.query(`DELETE FROM waitlist`);
  await h.owner.query(`DELETE FROM settings WHERE key IN ('auth.setup', 'signup_mode')`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Started {
  server: FastifyInstance;
  lines: string[];
  token: () => string;
}

/** Builds (and starts: `ready`) an API over the shared database with its log captured. */
async function startApi(
  env: Record<string, string> = {},
  level: 'trace' | 'warn' = 'warn',
): Promise<Started> {
  const lines: string[] = [];
  const logger = createLogger({
    name: 'setup-test',
    level,
    destination: new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  });
  const server = await buildServer({
    db: h.appDb,
    config: testConfig({ SIGNUP_MODE: 'closed', ...env }, h.db.urls.app),
    mailer: createCapturingMailer(),
    logger,
    libreTranslate: null,
  });
  await server.ready();
  servers.push(server);
  return { server, lines, token: () => tokenFrom(lines) };
}

const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

function tokenFrom(chunks: readonly string[]): string {
  const found = chunks.flatMap((c) => c.match(TOKEN_RE) ?? []);
  const last = found.at(-1);
  if (last === undefined) throw new Error('no setup token in the captured log');
  return last;
}

const complete = (s: FastifyInstance, body: Record<string, unknown>, ip?: string) =>
  s.inject({
    method: 'POST',
    url: '/api/v1/setup/complete',
    headers: { 'x-bantoozi-client': 'web' },
    ...(ip === undefined ? {} : { remoteAddress: ip }),
    payload: body,
  });

async function users(email?: string) {
  const { rows } = await h.owner.query<{ id: string; email: string; role: string }>(
    email === undefined
      ? `SELECT id::text, email, role FROM users`
      : `SELECT id::text, email, role FROM users WHERE email = $1`,
    email === undefined ? [] : [email],
  );
  return rows;
}

async function sessionCount(): Promise<number> {
  const { rows } = await h.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions`);
  return rows[0]?.n ?? 0;
}

function hasSessionCookie(res: LightMyRequestResponse): boolean {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header.join('\n') : String(header ?? '');
  return new RegExp(`${h.config.sessionCookieName}=[^;]+`).test(value);
}

async function seedAdmin(): Promise<void> {
  await createUser(h.owner, { email: nextEmail('admin'), role: 'admin' });
}

describe('token lifecycle at start', () => {
  it('without an admin: logs a 256-bit token once and stores only its digest in auth.setup', async () => {
    const a = await startApi();
    const token = a.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.lines.join('').split(token).length - 1).toBe(1);
    const { rows } = await h.owner.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM settings WHERE key = 'auth.setup'`,
    );
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows[0]?.value);
    expect(stored).not.toContain(token);
    expect(rows[0]?.value).toMatchObject({
      digest: expect.any(String),
      createdAt: expect.any(String),
    });
    expect(rows[0]?.value).not.toHaveProperty('consumedAt');
  });

  it('logs at warn level as JSON (a warn-level logger sees it)', async () => {
    const a = await startApi({}, 'warn');
    const line = a.lines.find((l) => l.includes(a.token()));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? '{}')).toMatchObject({ level: 40 });
  });

  it('writes the token to stderr when the log level would hide warn', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const lines: string[] = [];
    const logger = createLogger({
      name: 'setup-test',
      level: 'error',
      destination: new Writable({
        write(c, _e, cb) {
          lines.push(String(c));
          cb();
        },
      }),
    });
    const server = await buildServer({
      db: h.appDb,
      config: testConfig({ SIGNUP_MODE: 'closed', LOG_LEVEL: 'error' }, h.db.urls.app),
      mailer: createCapturingMailer(),
      logger,
      libreTranslate: null,
    });
    await server.ready();
    servers.push(server);
    const token = tokenFrom(stderr);
    expect(lines.join('')).not.toContain(token);
    const res = await complete(server, { token, email: nextEmail() });
    expect(res.statusCode).toBe(200);
  });

  it('an API restart rotates the token: the old one fails, the newest works', async () => {
    const a = await startApi();
    const oldToken = a.token();
    const b = await startApi();
    const newToken = b.token();
    expect(newToken).not.toBe(oldToken);
    const email = nextEmail();
    const bad = await complete(b.server, { token: oldToken, email });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.statusCode).toBeLessThan(500);
    expect(await users()).toHaveLength(0);
    expect((await complete(b.server, { token: newToken, email })).statusCode).toBe(200);
  });

  it('with an admin present: no token is generated, stored or logged', async () => {
    await seedAdmin();
    const a = await startApi({}, 'trace');
    expect(a.lines.join('')).not.toMatch(TOKEN_RE);
    const { rowCount } = await h.owner.query(`SELECT 1 FROM settings WHERE key = 'auth.setup'`);
    expect(rowCount).toBe(0);
  });

  it('a soft-deleted admin does not count: setup is open again after a restart', async () => {
    await seedAdmin();
    await h.owner.query(`UPDATE users SET deleted_at = now() WHERE role = 'admin'`);
    const a = await startApi();
    expect(a.token()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const res = await apiClient(a.server).get('/setup');
    expect(res.json()).toEqual({ open: true });
  });
});

describe('GET /setup', () => {
  it('is open without an admin and closed with one', async () => {
    const a = await startApi();
    const open = await apiClient(a.server).get('/setup');
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ open: true });
    await seedAdmin();
    expect((await apiClient(a.server).get('/setup')).json()).toEqual({ open: false });
  });

  it('is closed when started with an admin', async () => {
    await seedAdmin();
    const a = await startApi();
    expect((await apiClient(a.server).get('/setup')).json()).toEqual({ open: false });
  });
});

describe('POST /setup/complete', () => {
  it.each(['closed', 'invite', 'open'] as const)(
    'creates the admin and a session in %s signup mode, without an invite',
    async (mode) => {
      const a = await startApi({ SIGNUP_MODE: mode });
      const email = nextEmail();
      await h.owner.query(`INSERT INTO waitlist (email) VALUES ($1)`, [email]);
      const res = await complete(a.server, { token: a.token(), email: email.toUpperCase() });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ user: { role: string; email: string } }>().user).toMatchObject({
        role: 'admin',
        email,
      });
      expect(hasSessionCookie(res)).toBe(true);
      expect(await users(email)).toMatchObject([{ role: 'admin' }]);
      expect(await sessionCount()).toBe(1);
      expect(
        (await h.owner.query('SELECT 1 FROM waitlist WHERE email = $1', [email])).rowCount,
      ).toBe(0);
      expect(
        (await h.owner.query('SELECT 1 FROM invites WHERE used_at IS NOT NULL')).rowCount,
      ).toBe(0);
      // the cookie is a working session
      const me = await a.server.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: String(res.headers['set-cookie']).split(';')[0] ?? '' },
      });
      expect(me.statusCode).toBe(200);
    },
  );

  it('a wrong token is a 4xx with no user, no session and no cookie', async () => {
    const a = await startApi();
    const email = nextEmail();
    for (const token of ['x'.repeat(43), '', 'short']) {
      const res = await complete(a.server, { token, email });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(hasSessionCookie(res)).toBe(false);
    }
    expect(await users()).toHaveLength(0);
    expect(await sessionCount()).toBe(0);
    // negative control: the right token still works afterwards (the failures did not burn it)
    expect((await complete(a.server, { token: a.token(), email })).statusCode).toBe(200);
  });

  it('requires the CSRF header and a valid email', async () => {
    const a = await startApi();
    const noCsrf = await a.server.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      payload: { token: a.token(), email: nextEmail() },
    });
    expect(noCsrf.statusCode).toBe(403);
    const badEmail = await complete(a.server, { token: a.token(), email: 'not-an-email' });
    expect(badEmail.statusCode).toBe(400);
    expect(await users()).toHaveLength(0);
  });

  it('is single use: a second complete fails and setup closes', async () => {
    const a = await startApi();
    const token = a.token();
    expect((await complete(a.server, { token, email: nextEmail() })).statusCode).toBe(200);
    const second = await complete(a.server, { token, email: nextEmail('second') });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeLessThan(500);
    expect(hasSessionCookie(second)).toBe(false);
    expect(await users()).toHaveLength(1);
    expect((await apiClient(a.server).get('/setup')).json()).toEqual({ open: false });
    const { rows } = await h.owner.query<{ value: { consumedAt?: string; userId?: string } }>(
      `SELECT value FROM settings WHERE key = 'auth.setup'`,
    );
    expect(rows[0]?.value.consumedAt).toBeDefined();
    expect(rows[0]?.value.userId).toBe((await users())[0]?.id);
  });

  it('two concurrent completes with the right token create exactly one admin', async () => {
    const a = await startApi();
    const b = await startApi(); // a second instance rotates; use the newest token on both
    void a;
    const token = b.token();
    const results = await Promise.all([
      complete(b.server, { token, email: nextEmail('race-a') }),
      complete(b.server, { token, email: nextEmail('race-b') }),
      complete(a.server, { token, email: nextEmail('race-c') }),
    ]);
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 200)) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
    }
    expect((await users()).filter((u) => u.role === 'admin')).toHaveLength(1);
    expect(await users()).toHaveLength(1);
    expect(await sessionCount()).toBe(1);
  });

  it('an existing active non-admin user with the email is promoted (same row) and signed in', async () => {
    const a = await startApi();
    const existing = await createUser(h.owner, { email: nextEmail('existing'), role: 'user' });
    const res = await complete(a.server, { token: a.token(), email: existing.email });
    expect(res.statusCode).toBe(200);
    const rows = await users(existing.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: existing.id, role: 'admin' });
    expect(hasSessionCookie(res)).toBe(true);
  });

  it('the token never appears in a response, receipt, outbox row, mutation row or stored setting', async () => {
    const a = await startApi();
    const token = a.token();
    const email = nextEmail();
    const bad = await complete(a.server, { token: 'y'.repeat(43), email });
    const good = await complete(a.server, { token, email });
    const get = await apiClient(a.server).get('/setup');
    for (const r of [bad, good, get]) {
      expect(r.body).not.toContain(token);
      expect(JSON.stringify(r.headers)).not.toContain(token);
    }
    for (const table of ['job_outbox', 'api_mutations', 'settings', 'users', 'sessions']) {
      const { rows } = await h.owner.query<{ t: string }>(`SELECT t::text AS t FROM ${table} t`);
      expect(rows.map((r) => r.t).join('\n')).not.toContain(token);
    }
    // no other log line (after the one start-up line) repeats it either
    expect(a.lines.join('').split(token).length - 1).toBe(1);
  });

  it('is not an idempotent-mutation endpoint: no Idempotency-Key is required', async () => {
    const a = await startApi();
    const res = await apiClient(a.server).post(
      '/setup/complete',
      { token: a.token(), email: nextEmail() },
      { idempotencyKey: null },
    );
    expect(res.statusCode).toBe(200);
  });
});

describe('rate limit', () => {
  it('limits complete to 10 per 15 minutes per IP with 429, even with wrong tokens', async () => {
    const a = await startApi({ RATE_LIMITS_ENABLED: 'true' });
    for (let i = 0; i < 10; i += 1) {
      const res = await complete(
        a.server,
        { token: 'z'.repeat(43), email: nextEmail('rl') },
        '10.8.0.1',
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(429);
    }
    const limited = await complete(
      a.server,
      { token: a.token(), email: nextEmail('rl') },
      '10.8.0.1',
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(await users()).toHaveLength(0);
    // negative control: another IP is unaffected
    const other = await complete(
      a.server,
      { token: a.token(), email: nextEmail('rl') },
      '10.8.0.2',
    );
    expect(other.statusCode).toBe(200);
  });
});
