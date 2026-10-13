import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { closeServer } from './fake-http.js';

/**
 * Generated feed server for the load sanity test (spec 11 §9, M8-T8): `feedCount` deterministic RSS
 * feeds (default 1,000) that each publish `itemsPerFeedPerHour` new items (default 5) on a clock the
 * server owns, plus an article page for every item, so ingestion and extraction both have real work.
 *
 * - Item `n` of feed `f` is published at `epoch + phase(f) + n × interval`, with `interval =
 *   1 h / itemsPerFeedPerHour` and a per-feed `phase` below one interval. `epoch` is 24 h before the
 *   clock's start, so every feed already has history when the server comes up. A feed lists the
 *   newest `window` published items (default 6); an item that is not yet published has no page.
 * - Everything derives from `(feed, item)` through SHA-256: two servers give identical bytes for the
 *   same clock reading, with no random numbers and no wall-clock text in the bodies.
 * - The clock starts at `startAt` (default: now), follows real time times `speed` and can be moved
 *   forward with `advance`; tests and the control API use that to publish items on demand.
 * - It listens on one or several ports. The origin limiter (spec 03 §8.2) spaces requests per
 *   scheme://host:port, so serving 1,000 feeds from one port would make the throttle, not the
 *   pipeline, the bottleneck; feed `f` is advertised on port `ports[f % ports.length]` and every
 *   port answers every path.
 */

const HOUR_MS = 3_600_000;
const HISTORY_MS = 24 * HOUR_MS;

export interface LoadClock {
  /** Milliseconds since the epoch on the server's own clock. */
  now(): number;
  /** Moves the clock forward by `ms` (not backwards). */
  advance(ms: number): void;
}

export interface LoadClockOptions {
  startAt?: number;
  /** Clock seconds per real second. Default 1. */
  speed?: number;
  /** The real time source; tests pass a fake. Default `Date.now`. */
  realNow?: () => number;
}

export function createLoadClock(options: LoadClockOptions = {}): LoadClock {
  const realNow = options.realNow ?? Date.now;
  const speed = options.speed ?? 1;
  if (!(Number.isFinite(speed) && speed > 0)) throw new RangeError('speed must be positive');
  const realStart = realNow();
  const startAt = options.startAt ?? realStart;
  let advanced = 0;
  return {
    now: () => startAt + (realNow() - realStart) * speed + advanced,
    advance(ms) {
      if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError('advance takes a nonnegative ms');
      advanced += ms;
    },
  };
}

export interface LoadFeedsOptions {
  /** Default 1,000. */
  feedCount?: number;
  /** Default 5. */
  itemsPerFeedPerHour?: number;
  /** Items a feed lists. Default 6. */
  window?: number;
  /** Listening address. Default 127.0.0.1. */
  host?: string;
  /** Listening ports; 0 picks a random free one. Default one random port. */
  ports?: readonly number[];
  /** Hostname written into the feed and page URLs. Default the listening host. */
  publicHost?: string;
  /** Default: a clock starting now. */
  clock?: LoadClock;
}

export interface LoadFeedStats {
  feedRequests: number;
  notModified: number;
  pageRequests: number;
  notFound: number;
}

export interface LoadFeedServer {
  readonly feedCount: number;
  readonly itemsPerFeedPerHour: number;
  readonly window: number;
  readonly clock: LoadClock;
  /** Base URLs (`http://host:port`) in listening order. */
  readonly origins: readonly string[];
  /** The URL of feed `index` (0-based), on its own origin. */
  feedUrl(index: number): string;
  stats(): LoadFeedStats;
  close(): Promise<void>;
}

const WORDS = [
  'harbour',
  'quantum',
  'orchard',
  'ledger',
  'granite',
  'lantern',
  'meadow',
  'circuit',
  'summit',
  'compass',
  'beacon',
  'tundra',
  'velvet',
  'copper',
  'saffron',
  'glacier',
  'monsoon',
  'prairie',
  'cobalt',
  'ember',
  'harvest',
  'lattice',
  'marble',
  'nimbus',
  'outpost',
  'pioneer',
  'quarry',
  'ripple',
  'sparrow',
  'timber',
  'uplink',
  'valley',
  'willow',
  'zephyr',
  'anchor',
  'bastion',
  'canopy',
  'delta',
  'eclipse',
  'fjord',
  'gateway',
  'horizon',
  'island',
  'junction',
  'keystone',
  'lagoon',
  'mosaic',
  'nectar',
  'oasis',
  'plateau',
  'reactor',
  'signal',
  'terrace',
  'umbra',
  'vector',
  'warren',
  'yonder',
  'archive',
  'blossom',
  'cascade',
  'drizzle',
  'estuary',
  'foundry',
];

const TOPICS = [
  'climate policy',
  'football transfers',
  'machine learning',
  'space exploration',
  'public health',
  'electric vehicles',
  'chess strategy',
  'urban gardening',
  'cybersecurity',
  'renewable energy',
  'film festivals',
  'local elections',
  'open source software',
  'cooking',
  'startup funding',
  'cycling',
  'medieval history',
  'ocean research',
  'mobile networks',
  'jazz',
];

function digest(...parts: (string | number)[]): Buffer {
  return createHash('sha256').update(parts.join(':')).digest();
}

function pick<T>(items: readonly T[], bytes: Buffer, offset: number): T {
  return items[bytes.readUInt16BE(offset) % items.length] as T;
}

interface Layout {
  feedCount: number;
  intervalMs: number;
  window: number;
}

function layoutOf(options: LoadFeedsOptions): Layout {
  const feedCount = options.feedCount ?? 1000;
  const perHour = options.itemsPerFeedPerHour ?? 5;
  const window = options.window ?? 4;
  if (!Number.isInteger(feedCount) || feedCount < 1) throw new RangeError('feedCount must be >= 1');
  if (!(Number.isFinite(perHour) && perHour > 0)) throw new RangeError('itemsPerFeedPerHour > 0');
  if (!Number.isInteger(window) || window < 1) throw new RangeError('window must be >= 1');
  return { feedCount, intervalMs: HOUR_MS / perHour, window };
}

/** Offset of feed `feed`'s first item within one interval: feeds do not publish in lockstep. */
function phaseMs(feed: number, intervalMs: number): number {
  return digest('phase', feed).readUInt32BE(0) % Math.floor(intervalMs);
}

/** Publication time of item `item` of feed `feed`, given the clock's start. */
export function loadItemPublishedAt(
  feed: number,
  item: number,
  startAt: number,
  itemsPerFeedPerHour = 5,
): number {
  const intervalMs = HOUR_MS / itemsPerFeedPerHour;
  return startAt - HISTORY_MS + phaseMs(feed, intervalMs) + item * intervalMs;
}

/** Index of the newest published item of `feed` at `nowMs`, or -1 when none is. */
export function loadLatestItem(
  feed: number,
  nowMs: number,
  startAt: number,
  itemsPerFeedPerHour = 5,
): number {
  const intervalMs = HOUR_MS / itemsPerFeedPerHour;
  const first = loadItemPublishedAt(feed, 0, startAt, itemsPerFeedPerHour);
  return nowMs < first ? -1 : Math.floor((nowMs - first) / intervalMs);
}

export interface LoadItem {
  feed: number;
  item: number;
  title: string;
  summary: string;
  paragraphs: string[];
}

/** The deterministic title, summary and body of one item. */
export function loadItem(feed: number, item: number): LoadItem {
  const bytes = digest('item', feed, item);
  const topic = pick(TOPICS, bytes, 0);
  const a = pick(WORDS, bytes, 2);
  const b = pick(WORDS, bytes, 4);
  const c = pick(WORDS, bytes, 6);
  const title = `${topic.replace(/^./u, (ch) => ch.toUpperCase())}: the ${a} ${b} question in ${c} ${item}-${feed}`;
  const summary = `A report on ${topic} from the ${a} desk, looking at the ${b} and the ${c} of feed ${feed}.`;
  const paragraphs: string[] = [];
  for (let p = 0; p < 5; p += 1) {
    const words = digest('para', feed, item, p);
    const sentences: string[] = [];
    for (let s = 0; s < 4; s += 1) {
      const x = pick(WORDS, words, s * 6);
      const y = pick(WORDS, words, s * 6 + 2);
      const z = pick(WORDS, words, s * 6 + 4);
      sentences.push(
        `Observers of ${topic} noted that the ${x} around the ${y} had shifted toward the ${z} during the week, which changed how the ${a} and the ${b} are discussed in the region.`,
      );
    }
    paragraphs.push(sentences.join(' '));
  }
  return { feed, item, title, summary, paragraphs };
}

const escapeXml = (text: string): string =>
  text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');

function renderFeed(
  layout: Layout,
  feed: number,
  nowMs: number,
  startAt: number,
  perHour: number,
  base: string,
): { xml: string; etag: string } {
  const latest = loadLatestItem(feed, nowMs, startAt, perHour);
  const first = Math.max(0, latest - layout.window + 1);
  const items: string[] = [];
  for (let n = latest; n >= first; n -= 1) {
    const it = loadItem(feed, n);
    const published = new Date(loadItemPublishedAt(feed, n, startAt, perHour)).toUTCString();
    const link = `${base}/a/${feed}/${n}.html`;
    items.push(
      `<item><title>${escapeXml(it.title)}</title><link>${link}</link>` +
        `<guid isPermaLink="false">load-f${feed}-n${n}</guid><pubDate>${published}</pubDate>` +
        `<description>${escapeXml(it.summary)}</description></item>`,
    );
  }
  const updated =
    latest < 0 ? new Date(startAt) : new Date(loadItemPublishedAt(feed, latest, startAt, perHour));
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
    `<title>Load feed ${feed}</title><link>${base}/</link>` +
    `<description>Generated feed ${feed} of the load sanity test</description><language>en</language>` +
    `<lastBuildDate>${updated.toUTCString()}</lastBuildDate>${items.join('')}</channel></rss>`;
  return { xml, etag: `"f${feed}-${latest}"` };
}

function renderPage(it: LoadItem, publishedAt: number): string {
  const body = it.paragraphs.map((text) => `<p>${escapeXml(text)}</p>`).join('\n');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeXml(it.title)}</title>` +
    `<meta name="description" content="${escapeXml(it.summary)}">` +
    `<meta property="og:title" content="${escapeXml(it.title)}"></head><body><main><article>` +
    `<h1>${escapeXml(it.title)}</h1><p><time datetime="${new Date(publishedAt).toISOString()}">` +
    `${new Date(publishedAt).toUTCString()}</time></p>\n${body}\n</article></main></body></html>`
  );
}

/** Starts the generated feed server; resolves when every port is listening. */
export async function startLoadFeedServer(options: LoadFeedsOptions = {}): Promise<LoadFeedServer> {
  const layout = layoutOf(options);
  const perHour = options.itemsPerFeedPerHour ?? 5;
  const host = options.host ?? '127.0.0.1';
  const clock = options.clock ?? createLoadClock();
  const startAt = clock.now();
  const wantedPorts =
    options.ports === undefined || options.ports.length === 0 ? [0] : options.ports;
  const counters: LoadFeedStats = { feedRequests: 0, notModified: 0, pageRequests: 0, notFound: 0 };

  const servers: Server[] = [];
  const origins: string[] = [];
  const publicHost = options.publicHost ?? host;
  for (const wanted of wantedPorts) {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://load.local').pathname;
      const origin = `http://${req.headers.host ?? publicHost}`;
      const text = (
        status: number,
        type: string,
        body: string,
        headers: Record<string, string> = {},
      ) =>
        res
          .writeHead(status, { 'content-type': type, ...headers })
          .end(req.method === 'HEAD' ? undefined : body);
      const miss = () => {
        counters.notFound += 1;
        text(404, 'text/plain; charset=utf-8', 'not found');
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        text(405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'GET, HEAD' });
        return;
      }
      if (path === '/robots.txt') {
        text(200, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
        return;
      }
      if (path === '/healthz') {
        text(200, 'text/plain; charset=utf-8', 'ok');
        return;
      }
      const feedMatch = /^\/feed\/(\d{1,6})\.xml$/u.exec(path);
      if (feedMatch !== null) {
        const feed = Number(feedMatch[1]);
        if (feed >= layout.feedCount) return miss();
        counters.feedRequests += 1;
        const { xml, etag } = renderFeed(layout, feed, clock.now(), startAt, perHour, origin);
        if (req.headers['if-none-match'] === etag) {
          counters.notModified += 1;
          res.writeHead(304, { etag }).end();
          return;
        }
        text(200, 'application/rss+xml; charset=utf-8', xml, { etag });
        return;
      }
      const pageMatch = /^\/a\/(\d{1,6})\/(\d{1,9})\.html$/u.exec(path);
      if (pageMatch !== null) {
        const feed = Number(pageMatch[1]);
        const item = Number(pageMatch[2]);
        if (
          feed >= layout.feedCount ||
          item > loadLatestItem(feed, clock.now(), startAt, perHour)
        ) {
          return miss();
        }
        counters.pageRequests += 1;
        text(
          200,
          'text/html; charset=utf-8',
          renderPage(loadItem(feed, item), loadItemPublishedAt(feed, item, startAt, perHour)),
        );
        return;
      }
      miss();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(wanted, host, () => resolve());
    });
    servers.push(server);
    origins.push(`http://${publicHost}:${(server.address() as AddressInfo).port}`);
  }

  return {
    feedCount: layout.feedCount,
    itemsPerFeedPerHour: perHour,
    window: layout.window,
    clock,
    origins,
    feedUrl(index) {
      if (!Number.isInteger(index) || index < 0 || index >= layout.feedCount) {
        throw new RangeError(`feed index ${index} is outside 0..${layout.feedCount - 1}`);
      }
      return `${origins[index % origins.length]}/feed/${index}.xml`;
    },
    stats: () => ({ ...counters }),
    close: async () => {
      await Promise.all(servers.map((server) => closeServer(server)));
    },
  };
}
