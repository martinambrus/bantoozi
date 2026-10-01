import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * Admin invite creation and waitlist invitations (spec 08 §9, §2.2): invites commit in the
 * mutation, the email is sent after commit and never re-sent on replay, and an SMTP failure keeps
 * the invite with `emailSent: false`.
 */

let h: ApiHarness;
let admin: TestUser;
let reader: TestUser;

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.mailer.failing = false;
});

async function invitesBy(userId: string) {
  const result = await h.owner.query<{ code: string; email: string | null; days: number }>(
    `SELECT code, email::text AS email,
            round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
       FROM invites WHERE created_by = $1 ORDER BY code`,
    [userId],
  );
  return result.rows;
}

describe('POST /admin/invites', () => {
  it('creates up to 50 unbound invites with the chosen expiry, admin-only', async () => {
    const client = apiClient(h.server, admin);
    const res = await client.post('/admin/invites', { count: 3, expiresDays: 90, note: 'batch' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    expect(body.emailSent).toBeUndefined();
    for (const item of body.items) {
      expect(item.url).toBe(`http://localhost:5173/join?code=${item.code}`);
      expect(item.email).toBeNull();
    }
    const stored = await invitesBy(admin.id);
    expect(stored.map((r) => r.days)).toEqual([90, 90, 90]);

    expect(
      (await apiClient(h.server, reader).post('/admin/invites', { count: 1 })).statusCode,
    ).toBe(403);
    expect((await client.post('/admin/invites', { count: 51 })).statusCode).toBe(400);
    expect((await client.post('/admin/invites', { count: 1, expiresDays: 91 })).statusCode).toBe(
      400,
    );
    expect(
      (await client.post('/admin/invites', { count: 2, email: 'two@example.test' })).statusCode,
    ).toBe(400);
    expect((await client.post('/admin/invites', { count: 1, extra: true })).statusCode).toBe(400);
  });

  it('emails a bound invite after commit, once, and reports an SMTP failure', async () => {
    const client = apiClient(h.server, admin);
    const key = randomUUID();
    const to = 'bound-admin@example.test';
    const first = await client.post('/admin/invites', { email: to }, { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    expect(first.json().emailSent).toBe(true);
    const code = first.json().items[0].code as string;
    expect(first.json().items[0].email).toBe(to);
    expect(h.mailer.sent.filter((m) => m.to === to)).toHaveLength(1);
    expect(h.mailer.sent.at(-1)!.text).toContain(code);

    const replay = await client.post('/admin/invites', { email: to }, { idempotencyKey: key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().items[0].code).toBe(code);
    expect(h.mailer.sent.filter((m) => m.to === to)).toHaveLength(1);

    h.mailer.failing = true;
    const failed = await client.post('/admin/invites', { email: 'smtp-down@example.test' });
    expect(failed.statusCode).toBe(201);
    expect(failed.json().emailSent).toBe(false);
    const kept = await h.owner.query('SELECT 1 FROM invites WHERE code = $1', [
      failed.json().items[0].code,
    ]);
    expect(kept.rowCount).toBe(1);
    const outbox = await h.owner.query<{ payload: unknown }>('SELECT payload FROM job_outbox');
    expect(JSON.stringify(outbox.rows)).not.toContain(code);
  });
});

describe('POST /admin/waitlist/:id/invite', () => {
  async function waitlistEntry(email: string, locale: 'en' | 'sk'): Promise<string> {
    const result = await h.owner.query<{ id: string }>(
      'INSERT INTO waitlist (email, locale) VALUES ($1, $2) RETURNING id::text AS id',
      [email, locale],
    );
    return result.rows[0]!.id;
  }

  it('binds an invite to the entry, records it, and emails it in the entry locale', async () => {
    const to = 'waiting-sk@example.test';
    const id = await waitlistEntry(to, 'sk');
    const client = apiClient(h.server, admin);
    const key = randomUUID();
    const res = await client.post(`/admin/waitlist/${id}/invite`, {}, { idempotencyKey: key });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emailSent).toBe(true);
    expect(body.invite.email).toBe(to);
    expect(body.entry).toEqual(
      expect.objectContaining({ id, email: to, locale: 'sk', inviteCode: body.invite.code }),
    );
    expect(body.entry.invitedAt).not.toBeNull();
    const mail = h.mailer.sent.filter((m) => m.to === to);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain(body.invite.code);
    const stored = await h.owner.query<{ invite_code: string; email: string }>(
      `SELECT w.invite_code, i.email::text AS email
         FROM waitlist w JOIN invites i ON i.code = w.invite_code WHERE w.id = $1`,
      [id],
    );
    expect(stored.rows[0]).toEqual({ invite_code: body.invite.code, email: to });

    const replay = await client.post(`/admin/waitlist/${id}/invite`, {}, { idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().invite.code).toBe(body.invite.code);
    expect(replay.json().emailSent).toBeUndefined();
    expect(h.mailer.sent.filter((m) => m.to === to)).toHaveLength(1);
  });

  it('refuses to invite an email that already has an account', async () => {
    const id = await waitlistEntry(reader.email, 'en');
    const client = apiClient(h.server, admin);
    const res = await client.post(`/admin/waitlist/${id}/invite`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ reason: 'account_exists' });
    const stored = await h.owner.query<{ invite_code: string | null }>(
      'SELECT invite_code FROM waitlist WHERE id = $1',
      [id],
    );
    expect(stored.rows[0]!.invite_code).toBeNull();
    expect(h.mailer.sent.filter((m) => m.to === reader.email)).toHaveLength(0);
  });

  it('keeps the invite when SMTP fails, 404s unknown entries and refuses non-admins', async () => {
    const to = 'waiting-en@example.test';
    const id = await waitlistEntry(to, 'en');
    const client = apiClient(h.server, admin);
    h.mailer.failing = true;
    const res = await client.post(`/admin/waitlist/${id}/invite`);
    expect(res.statusCode).toBe(200);
    expect(res.json().emailSent).toBe(false);
    expect(res.json().entry.inviteCode).toBe(res.json().invite.code);
    h.mailer.failing = false;

    expect((await client.post('/admin/waitlist/999999999/invite')).statusCode).toBe(404);
    expect((await client.post('/admin/waitlist/abc/invite')).statusCode).toBe(400);
    expect(
      (await apiClient(h.server, reader).post(`/admin/waitlist/${id}/invite`)).statusCode,
    ).toBe(403);
    expect(
      (await client.post(`/admin/waitlist/${id}/invite`, {}, { client: null })).statusCode,
    ).toBe(403);
  });
});
