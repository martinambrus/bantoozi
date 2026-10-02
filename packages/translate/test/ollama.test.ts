import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { REQUEST_OVERHEAD_TOKENS, conservativeTokens, createManualClock } from '@bantoozi/shared';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OLLAMA_PRICES,
  TIER2_MAX_OUTPUT_CHARS,
  TIER2_SYSTEM_PROMPT_TEMPLATE,
  buildTier2Request,
  createOllamaTranslator,
  estimateTier2Cost,
  parseTier2Content,
  tier2CostUsd,
  tier2SystemPrompt,
  toExternalCall,
  type OllamaTranslator,
  type OllamaTranslatorOptions,
  type Tier2AttemptResult,
  type TranslationTexts,
} from '../src/index.js';

const ORIGIN = 'https://ollama.test';
const KEY = 'ok-test-SECRET-4f9a2c';
const MODEL = 'glm-5.3-flash';

const SOURCE: TranslationTexts = {
  title: 'Vláda schválila nový rozpočet na verejnú dopravu',
  excerpt: null,
  body_lead: 'Dnes ráno otvorili nový most cez Dunaj v Bratislave.',
};
const TRANSLATED = {
  title: 'The government approved a new budget for public transport',
  excerpt: '',
  body_lead: 'This morning a new bridge over the Danube opened in Bratislava.',
};

let agent: MockAgent;
const clock = createManualClock('2026-09-26T10:00:00Z');

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});

afterEach(async () => {
  await agent.close();
});

function translator(options: Partial<OllamaTranslatorOptions> = {}): OllamaTranslator {
  return createOllamaTranslator({ baseUrl: ORIGIN, dispatcher: agent, clock, ...options });
}

/** A non-streamed `/api/chat` response. */
function chat(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    created_at: '2026-09-26T10:00:01Z',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    total_duration: 1_200_000_000,
    prompt_eval_count: 120,
    eval_count: 40,
    ...extra,
  };
}

interface Captured {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function headerRecord(headers: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === null || headers === undefined) return record;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      record[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    }
    return record;
  }
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers as Record<string, string>);
  for (const [name, value] of entries) record[name.toLowerCase()] = String(value);
  return record;
}

/** Replies once to `POST /api/chat`, recording the request. */
function replyOnce(
  statusCode: number,
  data: unknown,
  headers: Record<string, string> = {},
): Captured[] {
  const captured: Captured[] = [];
  agent
    .get(ORIGIN)
    .intercept({ path: '/api/chat', method: 'POST' })
    .reply((options) => {
      captured.push({
        path: options.path,
        method: options.method,
        headers: headerRecord(options.headers),
        body: String(options.body),
      });
      return {
        statusCode,
        data: typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data),
        responseOptions: { headers: { 'content-type': 'application/json', ...headers } },
      };
    });
  return captured;
}

const input = (extra: Partial<Parameters<OllamaTranslator['translateOnce']>[0]> = {}) => ({
  model: MODEL,
  sourceLang: 'sk',
  source: SOURCE,
  auth: { apiKey: KEY, credentialVersion: '5' },
  ...extra,
});

function failure(result: Tier2AttemptResult): Extract<Tier2AttemptResult, { ok: false }> {
  if (result.ok) throw new Error('expected a failure');
  return result;
}

describe('the tier-2 request (spec 07 §3 step 3)', () => {
  it('posts exactly the spec body, with the key only in the Authorization header', async () => {
    const captured = replyOnce(200, chat(JSON.stringify(TRANSLATED)));
    await translator().translateOnce(input());
    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request?.path).toBe('/api/chat');
    expect(request?.method).toBe('POST');
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.headers['content-type']).toBe('application/json');
    const body = JSON.parse(request?.body ?? '') as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['model', 'stream', 'options', 'messages']);
    expect(body).toEqual({
      model: MODEL,
      stream: false,
      options: { temperature: 0, num_predict: 2048 },
      messages: [
        {
          role: 'system',
          content:
            "You are a professional translator. Translate every field of the user's JSON from Slovak to English. Keep names, numbers, product names and quotes' meaning. Do not add or remove information. Output only JSON with the same keys.",
        },
        {
          role: 'user',
          content: JSON.stringify({
            title: SOURCE.title,
            excerpt: '',
            body_lead: SOURCE.body_lead,
          }),
        },
      ],
    });
    // No structured `format` (not assumed on Cloud, spec 04 §8) and no tools.
    expect(body).not.toHaveProperty('format');
    expect(body).not.toHaveProperty('tools');
    expect(request?.body).not.toContain(KEY);
    expect(buildTier2Request({ model: MODEL, sourceLang: 'sk', source: SOURCE })).toEqual(body);
  });

  it('uses the configured model, never a hard-coded one', async () => {
    const captured = replyOnce(200, chat(JSON.stringify(TRANSLATED), { model: 'glm-5.3' }));
    const result = await translator().translateOnce(input({ model: 'glm-5.3' }));
    expect(JSON.parse(captured[0]?.body ?? '')).toMatchObject({ model: 'glm-5.3' });
    expect(result).toMatchObject({ ok: true, model: 'glm-5.3', reportedModel: 'glm-5.3' });
    // Priced at the strong model's rate.
    expect(result.attempt.costUsd).toBe(
      tier2CostUsd(OLLAMA_PRICES['glm-5.3']!, { inputTokens: 120, outputTokens: 40 }),
    );
  });

  it('fills the language name into the system prompt', () => {
    expect(TIER2_SYSTEM_PROMPT_TEMPLATE).toContain('from <Language> to English');
    expect(tier2SystemPrompt('cs')).toContain('from Czech to English');
    expect(tier2SystemPrompt('de')).toContain('from German to English');
    for (const lang of ['en', 'und', 'xx', 'sk-SK', '']) {
      expect(() => tier2SystemPrompt(lang), lang).toThrow(TypeError);
    }
  });
});

describe('a successful tier-2 attempt', () => {
  it('returns the translation, the usage, the cost and the credential version', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/chat', method: 'POST' })
      .reply(() => {
        clock.advance(1_234);
        return { statusCode: 200, data: JSON.stringify(chat(JSON.stringify(TRANSLATED))) };
      });
    const result = await translator().translateOnce(input());
    expect(result).toEqual({
      ok: true,
      texts: { title: TRANSLATED.title, excerpt: null, body_lead: TRANSLATED.body_lead },
      model: MODEL,
      reportedModel: MODEL,
      attempt: {
        engine: 'llm',
        model: MODEL,
        attempt: 1,
        status: 'ok',
        httpStatus: 200,
        startedAt: new Date('2026-09-26T10:00:00Z'),
        latencyMs: 1_234,
        inputTokens: 120,
        outputTokens: 40,
        costUsd: (120 * 0.15 + 40 * 0.5) / 1e6,
        billing: 'known',
        credentialVersion: '5',
      },
    });
    clock.set('2026-09-26T10:00:00Z');
  });

  it('keeps an absent source field null whatever the model wrote for it', async () => {
    replyOnce(200, chat(JSON.stringify({ ...TRANSLATED, excerpt: 'An invented excerpt' })));
    const result = await translator().translateOnce(input());
    expect(result).toMatchObject({ ok: true, texts: { excerpt: null } });
  });

  it('tolerates one Markdown code fence around the JSON and trims the texts', async () => {
    replyOnce(
      200,
      chat(
        `\`\`\`json\n${JSON.stringify({ ...TRANSLATED, title: `  ${TRANSLATED.title} ` })}\n\`\`\``,
      ),
    );
    const result = await translator().translateOnce(input());
    expect(result).toMatchObject({ ok: true, texts: { title: TRANSLATED.title } });
  });

  it('accepts an empty tool_calls list and omits an invalid reported model', async () => {
    replyOnce(
      200,
      chat(JSON.stringify(TRANSLATED), {
        model: 'bad model!',
        message: { role: 'assistant', content: JSON.stringify(TRANSLATED), tool_calls: [] },
      }),
    );
    const result = await translator().translateOnce(input());
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('reportedModel');
  });

  it('marks unknown usage as uncertain billing', async () => {
    for (const usage of [
      { prompt_eval_count: undefined, eval_count: undefined },
      { prompt_eval_count: -1, eval_count: 40 },
      { prompt_eval_count: 1.5, eval_count: 40 },
      { prompt_eval_count: '120', eval_count: 40 },
    ]) {
      replyOnce(200, chat(JSON.stringify(TRANSLATED), usage));
      const result = await translator().translateOnce(input());
      expect(result.ok).toBe(true);
      expect(result.attempt.billing).toBe('uncertain');
    }
  });

  it('records a repair attempt with its ordinal and omits a malformed credential version', async () => {
    replyOnce(200, chat(JSON.stringify(TRANSLATED)));
    const result = await translator().translateOnce(
      input({ attempt: 2, auth: { apiKey: KEY, credentialVersion: 'v5' } }),
    );
    expect(result.attempt.attempt).toBe(2);
    expect(result.attempt).not.toHaveProperty('credentialVersion');
    await expect(translator().translateOnce(input({ attempt: 3 }))).rejects.toThrow(RangeError);
    await expect(translator().translateOnce(input({ attempt: 0 }))).rejects.toThrow(RangeError);
  });

  it('maps an attempt to the engine router call (spec 04 §1)', async () => {
    replyOnce(200, chat(JSON.stringify(TRANSLATED)));
    const result = await translator().translateOnce(input());
    expect(
      toExternalCall(result.attempt, {
        logicalRequestId: 'translate:42:3',
        articleId: '42',
        articleRevision: '3',
      }),
    ).toEqual({
      engine: 'llm',
      kind: 'translate',
      model: MODEL,
      articleId: '42',
      inputTokens: 120,
      outputTokens: 40,
      costUsd: result.attempt.costUsd,
      latencyMs: result.attempt.latencyMs,
      status: 'ok',
      billing: 'known',
      logicalRequestId: 'translate:42:3',
      attempt: 1,
      articleRevision: '3',
      credentialVersion: '5',
    });
  });
});

describe('malformed tier-2 output never becomes article text (spec 07 §6)', () => {
  const valid = JSON.stringify(TRANSLATED);
  const cases: Array<[string, string, string]> = [
    ['prose', 'Here is your translation: The government approved…', 'not_json'],
    ['an array', '["a","","b"]', 'not_an_object'],
    ['a string', '"The government approved"', 'not_an_object'],
    ['an extra key', '{"title":"a","excerpt":"","body_lead":"b","summary":"c"}', 'extra_keys'],
    [
      'a __proto__ key',
      '{"title":"a","excerpt":"","body_lead":"b","__proto__":{"x":1}}',
      'extra_keys',
    ],
    [
      'only a __proto__ key',
      '{"__proto__":{"title":"a","excerpt":"","body_lead":"b"}}',
      'extra_keys',
    ],
    ['a missing key', '{"title":"a","body_lead":"b"}', 'missing_keys'],
    ['a number', '{"title":1,"excerpt":"","body_lead":"b"}', 'non_string_field'],
    ['a null', '{"title":null,"excerpt":"","body_lead":"b"}', 'non_string_field'],
    ['a nested object', '{"title":{"text":"a"},"excerpt":"","body_lead":"b"}', 'non_string_field'],
    [
      'an overlong field',
      JSON.stringify({ ...TRANSLATED, body_lead: 'b'.repeat(TIER2_MAX_OUTPUT_CHARS + 1) }),
      'field_too_long',
    ],
    ['a NUL character', '{"title":"a\\u0000","excerpt":"","body_lead":"b"}', 'unstorable_text'],
    ['a lone surrogate', '{"title":"a\\udc00","excerpt":"","body_lead":"b"}', 'unstorable_text'],
    ['two fences', `\`\`\`json\n${valid}\n\`\`\`\n\`\`\`json\n${valid}\n\`\`\``, 'not_json'],
    ['trailing prose', `${valid}\nHope this helps!`, 'not_json'],
  ];

  for (const [name, content, problem] of cases) {
    it(`rejects ${name} as invalid_response:${problem}, worth one repair attempt`, async () => {
      replyOnce(200, chat(content));
      const result = failure(await translator().translateOnce(input()));
      expect(result).toEqual({
        ok: false,
        reason: 'invalid_response',
        retryable: true,
        attempt: expect.objectContaining({
          status: 'invalid_response',
          httpStatus: 200,
          error: `invalid_response:${problem}`,
          inputTokens: 120,
          outputTokens: 40,
          billing: 'known',
        }) as unknown,
      });
      expect(result).not.toHaveProperty('texts');
    });
  }

  it('validates content directly with the same rules', () => {
    expect(parseTier2Content(valid, SOURCE)).toEqual({
      ok: true,
      texts: { title: TRANSLATED.title, excerpt: null, body_lead: TRANSLATED.body_lead },
    });
    expect(parseTier2Content('{}', SOURCE)).toEqual({ ok: false, problem: 'missing_keys' });
  });
});

describe('tier-2 envelope and transport failures', () => {
  const content = JSON.stringify(TRANSLATED);
  const envelopes: Array<[string, unknown, string, 'known' | 'uncertain']> = [
    [
      'a truncated answer (done_reason length)',
      chat(content, { done_reason: 'length' }),
      'truncated',
      'known',
    ],
    ['an unfinished answer', chat(content, { done: false }), 'not_done', 'known'],
    ['another done reason', chat(content, { done_reason: 'load' }), 'not_stopped', 'known'],
    ['no message', chat(content, { message: undefined }), 'envelope', 'known'],
    [
      'a non-assistant message',
      chat(content, { message: { role: 'user', content } }),
      'envelope',
      'known',
    ],
    [
      'non-string content',
      chat(content, { message: { role: 'assistant', content: 42 } }),
      'envelope',
      'known',
    ],
    [
      'tool calls',
      chat(content, {
        message: {
          role: 'assistant',
          content,
          tool_calls: [{ function: { name: 'fetch', arguments: {} } }],
        },
      }),
      'tool_calls',
      'known',
    ],
    ['an array envelope', [chat(content)], 'envelope', 'uncertain'],
    ['a non-JSON body', '<html>502</html>', 'not_json', 'uncertain'],
  ];

  for (const [name, body, problem, billing] of envelopes) {
    it(`rejects ${name} as invalid_response:${problem}`, async () => {
      replyOnce(200, body);
      const result = failure(await translator().translateOnce(input()));
      expect(result).toMatchObject({ reason: 'invalid_response', retryable: true });
      expect(result.attempt).toMatchObject({ error: `invalid_response:${problem}`, billing });
    });
  }

  it('rejects a response above the byte bound as uncertain billing', async () => {
    replyOnce(200, chat('x'.repeat(4_096)));
    const result = failure(await translator({ maxResponseBytes: 1_024 }).translateOnce(input()));
    expect(result.attempt).toMatchObject({
      error: 'invalid_response:too_large',
      billing: 'uncertain',
    });
  });

  it('maps HTTP statuses to reasons, retryability and billing certainty', async () => {
    const cases: Array<[number, Record<string, string>, Record<string, unknown>]> = [
      [
        401,
        {},
        {
          reason: 'auth_error',
          retryable: false,
          attempt: { status: 'auth_error', billing: 'known' },
        },
      ],
      [403, {}, { reason: 'auth_error', retryable: false }],
      [404, {}, { reason: 'model_unavailable', retryable: false, attempt: { status: 'error' } }],
      [
        400,
        {},
        { reason: 'invalid_request', retryable: false, attempt: { status: 'invalid_request' } },
      ],
      [
        429,
        { 'retry-after': '7' },
        {
          reason: 'rate_limited',
          retryable: true,
          retryAfterMs: 7_000,
          attempt: { status: 'rate_limited', billing: 'known' },
        },
      ],
      [
        500,
        {},
        {
          reason: 'server_error',
          retryable: true,
          attempt: { status: 'error', billing: 'uncertain' },
        },
      ],
      [
        503,
        { 'retry-after': '2' },
        { reason: 'server_error', retryable: true, retryAfterMs: 2_000 },
      ],
      [
        302,
        { location: 'https://elsewhere.test/api/chat' },
        { reason: 'http_error', retryable: false },
      ],
      [418, {}, { reason: 'http_error', retryable: false }],
    ];
    for (const [status, headers, expected] of cases) {
      replyOnce(status, { error: `upstream said ${KEY}` }, headers);
      const result = failure(await translator().translateOnce(input()));
      expect(result, String(status)).toMatchObject(expected);
      expect(result.attempt).toMatchObject({
        httpStatus: status,
        error: `http_${status}`,
        costUsd: 0,
      });
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
    agent.assertNoPendingInterceptors();
  });

  it('classifies network errors by code; a request that never left is known not billed', async () => {
    const cases: Array<[string, string, string, 'known' | 'uncertain']> = [
      ['ECONNRESET', 'network_error', 'network:ECONNRESET', 'uncertain'],
      ['ECONNREFUSED', 'network_error', 'network:ECONNREFUSED', 'known'],
      ['ENOTFOUND', 'network_error', 'network:ENOTFOUND', 'known'],
      ['UND_ERR_CONNECT_TIMEOUT', 'timeout', 'timeout', 'known'],
      ['UND_ERR_HEADERS_TIMEOUT', 'timeout', 'timeout', 'uncertain'],
    ];
    for (const [code, reason, error, billing] of cases) {
      agent
        .get(ORIGIN)
        .intercept({ path: '/api/chat', method: 'POST' })
        .replyWithError(Object.assign(new Error(`failed with key ${KEY}`), { code }));
      const result = failure(await translator().translateOnce(input()));
      expect(result, code).toMatchObject({ reason, retryable: true, attempt: { error, billing } });
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it('never sends a key that is not a valid header value', async () => {
    for (const apiKey of [
      '',
      ' padded',
      'padded ',
      'line\nbreak',
      'tab\tkey',
      'ключ',
      'k'.repeat(4_097),
    ]) {
      const result = failure(await translator().translateOnce(input({ auth: { apiKey } })));
      expect(result).toMatchObject({
        reason: 'auth_error',
        retryable: false,
        attempt: {
          status: 'auth_error',
          error: 'invalid_key_format',
          billing: 'known',
          costUsd: 0,
        },
      });
      if (apiKey !== '') expect(JSON.stringify(result)).not.toContain(apiKey);
    }
  });
});

describe('tier-2 deadlines and cancellation', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      server === undefined ? resolve() : server.close(() => resolve()),
    );
    server = undefined;
  });

  /** A local server that accepts the request and never answers. */
  async function hangingServer(): Promise<string> {
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('ends an attempt at its deadline as a retryable timeout with uncertain billing', async () => {
    const baseUrl = await hangingServer();
    const own = createOllamaTranslator({ baseUrl, timeoutMs: 150 });
    const started = Date.now();
    const result = failure(await own.translateOnce(input()));
    await own.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(result).toMatchObject({
      reason: 'timeout',
      retryable: true,
      attempt: { status: 'timeout', error: 'timeout', billing: 'uncertain' },
    });
  });

  it('stops at the caller’s abort, not retryable', async () => {
    const baseUrl = await hangingServer();
    const own = createOllamaTranslator({ baseUrl, timeoutMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = failure(await own.translateOnce(input({ signal: controller.signal })));
    await own.close();
    expect(result).toMatchObject({
      reason: 'cancelled',
      retryable: false,
      attempt: { error: 'cancelled' },
    });
  });
});

describe('tier-2 admission estimate and prices (spec 04 §6.1, §8)', () => {
  it('prices the models per million tokens', () => {
    expect(OLLAMA_PRICES).toEqual({
      'glm-5.3-flash': { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.5 },
      'glm-5.3': { inputPerMTokUsd: 1.4, outputPerMTokUsd: 4.4 },
      'gemma4:31b': { inputPerMTokUsd: 0.14, outputPerMTokUsd: 0.4 },
    });
    expect(
      tier2CostUsd(OLLAMA_PRICES['glm-5.3']!, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(5.8);
  });

  it('estimates the exact messages plus overhead, and num_predict output tokens', () => {
    const request = buildTier2Request({ model: MODEL, sourceLang: 'sk', source: SOURCE });
    const inputTokens = conservativeTokens(request.messages) + REQUEST_OVERHEAD_TOKENS;
    const fast = estimateTier2Cost({ model: MODEL, sourceLang: 'sk', source: SOURCE });
    expect(fast).toEqual({
      inputTokens,
      outputTokens: 2048,
      estimateUsd: tier2CostUsd(OLLAMA_PRICES[MODEL]!, { inputTokens, outputTokens: 2048 }),
    });
    const strong = translator().estimate({ model: 'glm-5.3', sourceLang: 'sk', source: SOURCE });
    expect(strong.estimateUsd).toBeGreaterThan(fast.estimateUsd);
    // A custom table prices a custom model.
    const custom = createOllamaTranslator({
      baseUrl: ORIGIN,
      dispatcher: agent,
      prices: { 'my-model:latest': { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } },
    });
    expect(
      custom.estimate({ model: 'my-model:latest', sourceLang: 'sk', source: SOURCE }).estimateUsd,
    ).toBeCloseTo((inputTokens + 2048) / 1e6, 9);
  });

  it('refuses an unpriced model, invalid input and invalid options (programming errors)', async () => {
    expect(() =>
      estimateTier2Cost({ model: 'unknown-model', sourceLang: 'sk', source: SOURCE }),
    ).toThrow(TypeError);
    await expect(translator().translateOnce(input({ model: 'unknown-model' }))).rejects.toThrow(
      TypeError,
    );
    await expect(translator().translateOnce(input({ model: 'bad model' }))).rejects.toThrow(
      TypeError,
    );
    await expect(translator().translateOnce(input({ sourceLang: 'en' }))).rejects.toThrow(
      TypeError,
    );
    await expect(translator().translateOnce(input({ sourceLang: 'und' }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      translator().translateOnce(
        input({ source: { title: null, excerpt: '  ', body_lead: null } }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      translator().translateOnce(input({ source: { ...SOURCE, title: 't'.repeat(501) } })),
    ).rejects.toThrow(RangeError);
    expect(() => createOllamaTranslator({ baseUrl: 'ollama.test' })).toThrow(TypeError);
    expect(() => createOllamaTranslator({ baseUrl: ORIGIN, timeoutMs: -1 })).toThrow(RangeError);
    expect(() => createOllamaTranslator({ baseUrl: ORIGIN, maxResponseBytes: 0 })).toThrow(
      RangeError,
    );
  });
});
