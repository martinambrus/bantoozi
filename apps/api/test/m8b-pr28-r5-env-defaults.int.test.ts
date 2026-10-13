import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * PR #28 Codex round 5: a worker reports an environment default the config accepts but a PATCH would
 * not (wider env ranges). The response must still serialize and show it; a write keeps the narrow bounds.
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
  await h.owner.query(
    "DELETE FROM settings WHERE key IN ('worker.heartbeat', 'engine.concurrency')",
  );
});

const WIDEST = {
  'engine.typesafe_model': 'jev-1.13.0',
  'engine.typesafe_base_url': 'https://jev.example.com',
  'engine.typesafe_price_per_mtok_usd': 5000,
  'engine.concurrency': 256,
  'engine.llm_fallback_enabled': true,
  'engine.ollama_models': { fast: 'glm-5.3-flash', strong: 'glm-5.3' },
  'engine.ollama_base_url': 'https://ollama.example.com',
  'engine.ollama_max_concurrency': 64,
  'engine.prefilter_min_cards': 1_000_000,
  'ingest.max_age_days': 3650,
  'fetch.limits': { timeoutMs: 600_000, maxBytes: 1024 ** 3 },
  'translate.libretranslate_url': 'http://libretranslate:5000',
};

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

describe('env defaults wider than the write bounds (PR #28 round 5)', () => {
  it('GET shows the widest value of every numeric key', async () => {
    await heartbeat(WIDEST);
    const res = await apiClient(h.server, admin).get('/admin/settings');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    // fetch.limits and the LibreTranslate URL are answered from the API's own environment.
    const own = ['fetch.limits', 'translate.libretranslate_url'];
    for (const [key, value] of Object.entries(WIDEST).filter(([key]) => !own.includes(key))) {
      expect(body.defaults[key], key).toEqual(value);
      expect(body.values[key], key).toEqual(value);
    }
  });

  it('a PATCH of an unrelated key answers 200 with those defaults', async () => {
    await heartbeat({ ...WIDEST, 'engine.concurrency': 128 });
    const res = await apiClient(h.server, admin).patch('/admin/settings', {
      'engine.llm_daily_cap': 150,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().values['engine.concurrency']).toBe(128);
  });

  it('negative control: storing 128 is still refused with the key in the details', async () => {
    await heartbeat(WIDEST);
    const res = await apiClient(h.server, admin).patch('/admin/settings', {
      'engine.concurrency': 128,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('engine.concurrency');
  });
});
