import type { Database } from '@bantoozi/db';
import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_CALL_DEADLINE_MS,
  CLASSIFICATION_LEASE_MS,
  createWorkerModels,
  type WorkerModelConfig,
} from '../src/classification-deps.js';

const config: WorkerModelConfig = {
  nodeEnv: 'test',
  typesafeBaseUrl: 'http://127.0.0.1:9',
  typesafeModel: 'jev-1.13.0',
  typesafePricePerMtokUsd: 0.042,
  engineConcurrency: 4,
  dailyBudgetUsd: 2,
  ollamaBaseUrl: 'http://127.0.0.1:9',
  ollamaModelFast: 'glm-fast',
  ollamaModelStrong: 'glm-strong',
  ollamaMaxConcurrency: 2,
  llmFallbackEnabled: false,
  libretranslateUrl: 'http://127.0.0.1:9',
  providerMasterKeyId: undefined,
  providerMasterKeys: undefined,
  typesafeApiKey: undefined,
  ollamaApiKey: undefined,
};

const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('createWorkerModels', () => {
  it('shares one router and resolver between classification, translation and key validation', async () => {
    const models = createWorkerModels({} as Database, config, logger);
    const { classification, providerValidation, credentials } = models;

    expect(classification.primaryModel).toBe('jev-1.13.0');
    expect(classification.callDeadlineMs).toBe(CLASSIFICATION_CALL_DEADLINE_MS);
    // The lease outlasts one router call: the deadline plus the final (LLM) attempt's 60 s timeout.
    expect(CLASSIFICATION_LEASE_MS).toBeGreaterThan(CLASSIFICATION_CALL_DEADLINE_MS + 60_000);
    expect(classification.leaseMs).toBe(CLASSIFICATION_LEASE_MS);
    expect(providerValidation.router).toBe(classification.router);
    expect(providerValidation.credentials).toBe(credentials);
    expect(providerValidation.config).toBe(config);
    expect(classification.translation).toMatchObject({
      credentials,
      modelFast: 'glm-fast',
      modelStrong: 'glm-strong',
    });
    expect(typeof classification.translation?.supportedSources).toBe('function');
    // Without a keyring the resolver reports it by reason, never by key material.
    expect(credentials.keyring()).toEqual({ ok: false, reason: expect.any(String) });

    await expect(models.close()).resolves.toBeUndefined();
  });
});
