import { describe, expect, it } from 'vitest';

import * as translate from '../src/index.js';
import {
  PACKAGE_NAME,
  TRANSLATION_FIELDS,
  TRANSLATION_POLICY_VERSION,
  toExternalCall,
  type TranslationAttempt,
} from '../src/index.js';

describe('@bantoozi/translate public API', () => {
  it('exposes the translators, the assessment, the row rules and the policy version', () => {
    expect(PACKAGE_NAME).toBe('@bantoozi/translate');
    expect(TRANSLATION_FIELDS).toEqual(['title', 'excerpt', 'body_lead']);
    expect(TRANSLATION_POLICY_VERSION).toMatch(/^translate-policy-\d+$/);
    for (const name of [
      'createLibreTranslateClient',
      'createOllamaTranslator',
      'assessTranslation',
      'selectBestTranslation',
      'decideTier2',
      'mayRunTier2',
      'skippedTier2QualityDetail',
      'translateCardText',
      'verifyTier1',
      'translationSourceSha256',
    ]) {
      expect(typeof (translate as Record<string, unknown>)[name], name).toBe('function');
    }
    // Internal HTTP plumbing stays private.
    expect(translate).not.toHaveProperty('classifyThrown');
    expect(translate).not.toHaveProperty('readBoundedBody');
  });

  it('maps a tier-1 attempt to an engine_calls record: libretranslate, translate, cost 0', () => {
    const attempt: TranslationAttempt = {
      engine: 'libretranslate',
      attempt: 2,
      status: 'error',
      httpStatus: 503,
      error: 'http_503',
      startedAt: new Date('2026-09-26T10:00:00Z'),
      latencyMs: 12,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      billing: 'known',
    };
    expect(toExternalCall(attempt, { logicalRequestId: 'translate:42:3:t1' })).toEqual({
      engine: 'libretranslate',
      kind: 'translate',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 12,
      status: 'error',
      error: 'http_503',
      billing: 'known',
      logicalRequestId: 'translate:42:3:t1',
      attempt: 2,
    });
  });
});
