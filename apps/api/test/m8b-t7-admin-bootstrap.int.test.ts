import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authTiming } from '../src/services/auth.js';
import {
  apiClient,
  createApiHarness,
  createTestSession,
  type ApiHarness,
} from './support/harness.js';

/**
 * M8b-T7 (owner 2026-10-13, scope §A2): `ADMIN_EMAILS` is bootstrap only.
 *
 * Rule chosen: verify computes `admin = listed && (creatingAccount || noActiveAdmin)`, evaluated under
 * the setup advisory lock `bantoozi:setup` (packages/db/src/api/setup.ts `lockSetup`). A restore of a
 * soft-deleted account is not a creation. `adminBootstrap` in the admin user DTO stays a boolean
 * ("listed in ADMIN_EMAILS") but is informational only: it no longer predicts the role.
 */

const LISTED_A = 'listed-a@example.test';
const LISTED_B = 'listed-b@example.test';
const LISTED_NEW = 'listed-new@example.test';
let h: ApiHarness;
let seq = 0;
const nextEmail = (p = 'user') => `${p}-${++seq}@example.test`;
const anon = () => apiClient(h.server);

beforeAll(async () => {
  authTiming.minResponseMs = 0;
  h = await createApiHarness({
    env: {
      ADMIN_EMAILS: `${LISTED_A}, ${LISTED_B}, ${LISTED_NEW}`,
      SIGNUP_MODE: 'invite',
    },
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await h.owner.query(`DELETE FROM sessions`);
  await h.owner.query(`DELETE FROM users`);
  await h.owner.query(`DELETE FROM waitlist`);
  await h.owner.query(`DELETE FROM invites`);
  await h.owner.query(`DELETE FROM settings WHERE key IN ('auth.setup', 'signup_mode')`);
});

function lastCode(email: string): string {
  const mail = h.mailer.sent.filter((m) => m.to === email).at(-1);
  const match = mail?.text.match(/\b(\d{6})\b/);
  if (match?.[1] === undefined) throw new Error(`no code mailed to ${email}`);
  return match[1];
}

async function requestCode(email: string): Promise<void> {
  const res = await anon().post('/auth/request-code', { email });
  expect(res.statusCode).toBe(202);
}

async function verifyWith(email: string) {
  return anon().post('/auth/verify', { email, code: lastCode(email) });
}

async function roleOf(email: string): Promise<string | undefined> {
  const { rows } = await h.owner.query<{ role: string }>(
    `SELECT role FROM users WHERE email = $1`,
    [email],
  );
  return rows[0]?.role;
}

async function adminCount(): Promise<number> {
  const { rows } = await h.owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL`,
  );
  return rows[0]?.n ?? -1;
}

describe('ADMIN_EMAILS is bootstrap only: verify rule', () => {
  it('a demoted listed user stays a user after login while another admin exists', async () => {
    await createUser(h.owner, { email: nextEmail('boss'), role: 'admin' });
    await createUser(h.owner, { email: LISTED_A, role: 'user' });
    await requestCode(LISTED_A);
    const res = await verifyWith(LISTED_A);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { role: string } }>().user.role).toBe('user');
    expect(await roleOf(LISTED_A)).toBe('user');
  });

  it('negative control: with no active admin the listed user is promoted at login (a soft-deleted admin does not count)', async () => {
    await createUser(h.owner, { email: nextEmail('gone'), role: 'admin', deletedAt: new Date() });
    await createUser(h.owner, { email: LISTED_A, role: 'user' });
    await requestCode(LISTED_A);
    const res = await verifyWith(LISTED_A);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { role: string } }>().user.role).toBe('admin');
    expect(await roleOf(LISTED_A)).toBe('admin');
  });

  it('a non-listed user is never promoted, even with no admin in the database', async () => {
    await createUser(h.owner, { email: 'plain@example.test', role: 'user' });
    await requestCode('plain@example.test');
    const res = await verifyWith('plain@example.test');
    expect(res.statusCode).toBe(200);
    expect(await roleOf('plain@example.test')).toBe('user');
  });

  it('a new listed address becomes admin at signup (account creation) even when another admin exists', async () => {
    await createUser(h.owner, { email: nextEmail('boss'), role: 'admin' });
    expect(await roleOf(LISTED_NEW)).toBeUndefined();
    await requestCode(LISTED_NEW);
    const res = await verifyWith(LISTED_NEW);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { role: string } }>().user.role).toBe('admin');
    expect(await roleOf(LISTED_NEW)).toBe('admin');
    expect(await adminCount()).toBe(2);
  });

  it('restoring a soft-deleted listed account is not a creation: it stays a user while an admin exists', async () => {
    await createUser(h.owner, { email: nextEmail('boss'), role: 'admin' });
    await createUser(h.owner, {
      email: LISTED_A,
      role: 'user',
      deletedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await requestCode(LISTED_A);
    const res = await verifyWith(LISTED_A);
    expect(res.statusCode).toBe(200);
    expect(await roleOf(LISTED_A)).toBe('user');
  });

  it('the verify rule runs under the setup advisory lock: a held lock delays the verify of a listed address', async () => {
    await createUser(h.owner, { email: LISTED_A, role: 'user' });
    await requestCode(LISTED_A);
    const code = lastCode(LISTED_A);
    const holder = await h.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('bantoozi:setup', 0))`);
      let settled = false;
      const pending = anon()
        .post('/auth/verify', { email: LISTED_A, code })
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(settled, 'verify must wait for the setup lock').toBe(false);
      await holder.query('COMMIT');
      const res = await pending;
      expect(res.statusCode).toBe(200);
      // No admin existed once the lock was released: the listed user is promoted.
      expect(await roleOf(LISTED_A)).toBe('admin');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('two concurrent verifies of two listed users with no admin present both succeed and exactly one becomes admin', async () => {
    for (let round = 0; round < 4; round += 1) {
      await h.owner.query(`DELETE FROM users`);
      await createUser(h.owner, { email: LISTED_A, role: 'user' });
      await createUser(h.owner, { email: LISTED_B, role: 'user' });
      await requestCode(LISTED_A);
      await requestCode(LISTED_B);
      const [a, b] = await Promise.all([verifyWith(LISTED_A), verifyWith(LISTED_B)]);
      expect([a.statusCode, b.statusCode], `round ${round}`).toEqual([200, 200]);
      expect(await adminCount(), `round ${round}: exactly one admin`).toBe(1);
    }
  });

  it('two concurrent signups of two listed addresses with no admin present both succeed (both are creations)', async () => {
    await requestCode(LISTED_A);
    await requestCode(LISTED_B);
    const [a, b] = await Promise.all([verifyWith(LISTED_A), verifyWith(LISTED_B)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await roleOf(LISTED_A)).toBe('admin');
    expect(await roleOf(LISTED_B)).toBe('admin');
  });
});

describe('ADMIN_EMAILS is bootstrap only: admin DTO', () => {
  it('a demotion sticks and GET /admin/users reports role user with adminBootstrap still informational', async () => {
    const boss = await createUser(h.owner, { email: nextEmail('boss'), role: 'admin' });
    const bossSession = await createTestSession(h, boss);
    await createUser(h.owner, { email: LISTED_A, role: 'user' });
    await createUser(h.owner, { email: 'plain@example.test', role: 'user' });
    const res = await apiClient(h.server, bossSession).get('/admin/users', {
      query: { limit: '50' },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: { email: string; role: string; adminBootstrap: boolean }[] }>()
      .items;
    const listed = items.find((u) => u.email === LISTED_A);
    expect(listed).toMatchObject({ role: 'user', adminBootstrap: true });
    expect(items.find((u) => u.email === 'plain@example.test')).toMatchObject({
      role: 'user',
      adminBootstrap: false,
    });
  });

  it('the DTO documents the new meaning: no longer "a demotion lasts only until the next login"', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../packages/shared/src/dto/admin.ts', import.meta.url)),
      'utf8',
    );
    const at = source.indexOf('adminBootstrap:');
    expect(at).toBeGreaterThan(0);
    const comment = source.slice(Math.max(0, at - 400), at);
    expect(comment).not.toMatch(/demotion lasts only until the next login/iu);
    expect(comment).toMatch(/created/iu);
  });
});
