import { describe, expect, it } from 'vitest';

import { callRestartFingerprint } from './support/m8b-t5-world.js';

/**
 * M8b-T5: the restart fingerprint covers exactly the restart-class values (model, base URLs, fallback,
 * Ollama models and concurrency, LibreTranslate URL) and nothing else, whatever the key order.
 */
const BASE = {
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
  fetchLimits: { timeoutMs: 10_000, maxBytes: 5_242_880 },
  rateLimitsEnabled: true,
  libretranslateUrl: 'http://libretranslate:5000',
};

describe('restartFingerprint', () => {
  it.each([
    ['typesafeModel', 'jev-1.14.0'],
    ['typesafeBaseUrl', 'https://api.typesafe.ai/v2'],
    ['llmFallbackEnabled', true],
    ['ollamaModels', { fast: 'glm-5.3', strong: 'glm-5.3-flash' }],
    ['ollamaBaseUrl', 'https://ollama.com/api'],
    ['ollamaMaxConcurrency', 3],
    ['libretranslateUrl', 'http://libretranslate-2:5000'],
  ] as const)('changes with %s', async (field, value) => {
    expect(await callRestartFingerprint({ ...BASE, [field]: value })).not.toBe(
      await callRestartFingerprint(BASE),
    );
  });

  it.each([
    ['typesafePricePerMtokUsd', 0.5],
    ['engineConcurrency', 2],
    ['prefilterMinCards', 5],
    ['ingestMaxAgeDays', 99],
    ['fetchLimits', { timeoutMs: 1_000, maxBytes: 65_536 }],
    ['rateLimitsEnabled', false],
  ] as const)('ignores the live-class %s', async (field, value) => {
    expect(await callRestartFingerprint({ ...BASE, [field]: value })).toBe(
      await callRestartFingerprint(BASE),
    );
  });

  it('is stable across key order and is a non-empty string', async () => {
    const reordered = Object.fromEntries(Object.entries(BASE).reverse());
    const reorderedModels = {
      ...reordered,
      ollamaModels: { strong: 'glm-5.3', fast: 'glm-5.3-flash' },
    };
    const a = await callRestartFingerprint(BASE);
    expect(a).toBeTypeOf('string');
    expect(a.length).toBeGreaterThan(0);
    expect(await callRestartFingerprint(reorderedModels)).toBe(a);
  });
});
