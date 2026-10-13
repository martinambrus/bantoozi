import { describe, expect, it } from 'vitest';

import { AdminSettingsValuesSchema, ENV_RANGES, validateRuntimeSetting } from '../src/index.js';

/** PR #28 round 5: the response schema takes every env value; the write validation stays narrow. */
describe('env ranges versus write bounds', () => {
  const ctx = { production: false, providerHostAllowlist: [], ollamaPricedModels: [] };
  const widest = {
    'engine.concurrency': ENV_RANGES.engineConcurrency.max,
    'engine.ollama_max_concurrency': ENV_RANGES.ollamaMaxConcurrency.max,
    'engine.prefilter_min_cards': ENV_RANGES.prefilterMinCards.max,
    'ingest.max_age_days': ENV_RANGES.ingestMaxAgeDays.max,
    'fetch.limits': {
      timeoutMs: ENV_RANGES.fetchTimeoutMs.max,
      maxBytes: ENV_RANGES.fetchMaxBytes.max,
    },
    'engine.typesafe_price_per_mtok_usd': 5000,
  };

  it('the values schema shows the widest env value of each runtime key', () => {
    const shape = AdminSettingsValuesSchema.shape;
    for (const [key, value] of Object.entries(widest)) {
      expect(shape[key as keyof typeof shape].safeParse(value).success, key).toBe(true);
    }
  });

  it('negative control: a value beyond the env range is not shown, and a write keeps the narrow bound', () => {
    const shape = AdminSettingsValuesSchema.shape;
    expect(shape['engine.concurrency'].safeParse(257).success).toBe(false);
    expect(validateRuntimeSetting('engine.concurrency', 128, ctx).ok).toBe(false);
    expect(validateRuntimeSetting('ingest.max_age_days', 366, ctx).ok).toBe(false);
  });
});
