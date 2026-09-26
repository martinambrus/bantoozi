import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createManualClock } from '@bantoozi/shared';
import {
  FAKE_LIBRETRANSLATE_LANGUAGES,
  pseudoTranslate,
  startFakeLibreTranslate,
  type FakeLibreTranslate,
} from '@bantoozi/testing';
import { MockAgent } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  TIER1_MAX_OUTPUT_CHARS,
  assessTranslation,
  createLibreTranslateClient,
  missingLanguagePairs,
  supportedSourceLanguages,
  verifyTier1,
  type LibreTranslateClient,
  type LibreTranslateClientOptions,
  type Tier1ArticleResult,
  type TranslationAttempt,
  type TranslationTexts,
} from '../src/index.js';

const TITLE = 'Vláda schválila nový rozpočet na verejnú dopravu';
const EXCERPT = 'Úryvok článku o doprave v Bratislave';
const BODY = 'Dnes ráno otvorili nový most cez Dunaj v Bratislave.';

let lt: FakeLibreTranslate;
const clients: LibreTranslateClient[] = [];

beforeAll(async () => {
  lt = await startFakeLibreTranslate({
    translations: { [TITLE]: 'The government approved a new budget for public transport' },
  });
});

afterAll(async () => {
  await lt.close();
});

beforeEach(() => {
  lt.reset();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** A client of the fake server whose backoff sleeps are recorded, not waited for. */
function tier1(options: Partial<LibreTranslateClientOptions> = {}): {
  client: LibreTranslateClient;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  const client = createLibreTranslateClient({
    baseUrl: lt.url,
    timeoutMs: 2_000,
    backoffMs: 10,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  clients.push(client);
  return { client, sleeps };
}

const article = (texts: Partial<TranslationTexts>): TranslationTexts => ({
  title: null,
  excerpt: null,
  body_lead: null,
  ...texts,
});

function translatedTexts(result: Tier1ArticleResult): TranslationTexts {
  if (result.status !== 'translated' && result.status !== 'passthrough') {
    throw new Error(`expected a translation, got ${result.status}`);
  }
  return result.texts;
}

const errors = (attempts: TranslationAttempt[]): Array<string | undefined> =>
  attempts.map((attempt) => attempt.error);

describe('tier 1 requests (spec 07 §3 step 2)', () => {
  it('sends the nonblank texts in field order with an explicit source, target en and format text', async () => {
    const { client } = tier1();
    const result = await client.translateArticle({
      source: article({ title: TITLE, excerpt: '  ', body_lead: BODY }),
      lang: 'sk',
    });
    expect(lt.requests).toHaveLength(1);
    const [request] = lt.requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/translate');
    expect(request?.body).toEqual({ q: [TITLE, BODY], source: 'sk', target: 'en', format: 'text' });
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers.authorization).toBeUndefined();
    expect(translatedTexts(result)).toEqual({
      title: 'The government approved a new budget for public transport',
      excerpt: null,
      body_lead: pseudoTranslate(BODY),
    });
    expect(result.attempts).toHaveLength(1);
    const [attempt] = result.attempts;
    expect(attempt).toEqual({
      engine: 'libretranslate',
      attempt: 1,
      status: 'ok',
      httpStatus: 200,
      startedAt: expect.any(Date) as Date,
      latencyMs: expect.any(Number) as number,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      billing: 'known',
    });
  });

  it('never shifts an excerpt into the title when earlier fields are absent', async () => {
    const { client } = tier1();
    const result = await client.translateArticle({
      source: article({ excerpt: EXCERPT }),
      lang: 'sk',
    });
    expect(lt.requests[0]?.body).toMatchObject({ q: [EXCERPT] });
    expect(translatedTexts(result)).toEqual({
      title: null,
      excerpt: pseudoTranslate(EXCERPT),
      body_lead: null,
    });
  });

  it('keeps the explicit mapping of any ordered field list, short fields included', async () => {
    const { client } = tier1();
    const result = await client.translate({
      fields: [
        { field: 'interest', text: 'Most' },
        { field: 'not_for', text: ' ' },
        { field: 'other', text: BODY },
      ],
      source: 'cs',
    });
    expect(lt.requests[0]?.body).toMatchObject({ q: ['Most', BODY], source: 'cs' });
    expect(result).toMatchObject({
      status: 'translated',
      translations: [
        { field: 'interest', text: pseudoTranslate('Most') },
        { field: 'other', text: pseudoTranslate(BODY) },
      ],
    });
  });

  it('passes English through, never requests und, and sends nothing without text', async () => {
    const { client } = tier1();
    const english = await client.translateArticle({
      source: article({ title: 'Hello there' }),
      lang: 'en',
    });
    expect(english).toEqual({
      status: 'passthrough',
      texts: article({ title: 'Hello there' }),
      attempts: [],
    });
    expect(
      await client.translateArticle({ source: article({ title: TITLE }), lang: 'und' }),
    ).toEqual({
      status: 'not_requested',
      reason: 'undetermined_language',
      attempts: [],
    });
    expect(
      await client.translateArticle({ source: article({ title: '   ' }), lang: 'sk' }),
    ).toEqual({
      status: 'not_requested',
      reason: 'no_text',
      attempts: [],
    });
    expect(lt.requests).toHaveLength(0);
  });
});

describe('fake server modes through the client and the assessment', () => {
  const source = article({ title: TITLE, body_lead: BODY });

  it('ok: a translation that assesses ok', async () => {
    const { client } = tier1();
    const texts = translatedTexts(await client.translateArticle({ source, lang: 'sk' }));
    expect(assessTranslation(source, texts, 'sk')).toMatchObject({
      quality: 'ok',
      conclusive: true,
    });
  });

  it('weak: the echo comes back as text and assesses weak', async () => {
    lt.setOptions({ mode: 'weak' });
    const { client } = tier1();
    const texts = translatedTexts(await client.translateArticle({ source, lang: 'sk' }));
    expect(texts).toEqual(source);
    expect(assessTranslation(source, texts, 'sk')).toMatchObject({ quality: 'weak' });
  });

  it('fail: empty strings keep their fields and assess fail', async () => {
    lt.setOptions({ mode: 'fail' });
    const { client } = tier1();
    const texts = translatedTexts(await client.translateArticle({ source, lang: 'sk' }));
    expect(texts).toEqual({ title: '', excerpt: null, body_lead: '' });
    expect(assessTranslation(source, texts, 'sk')).toMatchObject({ quality: 'fail' });
  });

  it('timeout: two attempts end at their deadline, then a non-terminal timeout', async () => {
    lt.setOptions({ mode: 'timeout' });
    const { client, sleeps } = tier1({ timeoutMs: 150 });
    const started = Date.now();
    const result = await client.translateArticle({ source, lang: 'sk' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(result).toMatchObject({ status: 'failed', reason: 'timeout', terminal: false });
    expect(result.attempts.map((attempt) => [attempt.attempt, attempt.status])).toEqual([
      [1, 'timeout'],
      [2, 'timeout'],
    ]);
    expect(errors(result.attempts)).toEqual(['timeout', 'timeout']);
    expect(lt.requests).toHaveLength(2);
    expect(sleeps).toEqual([10]);
  });
});

describe('tier 1 retries and failures', () => {
  const source = article({ title: TITLE });

  it('retries one transient 5xx after the backoff and succeeds', async () => {
    lt.setOptions({ sequence: [{ mode: 'status', status: 503 }] });
    const { client, sleeps } = tier1();
    const result = await client.translateArticle({ source, lang: 'sk' });
    expect(result.status).toBe('translated');
    expect(
      result.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.httpStatus]),
    ).toEqual([
      [1, 'error', 503],
      [2, 'ok', 200],
    ]);
    expect(errors(result.attempts)).toEqual(['http_503', undefined]);
    expect(sleeps).toEqual([10]);
  });

  it('fails a 5xx on both attempts without a terminal verdict', async () => {
    lt.setOptions({ mode: 'status', status: 500 });
    const { client } = tier1({ maxAttempts: 2 });
    const result = await client.translateArticle({ source, lang: 'sk' });
    expect(result).toMatchObject({ status: 'failed', reason: 'server_error', terminal: false });
    expect(result.attempts).toHaveLength(2);
    expect(lt.requests).toHaveLength(2);
    expect('texts' in result).toBe(false);
  });

  it('makes a single attempt when configured with maxAttempts 1', async () => {
    lt.setOptions({ mode: 'status', status: 502 });
    const { client, sleeps } = tier1({ maxAttempts: 1 });
    const result = await client.translateArticle({ source, lang: 'sk' });
    expect(result).toMatchObject({ status: 'failed', reason: 'server_error' });
    expect(lt.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('waits a valid Retry-After of a 429 within the bound', async () => {
    lt.setOptions({ sequence: [{ mode: 'status', status: 429, retryAfter: '2' }] });
    const { client, sleeps } = tier1();
    const result = await client.translateArticle({ source, lang: 'sk' });
    expect(result.status).toBe('translated');
    expect(result.attempts[0]).toMatchObject({
      status: 'rate_limited',
      httpStatus: 429,
      error: 'http_429',
    });
    expect(sleeps).toEqual([2_000]);
  });

  it('accepts a Retry-After HTTP date', async () => {
    const clock = createManualClock('2026-09-26T10:00:00Z');
    lt.setOptions({
      sequence: [{ mode: 'status', status: 503, retryAfter: 'Sat, 26 Sep 2026 10:00:03 GMT' }],
    });
    const { client, sleeps } = tier1({ clock });
    expect((await client.translateArticle({ source, lang: 'sk' })).status).toBe('translated');
    expect(sleeps).toEqual([3_000]);
  });

  it('does not sleep past the bound: it fails with retryAt instead', async () => {
    const clock = createManualClock('2026-09-26T10:00:00Z');
    lt.setOptions({ mode: 'status', status: 429, retryAfter: '60' });
    const { client, sleeps } = tier1({ clock, maxRetryDelayMs: 5_000 });
    const result = await client.translateArticle({ source, lang: 'sk' });
    expect(result).toEqual({
      status: 'failed',
      reason: 'rate_limited',
      terminal: false,
      retryAt: new Date('2026-09-26T10:01:00Z'),
      attempts: [expect.objectContaining({ attempt: 1, status: 'rate_limited', latencyMs: 0 })],
    });
    expect(sleeps).toEqual([]);
    expect(lt.requests).toHaveLength(1);
  });

  it('treats an unsupported language as terminal, without a retry', async () => {
    const { client } = tier1();
    const result = await client.translateArticle({ source, lang: 'de' });
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'unsupported_language',
      terminal: true,
    });
    expect(result.attempts).toEqual([
      expect.objectContaining({ status: 'invalid_request', httpStatus: 400, error: 'http_400' }),
    ]);
    expect(lt.requests).toHaveLength(1);
  });

  it('recognizes a pair without an installed model as unsupported', async () => {
    lt.setOptions({
      languages: [
        { code: 'en', name: 'English', targets: ['sk'] },
        { code: 'sk', name: 'Slovak', targets: ['en'] },
        { code: 'cs', name: 'Czech', targets: ['sk'] },
      ],
    });
    const { client } = tier1();
    expect(await client.translateArticle({ source, lang: 'cs' })).toMatchObject({
      status: 'failed',
      reason: 'unsupported_language',
      terminal: true,
    });
  });

  it('fails a language outside supportedSources without a request', async () => {
    const { client } = tier1();
    const result = await client.translateArticle({
      source,
      lang: 'pl',
      supportedSources: new Set(['sk', 'cs']),
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'unsupported_language',
      terminal: true,
      attempts: [],
    });
    expect(lt.requests).toHaveLength(0);
  });

  it('treats other validation errors as terminal invalid requests', async () => {
    lt.setOptions({
      mode: 'status',
      status: 400,
      errorMessage: 'Invalid request: missing q parameter',
    });
    const { client } = tier1();
    expect(await client.translateArticle({ source, lang: 'sk' })).toMatchObject({
      status: 'failed',
      reason: 'invalid_request',
      terminal: true,
      attempts: [expect.objectContaining({ status: 'invalid_request' })],
    });
    expect(lt.requests).toHaveLength(1);
  });

  it('fails auth and unexpected statuses once, non-terminal (configuration, not content)', async () => {
    const { client } = tier1();
    lt.setOptions({ mode: 'status', status: 403 });
    expect(await client.translateArticle({ source, lang: 'sk' })).toMatchObject({
      status: 'failed',
      reason: 'auth_error',
      terminal: false,
      attempts: [expect.objectContaining({ status: 'auth_error', httpStatus: 403 })],
    });
    lt.reset({ mode: 'status', status: 404 });
    expect(await client.translateArticle({ source, lang: 'sk' })).toMatchObject({
      status: 'failed',
      reason: 'http_error',
      terminal: false,
      attempts: [expect.objectContaining({ status: 'error', error: 'http_404' })],
    });
    expect(lt.requests).toHaveLength(1);
  });

  it('retries a refused connection once as a network error', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { client } = tier1({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.translateArticle({ source, lang: 'sk' });
    expect(result).toMatchObject({ status: 'failed', reason: 'network_error', terminal: false });
    expect(errors(result.attempts)).toEqual(['network:ECONNREFUSED', 'network:ECONNREFUSED']);
  });

  it('stops when the caller aborts: during a request and during the backoff', async () => {
    lt.setOptions({ mode: 'timeout' });
    const { client, sleeps } = tier1();
    const during = new AbortController();
    setTimeout(() => during.abort(), 50);
    const result = await client.translateArticle({ source, lang: 'sk', signal: during.signal });
    expect(result).toMatchObject({ status: 'failed', reason: 'cancelled', terminal: false });
    expect(errors(result.attempts)).toEqual(['cancelled']);
    expect(sleeps).toEqual([]);

    // The default sleep is a real timer that the caller's abort ends.
    lt.reset({ sequence: [{ mode: 'status', status: 503 }] });
    const realSleep = createLibreTranslateClient({ baseUrl: lt.url, backoffMs: 1_000 });
    clients.push(realSleep);
    const backoff = new AbortController();
    setTimeout(() => backoff.abort(), 100);
    const started = Date.now();
    const cancelled = await realSleep.translateArticle({
      source,
      lang: 'sk',
      signal: backoff.signal,
    });
    expect(Date.now() - started).toBeLessThan(900);
    expect(cancelled).toMatchObject({ status: 'failed', reason: 'cancelled', terminal: false });
    expect(cancelled.attempts).toHaveLength(1);
    expect(lt.requests).toHaveLength(1);

    const aborted = AbortSignal.abort();
    expect(await client.translateArticle({ source, lang: 'sk', signal: aborted })).toMatchObject({
      status: 'failed',
      reason: 'cancelled',
    });
  });
});

describe('invalid tier-1 responses never become article text (spec 07 §6)', () => {
  const source = article({ title: TITLE, body_lead: BODY });
  const cases: Array<[string, { body?: unknown; rawText?: string }, string]> = [
    ['a string instead of an array', { body: { translatedText: 'one text' } }, 'shape'],
    ['an array body', { body: [['a', 'b']] }, 'shape'],
    ['another key', { body: { translation: ['a', 'b'] } }, 'shape'],
    ['an inherited key', { rawText: '{"__proto__":{"translatedText":["a","b"]}}' }, 'shape'],
    ['too few texts', { body: { translatedText: ['only one'] } }, 'length_mismatch'],
    ['too many texts', { body: { translatedText: ['a', 'b', 'c'] } }, 'length_mismatch'],
    ['a number', { body: { translatedText: ['a', 42] } }, 'non_string'],
    ['a null', { body: { translatedText: [null, 'b'] } }, 'non_string'],
    ['an object', { body: { translatedText: ['a', { text: 'b' }] } }, 'non_string'],
    ['a NUL character', { body: { translatedText: ['a\u0000b', 'b'] } }, 'unstorable_text'],
    ['a lone surrogate', { rawText: '{"translatedText":["a\\ud800","b"]}' }, 'unstorable_text'],
    [
      'an overlong text',
      { body: { translatedText: ['a'.repeat(TIER1_MAX_OUTPUT_CHARS + 1), 'b'] } },
      'text_too_long',
    ],
    ['not JSON', { rawText: '<html>Bad gateway</html>' }, 'not_json'],
    ['an empty body', { rawText: '' }, 'not_json'],
  ];

  for (const [name, reply, problem] of cases) {
    it(`rejects ${name} as invalid_response:${problem}, terminal and not retried`, async () => {
      lt.setOptions({ mode: 'raw', ...reply });
      const { client } = tier1();
      const result = await client.translateArticle({ source, lang: 'sk' });
      expect(result).toEqual({
        status: 'failed',
        reason: 'invalid_response',
        terminal: true,
        attempts: [
          expect.objectContaining({
            status: 'invalid_response',
            httpStatus: 200,
            error: `invalid_response:${problem}`,
          }),
        ],
      });
      expect(lt.requests).toHaveLength(1);
    });
  }

  it('rejects a response above the byte bound', async () => {
    lt.setOptions({ mode: 'raw', body: { translatedText: ['a'.repeat(3_000), 'b'] } });
    const { client } = tier1({ maxResponseBytes: 1_024 });
    expect(await client.translateArticle({ source, lang: 'sk' })).toMatchObject({
      status: 'failed',
      reason: 'invalid_response',
      attempts: [expect.objectContaining({ error: 'invalid_response:too_large' })],
    });
  });
});

describe('tier 1 over a mocked dispatcher', () => {
  const origin = 'http://libretranslate.test';
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  const mocked = (baseUrl = origin): LibreTranslateClient =>
    createLibreTranslateClient({
      baseUrl,
      dispatcher: agent,
      backoffMs: 1,
      sleep: () => Promise.resolve(),
    });

  it('resolves the endpoints below a base path', async () => {
    agent
      .get(origin)
      .intercept({ path: '/lt/translate', method: 'POST' })
      .reply(200, { translatedText: ['Bridge opened'] });
    const result = await mocked(`${origin}/lt`).translate({
      fields: [{ field: 'title', text: 'Most' }],
      source: 'sk',
    });
    expect(result).toMatchObject({
      status: 'translated',
      translations: [{ field: 'title', text: 'Bridge opened' }],
    });
    agent.assertNoPendingInterceptors();
  });

  it('never follows a redirect', async () => {
    agent
      .get(origin)
      .intercept({ path: '/translate', method: 'POST' })
      .reply(302, '', { headers: { location: 'http://elsewhere.test/translate' } });
    const result = await mocked().translate({
      fields: [{ field: 'title', text: 'Most' }],
      source: 'sk',
    });
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'http_error',
      attempts: [expect.objectContaining({ httpStatus: 302, error: 'http_302' })],
    });
  });

  it('rejects invalid UTF-8 and a Content-Length above the bound', async () => {
    const pool = agent.get(origin);
    pool
      .intercept({ path: '/translate', method: 'POST' })
      .reply(200, Buffer.from([0x7b, 0xff, 0x7d]));
    pool
      .intercept({ path: '/translate', method: 'POST' })
      .reply(200, '{}', { headers: { 'content-length': String(10 * 1024 * 1024) } });
    const client = mocked();
    const fields = [{ field: 'title', text: 'Most' }];
    expect((await client.translate({ fields, source: 'sk' })).attempts[0]?.error).toBe(
      'invalid_response:not_json',
    );
    expect((await client.translate({ fields, source: 'sk' })).attempts[0]?.error).toBe(
      'invalid_response:too_large',
    );
  });

  it('describes network failures by code only and retries them', async () => {
    const pool = agent.get(origin);
    pool
      .intercept({ path: '/translate', method: 'POST' })
      .replyWithError(
        Object.assign(new Error('socket hang up near Vláda schválila'), { code: 'ECONNRESET' }),
      );
    pool
      .intercept({ path: '/translate', method: 'POST' })
      .replyWithError(new Error('no code at all'));
    const result = await mocked().translate({
      fields: [{ field: 'title', text: 'Most' }],
      source: 'sk',
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'network_error', terminal: false });
    expect(errors(result.attempts)).toEqual(['network:ECONNRESET', 'network']);
    expect(JSON.stringify(result)).not.toContain('Vláda');
  });
});

describe('/languages and the tier-1 capability check (spec 07 §2)', () => {
  it('lists the installed languages and derives the supported sources', async () => {
    const { client } = tier1();
    const listed = await client.languages();
    expect(listed).toMatchObject({ ok: true, languages: FAKE_LIBRETRANSLATE_LANGUAGES });
    expect(lt.requests[0]).toMatchObject({ method: 'GET', path: '/languages' });
    if (!listed.ok) throw new Error('unreachable');
    expect(supportedSourceLanguages(listed.languages)).toEqual(new Set(['sk', 'cs']));
    expect(missingLanguagePairs(listed.languages)).toEqual([]);
  });

  it('names the required pairs that are missing', () => {
    const languages = [
      { code: 'en', name: 'English', targets: ['sk'] },
      { code: 'sk', name: 'Slovak', targets: ['en'] },
    ];
    expect(missingLanguagePairs(languages)).toEqual([['cs', 'en']]);
    expect(supportedSourceLanguages(languages)).toEqual(new Set(['sk']));
    expect(supportedSourceLanguages(languages, 'sk')).toEqual(new Set(['en']));
  });

  it('reports a failed or malformed /languages', async () => {
    const { client } = tier1();
    lt.setOptions({ mode: 'status', status: 503 });
    expect(await client.languages()).toMatchObject({ ok: false, reason: 'server_error' });
    for (const languages of [
      [{ code: 'e n', name: 'English', targets: [] }],
      [{ code: 'en', name: 42, targets: [] }],
      [{ code: 'en', name: 'English', targets: 'sk' }],
      [{ code: 'en', name: 'English', targets: [7] }],
      ['en'],
    ]) {
      lt.reset({ languages: languages as never });
      expect(await client.languages()).toMatchObject({ ok: false, reason: 'invalid_response' });
    }
  });

  it('verifies sk→en and cs→en with fixture translations', async () => {
    const { client } = tier1();
    const verification = await verifyTier1(client);
    expect(verification).toMatchObject({
      ok: true,
      missingPairs: [],
      samples: [
        { lang: 'sk', outcome: 'ok' },
        { lang: 'cs', outcome: 'ok' },
      ],
    });
    expect(verification.attempts).toHaveLength(3);
  });

  it('fails the check for an echoing model, a missing pair or an unreachable server', async () => {
    const { client } = tier1();
    lt.setOptions({ mode: 'weak' });
    expect(await verifyTier1(client)).toMatchObject({
      ok: false,
      samples: [
        { lang: 'sk', outcome: 'weak' },
        { lang: 'cs', outcome: 'weak' },
      ],
    });
    lt.reset({
      languages: [
        { code: 'en', name: 'English', targets: ['sk'] },
        { code: 'sk', name: 'Slovak', targets: ['en'] },
      ],
    });
    expect(await verifyTier1(client)).toMatchObject({
      ok: false,
      missingPairs: [['cs', 'en']],
      samples: [
        { lang: 'sk', outcome: 'ok' },
        { lang: 'cs', outcome: 'not_requested' },
      ],
    });
    lt.reset({ mode: 'status', status: 500 });
    expect(await verifyTier1(client)).toMatchObject({
      ok: false,
      languagesFailure: 'server_error',
      missingPairs: [
        ['sk', 'en'],
        ['cs', 'en'],
      ],
      samples: [],
    });
    lt.reset({ sequence: [{ mode: 'status', status: 400, errorMessage: 'broken' }] });
    expect(await verifyTier1(client)).toMatchObject({
      ok: false,
      samples: [
        { lang: 'sk', outcome: 'failed', failure: 'invalid_request' },
        { lang: 'cs', outcome: 'ok' },
      ],
    });
  });
});

describe('tier-1 input validation (programming errors throw)', () => {
  it('rejects invalid options', () => {
    for (const baseUrl of [
      'not a url',
      'ftp://lt.test',
      'http://user:pw@lt.test',
      'http://lt.test/?x=1',
      'http://lt.test/#x',
    ]) {
      expect(() => createLibreTranslateClient({ baseUrl })).toThrow(TypeError);
    }
    expect(() => createLibreTranslateClient({ baseUrl: 'http://lt.test', maxAttempts: 3 })).toThrow(
      RangeError,
    );
    expect(() => createLibreTranslateClient({ baseUrl: 'http://lt.test', timeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      createLibreTranslateClient({ baseUrl: 'http://lt.test', maxConnections: 0 }),
    ).toThrow(RangeError);
  });

  it('rejects invalid requests before sending anything', async () => {
    const { client } = tier1();
    const fields = [{ field: 'title', text: 'Most' }];
    await expect(client.translate({ fields, source: 'auto' })).rejects.toThrow(TypeError);
    await expect(client.translate({ fields, source: 'SK' })).rejects.toThrow(TypeError);
    await expect(client.translate({ fields, source: 'sk', target: 'de' as 'en' })).rejects.toThrow(
      TypeError,
    );
    await expect(
      client.translate({ fields: [...fields, { field: 'title', text: 'Iný' }], source: 'sk' }),
    ).rejects.toThrow(/duplicate field title/);
    await expect(
      client.translate({ fields: [{ field: 'Title!', text: 'x' }], source: 'sk' }),
    ).rejects.toThrow(TypeError);
    await expect(
      client.translate({
        fields: [{ field: 'title', text: null as unknown as string }],
        source: 'sk',
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      client.translate({ fields: [{ field: 'title', text: 'a'.repeat(2_001) }], source: 'sk' }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.translate({
        fields: ['a', 'b', 'c', 'd'].map((field) => ({ field, text: 'x'.repeat(1_600) })),
        source: 'sk',
      }),
    ).rejects.toThrow(RangeError);
    expect(lt.requests).toHaveLength(0);
  });
});
