import { afterEach, describe, expect, it } from 'vitest';

import {
  createLoadClock,
  loadItem,
  loadItemPublishedAt,
  loadLatestItem,
  startLoadFeedServer,
  type LoadFeedServer,
} from '../src/load-feeds.js';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 1, 12, 0, 0);

let server: LoadFeedServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function fixedClock(startAt = START) {
  let real = 1_000;
  const clock = createLoadClock({ startAt, realNow: () => real });
  return { clock, tick: (ms: number) => (real += ms) };
}

async function text(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

const itemGuids = (xml: string): string[] =>
  [...xml.matchAll(/<guid[^>]*>load-f(\d+)-n(\d+)<\/guid>/gu)].map((m) => `${m[1]}:${m[2]}`);

describe('load clock', () => {
  it('follows real time times speed, advances and never goes backwards', () => {
    const { clock, tick } = fixedClock();
    expect(clock.now()).toBe(START);
    tick(1_000);
    expect(clock.now()).toBe(START + 1_000);
    clock.advance(HOUR);
    expect(clock.now()).toBe(START + 1_000 + HOUR);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => createLoadClock({ speed: 0 })).toThrow(RangeError);
  });
});

describe('item schedule', () => {
  it('publishes five items per hour per feed with per-feed phases', () => {
    const times = Array.from({ length: 11 }, (_, n) => loadItemPublishedAt(3, n, START));
    expect(times.slice(1).every((t, i) => t - (times[i] as number) === HOUR / 5)).toBe(true);
    const phases = new Set(Array.from({ length: 50 }, (_, f) => loadItemPublishedAt(f, 0, START)));
    expect(phases.size).toBeGreaterThan(40);
    // Over any whole hour a feed gains exactly five items.
    for (const feed of [0, 17, 999]) {
      const before = loadLatestItem(feed, START + 10 * 60_000, START);
      expect(loadLatestItem(feed, START + 10 * 60_000 + HOUR, START) - before).toBe(5);
    }
    expect(loadLatestItem(0, START - 25 * HOUR, START)).toBe(-1);
  });

  it('derives titles and bodies from the item alone', () => {
    expect(loadItem(4, 9)).toEqual(loadItem(4, 9));
    expect(loadItem(4, 9).title).not.toBe(loadItem(4, 10).title);
    expect(loadItem(4, 9).paragraphs.join(' ').split(/\s+/u).length).toBeGreaterThan(150);
  });
});

describe('startLoadFeedServer', () => {
  it('serves 1,000 feeds, the newest window of items, on the clock it owns', async () => {
    const { clock } = fixedClock();
    server = await startLoadFeedServer({ clock, ports: [0, 0, 0] });
    expect(server.feedCount).toBe(1000);
    expect(server.origins).toHaveLength(3);
    const first = await text(server.feedUrl(0));
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('rss+xml');
    const guids = itemGuids(first.body);
    expect(guids).toHaveLength(6);
    // Same bytes on a second request: deterministic, no wall-clock text.
    expect((await text(server.feedUrl(0))).body).toBe(first.body);

    clock.advance(HOUR);
    const later = itemGuids((await text(server.feedUrl(0))).body);
    const numbers = (list: string[]) => list.map((g) => Number(g.split(':')[1]));
    expect(Math.max(...numbers(later)) - Math.max(...numbers(guids))).toBe(5);
    expect(later).toHaveLength(6);
  });

  it('spreads the feeds over the origins and rejects bad indexes', async () => {
    server = await startLoadFeedServer({ ports: [0, 0], feedCount: 10 });
    expect(server.feedUrl(0).startsWith(server.origins[0] as string)).toBe(true);
    expect(server.feedUrl(1).startsWith(server.origins[1] as string)).toBe(true);
    expect(server.feedUrl(2).startsWith(server.origins[0] as string)).toBe(true);
    expect(() => server?.feedUrl(10)).toThrow(RangeError);
    expect((await text(`${server.origins[0]}/feed/10.xml`)).status).toBe(404);
  });

  it('answers 304 to a matching If-None-Match and a new item changes the ETag', async () => {
    const { clock } = fixedClock();
    server = await startLoadFeedServer({ clock, feedCount: 2 });
    const url = server.feedUrl(1);
    const etag = (await text(url)).headers.get('etag') as string;
    expect(etag).toBeTruthy();
    expect((await text(url, { 'if-none-match': etag })).status).toBe(304);
    clock.advance(HOUR);
    const changed = await text(url, { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect(server.stats().notModified).toBe(1);
  });

  it('serves the article page of a published item and 404 for a future one', async () => {
    const { clock } = fixedClock();
    server = await startLoadFeedServer({ clock, feedCount: 3 });
    const feed = await text(server.feedUrl(2));
    const link = /<link>(http[^<]+\/a\/2\/\d+\.html)<\/link>/u.exec(feed.body)?.[1] as string;
    expect(link.startsWith(server.origins[2 % server.origins.length] as string)).toBe(true);
    const page = await text(link);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<article>');
    expect(page.body).toContain(
      loadItem(2, Number(/(\d+)\.html$/u.exec(link)?.[1])).title.slice(0, 20),
    );
    const latest = loadLatestItem(2, clock.now(), START);
    expect((await text(`${server.origins[0]}/a/2/${latest + 1}.html`)).status).toBe(404);
    clock.advance(HOUR);
    expect((await text(`${server.origins[0]}/a/2/${latest + 1}.html`)).status).toBe(200);
    expect(server.stats().pageRequests).toBe(2);
  });

  it('serves robots.txt, rejects writes and validates options', async () => {
    server = await startLoadFeedServer({ feedCount: 1 });
    expect((await text(`${server.origins[0]}/robots.txt`)).body).toContain('Allow: /');
    const post = await fetch(server.feedUrl(0), { method: 'POST' });
    expect(post.status).toBe(405);
    await expect(startLoadFeedServer({ feedCount: 0 })).rejects.toThrow(RangeError);
    await expect(startLoadFeedServer({ itemsPerFeedPerHour: 0 })).rejects.toThrow(RangeError);
  });
});
