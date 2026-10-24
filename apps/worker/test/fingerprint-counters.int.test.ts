import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startHealthServer } from '../src/health-server.js';
import { ClassifyHarness } from './support/classify.js';
import { V113, begin, registryOf, REGISTRY_KEY } from './support/jev4-world.js';
import { LearnWorld, RATED } from './support/learn-world.js';

let h: ClassifyHarness;
let w: LearnWorld;
let warnings: Array<{ obj: object; msg: string }>;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = await LearnWorld.create(h);
  (h.deps as { logger: unknown }).logger = {
    info: () => {},
    error: () => {},
    warn: (obj: object, msg: string) => warnings.push({ obj, msg }),
  };
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

beforeEach(async () => {
  warnings = [];
  h.router.reset();
  await h.clearOutbox();
});

const counters = async () => (await import('../src/learn/fingerprints.js')).fingerprintCounters;

async function rated(): Promise<string> {
  const userId = await w.user({ lastActiveDaysAgo: 0 });
  await w.rateRange(userId, 0, RATED);
  return userId;
}

async function withFailingRegistry<T>(run: () => Promise<T>): Promise<T> {
  await h.owner.query(`CREATE OR REPLACE FUNCTION f2_fail_registry() RETURNS trigger AS $$
    BEGIN
      IF NEW.key = '${REGISTRY_KEY}' THEN RAISE EXCEPTION 'f2 forced registry failure'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await h.owner.query(
    `CREATE TRIGGER f2_fail_registry BEFORE INSERT OR UPDATE ON settings
       FOR EACH ROW EXECUTE FUNCTION f2_fail_registry()`,
  );
  try {
    return await run();
  } finally {
    await h.owner.query(`DROP TRIGGER IF EXISTS f2_fail_registry ON settings`);
  }
}

describe('fingerprint registration visibility', () => {
  it('house.nightly-learn counts and logs an eviction', async () => {
    await begin(h, V113);
    const filler: Record<string, unknown> = {};
    for (let i = 0; i < 64; i += 1) {
      filler[i.toString(16).padStart(64, '0')] = {
        family: 'e'.repeat(64),
        settings: {},
        firstSeenAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      };
    }
    await h.owner.query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [
      REGISTRY_KEY,
      JSON.stringify(filler),
    ]);
    const before = (await counters()).evicted;
    await h.dispatch('house.nightly-learn', {});
    expect((await counters()).evicted).toBe(before + 1);
    expect(Object.keys(await registryOf(h))).toHaveLength(64);
    expect(warnings.some((x) => x.msg === 'rating fingerprint registry evicted entries')).toBe(
      true,
    );
  });

  it('house.nightly-learn continues after a failed registration, user.learn still rejects', async () => {
    await begin(h, V113);
    const userId = await rated();
    const failedBefore = (await counters()).failed;
    const mark = await h.mark();
    await withFailingRegistry(async () => {
      await h.dispatch('house.nightly-learn', {});
      expect((await counters()).failed).toBe(failedBefore + 1);
      expect(warnings.some((x) => x.msg === 'rating fingerprint registration failed')).toBe(true);
      expect(await w.userIntents('user.learn', userId, mark)).not.toHaveLength(0);
      const progress = await h.owner.query(
        `SELECT value FROM settings WHERE key = 'house.progress'`,
      );
      expect(JSON.stringify(progress.rows[0]?.value ?? {})).toContain('house.nightly-learn');

      await expect(h.dispatch('user.learn', { userId })).rejects.toThrow();
      expect((await counters()).failed).toBe(failedBefore + 2);
    });
  });
});

describe('/metrics', () => {
  it('shows the two counters', async () => {
    const c = await counters();
    c.evicted = 7;
    c.failed = 3;
    const server = await startHealthServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret-token',
      queues: [],
      consumingQueues: () => [],
      readHeartbeatAt: async () => new Date(),
    });
    try {
      const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
      const text = await (
        await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer secret-token' } })
      ).text();
      expect(text).toContain('# TYPE bantoozi_worker_rating_fingerprint_evicted_total counter');
      expect(text).toContain('bantoozi_worker_rating_fingerprint_evicted_total 7');
      expect(text).toContain(
        '# TYPE bantoozi_worker_rating_fingerprint_registration_failed_total counter',
      );
      expect(text).toContain('bantoozi_worker_rating_fingerprint_registration_failed_total 3');
    } finally {
      await server.close();
    }
  });
});
