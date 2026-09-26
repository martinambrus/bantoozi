import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FAKE_OLLAMA_PATH,
  fakeOllamaContent,
  fakeOllamaResponse,
  startFakeOllama,
  type FakeOllamaServer,
} from '../src/index.js';

const SYSTEM = 'You are a careful classifier. Output only JSON matching the schema.';
const DECISION = {
  state: { article: { title: 'Solid-state battery pilot line', excerpt: 'The carmaker reports.' } },
  questions: {
    card: { type: 'noul', instructions: { interest: 'battery chemistry' } },
    kind: {
      type: 'choice',
      instructions: 'x',
      criteria: { news_report: 'Reports an event', opinion: null },
    },
    depth: { type: 'score', instructions: 'x', criteria: ['a', 'b', 'c'] },
  },
};

function chat(user: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'glm-5.3-flash',
    stream: false,
    options: { temperature: 0, num_predict: 512 },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
    ],
    ...extra,
  };
}

interface ChatResponse {
  model: string;
  created_at: string;
  message: { role: string; content: string };
  done: boolean;
  done_reason: string;
  prompt_eval_count: number;
  eval_count: number;
}

const tokens = (text: string): number => Math.ceil(text.length / 3.5);

describe('fake Ollama content', () => {
  it('answers a decision request with the spec 04 §10 rules in the fallback schema', () => {
    expect(JSON.parse(fakeOllamaContent(chat(DECISION)))).toEqual({
      card: { p: 0.9 },
      kind: { probabilities: { news_report: 0.7, opinion: expect.closeTo(0.3, 12) } },
      depth: { probabilities: { '0': 0, '1': 1, '2': 0 } },
    });
    expect(fakeOllamaContent(chat(DECISION))).not.toMatch(/\s/);
  });

  it('echoes any other JSON object (a translation request)', () => {
    const translation = { source: 'cs', target: 'en', texts: ['Ahoj světe'] };
    expect(JSON.parse(fakeOllamaContent(chat(translation)))).toEqual(translation);
  });

  it('uses the last user message', () => {
    const body = chat(DECISION);
    (body.messages as unknown[]).push(
      { role: 'assistant', content: '{}' },
      { role: 'user', content: '{"again": true}' },
    );
    expect(fakeOllamaContent(body)).toBe('{"again":true}');
  });

  it('answers {} to anything it cannot read', () => {
    expect(fakeOllamaContent(chat('plain text'))).toBe('{}');
    expect(fakeOllamaContent(chat('[1, 2]'))).toBe('{}');
    expect(fakeOllamaContent(chat({ state: {}, questions: {} }))).toBe('{}');
    expect(fakeOllamaContent({ model: 'x' })).toBe('{}');
    expect(fakeOllamaContent(null)).toBe('{}');
  });
});

describe('fake Ollama responses', () => {
  it('ok: a complete /api/chat response with usage counters', () => {
    const body = chat(DECISION);
    const response = fakeOllamaResponse(body) as ChatResponse;
    const content = fakeOllamaContent(body);
    const messages = body.messages as Array<{ content: string }>;
    expect(response).toEqual({
      model: 'glm-5.3-flash',
      created_at: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content },
      done: true,
      done_reason: 'stop',
      total_duration: expect.any(Number),
      load_duration: expect.any(Number),
      prompt_eval_count: messages.reduce((total, m) => total + tokens(m.content), 0),
      prompt_eval_duration: expect.any(Number),
      eval_count: tokens(content),
      eval_duration: expect.any(Number),
    });
  });

  it('malformed: the content wrapped in chatty non-JSON text', () => {
    const response = fakeOllamaResponse(chat(DECISION), { mode: 'malformed' }) as ChatResponse;
    expect(response.message.content).toBe(
      `Sure! Here are the answers you asked for: ${fakeOllamaContent(chat(DECISION))}`,
    );
    expect(() => JSON.parse(response.message.content) as unknown).toThrow(SyntaxError);
    expect(response.done_reason).toBe('stop');
  });

  it('truncated: the first half, done_reason "length", eval_count = num_predict', () => {
    const content = fakeOllamaContent(chat(DECISION));
    const response = fakeOllamaResponse(chat(DECISION), { mode: 'truncated' }) as ChatResponse;
    expect(response.message.content).toBe(content.slice(0, Math.floor(content.length / 2)));
    expect(response.done).toBe(true);
    expect(response.done_reason).toBe('length');
    expect(response.eval_count).toBe(512);
    const noCap = chat(DECISION, { options: { temperature: 0 } });
    const uncapped = fakeOllamaResponse(noCap, { mode: 'truncated' }) as ChatResponse;
    expect(uncapped.eval_count).toBe(tokens(uncapped.message.content));
  });

  it('uses reply for the content, then applies the mode', () => {
    const reply = (): string => '{"text": "Hello world"}';
    expect((fakeOllamaResponse(chat(DECISION), { reply }) as ChatResponse).message.content).toBe(
      reply(),
    );
    expect(
      (fakeOllamaResponse(chat(DECISION), { reply, mode: 'truncated' }) as ChatResponse).message
        .content,
    ).toBe(reply().slice(0, Math.floor(reply().length / 2)));
  });

  it('answers a body without model or messages', () => {
    const response = fakeOllamaResponse({}) as ChatResponse;
    expect(response.model).toBe('fake');
    expect(response.message.content).toBe('{}');
    expect(response.prompt_eval_count).toBe(0);
  });
});

describe('fake Ollama server', () => {
  let server: FakeOllamaServer;

  beforeAll(async () => {
    server = await startFakeOllama();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.setOptions({
      mode: 'ok',
      status: undefined,
      headers: undefined,
      reply: undefined,
      statusOverride: undefined,
      latencyMs: 0,
      recordRequests: true,
      apiKey: undefined,
    });
  });

  async function post(
    body: unknown,
    init: { path?: string; method?: string; headers?: Record<string, string>; raw?: string } = {},
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    const method = init.method ?? 'POST';
    const res = await fetch(`${server.url}${init.path ?? FAKE_OLLAMA_PATH}`, {
      method,
      headers: { 'content-type': 'application/json', ...init.headers },
      ...(method === 'GET' ? {} : { body: init.raw ?? JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, headers: res.headers, json };
  }

  it('answers POST /api/chat and records the request', async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const before = server.requestCount();
    const body = chat(DECISION);
    const reply = await post(body, { headers: { authorization: 'Bearer k' } });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual(fakeOllamaResponse(body));
    expect(server.requestCount()).toBe(before + 1);
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/chat',
      rawBody: JSON.stringify(body),
      body,
    });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer k');
  });

  it('sends each mode', async () => {
    const body = chat(DECISION);
    server.setOptions({ mode: 'malformed' });
    expect((await post(body)).json).toEqual(fakeOllamaResponse(body, { mode: 'malformed' }));
    server.setOptions({ mode: 'truncated' });
    expect((await post(body)).json).toEqual(fakeOllamaResponse(body, { mode: 'truncated' }));
    server.setOptions({ mode: 'status' });
    expect(await post(body)).toMatchObject({
      status: 503,
      json: { error: 'fake Ollama status 503' },
    });
    server.setOptions({ mode: 'status', status: 429, headers: { 'retry-after': '4' } });
    const limited = await post(body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('4');
  });

  it('uses reply in every 200 mode', async () => {
    const reply = (received: unknown): string =>
      JSON.stringify({ model: (received as { model: string }).model });
    server.setOptions({ reply });
    const body = chat(DECISION);
    expect((await post(body)).json).toMatchObject({
      message: { content: '{"model":"glm-5.3-flash"}' },
    });
    server.setOptions({ mode: 'truncated' });
    const full = '{"model":"glm-5.3-flash"}';
    expect((await post(body)).json).toMatchObject({
      message: { content: full.slice(0, Math.floor(full.length / 2)) },
      done_reason: 'length',
    });
  });

  it('lets statusOverride replace any response', async () => {
    server.setOptions({
      mode: 'status',
      statusOverride: () => ({ status: 200, body: { done: true, message: { content: 'x' } } }),
    });
    expect(await post(chat(DECISION))).toMatchObject({ status: 200, json: { done: true } });
    server.setOptions({ statusOverride: () => undefined });
    expect((await post(chat(DECISION))).status).toBe(503);
  });

  it('delays responses by latencyMs', async () => {
    server.setOptions({ latencyMs: 150 });
    const started = Date.now();
    expect((await post(chat(DECISION))).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('records nothing with recordRequests: false', async () => {
    server.setOptions({ recordRequests: false });
    const before = server.requestCount();
    await post(chat(DECISION));
    expect(server.requests).toHaveLength(0);
    expect(server.requestCount()).toBe(before + 1);
  });

  it('requires the bearer key when apiKey is set', async () => {
    server.setOptions({ apiKey: 'secret' });
    expect(await post(chat(DECISION))).toMatchObject({
      status: 401,
      json: { error: 'unauthorized' },
    });
    expect(
      (await post(chat(DECISION), { headers: { authorization: 'Bearer secret' } })).status,
    ).toBe(200);
  });

  it('answers other paths, methods and malformed bodies like Ollama', async () => {
    expect(await post(chat(DECISION), { path: '/api/generate' })).toMatchObject({
      status: 404,
      json: { error: '404 page not found' },
    });
    expect((await post(undefined, { method: 'GET' })).status).toBe(405);
    expect(await post(undefined, { raw: '{"model": ' })).toMatchObject({
      status: 400,
      json: { error: 'invalid JSON' },
    });
    expect((await post(undefined, { raw: `"${'x'.repeat(17 * 1024 * 1024)}"` })).status).toBe(413);
  });

  it('validates latencyMs', async () => {
    expect(() => server.setOptions({ latencyMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    await expect(startFakeOllama({ latencyMs: -5 })).rejects.toThrow(RangeError);
  });
});
