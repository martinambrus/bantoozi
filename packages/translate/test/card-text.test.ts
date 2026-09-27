import {
  pseudoTranslate,
  startFakeLibreTranslate,
  type FakeLibreTranslate,
} from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createLibreTranslateClient,
  translateCardText,
  type LibreTranslateClient,
} from '../src/index.js';

const SK_INTEREST = 'Správy o hokeji a futbale zo Slovenska, ktoré ma zaujímajú';
const SK_NOT_FOR = 'Bulvár a klebety o celebritách';
const CS_INTEREST = 'Nové cyklotrasy a veřejná doprava v Praze';
const CS_NOT_FOR = 'Politické spory o rozpočtu města';
const SUPPORTED: ReadonlySet<string> = new Set(['sk', 'cs']);

let lt: FakeLibreTranslate;
let client: LibreTranslateClient;

beforeAll(async () => {
  lt = await startFakeLibreTranslate();
  client = createLibreTranslateClient({
    baseUrl: lt.url,
    timeoutMs: 2_000,
    backoffMs: 1,
    sleep: () => Promise.resolve(),
  });
});

afterAll(async () => {
  await client.close();
  await lt.close();
});

beforeEach(() => {
  lt.reset();
});

describe('translateCardText (spec 07 §5)', () => {
  it('translates a Slovak interest and not_for as one pair, in that order', async () => {
    const result = await translateCardText(client, {
      interest: SK_INTEREST,
      notFor: SK_NOT_FOR,
      locale: 'sk-SK',
      supportedSources: SUPPORTED,
    });
    expect(lt.requests).toHaveLength(1);
    expect(lt.requests[0]?.body).toEqual({
      q: [SK_INTEREST, SK_NOT_FOR],
      source: 'sk',
      target: 'en',
      format: 'text',
    });
    expect(result).toMatchObject({
      lang: 'sk',
      status: 'translated',
      interestEn: pseudoTranslate(SK_INTEREST),
      notForEn: pseudoTranslate(SK_NOT_FOR),
      assessment: { quality: 'ok' },
    });
    expect(result.attempts).toEqual([
      expect.objectContaining({ engine: 'libretranslate', status: 'ok' }),
    ]);
  });

  it('maps an omitted not_for explicitly: one text sent, notForEn null', async () => {
    for (const notFor of [undefined, null, '', '   ']) {
      lt.reset();
      const result = await translateCardText(client, {
        interest: CS_INTEREST,
        ...(notFor === undefined ? {} : { notFor }),
        supportedSources: SUPPORTED,
      });
      expect(lt.requests[0]?.body).toMatchObject({ q: [CS_INTEREST], source: 'cs' });
      expect(result).toMatchObject({
        lang: 'cs',
        status: 'translated',
        interestEn: pseudoTranslate(CS_INTEREST),
        notForEn: null,
      });
    }
  });

  it('translates Czech as Czech, never through the Slovak locale', async () => {
    const result = await translateCardText(client, {
      interest: CS_INTEREST,
      notFor: CS_NOT_FOR,
      locale: 'sk',
      supportedSources: SUPPORTED,
    });
    expect(result).toMatchObject({ lang: 'cs', status: 'translated' });
    expect(lt.requests[0]?.body).toMatchObject({ source: 'cs' });
  });

  it('keeps English, undetermined and unsupported cards as written, without a request', async () => {
    const cases = [
      [{ interest: 'Electric cars and battery technology news', locale: 'sk' }, 'en', 'english'],
      [{ interest: '2026 !!! 42' }, 'und', 'undetermined'],
      [
        { interest: 'Neue Radwege und öffentlicher Verkehr in Berlin', locale: 'sk' },
        'de',
        'unsupported',
      ],
    ] as const;
    for (const [input, lang, status] of cases) {
      expect(await translateCardText(client, { ...input, supportedSources: SUPPORTED })).toEqual({
        lang,
        status,
        interestEn: null,
        notForEn: null,
        attempts: [],
      });
    }
    // A language with a model installed elsewhere is still unsupported here.
    expect(
      await translateCardText(client, {
        interest: SK_INTEREST,
        supportedSources: new Set(['cs']),
      }),
    ).toMatchObject({ lang: 'sk', status: 'unsupported', attempts: [] });
    expect(lt.requests).toHaveLength(0);
  });

  it('never translates a brand-only phrase because the UI locale is Slovak', async () => {
    for (const interest of ['iPhone', '2026 !!! 42']) {
      const result = await translateCardText(client, {
        interest,
        locale: 'sk',
        supportedSources: SUPPORTED,
      });
      // The hinted detection is what `interest_cards.lang` stores; the text stays as written.
      expect(result).toEqual({
        lang: 'sk',
        status: 'unconfirmed',
        interestEn: null,
        notForEn: null,
        attempts: [],
      });
    }
    expect(lt.requests).toHaveLength(0);
  });

  it('keeps the original pair on a weak or failed translation, with its assessment', async () => {
    lt.setOptions({ mode: 'weak' });
    const weak = await translateCardText(client, {
      interest: SK_INTEREST,
      notFor: SK_NOT_FOR,
      supportedSources: SUPPORTED,
    });
    expect(weak).toMatchObject({
      lang: 'sk',
      status: 'weak',
      interestEn: null,
      notForEn: null,
      assessment: { quality: 'weak' },
    });
    expect(weak.attempts).toHaveLength(1);

    lt.reset({ mode: 'fail' });
    const failed = await translateCardText(client, {
      interest: SK_INTEREST,
      notFor: SK_NOT_FOR,
      supportedSources: SUPPORTED,
    });
    expect(failed).toMatchObject({
      status: 'failed',
      interestEn: null,
      notForEn: null,
      assessment: { quality: 'fail' },
    });
  });

  it('never publishes half a pair', async () => {
    lt.setOptions({ mode: 'raw', body: { translatedText: [pseudoTranslate(SK_INTEREST), ''] } });
    const result = await translateCardText(client, {
      interest: SK_INTEREST,
      notFor: SK_NOT_FOR,
      supportedSources: SUPPORTED,
    });
    expect(result).toMatchObject({ status: 'failed', interestEn: null, notForEn: null });
    if (result.assessment?.skipped !== false) throw new Error('expected an assessment');
    expect(result.assessment.fields.interest.result).toBe('ok');
    expect(result.assessment.fields.not_for.reasons).toEqual(['empty_output']);
  });

  it('keeps the card usable during a tier-1 outage and reports every attempt', async () => {
    lt.setOptions({ mode: 'status', status: 503 });
    const result = await translateCardText(client, {
      interest: SK_INTEREST,
      supportedSources: SUPPORTED,
    });
    expect(result).toMatchObject({
      lang: 'sk',
      status: 'failed',
      failure: 'server_error',
      interestEn: null,
      notForEn: null,
    });
    expect(result.attempts.map((attempt) => attempt.error)).toEqual(['http_503', 'http_503']);
  });

  it('requires a nonblank interest', async () => {
    await expect(
      translateCardText(client, { interest: '  ', supportedSources: SUPPORTED }),
    ).rejects.toThrow(TypeError);
  });
});
