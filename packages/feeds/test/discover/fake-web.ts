import type { DiscoverDeps, DiscoveryFetchOptions } from '../../src/discover/index.js';
import type { DecodeResult, SafeFetchResult } from '../../src/http/index.js';
import type { FeedKind, ParseFeedResult } from '../../src/parse/index.js';

/** A scripted response of the fake web; unknown URLs answer `FEED_HTTP_404`. */
export type FakeResponse =
  | {
      body: string;
      contentType?: string;
      status?: number;
      /** Where the redirect chain ended (default: the requested URL). */
      finalUrl?: string;
      /** Every hop was 301/308. */
      permanent?: boolean;
      /** Number of redirect hops reported (default 0, or 1 when `finalUrl` differs). */
      hops?: number;
      /** The body cannot be decoded. */
      undecodable?: boolean;
      /** Real milliseconds before the response arrives (default 0). */
      delayMs?: number;
      /** The response arrives when this promise settles (after `delayMs`). */
      gate?: Promise<unknown>;
      /** Fake-clock milliseconds the request takes (default 0). */
      tookMs?: number;
    }
  | {
      fail: string;
      message?: string;
      retryAt?: Date;
      delayMs?: number;
      gate?: Promise<unknown>;
      tookMs?: number;
    };

export interface FetchCall {
  url: string;
  options: DiscoveryFetchOptions;
}

const UNDECODABLE = new Uint8Array([0, 0, 0xff]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * An in-memory web for discovery tests: scripted responses per exact URL, a fake clock advanced by
 * each response's `tookMs`, a record of every fetch and parse, and the peak number of concurrent
 * fetches. Aborting a fetch's signal ends it with `FEED_TIMEOUT`, as `safeFetch` does.
 */
export class FakeWeb {
  readonly calls: FetchCall[] = [];
  readonly parsed: string[] = [];
  now = 1_000_000;
  maxInFlight = 0;
  private inFlight = 0;
  private readonly routes = new Map<string, FakeResponse | ((call: FetchCall) => FakeResponse)>();

  route(url: string, response: FakeResponse | ((call: FetchCall) => FakeResponse)): this {
    this.routes.set(url, response);
    return this;
  }

  urls(): string[] {
    return this.calls.map((call) => call.url);
  }

  deps(overrides: Partial<DiscoverDeps> = {}): DiscoverDeps {
    return {
      fetch: (url, options) => this.fetch(url, options),
      parse: (text, options) => this.parse(text, options.url),
      decode: (bytes) => this.decode(bytes),
      now: () => this.now,
      ...overrides,
    };
  }

  async fetch(url: string, options: DiscoveryFetchOptions): Promise<SafeFetchResult> {
    const call = { url, options };
    this.calls.push(call);
    const route = this.routes.get(url);
    const response: FakeResponse =
      route === undefined
        ? { fail: 'FEED_HTTP_404', message: 'HTTP 404' }
        : typeof route === 'function'
          ? route(call)
          : route;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const aborted =
        (await wait(response.delayMs ?? 0, options.signal)) ||
        (response.gate !== undefined && (await gated(response.gate, options.signal)));
      this.now += response.tookMs ?? 0;
      if (aborted) return { ok: false, code: 'FEED_TIMEOUT', message: 'aborted' };
      if ('fail' in response) {
        const status = /^FEED_HTTP_(\d+)$/.exec(response.fail)?.[1];
        return {
          ok: false,
          code: response.fail as Extract<SafeFetchResult, { ok: false }>['code'],
          message: response.message ?? response.fail,
          ...(status === undefined ? {} : { status: Number(status) }),
          ...(response.retryAt === undefined ? {} : { retryAt: response.retryAt }),
        };
      }
      const finalUrl = response.finalUrl ?? url;
      const hops = response.hops ?? (finalUrl === url ? 0 : 1);
      return {
        ok: true,
        status: response.status ?? 200,
        finalUrl,
        permanentRedirect: hops > 0 && response.permanent === true,
        redirects: Array.from({ length: hops }, (_, i) => ({
          status: response.permanent === true ? 301 : 302,
          from: i === 0 ? url : `${url}#hop${i}`,
          to: i === hops - 1 ? finalUrl : `${url}#hop${i + 1}`,
        })),
        headers: response.contentType === undefined ? {} : { 'content-type': response.contentType },
        bodyBytes: response.undecodable === true ? UNDECODABLE : encoder.encode(response.body),
      };
    } finally {
      this.inFlight -= 1;
    }
  }

  decode(bytes: Uint8Array): DecodeResult {
    if (bytes.length === UNDECODABLE.length && bytes.every((byte, i) => byte === UNDECODABLE[i])) {
      return { ok: false, code: 'FEED_DECODE_ERROR', message: 'the body cannot be decoded' };
    }
    return { ok: true, text: decoder.decode(bytes), encoding: 'utf-8' };
  }

  /** A fake `parseFeed` for the tiny documents built by {@link rss}, {@link atom}, {@link rdf}… */
  async parse(text: string, url: string): Promise<ParseFeedResult> {
    this.parsed.push(url);
    await Promise.resolve();
    const start = text.trimStart();
    const kind: FeedKind | null = start.startsWith('<rss')
      ? 'rss'
      : start.startsWith('<feed')
        ? 'atom'
        : start.startsWith('<rdf:RDF')
          ? 'rdf'
          : start.startsWith('{') && start.includes('jsonfeed.org/version')
            ? 'json'
            : null;
    if (start.startsWith('<broken')) {
      return { ok: false, code: 'FEED_PARSE_ERROR', message: 'the feed is malformed' };
    }
    if (kind === null) return { ok: false, code: 'FEED_NOT_A_FEED', message: 'not a feed' };
    const title =
      kind === 'json'
        ? ((JSON.parse(text) as { title?: string }).title ?? null)
        : (/<title>([^<]*)<\/title>/.exec(text)?.[1] ?? null);
    return {
      ok: true,
      kind,
      feed: {
        title,
        siteUrl: null,
        description: null,
        language: null,
        langHint: null,
        iconUrl: null,
        ttlMinutes: null,
        syUpdatePeriod: null,
        syUpdateFrequency: null,
      },
      items: [],
      totalItems: 0,
      itemsTruncated: false,
      itemErrors: [],
      itemErrorCount: 0,
      lenient: false,
    };
  }
}

/** Resolves true when aborted before `gate` settles. */
function gated(gate: Promise<unknown>, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(true);
    signal?.addEventListener('abort', onAbort, { once: true });
    void gate.finally(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    });
  });
}

/** A promise the test settles by hand, to order concurrent responses deterministically. */
export function deferred(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Waits (macrotask by macrotask) until `condition` holds; fails after 2 s. */
export async function until(condition: () => boolean): Promise<void> {
  const limit = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > limit) throw new Error('condition not reached');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Resolves true when aborted before `ms` real milliseconds passed. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const rss = (title: string | null = 'An RSS feed'): string =>
  `<rss version="2.0"><channel>${title === null ? '' : `<title>${title}</title>`}</channel></rss>`;
export const atom = (title = 'An Atom feed'): string =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title></feed>`;
export const rdf = (title = 'An RDF feed'): string =>
  `<rdf:RDF><channel><title>${title}</title></channel></rdf:RDF>`;
export const jsonFeed = (title = 'A JSON feed'): string =>
  JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title, items: [] });
export const htmlPage = (head = '', body = ''): string =>
  `<!doctype html><html><head><title>Page</title>${head}</head><body>${body}</body></html>`;
export const alternate = (type: string, href: string, title?: string): string =>
  `<link rel="alternate" type="${type}" href="${href}"${title === undefined ? '' : ` title="${title}"`}>`;

export const HTML = 'text/html; charset=utf-8';
export const RSS = 'application/rss+xml';
