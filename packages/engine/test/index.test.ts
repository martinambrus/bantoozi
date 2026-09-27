import { describe, expect, it } from 'vitest';

import * as engine from '../src/index.js';

describe('@bantoozi/engine public entry', () => {
  it('exposes the router and its building blocks', () => {
    expect(engine.PACKAGE_NAME).toBe('@bantoozi/engine');
    for (const name of [
      'createEngineRouter',
      'createBreakerCoordinator',
      'createMemoryCircuitStore',
      'createPrioritySemaphore',
      'createRateLimiter',
      'createTypeSafeEngine',
      'createLlmFallbackEngine',
      'validateRequest',
      'normalizeAnswers',
      'splitQuestionsForLlm',
      'decideRetry',
      'parseRetryAfter',
      'nextBudgetAlerts',
    ] as const) {
      expect(typeof engine[name]).toBe('function');
    }
  });
});
