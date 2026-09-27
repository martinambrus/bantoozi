import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FAKE_LIBRETRANSLATE_LANGUAGES,
  pseudoTranslate,
  startFakeLibreTranslate,
  type FakeLibreTranslate,
} from '../src/index.js';

let lt: FakeLibreTranslate;

beforeAll(async () => {
  lt = await startFakeLibreTranslate({ translations: { 'Dobrý deň': 'Good day' } });
});

afterAll(async () => {
  await lt.close();
});

beforeEach(() => {
  lt.reset();
});

async function translate(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${lt.url}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

describe('fake LibreTranslate server', () => {
  it('listens on a random loopback port and serves /languages', async () => {
    expect(lt.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${lt.url}/languages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_LIBRETRANSLATE_LANGUAGES);
  });

  it('translates in ok mode from the dictionary, else with the pseudo-translation, and records requests', async () => {
    const { status, json } = await translate({
      q: ['Dobrý deň', 'Vláda schválila rozpočet'],
      source: 'sk',
      target: 'en',
      format: 'text',
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      translatedText: ['Good day', pseudoTranslate('Vláda schválila rozpočet')],
    });
    expect(lt.requests).toHaveLength(1);
    expect(lt.requests[0]).toMatchObject({
      method: 'POST',
      path: '/translate',
      body: { q: ['Dobrý deň', 'Vláda schválila rozpočet'], source: 'sk', target: 'en' },
    });
    // A single string q gets a single string back, as LibreTranslate does.
    expect((await translate({ q: 'Dobrý deň', source: 'sk', target: 'en' })).json).toEqual({
      translatedText: 'Good day',
    });
  });

  it('echoes in weak mode and answers empty strings in fail mode', async () => {
    lt.setOptions({ mode: 'weak' });
    expect((await translate({ q: ['Dobrý deň'], source: 'sk', target: 'en' })).json).toEqual({
      translatedText: ['Dobrý deň'],
    });
    lt.setOptions({ mode: 'fail' });
    expect((await translate({ q: ['a', 'b'], source: 'sk', target: 'en' })).json).toEqual({
      translatedText: ['', ''],
    });
  });

  it('never answers in timeout mode', async () => {
    lt.setOptions({ mode: 'timeout' });
    const aborted = fetch(`${lt.url}/translate`, {
      method: 'POST',
      body: JSON.stringify({ q: ['x'], source: 'sk', target: 'en' }),
      signal: AbortSignal.timeout(150),
    });
    await expect(aborted).rejects.toThrow();
    expect(lt.requests).toHaveLength(1);
  });

  it('answers a scripted status with Retry-After, then follows the sequence back to the base mode', async () => {
    lt.setOptions({
      sequence: [
        { mode: 'status', status: 429, retryAfter: '3', errorMessage: 'Slowdown' },
        { mode: 'raw', body: { translatedText: 'not an array' } },
        { mode: 'raw', rawText: 'not json' },
      ],
    });
    const limited = await fetch(`${lt.url}/translate`, {
      method: 'POST',
      body: JSON.stringify({ q: ['x'], source: 'sk', target: 'en' }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3');
    expect(await limited.json()).toEqual({ error: 'Slowdown' });
    expect((await translate({ q: ['x'], source: 'sk', target: 'en' })).json).toEqual({
      translatedText: 'not an array',
    });
    const text = await fetch(`${lt.url}/translate`, { method: 'POST', body: '{}' });
    expect(await text.text()).toBe('not json');
    expect((await translate({ q: ['Dobrý deň'], source: 'sk', target: 'en' })).json).toEqual({
      translatedText: ['Good day'],
    });
  });

  it('rejects unsupported languages and pairs like LibreTranslate', async () => {
    expect(await translate({ q: ['x'], source: 'de', target: 'en' })).toEqual({
      status: 400,
      json: { error: 'de is not supported' },
    });
    lt.setOptions({
      languages: [
        { code: 'en', name: 'English', targets: ['sk'] },
        { code: 'sk', name: 'Slovak', targets: [] },
      ],
    });
    expect(await translate({ q: ['x'], source: 'sk', target: 'en' })).toEqual({
      status: 400,
      json: { error: 'English (en) is not available as a target language from Slovak (sk)' },
    });
  });

  it('validates the request body', async () => {
    expect((await translate('not json')).status).toBe(400);
    expect((await translate([1])).status).toBe(400);
    expect((await translate({ source: 'sk', target: 'en' })).json).toEqual({
      error: 'Invalid request: missing q parameter',
    });
    expect((await translate({ q: ['x'], target: 'en' })).status).toBe(400);
    expect((await translate({ q: ['x'], source: 'sk' })).status).toBe(400);
    expect((await translate({ q: [1], source: 'sk', target: 'en' })).status).toBe(400);
    expect((await translate({ q: ['x'], source: 'sk', target: 'en', format: 'pdf' })).status).toBe(
      400,
    );
    expect((await fetch(`${lt.url}/translate`)).status).toBe(405);
    expect((await fetch(`${lt.url}/languages`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${lt.url}/nope`)).status).toBe(404);
  });

  it('applies the base status and timeout modes to /languages, and delays answers', async () => {
    lt.setOptions({ mode: 'status', status: 503 });
    expect((await fetch(`${lt.url}/languages`)).status).toBe(503);
    lt.reset({ delayMs: 120 });
    const started = Date.now();
    expect((await fetch(`${lt.url}/languages`)).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('resets to its start options and clears the recording', async () => {
    lt.setOptions({ mode: 'fail', sequence: [{ mode: 'weak' }] });
    await translate({ q: ['x'], source: 'sk', target: 'en' });
    lt.reset();
    expect(lt.requests).toHaveLength(0);
    expect((await translate({ q: ['Dobrý deň'], source: 'sk', target: 'en' })).json).toEqual({
      translatedText: ['Good day'],
    });
  });
});

describe('pseudoTranslate', () => {
  it('is deterministic, keeps names and numbers, and replaces the words', () => {
    const source = 'Vláda v Bratislave schválila 3 nové linky. Doprava sa zlepší.';
    const out = pseudoTranslate(source);
    expect(pseudoTranslate(source)).toBe(out);
    expect(out).toContain('Bratislave');
    expect(out).toContain(' 3 ');
    expect(out).not.toContain('schválila');
    expect(out).toMatch(/^[A-Z]/);
    expect(out.endsWith('.')).toBe(true);
  });
});
