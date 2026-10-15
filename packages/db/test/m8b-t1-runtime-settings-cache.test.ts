import { describe, expect, it } from 'vitest';

import type { RuntimeEnvDefaults, RuntimeSettingsContext } from '@bantoozi/shared';

import { createRuntimeSettingsCache, runtimeSettingsLoader } from '../src/index.js';

/**
 * M8b-T1 ruler: the `RuntimeSettings` TTL cache (scope §B2). New in `packages/db/src/runtime-settings.ts`,
 * exported from the index:
 *
 *   createRuntimeSettingsCache({ load, env, context, ttlMs = 10_000, now = Date.now })
 *     .get(): Promise<{values, sources, problems}>   (single-flight; same snapshot object inside the TTL)
 *     .invalidate(): void                            (the next get() reloads, even over an in-flight refresh)
 *   runtimeSettingsLoader(db): () => Promise<Map<string, unknown>>   (ONE statement per call)
 * `load` failing with a last good snapshot returns that snapshot (problem key '*'); with none, get() rejects.
 */

const CTX: RuntimeSettingsContext = {
  production: true,
  providerHostAllowlist: ['api.typesafe.ai'],
  ollamaPricedModels: ['glm-5.3-flash', 'glm-5.3'],
};
const ENV: RuntimeEnvDefaults = {
  typesafeModel: 'jev-1.13.0',
  typesafeBaseUrl: 'https://api.typesafe.ai',
  typesafePricePerMtokUsd: 0.042,
  engineConcurrency: 8,
  llmFallbackEnabled: false,
  ollamaModelFast: 'glm-5.3-flash',
  ollamaModelStrong: 'glm-5.3',
  ollamaBaseUrl: 'https://ollama.com',
  ollamaMaxConcurrency: 1,
  prefilterMinCards: 60,
  autoAnalysisDailyCap: 1000,
  ingestMaxAgeDays: 14,
  fetchTimeoutMs: 20_000,
  fetchMaxBytes: 5_242_880,
  rateLimitsEnabled: true,
  libretranslateUrl: 'http://libretranslate:5000',
};

function harness(initial: Record<string, unknown> = {}) {
  let rows = new Map(Object.entries(initial));
  let calls = 0;
  let fail: Error | undefined;
  let gate: Promise<void> | undefined;
  let clock = 1_000_000;
  const load = async () => {
    calls += 1;
    const snapshot = new Map(rows);
    if (gate) await gate;
    if (fail) throw fail;
    return snapshot;
  };
  const cache = createRuntimeSettingsCache({
    load,
    env: ENV,
    context: CTX,
    ttlMs: 10_000,
    now: () => clock,
  });
  return {
    cache,
    calls: () => calls,
    set: (r: Record<string, unknown>) => {
      rows = new Map(Object.entries(r));
    },
    advance: (ms: number) => {
      clock += ms;
    },
    failWith: (e: Error | undefined) => {
      fail = e;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe('M8b-T1 RuntimeSettings cache', () => {
  it('serves from the cache inside the TTL and reloads after it expires', async () => {
    const h = harness({ 'engine.concurrency': 3 });
    const a = await h.cache.get();
    expect(a.values.engineConcurrency).toBe(3);
    h.set({ 'engine.concurrency': 5 });
    h.advance(9_999);
    expect((await h.cache.get()).values.engineConcurrency).toBe(3);
    expect(h.calls()).toBe(1);
    h.advance(1); // exactly the TTL
    expect((await h.cache.get()).values.engineConcurrency).toBe(5);
    expect(h.calls()).toBe(2);
  });

  it('single-flight: concurrent readers share one query per refresh', async () => {
    const h = harness();
    const release = h.hold();
    const readers = Array.from({ length: 25 }, () => h.cache.get());
    release();
    const snaps = await Promise.all(readers);
    expect(h.calls()).toBe(1);
    expect(new Set(snaps).size).toBe(1);
    // a second wave after expiry is again one query
    h.advance(10_000);
    const release2 = h.hold();
    const wave = Array.from({ length: 10 }, () => h.cache.get());
    release2();
    await Promise.all(wave);
    expect(h.calls()).toBe(2);
  });

  it('invalidate forces the next read to reload inside the TTL', async () => {
    const h = harness({ 'engine.concurrency': 3 });
    await h.cache.get();
    h.set({ 'engine.concurrency': 7 });
    h.cache.invalidate();
    expect((await h.cache.get()).values.engineConcurrency).toBe(7);
    expect(h.calls()).toBe(2);
    await h.cache.get();
    expect(h.calls()).toBe(2); // and the fresh snapshot is cached again
  });

  it('invalidate during an in-flight refresh: the stale result does not satisfy the next read', async () => {
    const h = harness({ 'engine.concurrency': 3 });
    const release = h.hold();
    const inflight = h.cache.get();
    h.set({ 'engine.concurrency': 6 });
    h.cache.invalidate();
    release();
    await inflight;
    expect((await h.cache.get()).values.engineConcurrency).toBe(6);
    expect(h.calls()).toBe(2);
  });

  it('keeps the last good snapshot when a refresh fails, and retries on the next read', async () => {
    const h = harness({ 'engine.concurrency': 3 });
    await h.cache.get();
    h.advance(10_000);
    h.failWith(new Error('db down'));
    const during = await h.cache.get();
    expect(during.values.engineConcurrency).toBe(3);
    expect(during.problems.some((p) => p.key === '*')).toBe(true);
    h.failWith(undefined);
    h.set({ 'engine.concurrency': 4 });
    expect((await h.cache.get()).values.engineConcurrency).toBe(4);
    expect(h.calls()).toBe(3);
  });

  it('rejects when the very first load fails (no last good value exists)', async () => {
    const h = harness();
    h.failWith(new Error('db down'));
    await expect(h.cache.get()).rejects.toThrow('db down');
  });

  it('keeps the last good value of a key whose row turned invalid, and reports it', async () => {
    const h = harness({ 'engine.concurrency': 3, 'ingest.max_age_days': 30 });
    await h.cache.get();
    h.set({ 'engine.concurrency': 9999, 'ingest.max_age_days': 40 });
    h.cache.invalidate();
    const s = await h.cache.get();
    expect(s.values.engineConcurrency).toBe(3);
    expect(s.values.ingestMaxAgeDays).toBe(40);
    expect(s.problems.map((p) => p.key)).toEqual(['engine.concurrency']);
    // negative control: once the row is valid again the problem clears
    h.set({ 'engine.concurrency': 5 });
    h.cache.invalidate();
    const t = await h.cache.get();
    expect(t.values.engineConcurrency).toBe(5);
    expect(t.problems).toEqual([]);
  });

  it('first load with an invalid production row falls back to the env value', async () => {
    const h = harness({ 'engine.typesafe_base_url': 'https://evil.example' });
    const s = await h.cache.get();
    expect(s.values.typesafeBaseUrl).toBe('https://api.typesafe.ai');
    expect(s.problems.map((p) => p.key)).toEqual(['engine.typesafe_base_url']);
  });
});

describe('M8b-T1 runtimeSettingsLoader', () => {
  it('reads all runtime keys in exactly one statement', async () => {
    const seen: unknown[] = [];
    const db = {
      execute: async (q: unknown) => {
        seen.push(q);
        return { rows: [{ key: 'engine.concurrency', value: 3 }], rowCount: 1 };
      },
    };
    const map = await runtimeSettingsLoader(db as never)();
    expect(seen).toHaveLength(1);
    expect(map.get('engine.concurrency')).toBe(3);
  });
});
