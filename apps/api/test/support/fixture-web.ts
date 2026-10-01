import {
  decodeBody,
  parseFeed,
  type DiscoverDeps,
  type DiscoveryFetchOptions,
  type SafeFetchResult,
} from '@bantoozi/feeds';
import { readFixture } from '@bantoozi/testing';

/** A scripted response: fixture bytes, an HTML page, or a fetch failure. */
export type FixtureResponse =
  | { body: Uint8Array | string; contentType: string; finalUrl?: string }
  | { fail: Extract<SafeFetchResult, { ok: false }>['code']; status?: number };

const encoder = new TextEncoder();

/**
 * An offline web for discovery in API tests (spec 01 §5: no live network): scripted responses per
 * exact URL, parsed and decoded by the real `parseFeed` and `decodeBody`, so subscribe/discovery
 * routes run the production pipeline over committed fixtures. Unknown URLs answer `FEED_HTTP_404`.
 * `onFetch` runs before every response (spies, e.g. "no transaction is open during discovery").
 */
export class FixtureWeb {
  readonly fetched: string[] = [];
  onFetch: ((url: string) => void | Promise<void>) | null = null;
  private readonly routes = new Map<string, FixtureResponse>();

  route(url: string, response: FixtureResponse): this {
    this.routes.set(url, response);
    return this;
  }

  /** Serve a committed feed fixture, e.g. `feed(url, 'rss2.xml', 'application/rss+xml')`. */
  feed(url: string, fixture: string, contentType = 'application/rss+xml'): this {
    return this.route(url, { body: readFixture('feeds', fixture), contentType });
  }

  deps(): DiscoverDeps {
    return {
      fetch: (url, options) => this.fetch(url, options),
      parse: (text, options) => parseFeed(text, options),
      decode: (bytes, contentType) => decodeBody(bytes, contentType),
    };
  }

  private async fetch(url: string, _options: DiscoveryFetchOptions): Promise<SafeFetchResult> {
    this.fetched.push(url);
    await this.onFetch?.(url);
    const response = this.routes.get(url) ?? { fail: 'FEED_HTTP_404', status: 404 };
    if ('fail' in response) {
      return {
        ok: false,
        code: response.fail,
        message: response.fail,
        ...(response.status === undefined ? {} : { status: response.status }),
      };
    }
    const finalUrl = response.finalUrl ?? url;
    return {
      ok: true,
      status: 200,
      finalUrl,
      permanentRedirect: false,
      redirects: finalUrl === url ? [] : [{ status: 302, from: url, to: finalUrl }],
      headers: { 'content-type': response.contentType },
      bodyBytes: typeof response.body === 'string' ? encoder.encode(response.body) : response.body,
    };
  }
}

/** A tiny RSS 2.0 document (real syntax, parsed by `parseFeed`). */
export function rssDocument(title: string, items: readonly { title: string; link: string }[] = []) {
  const entries = items
    .map((item) => `<item><title>${item.title}</title><link>${item.link}</link></item>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>https://example.com/</link>${entries}</channel></rss>`;
}

/** An HTML page advertising feeds through `<link rel="alternate">`. */
export function htmlWithFeeds(feeds: readonly { href: string; title?: string; type?: string }[]) {
  const links = feeds
    .map(
      (feed) =>
        `<link rel="alternate" type="${feed.type ?? 'application/rss+xml'}" href="${feed.href}"${
          feed.title === undefined ? '' : ` title="${feed.title}"`
        }>`,
    )
    .join('');
  return `<!doctype html><html><head><title>Site</title>${links}</head><body>Hi</body></html>`;
}
