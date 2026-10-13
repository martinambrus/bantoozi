import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authTiming } from '../src/services/auth.js';
import { setupTokenDigest } from '../src/services/setup.js';
import { buildServer } from '../src/server.js';
import {
  apiClient,
  createApiHarness,
  createCapturingMailer,
  testConfig,
  type ApiHarness,
  type CapturingMailer,
} from './support/harness.js';

/**
 * PR #28 Codex round 4: every path takes the `bantoozi:setup` lock BEFORE the auth-email lock.
 * `verifyLoginCode` took the email lock and then the setup lock while `completeSetup` took them the
 * other way round, so a setup completion and an ADMIN_EMAILS login of the same address could
 * deadlock (40P01 -> 500).
 */
const ROUNDS = 20;
const EMAILS = Array.from({ length: ROUNDS }, (_, i) => `race-${i}@example.test`);
let h: ApiHarness;
let server: FastifyInstance;
let mailer: CapturingMailer;
let pepper: string;

beforeAll(async () => {
  authTiming.minResponseMs = 0;
  const env = { SIGNUP_MODE: 'invite', ADMIN_EMAILS: EMAILS.join(',') };
  h = await createApiHarness({ env });
  mailer = createCapturingMailer();
  const config = testConfig(env, h.db.urls.app);
  pepper = config.sessionPepper;
  server = await buildServer({ db: h.appDb, config, mailer, libreTranslate: null });
  await server.ready();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await h?.close();
});

beforeEach(async () => {
  await h.owner.query(`DELETE FROM sessions`);
  await h.owner.query(`DELETE FROM users`);
  await h.owner.query(`DELETE FROM settings WHERE key IN ('auth.setup', 'signup_mode')`);
});

describe('setup lock before email lock', () => {
  it(`${ROUNDS} concurrent setup completions and ADMIN_EMAILS logins of one address never deadlock`, async () => {
    for (const [i, email] of EMAILS.entries()) {
      await h.owner.query(`DELETE FROM sessions`);
      await h.owner.query(`DELETE FROM users`);
      const token = `r4-token-${i}`.padEnd(43, 'x');
      await h.owner.query(
        `INSERT INTO settings (key, value) VALUES ('auth.setup', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          JSON.stringify({
            digest: setupTokenDigest(pepper, token),
            createdAt: new Date().toISOString(),
          }),
        ],
      );
      const login = apiClient(server);
      expect((await login.post('/auth/request-code', { email })).statusCode).toBe(202);
      const code = mailer.sent
        .filter((m) => m.to === email)
        .at(-1)
        ?.text.match(/\b(\d{6})\b/)?.[1];

      const [setup, verify] = await Promise.all([
        server.inject({
          method: 'POST',
          url: '/api/v1/setup/complete',
          headers: { 'x-bantoozi-client': 'web' },
          payload: { token, email },
        }),
        apiClient(server).post('/auth/verify', { email, code }),
      ]);
      expect(setup.statusCode, `round ${i}: ${setup.body}`).toBeLessThan(500);
      expect(verify.statusCode, `round ${i}: ${verify.body}`).toBeLessThan(500);
      const { rows } = await h.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL`,
      );
      expect(rows[0]?.n, `round ${i}`).toBe(1);
    }
  }, 120_000);

  it('deterministically: while another transaction holds the setup lock, a waiting ADMIN_EMAILS login does not hold the email lock', async () => {
    const email = EMAILS[0]!;
    const login = apiClient(server);
    expect((await login.post('/auth/request-code', { email })).statusCode).toBe(202);
    const code = mailer.sent
      .filter((m) => m.to === email)
      .at(-1)
      ?.text.match(/\b(\d{6})\b/)?.[1];

    const holder = await h.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('bantoozi:setup', 0))`);
      const verifying = apiClient(server).post('/auth/verify', { email, code });
      // Wait until the login is blocked on an advisory lock.
      for (let tries = 0; tries < 100; tries += 1) {
        const { rows } = await h.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        );
        if ((rows[0]?.n ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The setup path takes the email lock while holding the setup lock. If the login already
      // holds the email lock this is a lock cycle (40P01 for one of the two).
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `bantoozi:auth-email:${email}`,
      ]);
      await holder.query('COMMIT');
      const res = await verifying;
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 30_000);
});
