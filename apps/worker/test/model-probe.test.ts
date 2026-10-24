import { createTypeSafeEngine, type EngineRouter } from '@bantoozi/engine';
import type { CredentialResolver } from '@bantoozi/shared/server';
import { startFakeTypeSafe } from '@bantoozi/testing';
import { describe, expect, it, vi } from 'vitest';

import { createModelProber, MODEL_PROBE_QUESTIONS, MODEL_PROBE_STATE } from '../src/model-probe.js';

// Both consumers receive these exact fake responses (D-273).
const responses = [
  { status: 404, body: {}, unavailable: false },
  { status: 404, body: { error: { code: 'not_found' } }, unavailable: false },
  { status: 410, body: {}, unavailable: true },
  ...[400, 404, 422].map((status) => ({
    status,
    body: { error: { code: 'model_not_found' } },
    unavailable: true,
  })),
  { status: 400, body: { error: { code: 'bad_request' } }, unavailable: false },
  {
    status: 422,
    body: { detail: [{ loc: ['body', 'model'], type: 'value_error' }] },
    unavailable: true,
  },
  { status: 413, body: { error: { code: 'model_not_found' } }, unavailable: false },
  { status: 413, body: { error: { code: 'model_unavailable' } }, unavailable: false },
];

describe('D-273 engine and prober agreement', () => {
  it.each(responses)(
    'HTTP $status: model unavailable = $unavailable ($body)',
    async ({ status, body, unavailable }) => {
      const fake = await startFakeTypeSafe({ statusOverride: () => ({ status, body }) });
      try {
        const auth = { apiKey: 'test-key', source: 'env' as const };
        const credentials: Pick<CredentialResolver, 'useActive'> = {
          useActive: async (_provider, _signal, send) => send(auth),
        };
        const ledger: Pick<
          EngineRouter,
          'reserveExternalCall' | 'recordExternalCall' | 'releaseExternalCall'
        > = {
          reserveExternalCall: vi.fn(async () => 'reservation'),
          recordExternalCall: vi.fn(async () => ({ overrun: false })),
          releaseExternalCall: vi.fn(async () => undefined),
        };
        const engine = createTypeSafeEngine({
          baseUrl: fake.url,
          model: 'jev-1.13.0',
          pricePerMTokUsd: 0.042,
          production: false,
        });
        const attempt = await engine.ask(
          {
            kind: 'eval',
            state: MODEL_PROBE_STATE,
            questions: MODEL_PROBE_QUESTIONS,
            questionSetSha: 'test',
            stateSha256: 'test',
            priority: 'interactive',
            authorization: { type: 'model_probe', model: 'jev-1.13.0' },
          },
          new AbortController().signal,
          auth,
        );
        expect(attempt).toMatchObject({ ok: false, retryable: false, billing: 'known' });
        if (attempt.ok) throw new Error('expected failure');
        expect(attempt.detail?.startsWith('model_unavailable:')).toBe(unavailable);
        const prober = createModelProber({
          ledger,
          credentials,
          config: {
            nodeEnv: 'test',
            typesafeBaseUrl: fake.url,
            typesafePricePerMtokUsd: 0.042,
          },
          logger: { info() {}, warn() {}, error() {} },
        });
        expect(await prober.probe('jev-1.13.0')).toMatchObject({
          ok: false,
          error: unavailable ? 'model_unavailable' : 'request_rejected',
        });
        expect(fake.requests).toHaveLength(2);
        expect(ledger.recordExternalCall).toHaveBeenCalledTimes(1);
      } finally {
        await fake.close();
      }
    },
  );
});
