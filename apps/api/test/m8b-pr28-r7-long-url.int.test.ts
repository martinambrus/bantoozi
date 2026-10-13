import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * PR #28 Codex round 7: a worker whose environment URL is long (accepted by loadConfig up to 2048
 * characters) must not make GET/PATCH /admin/settings answer 500.
 */
let h: ApiHarness;
let admin: TestUser;

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.owner.query("DELETE FROM settings WHERE key IN ('worker.heartbeat')");
});

const long = (n: number) =>
  `https://jev.example.com/${'a'.repeat(n - 'https://jev.example.com/'.length)}`;

async function heartbeat(defaults: Record<string, unknown>) {
  const value = {
    'worker:a': {
      at: new Date().toISOString(),
      queues: ['article.enrich'],
      evalIngestOnly: false,
      envCredentials: [],
      runtime: { pendingRestart: false, problems: [], defaults },
    },
  };
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('worker.heartbeat', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}

describe('long environment URLs in the settings response (PR #28 round 7)', () => {
  it('GET answers 200 with a 1500-character default URL', async () => {
    const url = long(1500);
    await heartbeat({ 'engine.typesafe_base_url': url, 'engine.ollama_base_url': url });
    const res = await apiClient(h.server, admin).get('/admin/settings');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().values['engine.typesafe_base_url']).toBe(url);
  });

  it('PATCH of an unrelated key answers 200 with it', async () => {
    await heartbeat({ 'engine.typesafe_base_url': long(1500) });
    const res = await apiClient(h.server, admin).patch('/admin/settings', {
      'engine.llm_daily_cap': 150,
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('negative control: writing a URL over the UI bound (500) is still refused', async () => {
    const res = await apiClient(h.server, admin).patch('/admin/settings', {
      'engine.typesafe_base_url': long(600),
    });
    expect(res.statusCode).toBe(400);
  });
});
