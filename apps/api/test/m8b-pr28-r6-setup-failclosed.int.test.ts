import { Writable } from 'node:stream';

import { createLogger } from '@bantoozi/shared/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { authTiming } from '../src/services/auth.js';
import { buildServer } from '../src/server.js';
import { createApiHarness, testConfig, type ApiHarness } from './support/harness.js';

/**
 * PR #28 review round 6: when the start-up token rotation fails while no admin exists, this process
 * must not redeem the previous process's token. It stays closed (the generic INVALID_CODE) until it
 * has persisted its own digest; a retry runs under the setup lock on the next GET /setup or
 * POST /setup/complete and logs the new token exactly once.
 */

let h: ApiHarness;
const servers: FastifyInstance[] = [];
let seq = 0;
const nextEmail = () => `r6-${++seq}@example.test`;

beforeAll(async () => {
  authTiming.minResponseMs = 0;
  h = await createApiHarness({ env: { SIGNUP_MODE: 'invite' } });
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

async function startApi(failures = 0) {
  const lines: string[] = [];
  let calls = 0;
  const server = await buildServer({
    db: h.appDb,
    config: testConfig({ SIGNUP_MODE: 'invite' }, h.db.urls.app),
    logger: createLogger({
      name: 'setup-r6',
      level: 'warn',
      destination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    }),
    libreTranslate: null,
    setupTokenGenerator: () => {
      if (++calls <= failures) throw new Error('injected rotation failure');
      return `T${String(seq++).padStart(2, '0')}${'x'.repeat(40)}`;
    },
  });
  await server.ready();
  servers.push(server);
  return { server, tokens: () => lines.flatMap((l) => l.match(TOKEN_RE) ?? []) };
}

const complete = (s: FastifyInstance, body: Record<string, unknown>) =>
  s.inject({
    method: 'POST',
    url: '/api/v1/setup/complete',
    headers: { 'x-bantoozi-client': 'web' },
    payload: body,
  });
const state = (s: FastifyInstance) => s.inject({ method: 'GET', url: '/api/v1/setup' });

async function adminCount(): Promise<number> {
  const { rows } = await h.owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL`,
  );
  return rows[0]?.n ?? -1;
}

describe('start-up rotation failure fails closed', () => {
  it('negative control: a normal start logs a token that works', async () => {
    const a = await startApi();
    const [token] = a.tokens();
    expect(token).toBeDefined();
    const res = await complete(a.server, { token, email: nextEmail() });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses the previous process token while rotation keeps failing', async () => {
    const a = await startApi();
    const old = a.tokens().at(-1) as string;
    const b = await startApi(2); // onReady and the first retry both fail
    expect(b.tokens()).toEqual([]);
    const res = await complete(b.server, { token: old, email: nextEmail() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_CODE' } });
    expect(await adminCount()).toBe(0);
  });

  it('a later retry logs one new token that works; the old token never does', async () => {
    const a = await startApi();
    const old = a.tokens().at(-1) as string;
    const b = await startApi(2);
    expect((await complete(b.server, { token: old, email: nextEmail() })).statusCode).toBe(400);
    expect(b.tokens()).toEqual([]);
    // Concurrent triggers rotate once.
    await Promise.all([state(b.server), state(b.server), state(b.server)]);
    expect(b.tokens()).toHaveLength(1);
    await state(b.server);
    expect(b.tokens()).toHaveLength(1);
    const fresh = b.tokens()[0] as string;
    expect(fresh).not.toBe(old);
    expect((await complete(b.server, { token: old, email: nextEmail() })).statusCode).toBe(400);
    expect(await adminCount()).toBe(0);
    const ok = await complete(b.server, { token: fresh, email: nextEmail() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await adminCount()).toBe(1);
  });
});
