import { type JsonValue } from '@bantoozi/shared';
import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import { Agent } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTypeSafeEngine,
  type DecisionEngine,
  type EngineAttempt,
  type ProviderAuth,
  type Question,
  type TypeSafeEngineOptions,
} from '../src/index.js';

const AUTH: ProviderAuth = { apiKey: 'sk-probe-test-77', source: 'env' };
const CARD: Question = { type: 'noul', instructions: { interest: 'Solid-state batteries' } };
const STATE: JsonValue = { article: { title: 'Solid-state battery pilot line passes tests' } };

let fake: FakeTypeSafeServer;
let agent: Agent;

beforeAll(async () => {
  fake = await startFakeTypeSafe();
  agent = new Agent();
});
afterAll(async () => {
  await fake.close();
  await agent.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.setOptions({
    models: undefined,
    statusOverride: undefined,
    failRate: 0,
    latencyMs: 0,
    apiKey: AUTH.apiKey,
  });
});

function engine(overrides: Partial<TypeSafeEngineOptions> = {}): DecisionEngine {
  return createTypeSafeEngine({
    baseUrl: fake.url,
    model: 'jev-1.13.0',
    pricePerMTokUsd: 0.042,
    production: false,
    dispatcher: agent,
    ...overrides,
  });
}

const alias = (overrides: Partial<TypeSafeEngineOptions> = {}): DecisionEngine =>
  engine({ model: 'jev-latest', resolveAlias: true, ...overrides });

function ask(e: DecisionEngine): Promise<EngineAttempt> {
  return e.ask(
    {
      kind: 'enrich',
      state: STATE,
      questions: { card: CARD },
      questionSetSha: 'qs-probe',
      stateSha256: 'state-probe',
      priority: 'interactive',
      authorization: { type: 'eval', runId: 'run-probe' },
    },
    new AbortController().signal,
    AUTH,
  );
}

function failed(attempt: EngineAttempt): Extract<EngineAttempt, { ok: false }> {
  if (attempt.ok) throw new Error(`expected a failure, got ok (${attempt.model})`);
  return attempt;
}

function okModel(attempt: EngineAttempt): string {
  if (!attempt.ok) throw new Error(`expected ok, got ${attempt.status}: ${attempt.detail ?? ''}`);
  return attempt.model;
}

const PROD = { baseUrl: 'https://api.typesafe.example', production: true } as const;

describe('Jev model probe: configuration', () => {
  it('E1 an alias without resolveAlias throws in production and outside it', () => {
    expect(() => engine({ ...PROD, model: 'jev-latest' })).toThrow(/pinned version in production/);
    expect(() => engine({ model: 'jev-latest' })).toThrow(TypeError);
    expect(() => engine({ model: 'jev-latest' })).toThrow(/alias/i);
    expect(() => engine({ model: 'jev-latest', resolveAlias: false })).toThrow(/alias/i);
    expect(() => engine({ ...PROD, model: 'jev-latest', resolveAlias: true })).not.toThrow();
    expect(() => engine({ model: 'jev-latest', resolveAlias: true })).not.toThrow();
  });

  it('E2 resolveAlias with a concrete model throws', () => {
    expect(() => engine({ model: 'jev-1.13.0', resolveAlias: true })).toThrow(/resolveAlias/);
    expect(() => engine({ ...PROD, model: 'jev-1.13.0', resolveAlias: true })).toThrow(
      /resolveAlias/,
    );
    expect(() => engine({ model: 'jev-1.13.0' })).not.toThrow();
  });

  it('E6 production accepts a pinned release candidate and refuses aliases', () => {
    expect(() => engine({ ...PROD, model: 'jev-1.14.0-rc1' })).not.toThrow();
    for (const model of ['jev-latest', 'jev-beta', 'latest']) {
      expect(() => engine({ ...PROD, model })).toThrow(/pinned version in production/);
    }
  });
});

describe('Jev model probe: alias resolution', () => {
  it('E3 sends the alias and reports the answered concrete model', async () => {
    fake.setOptions({ models: { 'jev-latest': 'jev-1.13.0' } });
    expect(okModel(await ask(alias()))).toBe('jev-1.13.0');
    expect((fake.requests[0]?.body as { model: string }).model).toBe('jev-latest');
    fake.setOptions({ models: { 'jev-latest': 'jev-1.14.0' } });
    expect(okModel(await ask(alias()))).toBe('jev-1.14.0');
    expect((fake.requests[1]?.body as { model: string }).model).toBe('jev-latest');
  });

  it('E3b an alias answered with a release candidate is accepted', async () => {
    fake.setOptions({ models: { 'jev-latest': 'jev-1.14.0-rc1' } });
    expect(okModel(await ask(alias()))).toBe('jev-1.14.0-rc1');
  });

  it('E3c an alias answered with build metadata is accepted, a non-conforming answer is not shown', async () => {
    fake.setOptions({ models: { 'jev-latest': 'jev-1.14.0+build5' } });
    expect(okModel(await ask(alias()))).toBe('jev-1.14.0+build5');
    fake.setOptions({ models: { 'jev-latest': 'jev-1.14.0/x' } });
    expect(failed(await ask(alias())).detail).toBe('model_mismatch:unrecognized');
    fake.setOptions({ models: { 'jev-latest': `jev-1.14.0-${'a'.repeat(60)}` } });
    expect(failed(await ask(alias())).detail).toBe('model_mismatch:unrecognized');
  });

  it('E4 an answer equal to the alias or from another vendor is a mismatch', async () => {
    fake.setOptions({ models: { 'jev-latest': 'jev-latest' } });
    let attempt = failed(await ask(alias()));
    expect(attempt.status).toBe('invalid_response');
    expect(attempt.detail).toBe('model_mismatch:jev-latest');
    fake.setOptions({ models: { 'jev-latest': 'gpt-4-1.0.0' } });
    attempt = failed(await ask(alias()));
    expect(attempt.status).toBe('invalid_response');
    expect(attempt.detail).toBe('model_mismatch:gpt-4-1.0.0');
    fake.setOptions({ models: { 'jev-latest': 'jev-1.2.3' } });
    expect(okModel(await ask(alias()))).toBe('jev-1.2.3');
  });

  it('E5 a concrete engine keeps the exact answer check', async () => {
    fake.setOptions({ models: { 'jev-1.13.0': 'jev-1.14.0' } });
    const attempt = failed(await ask(engine()));
    expect(attempt.status).toBe('invalid_response');
    expect(attempt.detail).toBe('model_mismatch:jev-1.14.0');
    fake.setOptions({ models: { 'jev-1.13.0': 'jev-1.13.0' } });
    expect(okModel(await ask(engine()))).toBe('jev-1.13.0');
  });
});

describe('Jev model probe: retired models', () => {
  it('E7a an unknown model is model_unavailable', async () => {
    fake.setOptions({ models: {} });
    for (const e of [engine(), alias()]) {
      const attempt = failed(await ask(e));
      expect(attempt.status).toBe('error');
      expect(attempt.retryable).toBe(false);
      expect(attempt.billing).toBe('known');
      expect(attempt.detail).toBe('model_unavailable:http_404');
    }
    fake.setOptions({ models: { 'jev-1.13.0': 'jev-1.13.0' } });
    expect(okModel(await ask(engine()))).toBe('jev-1.13.0');
  });

  const respond = (status: number, body?: unknown): void =>
    fake.setOptions({
      statusOverride: () => ({ status, ...(body === undefined ? {} : { body }) }),
    });

  it('E7b 410 is model_unavailable, 502 is not', async () => {
    respond(410);
    const attempt = failed(await ask(engine()));
    expect(attempt.status).toBe('error');
    expect(attempt.retryable).toBe(false);
    expect(attempt.billing).toBe('known');
    expect(attempt.detail).toBe('model_unavailable:http_410');
    respond(502);
    expect(failed(await ask(engine())).detail).not.toMatch(/^model_unavailable/);
  });

  it('E7c provider error codes map to model_unavailable', async () => {
    respond(404, { error: { type: 'not_found_error', code: 'model_not_found' } });
    expect(failed(await ask(engine())).detail).toBe('model_unavailable:http_404');
    respond(400, { error: { type: 'invalid_request_error', code: 'unknown_model' } });
    expect(failed(await ask(engine())).detail).toBe('model_unavailable:http_400');
    respond(422, { error: { code: 'model_retired' } });
    expect(failed(await ask(engine())).detail).toBe('model_unavailable:http_422');
  });

  it('E7d a FastAPI validation error on the model field maps', async () => {
    respond(422, {
      detail: [{ loc: ['body', 'model'], msg: 'unknown model', type: 'value_error' }],
    });
    const attempt = failed(await ask(engine()));
    expect(attempt.detail).toBe('model_unavailable:http_422');
    expect(attempt.retryable).toBe(false);
    respond(422, {
      detail: [{ loc: ['body', 'questions'], msg: 'field required', type: 'value_error' }],
    });
    const control = failed(await ask(engine()));
    expect(control.status).toBe('invalid_request');
    expect(control.detail).not.toMatch(/^model_unavailable/);
  });

  it('E7e negative controls stay what they were', async () => {
    respond(404, { error: { type: 'not_found_error', code: 'not_found' } });
    expect(failed(await ask(engine())).detail).toBe('http_404');
    respond(400, { error: { type: 'invalid_request_error', code: 'bad_request' } });
    const rejected = failed(await ask(engine()));
    expect(rejected.status).toBe('invalid_request');
    expect(rejected.detail).toBe('http_400:bad_request');
    respond(413, { error: { code: 'model_not_found' } });
    expect(failed(await ask(engine())).detail).not.toMatch(/^model_unavailable/);
  });
});
