import type { Database } from '@bantoozi/db';
import type { EngineRouter } from '@bantoozi/engine';
import { AppError } from '@bantoozi/shared';
import type { Tier2AttemptResult } from '@bantoozi/translate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EvalSnapshot } from '../src/dataset/snapshot.js';
import { createRunStats, translateArticle, type CallEnv } from '../src/experiments/calls.js';
import { createEvalCredentialResolver } from '../src/experiments/credentials.js';

const snapshot: EvalSnapshot = {
  v: 1,
  articleId: '00000000-0000-4000-8000-000000000001',
  contentRevision: '1',
  url: null,
  lang: 'sk',
  input: {
    title: 'Nové batérie',
    excerpt: null,
    bodyLead: null,
    author: null,
    categories: [],
    wordCount: 2,
    lang: 'sk',
    feed: { title: null, site: null },
  },
  publishedAt: null,
  firstSeenAt: '2026-10-24T00:00:00Z',
  canonicalFeedId: null,
  carrierFeeds: [],
  storyGroupId: 'test-story',
};

function setup(execute = vi.fn(async () => ({ rows: [] }))) {
  const reserveExternalCall = vi.fn(async () => 'reservation');
  const recordExternalCall = vi.fn(async () => ({ overrun: false }));
  const translateOnce = vi.fn<(...args: unknown[]) => Promise<Tier2AttemptResult>>();
  const put = vi.fn();
  const env: CallEnv = {
    router: { reserveExternalCall, recordExternalCall } as unknown as EngineRouter,
    cache: { dir: '', key: () => 'test', get: async () => null, put },
    runId: '00000000-0000-4000-8000-000000000002',
    engine: null,
    typesafePricePerMTokUsd: 0.042,
    translators: {
      ollama: () => ({ estimate: () => ({ estimateUsd: 0.01 }), translateOnce }),
    } as unknown as CallEnv['translators'],
    credentials: createEvalCredentialResolver({
      db: { execute } as unknown as Database,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: {},
    }),
    ollamaModel: 'glm-5.3-flash',
    stats: createRunStats(),
    abort: { aborted: false, reason: null },
    estimating: false,
    clockMs: () => 0,
    articleLang: new Map([[snapshot.articleId, 'sk']]),
  };
  return { env, reserveExternalCall, recordExternalCall, translateOnce, put };
}

afterEach(() => vi.restoreAllMocks());

describe('eval tier-2 credential failures', () => {
  it('reports a credential lookup past its deadline as cancelled without reserving or sending', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
    const execute = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return new Promise<never>(() => undefined);
    });
    const { env, reserveExternalCall, recordExternalCall, translateOnce, put } = setup(execute);
    await expect(translateArticle(env, { snapshot, provider: 'ollama' })).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(timeout).toHaveBeenCalledWith(120_000);
    expect(execute).toHaveBeenCalledOnce();
    expect(reserveExternalCall).not.toHaveBeenCalled();
    expect(recordExternalCall).not.toHaveBeenCalled();
    expect(translateOnce).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each(['none', 'pending', 'disabled', 'lookup_failed'])(
    'keeps %s mapped to no_key',
    async (reason) => {
      const { env } = setup();
      vi.spyOn(env.credentials, 'useActive').mockRejectedValue(
        new AppError('ENGINE_UNAVAILABLE', 'unavailable', { details: { reason } }),
      );
      await expect(translateArticle(env, { snapshot, provider: 'ollama' })).resolves.toEqual({
        ok: false,
        reason: 'no_key',
      });
    },
  );

  it('keeps a sent failure when credential resolution cancels the repair', async () => {
    const { env, reserveExternalCall, recordExternalCall, translateOnce } = setup();
    vi.spyOn(env.credentials, 'useActive')
      .mockImplementationOnce(async (_provider, _signal, send) =>
        send({ apiKey: 'fixture-key', source: 'env' }),
      )
      .mockRejectedValueOnce(
        new AppError('ENGINE_UNAVAILABLE', 'unavailable', { details: { reason: 'cancelled' } }),
      );
    translateOnce.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_response',
      retryable: true,
      attempt: {
        engine: 'llm',
        model: env.ollamaModel,
        attempt: 1,
        status: 'invalid_response',
        startedAt: new Date('2026-10-24T00:00:00Z'),
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
        billing: 'known',
      },
    });
    await expect(translateArticle(env, { snapshot, provider: 'ollama' })).resolves.toEqual({
      ok: false,
      reason: 'ollama:invalid_response',
    });
    expect(reserveExternalCall).toHaveBeenCalledOnce();
    expect(recordExternalCall).toHaveBeenCalledOnce();
    expect(translateOnce).toHaveBeenCalledOnce();
  });
});
