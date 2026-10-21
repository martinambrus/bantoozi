import { describe, expect, it } from 'vitest';

import {
  RUNTIME_SETTING_KEYS,
  effectiveRuntimeSettings,
  parseSetting,
  validateRuntimeSetting,
  type RuntimeEnvDefaults,
  type RuntimeSettingsContext,
} from '../src/index.js';

/**
 * M8b-T1 ruler (scope §B2, §B4; owner change 2026-10-13: production base URLs must be on
 * PROVIDER_HOST_ALLOWLIST). New in `packages/shared/src/runtime-settings.ts`, exported from the index:
 *
 *   RUNTIME_SETTING_KEYS: readonly SettingKey[]  (the 13 live keys of scope §B2, and the 14th, D-251)
 *   validateRuntimeSetting(key, value, ctx) -> {ok:true,value} | {ok:false,message}
 *       null is always valid (reset to the env default); URLs are returned without a trailing "/".
 *   effectiveRuntimeSettings(stored: ReadonlyMap<string, unknown>, env, ctx, previous?)
 *       -> {values, sources, problems}; a null or absent row = env; a valid row wins; an invalid
 *       row is ignored (previous value -> source 'last_good', else env) and reported in problems.
 */

const PROD: RuntimeSettingsContext = {
  production: true,
  providerHostAllowlist: ['api.typesafe.ai', 'ollama.com', 'libretranslate', 'edge.example:8443'],
  ollamaPricedModels: ['glm-5.3-flash', 'glm-5.3', 'gemma4:31b'],
};
const DEV: RuntimeSettingsContext = { ...PROD, production: false, providerHostAllowlist: [] };

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

const ok = (key: string, value: unknown, ctx = PROD) =>
  validateRuntimeSetting(key as never, value, ctx);

describe('M8b-T1 registry schemas (context-free ranges)', () => {
  it('registers the 14 live keys', () => {
    expect([...RUNTIME_SETTING_KEYS].sort()).toEqual(
      [
        'api.rate_limits_enabled',
        'engine.auto_analysis_daily_cap',
        'engine.concurrency',
        'engine.llm_fallback_enabled',
        'engine.ollama_base_url',
        'engine.ollama_max_concurrency',
        'engine.ollama_models',
        'engine.prefilter_min_cards',
        'engine.typesafe_base_url',
        'engine.typesafe_model',
        'engine.typesafe_price_per_mtok_usd',
        'fetch.limits',
        'ingest.max_age_days',
        'translate.libretranslate_url',
      ].sort(),
    );
  });

  it.each([
    ['engine.concurrency', [1, 64], [0, 65, 1.5]],
    ['engine.ollama_max_concurrency', [1, 64], [0, 65]],
    ['engine.prefilter_min_cards', [1, 10_000], [0, 10_001]],
    ['engine.auto_analysis_daily_cap', [0, 1_000_000], [-1, 1_000_001]],
    ['ingest.max_age_days', [1, 365], [0, 366]],
  ] as const)('%s accepts %j and rejects %j; null resets', (key, good, bad) => {
    for (const v of good) expect(() => parseSetting(key, v)).not.toThrow();
    for (const v of bad) expect(() => parseSetting(key, v)).toThrow();
    expect(parseSetting(key, null)).toBeNull();
  });

  it('fetch.limits bounds: timeout 1 000..120 000 ms, body 64 KiB..50 MiB', () => {
    const p = (timeoutMs: number, maxBytes: number) =>
      parseSetting('fetch.limits', { timeoutMs, maxBytes });
    expect(() => p(1_000, 65_536)).not.toThrow();
    expect(() => p(120_000, 50 * 1024 * 1024)).not.toThrow();
    expect(() => p(999, 65_536)).toThrow();
    expect(() => p(120_001, 65_536)).toThrow();
    expect(() => p(1_000, 65_535)).toThrow();
    expect(() => p(1_000, 50 * 1024 * 1024 + 1)).toThrow();
    expect(() => parseSetting('fetch.limits', { timeoutMs: 5000 })).toThrow();
  });

  it('price is finite and at most 10; urls need an http(s) scheme and no credentials', () => {
    expect(() => parseSetting('engine.typesafe_price_per_mtok_usd', 0.042)).not.toThrow();
    for (const v of [Number.NaN, Infinity, -1, 10.01]) {
      expect(() => parseSetting('engine.typesafe_price_per_mtok_usd', v)).toThrow();
    }
    expect(() =>
      parseSetting('translate.libretranslate_url', 'http://libretranslate:5000'),
    ).not.toThrow();
    for (const v of ['ftp://x.example', 'https://u:p@x.example', 'not a url']) {
      expect(() => parseSetting('engine.typesafe_base_url', v)).toThrow();
    }
  });

  it('ollama_models needs both tiers', () => {
    expect(() => parseSetting('engine.ollama_models', { fast: 'a' })).toThrow();
    expect(parseSetting('engine.ollama_models', null)).toBeNull();
  });
});

describe('M8b-T1 validateRuntimeSetting: production rules', () => {
  it('null resets every key in every environment', () => {
    for (const key of RUNTIME_SETTING_KEYS) {
      expect(ok(key, null, PROD)).toEqual({ ok: true, value: null });
      expect(ok(key, null, DEV)).toEqual({ ok: true, value: null });
    }
  });

  it('typesafe model: production needs a pinned version, jev-fake is dev only', () => {
    expect(ok('engine.typesafe_model', 'jev-1.14.0')).toEqual({ ok: true, value: 'jev-1.14.0' });
    expect(ok('engine.typesafe_model', 'jev-fake').ok).toBe(false);
    expect(ok('engine.typesafe_model', 'jev-fake', DEV)).toEqual({ ok: true, value: 'jev-fake' });
  });

  it('typesafe model: production accepts exactly the alias jev-latest (JEV-2)', () => {
    expect(ok('engine.typesafe_model', 'jev-latest')).toEqual({ ok: true, value: 'jev-latest' });
    expect(ok('engine.typesafe_model', 'jev-1.14.0-rc1').ok).toBe(true);
    // negative controls: near misses stay refused, and the refusal names the alias
    for (const bad of [
      'latest',
      'jev-beta',
      'Jev-Latest',
      'jev-latest ',
      'jev-fake',
      'jev-preview',
    ]) {
      const r = ok('engine.typesafe_model', bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) {
        expect(r.message, bad).toContain('jev-latest');
        expect(r.message, bad).toContain('jev-1.13.0');
      }
    }
    // outside production nothing changes
    for (const v of ['jev-latest', 'jev-fake', 'jev-beta', 'jev-1.13.0']) {
      expect(ok('engine.typesafe_model', v, DEV)).toEqual({ ok: true, value: v });
    }
  });

  it.each([
    ['engine.typesafe_base_url', 'https://api.typesafe.ai'],
    ['engine.ollama_base_url', 'https://ollama.com'],
  ])('%s: https and allowlisted host in production', (key, good) => {
    expect(ok(key, good)).toEqual({ ok: true, value: good });
    expect(ok(key, `${good}/`)).toEqual({ ok: true, value: good }); // trailing slash stripped
    expect(
      ok(
        key,
        'https://API.TYPESAFE.AI'.replace('API.TYPESAFE.AI', new URL(good).host.toUpperCase()),
      ).ok,
    ).toBe(true);
    // negative controls: off the allowlist, plain http, credentials
    const off = ok(key, 'https://evil.example');
    expect(off.ok).toBe(false);
    expect(ok(key, `http://${new URL(good).host}`).ok).toBe(false);
    expect(ok(key, `https://u:p@${new URL(good).host}`).ok).toBe(false);
    // the very same off-list URL is accepted in dev, and plain http too
    expect(ok(key, 'https://evil.example', DEV)).toEqual({
      ok: true,
      value: 'https://evil.example',
    });
    expect(ok(key, 'http://localhost:9999', DEV)).toEqual({
      ok: true,
      value: 'http://localhost:9999',
    });
  });

  it('allowlist entries may carry a port; an empty allowlist rejects every production url', () => {
    expect(ok('engine.typesafe_base_url', 'https://edge.example:8443').ok).toBe(true);
    expect(ok('engine.typesafe_base_url', 'https://edge.example:9000').ok).toBe(false);
    const none = { ...PROD, providerHostAllowlist: [] };
    expect(ok('engine.typesafe_base_url', 'https://api.typesafe.ai', none).ok).toBe(false);
  });

  it('libretranslate url: http allowed (internal), but the host is on the allowlist in production', () => {
    expect(ok('translate.libretranslate_url', 'http://libretranslate:5000').ok).toBe(true);
    expect(ok('translate.libretranslate_url', 'http://other:5000').ok).toBe(false);
    expect(ok('translate.libretranslate_url', 'http://other:5000', DEV).ok).toBe(true);
  });

  it('ollama models must be in the price table, in every environment', () => {
    expect(ok('engine.ollama_models', { fast: 'glm-5.3-flash', strong: 'glm-5.3' }).ok).toBe(true);
    expect(ok('engine.ollama_models', { fast: 'gemma4:31b', strong: 'gemma4:31b' }, DEV).ok).toBe(
      true,
    );
    expect(ok('engine.ollama_models', { fast: 'glm-5.3-flash', strong: 'unpriced-9' }).ok).toBe(
      false,
    );
    expect(ok('engine.ollama_models', { fast: 'unpriced-9', strong: 'glm-5.3' }, DEV).ok).toBe(
      false,
    );
  });

  it('price: production needs 0 < price <= 10; dev may use 0 but never negative', () => {
    expect(ok('engine.typesafe_price_per_mtok_usd', 0.042)).toEqual({ ok: true, value: 0.042 });
    expect(ok('engine.typesafe_price_per_mtok_usd', 0).ok).toBe(false);
    expect(ok('engine.typesafe_price_per_mtok_usd', 10.5).ok).toBe(false);
    expect(ok('engine.typesafe_price_per_mtok_usd', 0, DEV).ok).toBe(true);
    expect(ok('engine.typesafe_price_per_mtok_usd', -1, DEV).ok).toBe(false);
  });

  it('invalid results carry a message naming no secret and the failure is not thrown', () => {
    const r = ok('engine.concurrency', 999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});

describe('M8b-T1 effectiveRuntimeSettings', () => {
  const eff = (rows: Record<string, unknown>, ctx = PROD, previous?: never) =>
    effectiveRuntimeSettings(new Map(Object.entries(rows)), ENV, ctx, previous);

  it('absent and null rows give the env values', () => {
    const empty = eff({});
    expect(empty.problems).toEqual([]);
    expect(empty.values).toMatchObject({
      typesafeModel: 'jev-1.13.0',
      typesafeBaseUrl: 'https://api.typesafe.ai',
      typesafePricePerMtokUsd: 0.042,
      engineConcurrency: 8,
      llmFallbackEnabled: false,
      ollamaModels: { fast: 'glm-5.3-flash', strong: 'glm-5.3' },
      ollamaBaseUrl: 'https://ollama.com',
      ollamaMaxConcurrency: 1,
      prefilterMinCards: 60,
      ingestMaxAgeDays: 14,
      fetchLimits: { timeoutMs: 20_000, maxBytes: 5_242_880 },
      rateLimitsEnabled: true,
      libretranslateUrl: 'http://libretranslate:5000',
    });
    expect(empty.sources['engine.concurrency']).toBe('env');
    const nulls = eff({
      'engine.concurrency': null,
      'fetch.limits': null,
      'engine.ollama_models': null,
    });
    expect(nulls.values).toEqual(empty.values);
    expect(nulls.sources['fetch.limits']).toBe('env');
  });

  it('a stored valid row wins over the env value', () => {
    const r = eff({
      'engine.concurrency': 3,
      'engine.typesafe_model': 'jev-1.14.0',
      'engine.llm_fallback_enabled': true,
      'engine.ollama_models': { fast: 'gemma4:31b', strong: 'glm-5.3' },
      'fetch.limits': { timeoutMs: 30_000, maxBytes: 1_000_000 },
      'api.rate_limits_enabled': false,
      'engine.typesafe_base_url': 'https://api.typesafe.ai/',
    });
    expect(r.problems).toEqual([]);
    expect(r.values.engineConcurrency).toBe(3);
    expect(r.values.typesafeModel).toBe('jev-1.14.0');
    expect(r.values.llmFallbackEnabled).toBe(true);
    expect(r.values.ollamaModels).toEqual({ fast: 'gemma4:31b', strong: 'glm-5.3' });
    expect(r.values.fetchLimits).toEqual({ timeoutMs: 30_000, maxBytes: 1_000_000 });
    expect(r.values.rateLimitsEnabled).toBe(false);
    expect(r.values.typesafeBaseUrl).toBe('https://api.typesafe.ai');
    expect(r.sources['engine.concurrency']).toBe('stored');
    expect(r.sources['engine.ingest_unrelated' as never]).toBeUndefined();
  });

  it('a stored INVALID row is ignored (env) and reported; other keys are unaffected', () => {
    const r = eff({
      'engine.typesafe_model': 'jev-fake', // not allowed in production
      'engine.typesafe_base_url': 'https://evil.example', // off the allowlist
      'engine.concurrency': 3,
      'ingest.max_age_days': 'many',
    });
    expect(r.values.typesafeModel).toBe('jev-1.13.0');
    expect(r.values.typesafeBaseUrl).toBe('https://api.typesafe.ai');
    expect(r.values.ingestMaxAgeDays).toBe(14);
    expect(r.values.engineConcurrency).toBe(3);
    expect(r.problems.map((p) => p.key).sort()).toEqual([
      'engine.typesafe_base_url',
      'engine.typesafe_model',
      'ingest.max_age_days',
    ]);
    expect(r.sources['engine.typesafe_model']).toBe('env');
    expect(r.problems.every((p) => typeof p.message === 'string' && p.message.length > 0)).toBe(
      true,
    );
    // negative control: the same rows are all valid in dev, so nothing is ignored there
    const dev = eff(
      { 'engine.typesafe_model': 'jev-fake', 'engine.typesafe_base_url': 'https://evil.example' },
      DEV,
    );
    expect(dev.problems).toEqual([]);
    expect(dev.values.typesafeModel).toBe('jev-fake');
  });

  it('an invalid row keeps the previous good value (source last_good) when one is given', () => {
    const first = eff({ 'engine.concurrency': 3 });
    const next = effectiveRuntimeSettings(
      new Map<string, unknown>([['engine.concurrency', 9999]]),
      ENV,
      PROD,
      first.values,
    );
    expect(next.values.engineConcurrency).toBe(3);
    expect(next.sources['engine.concurrency']).toBe('last_good');
    expect(next.problems.map((p) => p.key)).toEqual(['engine.concurrency']);
  });
});
