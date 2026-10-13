import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  LLM,
  NEW_MODEL,
  OLD_MODEL,
  WORKER_DEFAULT_KEYS,
  ClassifyHarness,
  baseConfig,
  heartbeatEntry,
  heartbeatWith,
  keyringJson,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * M8b-T5 heartbeat `runtime` (scope B2 item 6): defaults, pendingRestart, problems and the keyring
 * status of one worker, written through the real `startHeartbeat` (`HeartbeatOptions.runtime`) so the
 * stored entry passes `WorkerHeartbeatSchema`. The API reads `runtime.defaults` as `{settingKey:
 * envValue}` (`freshWorkerRuntimeDefaults`, apps/api/src/routes/admin/shared.ts).
 */
let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  await h?.close();
});

beforeEach(async () => {
  await resetWorld(h);
});

async function beat(runtime: WorkerRuntimeLike, processId: string) {
  const heartbeat = await heartbeatWith(h.db, processId, () => ({ ...runtime.heartbeatRuntime() }));
  try {
    await heartbeat.beat();
    return (await heartbeatEntry(h.owner, processId))?.runtime;
  } finally {
    await heartbeat.stop();
  }
}

async function boot(config = baseConfig('test')) {
  const runtime = await startRuntime({ db: h.db, config, recorder: recorder() });
  runtimes.push(runtime);
  return runtime;
}

describe('heartbeat runtime field', () => {
  it('carries the fingerprint, model, defaults, no restart and an ok keyring', async () => {
    const config = baseConfig('test');
    const runtime = await boot(config);
    expect(await beat(runtime, 'w1:1')).toEqual({
      fingerprint: runtime.fingerprint,
      model: OLD_MODEL,
      llm: null,
      pendingRestart: false,
      problems: [],
      keyring: { status: 'ok', activeKeyId: 'k1' },
      defaults: {
        'engine.typesafe_model': OLD_MODEL,
        'engine.typesafe_base_url': config.typesafeBaseUrl,
        'engine.typesafe_price_per_mtok_usd': config.typesafePricePerMtokUsd,
        'engine.concurrency': config.engineConcurrency,
        'engine.llm_fallback_enabled': false,
        'engine.ollama_models': { fast: LLM.fast, strong: LLM.strong },
        'engine.ollama_base_url': config.ollamaBaseUrl,
        'engine.ollama_max_concurrency': config.ollamaMaxConcurrency,
        'engine.prefilter_min_cards': config.prefilterMinCards,
        'ingest.max_age_days': config.ingestMaxAgeDays,
        'fetch.limits': { timeoutMs: config.fetchTimeoutMs, maxBytes: config.fetchMaxBytes },
        'translate.libretranslate_url': config.libretranslateUrl,
      },
    });
  });

  it('defaults hold exactly the twelve worker keys, with env values even when a stored row overrides', async () => {
    await setSetting(h.owner, 'engine.concurrency', 3);
    await setSetting(h.owner, 'fetch.limits', { timeoutMs: 20_000, maxBytes: 1_048_576 });
    const config = baseConfig('test');
    const runtime = await boot(config);
    const reported = runtime.heartbeatRuntime();
    expect(Object.keys(reported.defaults).sort()).toEqual([...WORKER_DEFAULT_KEYS].sort());
    expect(reported.defaults['engine.concurrency']).toBe(config.engineConcurrency);
    expect(reported.defaults['fetch.limits']).toEqual({
      timeoutMs: config.fetchTimeoutMs,
      maxBytes: config.fetchMaxBytes,
    });
  });

  it('reports the fallback models in llm while the fallback is on', async () => {
    const runtime = await boot(baseConfig('test', { llmFallbackEnabled: true }));
    const entry = await beat(runtime, 'w2:1');
    expect(entry?.llm).toEqual({ fast: LLM.fast, strong: LLM.strong });
  });

  it('reports pendingRestart and the problems that appear after the start', async () => {
    const runtime = await boot();
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    await setSetting(h.owner, 'engine.ollama_max_concurrency', 'many');
    await runtime.check();
    const entry = await beat(runtime, 'w3:1');
    expect(entry).toMatchObject({ model: OLD_MODEL, pendingRestart: true });
    expect(entry?.problems.map((p) => p.key)).toEqual(['engine.ollama_max_concurrency']);
    // The fingerprint is the booted one: it only changes with a restart.
    expect(entry?.fingerprint).toBe(runtime.fingerprint);
  });

  it.each([
    ['missing', { providerMasterKeyId: undefined, providerMasterKeys: undefined }, 'missing'],
    ['malformed', { providerMasterKeyId: 'k1', providerMasterKeys: '{not json' }, 'malformed'],
    [
      'active_key_missing',
      { providerMasterKeyId: 'k9', providerMasterKeys: keyringJson('k1') },
      'active_key_missing',
    ],
  ] as const)(
    'keyring %s is reported without an active key id or key material',
    async (_n, overrides, status) => {
      const runtime = await boot(baseConfig('test', overrides));
      const entry = await beat(runtime, `w4:${status}`);
      expect(entry?.keyring).toEqual({ status });
      expect(JSON.stringify(entry)).not.toContain(overrides.providerMasterKeys ?? 'no-keys-here');
    },
  );

  it('never carries key material when the keyring is ok', async () => {
    const keys = keyringJson('k1', 'k2');
    const runtime = await boot(
      baseConfig('test', { providerMasterKeys: keys, providerMasterKeyId: 'k2' }),
    );
    const entry = await beat(runtime, 'w5:1');
    expect(entry?.keyring).toEqual({ status: 'ok', activeKeyId: 'k2' });
    for (const secret of Object.values(JSON.parse(keys) as Record<string, string>)) {
      expect(JSON.stringify(entry)).not.toContain(secret);
    }
  });
});
