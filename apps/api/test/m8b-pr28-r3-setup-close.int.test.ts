import { Writable } from 'node:stream';

import { createLogger } from '@bantoozi/shared/server';
import { createUser } from '@bantoozi/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authTiming } from '../src/services/auth.js';
import { buildServer } from '../src/server.js';
import {
  apiClient,
  createApiHarness,
  createCapturingMailer,
  createTestSession,
  testConfig,
  type ApiHarness,
  type CapturingMailer,
} from './support/harness.js';

/**
 * PR #28 review round 3: an open `auth.setup` token must not outlive the moment an active admin
 * exists. Every path that makes an active admin closes it under the `bantoozi:setup` lock, so a
 * token logged earlier cannot become redeemable again if the last admin is deleted later.
 * Closed form: the strict schema's consumed shape (`consumedAt` + `userId`, no digest), which
 * `POST /setup/complete` answers with the generic refusal (the API role cannot DELETE settings).
 */

const LISTED = 'listed-r3@example.test';
let h: ApiHarness;
const servers: FastifyInstance[] = [];
let seq = 0;
const nextEmail = (p = 'r3') => `${p}-${++seq}@example.test`;

beforeAll(async () => {
  authTiming.minResponseMs = 0;
  h = await createApiHarness({ env: { SIGNUP_MODE: 'invite', ADMIN_EMAILS: LISTED } });
}, 120_000);

afterAll(async () => {
  for (const s of servers) await s.close();
  await h?.close();
});

beforeEach(async () => {
  await h.owner.query(`DELETE FROM sessions`);
  await h.owner.query(`DELETE FROM users`);
  await h.owner.query(`DELETE FROM settings WHERE key IN ('auth.setup', 'signup_mode')`);
});

const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

async function startApi(): Promise<{
  server: FastifyInstance;
  mailer: CapturingMailer;
  token: () => string;
}> {
  const lines: string[] = [];
  const mailer = createCapturingMailer();
  const server = await buildServer({
    db: h.appDb,
    config: testConfig({ SIGNUP_MODE: 'invite', ADMIN_EMAILS: LISTED }, h.db.urls.app),
    mailer,
    logger: createLogger({
      name: 'setup-r3',
      level: 'warn',
      destination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    }),
    libreTranslate: null,
  });
  await server.ready();
  servers.push(server);
  return {
    server,
    mailer,
    token: () => {
      const found = lines.flatMap((l) => l.match(TOKEN_RE) ?? []).at(-1);
      if (found === undefined) throw new Error('no setup token logged');
      return found;
    },
  };
}

const complete = (s: FastifyInstance, body: Record<string, unknown>) =>
  s.inject({
    method: 'POST',
    url: '/api/v1/setup/complete',
    headers: { 'x-bantoozi-client': 'web' },
    payload: body,
  });

async function setupRow(): Promise<Record<string, unknown> | undefined> {
  const { rows } = await h.owner.query<{ value: Record<string, unknown> }>(
    `SELECT value FROM settings WHERE key = 'auth.setup'`,
  );
  return rows[0]?.value;
}
const isOpen = async (): Promise<boolean> => (await setupRow())?.['digest'] !== undefined;

async function adminCount(): Promise<number> {
  const { rows } = await h.owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL`,
  );
  return rows[0]?.n ?? -1;
}

async function loginAs(a: { server: FastifyInstance; mailer: CapturingMailer }, email: string) {
  const client = apiClient(a.server);
  expect((await client.post('/auth/request-code', { email })).statusCode).toBe(202);
  const code = a.mailer.sent
    .filter((m) => m.to === email)
    .at(-1)
    ?.text.match(/\b(\d{6})\b/)?.[1];
  return client.post('/auth/verify', { email, code });
}

/** Opens setup with a known digest, as an earlier start would have left it. */
async function seedOpenRow(a: { token: () => string }): Promise<string> {
  return a.token();
}

describe('an open setup token is closed once an active admin exists', () => {
  it('ADMIN_EMAILS bootstrap closes it; deleting that admin later does not revive the old token', async () => {
    const a = await startApi();
    const token = await seedOpenRow(a);
    expect(await isOpen()).toBe(true);

    const login = await loginAs(a, LISTED);
    expect(login.statusCode, login.body).toBe(200);
    expect(await adminCount()).toBe(1);
    expect(await isOpen()).toBe(false);

    await h.owner.query(`UPDATE users SET deleted_at = now() WHERE role = 'admin'`);
    const email = nextEmail();
    const res = await complete(a.server, { token, email });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, res.body).toBeLessThan(500);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
    expect(await adminCount()).toBe(0);
    const { rowCount } = await h.owner.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    expect(rowCount).toBe(0);
  });

  it('negative control: without the admin step the same token still works', async () => {
    const a = await startApi();
    const token = await seedOpenRow(a);
    const res = await complete(a.server, { token, email: nextEmail() });
    expect(res.statusCode).toBe(200);
    expect(await adminCount()).toBe(1);
  });

  it('a start with an active admin present clears an open row', async () => {
    const a = await startApi();
    const token = await seedOpenRow(a);
    expect(await isOpen()).toBe(true);
    await createUser(h.owner, { email: nextEmail('boss'), role: 'admin' });
    const b = await startApi();
    expect(await isOpen()).toBe(false);
    await h.owner.query(`UPDATE users SET deleted_at = now() WHERE role = 'admin'`);
    const res = await complete(b.server, { token, email: nextEmail() });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await adminCount()).toBe(0);
  });

  it('a consumed row is left as it is by a start with an admin', async () => {
    const a = await startApi();
    const token = a.token();
    expect((await complete(a.server, { token, email: nextEmail() })).statusCode).toBe(200);
    const before = await setupRow();
    expect(before).toHaveProperty('consumedAt');
    await startApi();
    expect(await setupRow()).toEqual(before);
  });

  it('promoting a user to admin through the admin users API closes it', async () => {
    const a = await startApi();
    await seedOpenRow(a);
    const actor = await createTestSession(
      h,
      await createUser(h.owner, { email: nextEmail('actor'), role: 'admin' }),
    );
    const target = await createUser(h.owner, { email: nextEmail('target'), role: 'user' });
    // The admin created above did not pass through a service: the row is still open.
    expect(await isOpen()).toBe(true);
    const plan = await apiClient(a.server, actor).patch(`/admin/users/${target.id}`, {
      invitesLeft: 3,
    });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(await isOpen()).toBe(true);
    const res = await apiClient(a.server, actor).patch(`/admin/users/${target.id}`, {
      role: 'admin',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await isOpen()).toBe(false);
  });

  it('restoring a soft-deleted admin closes it', async () => {
    const a = await startApi();
    await seedOpenRow(a);
    const email = nextEmail('restored');
    await createUser(h.owner, { email, role: 'admin', deletedAt: new Date() });
    expect(await isOpen()).toBe(true);
    const login = await loginAs(a, email);
    expect(login.statusCode, login.body).toBe(200);
    expect(await adminCount()).toBe(1);
    expect(await isOpen()).toBe(false);
  });
});
