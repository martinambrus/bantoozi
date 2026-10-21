import { createHash } from 'node:crypto';

import { canonicalJson } from '@bantoozi/shared';
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

/** The hash as it was before JEV-2: exactly the seven restart-class values. */
function legacyFingerprint(v: typeof BASE): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        typesafeModel: v.typesafeModel,
        typesafeBaseUrl: v.typesafeBaseUrl,
        llmFallbackEnabled: v.llmFallbackEnabled,
        ollamaModels: { fast: v.ollamaModels.fast, strong: v.ollamaModels.strong },
        ollamaBaseUrl: v.ollamaBaseUrl,
        ollamaMaxConcurrency: v.ollamaMaxConcurrency,
        libretranslateUrl: v.libretranslateUrl,
      }),
    )
    .digest('hex');
}

const ALIAS = { ...BASE, typesafeModel: 'jev-latest' };

describe('restartFingerprint and the jev-latest alias (W1, JEV-2)', () => {
  it('W1 legacy: a concrete model hashes exactly the pre-change formula, with or without a resolved model', async () => {
    const legacy = legacyFingerprint(BASE);
    expect(await callRestartFingerprint({ ...BASE, typesafeResolvedModel: null })).toBe(legacy);
    expect(await callRestartFingerprint({ ...BASE, typesafeResolvedModel: 'jev-1.14.0' })).toBe(
      legacy,
    );
    // Control: the formula itself is sensitive to the model.
    expect(legacyFingerprint({ ...BASE, typesafeModel: 'jev-1.14.0' })).not.toBe(legacy);
  });

  it('W1: for the alias, resolved 1.13.0, resolved 1.14.0 and unresolved are three different hashes', async () => {
    const a = await callRestartFingerprint({ ...ALIAS, typesafeResolvedModel: 'jev-1.13.0' });
    const b = await callRestartFingerprint({ ...ALIAS, typesafeResolvedModel: 'jev-1.14.0' });
    const c = await callRestartFingerprint({ ...ALIAS, typesafeResolvedModel: null });
    expect(new Set([a, b, c]).size).toBe(3);
    // The same resolution hashes the same; the alias is not the concrete configuration.
    expect(await callRestartFingerprint({ ...ALIAS, typesafeResolvedModel: 'jev-1.13.0' })).toBe(a);
    expect(a).not.toBe(await callRestartFingerprint({ ...BASE, typesafeResolvedModel: null }));
  });

  it('W1: for the alias, a live-class field still changes nothing and a restart-class one still does', async () => {
    const resolved = { ...ALIAS, typesafeResolvedModel: 'jev-1.13.0' };
    const base = await callRestartFingerprint(resolved);
    expect(await callRestartFingerprint({ ...resolved, engineConcurrency: 2 })).toBe(base);
    expect(await callRestartFingerprint({ ...resolved, prefilterMinCards: 5 })).toBe(base);
    // The resolution itself is part of the hash.
    expect(await callRestartFingerprint({ ...resolved, typesafeResolvedModel: null })).not.toBe(
      base,
    );
    expect(await callRestartFingerprint({ ...resolved, ollamaMaxConcurrency: 3 })).not.toBe(base);
  });
});
