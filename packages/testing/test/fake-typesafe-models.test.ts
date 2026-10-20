import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FAKE_TYPESAFE_MODEL,
  FAKE_TYPESAFE_PATH,
  fakeTypeSafeAnswer,
  startFakeTypeSafe,
  type FakeTypeSafeServer,
} from '../src/index.js';

const body = (model: string): Record<string, unknown> => ({
  model,
  state: { article: { title: 'Solid-state battery pilot line' } },
  questions: { card: { type: 'noul', instructions: { interest: 'Batteries' } } },
});

let server: FakeTypeSafeServer;

beforeAll(async () => {
  server = await startFakeTypeSafe();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
  server.setOptions({ models: undefined, statusOverride: undefined, failRate: 0 });
});

async function post(payload: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${server.url}${FAKE_TYPESAFE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json() };
}

async function answered(model: string): Promise<unknown> {
  const reply = await post(body(model));
  expect(reply.status).toBe(200);
  return (reply.json as { model: unknown }).model;
}

describe('fake TypeSafe models table', () => {
  it('F1 legacy: answers jev-fake whatever was requested', async () => {
    expect(await answered('jev-latest')).toBe(FAKE_TYPESAFE_MODEL);
    expect(await answered('anything')).toBe('jev-fake');
  });

  it('F2 models maps the requested id to the answering id', async () => {
    server.setOptions({ models: { 'jev-latest': 'jev-1.13.0', 'jev-1.13.0': 'jev-1.13.0' } });
    expect(await answered('jev-latest')).toBe('jev-1.13.0');
    expect(await answered('jev-1.13.0')).toBe('jev-1.13.0');
    server.setOptions({ models: { 'jev-latest': 'jev-1.14.0' } });
    expect(await answered('jev-latest')).toBe('jev-1.14.0');
  });

  it('F3 a mismatch table answers a different model than requested', async () => {
    server.setOptions({ models: { 'jev-1.13.0': 'jev-1.14.0' } });
    expect(await answered('jev-1.13.0')).toBe('jev-1.14.0');
    server.setOptions({ models: { 'jev-1.13.0': 'jev-1.13.0' } });
    expect(await answered('jev-1.13.0')).toBe('jev-1.13.0');
  });

  it('F4 an unknown id is a 404 model_not_found', async () => {
    server.setOptions({ models: { 'jev-1.13.0': 'jev-1.13.0' } });
    const reply = await post(body('jev-1.12.0'));
    expect(reply.status).toBe(404);
    expect(reply.json).toEqual({
      error: {
        type: 'not_found_error',
        code: 'model_not_found',
        message: 'fake TypeSafe: unknown or retired model',
      },
    });
    expect((await post(body('jev-1.13.0'))).status).toBe(200);
  });

  it('F5 setOptions replaces the table mid-test', async () => {
    server.setOptions({ models: { 'jev-1.13.0': 'jev-1.13.0' } });
    expect(await answered('jev-1.13.0')).toBe('jev-1.13.0');
    server.setOptions({ models: { 'jev-1.13.0': 'jev-1.14.0' } });
    expect(await answered('jev-1.13.0')).toBe('jev-1.14.0');
    server.setOptions({ models: undefined });
    expect(await answered('jev-1.13.0')).toBe('jev-fake');
  });

  it('F6 order: statusOverride, failRate, validation, then the models rule', async () => {
    server.setOptions({ models: {}, statusOverride: () => ({ status: 503 }) });
    expect((await post(body('unknown'))).status).toBe(503);
    server.setOptions({ statusOverride: undefined, failRate: 1, failStatus: 502 });
    expect((await post(body('unknown'))).status).toBe(502);
    server.setOptions({ failRate: 0 });
    const invalid = await post({ model: 'unknown', state: { article: { title: 'x' } } });
    expect(invalid.status).toBe(422);
    expect((await post(body('unknown'))).status).toBe(404);
  });

  it('F7 fakeTypeSafeAnswer takes the answering model', () => {
    const request = body('jev-latest');
    expect((fakeTypeSafeAnswer(request, 'jev-1.13.0') as { model: string }).model).toBe(
      'jev-1.13.0',
    );
    expect((fakeTypeSafeAnswer(request) as { model: string }).model).toBe(FAKE_TYPESAFE_MODEL);
  });
});
