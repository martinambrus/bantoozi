import { supportedSourceLanguages, type LibreTranslateClient } from './libretranslate.js';

/**
 * A process cache of LibreTranslate's `GET /languages` (spec 07 §2): the source languages with an
 * installed `→ en` model, for `supportedSources`. A successful read is kept for `ttlMs`; a failed
 * read keeps the last known set (unknown, `undefined`, before the first success: LibreTranslate
 * itself then rejects an unsupported pair) and is retried after `retryMs`. Concurrent callers share
 * one request.
 */
export interface SupportedSourcesCacheOptions {
  /** How long a successful read is kept. Default 1 h. */
  ttlMs?: number;
  /** How long after a failed read the next caller retries. Default 1 min. */
  retryMs?: number;
  now?: () => number;
}

export const SUPPORTED_SOURCES_TTL_MS = 3_600_000;
export const SUPPORTED_SOURCES_RETRY_MS = 60_000;

export function createSupportedSourcesCache(
  client: Pick<LibreTranslateClient, 'languages'>,
  options: SupportedSourcesCacheOptions = {},
): () => Promise<ReadonlySet<string> | undefined> {
  const ttlMs = options.ttlMs ?? SUPPORTED_SOURCES_TTL_MS;
  const retryMs = options.retryMs ?? SUPPORTED_SOURCES_RETRY_MS;
  for (const [name, value] of [
    ['ttlMs', ttlMs],
    ['retryMs', retryMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be >= 0`);
  }
  const now = options.now ?? Date.now;
  let known: ReadonlySet<string> | undefined;
  let freshUntil = Number.NEGATIVE_INFINITY;
  let inflight: Promise<ReadonlySet<string> | undefined> | null = null;

  async function refresh(): Promise<ReadonlySet<string> | undefined> {
    try {
      const result = await client.languages();
      if (result.ok) {
        known = supportedSourceLanguages(result.languages);
        freshUntil = now() + ttlMs;
        return known;
      }
    } catch {
      // A client that throws is treated like a failed read.
    }
    freshUntil = now() + retryMs;
    return known;
  }

  return () => {
    if (now() < freshUntil) return Promise.resolve(known);
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
