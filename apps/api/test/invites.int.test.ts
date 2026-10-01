import { randomUUID } from 'node:crypto';

import { createUser } from '@bantoozi/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/** M4-T2 (spec 08 §2.2): invites, the invite email after commit, and the public waitlist. */

let h: ApiHarness;
let seq = 0;
const nextEmail = (prefix = 'friend') => `${prefix}-${++seq}@example.test`;

beforeAll(async () => {
  h = await createApiHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

afterEach(() => {
  h.mailer.failing = false;
});

async function setInvitesLeft(user: TestUser, n: number): Promise<void> {
  await h.owner.query('UPDATE users SET invites_left = $2 WHERE id = $1', [user.id, n]);
}

async function invitesLeft(user: TestUser): Promise<number> {
  const { rows } = await h.owner.query<{ n: number }>(
    'SELECT invites_left AS n FROM users WHERE id = $1',
    [user.id],
  );
  return rows[0]?.n ?? -1;
}

async function invitesOf(user: TestUser) {
  const { rows } = await h.owner.query<{
    code: string;
    email: string | null;
    note: string | null;
    days: number;
  }>(
    `SELECT code, email::text, note,
            round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
       FROM invites WHERE created_by = $1 ORDER BY created_at`,
    [user.id],
  );
  return rows;
}

describe('POST /invites', () => {
  it('creates a Crockford base32 invite for 30 days and decrements invites_left', async () => {
    const user = await createTestUser(h, { email: nextEmail('inviter') });
    await setInvitesLeft(user, 3);
    const res = await apiClient(h.server, user).post('/invites', { note: 'for Ann' });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ code: string; url: string; emailSent?: boolean }>();
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(body.url).toBe(`http://localhost:5173/join?code=${body.code}`);
    expect(body).not.toHaveProperty('emailSent');
    expect(await invitesLeft(user)).toBe(2);
    expect(await invitesOf(user)).toEqual([
      { code: body.code, email: null, note: 'for Ann', days: 30 },
    ]);
    expect(h.mailer.sent.filter((m) => m.text.includes(body.code))).toHaveLength(0);
  });

  it('emails the invite after commit when an email is given', async () => {
    const user = await createTestUser(h, { email: nextEmail('inviter'), locale: 'sk' });
    await h.owner.query(`UPDATE users SET display_name = 'Martin <b>' WHERE id = $1`, [user.id]);
    await setInvitesLeft(user, 1);
    const to = nextEmail('friend');
    const res = await apiClient(h.server, user).post('/invites', { email: ` ${to.toUpperCase()}` });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ code: string; url: string; emailSent?: boolean }>();
    expect(body.emailSent).toBe(true);
    const mail = h.mailer.sent.filter((m) => m.to === to).at(-1);
    expect(mail?.subject).toBe('Pozvánka do Bantoozi');
    expect(mail?.text).toContain(body.url);
    expect(mail?.html).toContain(`href="http://localhost:5173/join?code=${body.code}"`);
    expect(mail?.html).toContain('Martin &lt;b&gt;');
    expect((await invitesOf(user))[0]?.email).toBe(to);
    // Codes never enter the outbox.
    const outbox = await h.owner.query<{ payload: string }>(
      'SELECT payload::text AS payload FROM job_outbox',
    );
    expect(outbox.rows.some((r) => r.payload.includes(body.code))).toBe(false);
  });

  it('keeps the invite and answers emailSent:false when the email cannot be sent', async () => {
    const user = await createTestUser(h, { email: nextEmail('inviter') });
    await setInvitesLeft(user, 2);
    h.mailer.failing = true;
    const res = await apiClient(h.server, user).post('/invites', { email: nextEmail('friend') });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ code: string; url: string; emailSent?: boolean }>();
    expect(body.emailSent).toBe(false);
    expect(await invitesLeft(user)).toBe(1);
    const list = await apiClient(h.server, user).get('/invites');
    expect(list.json<{ items: { code: string; url: string }[] }>().items).toEqual([
      expect.objectContaining({ code: body.code, url: body.url }),
    ]);
  });

  it('a replayed Idempotency-Key returns the saved invite without another email or slot', async () => {
    const user = await createTestUser(h, { email: nextEmail('inviter') });
    await setInvitesLeft(user, 3);
    const to = nextEmail('friend');
    const key = randomUUID();
    const client = apiClient(h.server, user);
    const first = await client.post('/invites', { email: to }, { idempotencyKey: key });
    const again = await client.post('/invites', { email: to }, { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual({
      code: first.json<{ code: string }>().code,
      url: first.json<{ url: string }>().url,
    });
    expect(h.mailer.sent.filter((m) => m.to === to)).toHaveLength(1);
    expect(await invitesLeft(user)).toBe(2);
    const other = await client.post('/invites', { email: nextEmail() }, { idempotencyKey: key });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('refuses without invites left (409 QUOTA_EXCEEDED)', async () => {
    const user = await createTestUser(h, { email: nextEmail('inviter') });
    await setInvitesLeft(user, 0);
    const to = nextEmail();
    const res = await apiClient(h.server, user).post('/invites', { email: to });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'QUOTA_EXCEEDED', details: { limit: 'invites' } },
    });
    expect(await invitesOf(user)).toEqual([]);
    expect(h.mailer.sent.filter((m) => m.to === to)).toEqual([]);
  });

  it('two requests for the last slot: exactly one invite', async () => {
    const user = await createTestUser(h, { email: nextEmail('inviter') });
    await setInvitesLeft(user, 1);
    const client = apiClient(h.server, user);
    const results = await Promise.all([
      client.post('/invites', {}),
      client.post('/invites', {}),
      client.post('/invites', {}),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await invitesLeft(user)).toBe(0);
    expect(await invitesOf(user)).toHaveLength(1);
  });

  it('validates the body and requires a session, CSRF and an Idempotency-Key', async () => {
    const user = await createTestUser(h, { email: nextEmail('inviter') });
    await setInvitesLeft(user, 5);
    const client = apiClient(h.server, user);
    for (const body of [
      { email: 'nope' },
      { note: 'x'.repeat(501) },
      { extra: true },
      { email: `${'a'.repeat(250)}@example.test` },
    ]) {
      expect((await client.post('/invites', body)).statusCode).toBe(400);
    }
    expect((await client.post('/invites', {}, { idempotencyKey: null })).statusCode).toBe(400);
    expect((await client.post('/invites', {}, { client: null })).statusCode).toBe(403);
    expect((await apiClient(h.server).post('/invites', {})).statusCode).toBe(401);
    expect(await invitesLeft(user)).toBe(5);
  });
});

describe('GET /invites', () => {
  it("lists only the caller's invites with url and invitesLeft", async () => {
    const alice = await createTestUser(h, { email: nextEmail('alice') });
    const bob = await createTestUser(h, { email: nextEmail('bob') });
    await setInvitesLeft(alice, 3);
    await setInvitesLeft(bob, 3);
    const a = apiClient(h.server, alice);
    const created = await a.post('/invites', { email: nextEmail() });
    await apiClient(h.server, bob).post('/invites', {});
    const invitee = await createUser(h.owner);
    await h.owner.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE code = $1', [
      created.json<{ code: string }>().code,
      invitee.id,
    ]);

    const res = await a.get('/invites');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.json<{
      items: { code: string; email: string; usedAt: string | null; url: string }[];
      invitesLeft: number;
    }>();
    expect(body.invitesLeft).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      code: created.json<{ code: string }>().code,
      url: created.json<{ url: string }>().url,
    });
    expect(body.items[0]?.usedAt).not.toBeNull();
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      ['code', 'createdAt', 'email', 'expiresAt', 'url', 'usedAt'].sort(),
    );
    expect((await apiClient(h.server).get('/invites')).statusCode).toBe(401);
  });
});

describe('POST /waitlist', () => {
  async function waitlistRow(email: string) {
    const { rows } = await h.owner.query<{ locale: string; note: string | null; n: number }>(
      `SELECT locale, note, count(*) OVER ()::int AS n FROM waitlist WHERE email = $1`,
      [email],
    );
    return rows[0];
  }

  it('upserts without revealing whether the address is known', async () => {
    const email = nextEmail('wait');
    const anon = apiClient(h.server);
    const first = await anon.post('/waitlist', { email, note: 'RSS fan' });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ next: 'waitlisted' });
    expect(await waitlistRow(email)).toEqual({ locale: 'en', note: 'RSS fan', n: 1 });

    const second = await anon.post('/waitlist', { email: email.toUpperCase(), locale: 'sk' });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(await waitlistRow(email)).toEqual({ locale: 'sk', note: 'RSS fan', n: 1 });

    // An existing account answers identically and is not listed.
    const user = await createUser(h.owner);
    const known = await anon.post('/waitlist', { email: user.email });
    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual(first.json());
    expect(await waitlistRow(user.email)).toBeUndefined();

    // Accept-Language decides when no locale is given.
    const email2 = nextEmail('wait');
    await anon.post('/waitlist', { email: email2 }, { headers: { 'accept-language': 'sk-SK' } });
    expect((await waitlistRow(email2))?.locale).toBe('sk');
  });

  it('validates the body strictly', async () => {
    const anon = apiClient(h.server);
    for (const body of [
      {},
      { email: 'x' },
      { email: 'a@example.test', note: 'x'.repeat(501) },
      { email: 'a@example.test', extra: 1 },
    ]) {
      expect((await anon.post('/waitlist', body)).statusCode).toBe(400);
    }
  });

  it('is limited to 5 per hour per IP', async () => {
    const limited = await h.buildAnother({ env: { RATE_LIMITS_ENABLED: 'true' } });
    const post = (email: string) =>
      limited.inject({
        method: 'POST',
        url: '/api/v1/waitlist',
        remoteAddress: '10.8.0.1',
        headers: { 'x-bantoozi-client': 'web' },
        payload: { email },
      });
    for (let i = 0; i < 5; i += 1) expect((await post(nextEmail('wl'))).statusCode).toBe(202);
    const res = await post(nextEmail('wl'));
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
