import { describe, expect, it, vi } from 'vitest';

import {
  createSupportedSourcesCache,
  type LanguagesResult,
  type LibreTranslateLanguage,
  type TranslationAttempt,
} from '../src/index.js';

const attempt: TranslationAttempt = {
  engine: 'libretranslate',
  attempt: 1,
  status: 'ok',
  startedAt: new Date(0),
  latencyMs: 1,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  billing: 'known',
};

const LANGUAGES: LibreTranslateLanguage[] = [
  { code: 'en', name: 'English', targets: ['en', 'sk', 'cs'] },
  { code: 'sk', name: 'Slovak', targets: ['en', 'cs'] },
  { code: 'cs', name: 'Czech', targets: ['en', 'sk'] },
  { code: 'hu', name: 'Hungarian', targets: ['sk'] },
];

const ok = (languages = LANGUAGES): LanguagesResult => ({ ok: true, languages, attempt });
const failed: LanguagesResult = {
  ok: false,
  reason: 'server_error',
  attempt: { ...attempt, status: 'error', error: 'http_503' },
};

describe('createSupportedSourcesCache', () => {
  it('keeps the → en sources of one read for the TTL', async () => {
    let now = 0;
    const languages = vi.fn(async () => ok());
    const cached = createSupportedSourcesCache({ languages }, { ttlMs: 1000, now: () => now });

    expect([...((await cached()) ?? [])].sort()).toEqual(['cs', 'sk']);
    now = 999;
    await cached();
    expect(languages).toHaveBeenCalledTimes(1);

    now = 1000;
    languages.mockResolvedValueOnce(ok(LANGUAGES.slice(0, 2)));
    expect([...((await cached()) ?? [])]).toEqual(['sk']);
    expect(languages).toHaveBeenCalledTimes(2);
  });

  it('is unknown until the first successful read and retries a failure after retryMs', async () => {
    let now = 0;
    const languages = vi.fn(async (): Promise<LanguagesResult> => failed);
    const cached = createSupportedSourcesCache(
      { languages },
      { ttlMs: 10_000, retryMs: 100, now: () => now },
    );

    expect(await cached()).toBeUndefined();
    now = 99;
    expect(await cached()).toBeUndefined();
    expect(languages).toHaveBeenCalledTimes(1);

    now = 100;
    languages.mockResolvedValueOnce(ok());
    expect((await cached())?.has('sk')).toBe(true);
    expect(languages).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known set when a refresh fails or the client throws', async () => {
    let now = 0;
    const languages = vi.fn(async () => ok());
    const cached = createSupportedSourcesCache(
      { languages },
      { ttlMs: 10, retryMs: 5, now: () => now },
    );
    const first = await cached();

    now = 10;
    languages.mockResolvedValueOnce(failed);
    expect(await cached()).toBe(first);

    now = 15;
    languages.mockRejectedValueOnce(new Error('boom'));
    expect(await cached()).toBe(first);
    expect(languages).toHaveBeenCalledTimes(3);
  });

  it('shares one request between concurrent callers', async () => {
    let release: (value: LanguagesResult) => void = () => undefined;
    const languages = vi.fn(
      () =>
        new Promise<LanguagesResult>((resolve) => {
          release = resolve;
        }),
    );
    const cached = createSupportedSourcesCache({ languages });

    const both = Promise.all([cached(), cached()]);
    release(ok());
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(languages).toHaveBeenCalledTimes(1);
  });

  it('rejects a negative or non-finite duration', () => {
    const languages = async () => ok();
    expect(() => createSupportedSourcesCache({ languages }, { ttlMs: -1 })).toThrow(RangeError);
    expect(() => createSupportedSourcesCache({ languages }, { retryMs: Number.NaN })).toThrow(
      RangeError,
    );
  });
});
