import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFixtureServer, type FixtureServer } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCli } from '../src/cli.js';
import { parseFeedList } from '../src/collection/feed-list.js';
import { formatProbeReport, probeFeeds } from '../src/collection/reachability.js';
import { checkWorkers, HEARTBEAT_FRESH_MS } from '../src/collection/worker-check.js';
import { createEvalRuntime } from '../src/runtime.js';

/**
 * M3a-T2 (spec 10 §2.1): the worker precondition of `eval ingest-sample` and its `--dry-run`
 * reachability report, against a local fixture server (never the live network).
 */

const NOW = new Date('2026-10-01T12:00:00.000Z');
const beat = (
  ageMs: number,
  evalIngestOnly: boolean,
  queues = ['feed.fetch', 'article.extract'],
) => ({
  at: new Date(NOW.getTime() - ageMs).toISOString(),
  queues,
  evalIngestOnly,
  envCredentials: [],
});

describe('checkWorkers (spec 10 §2.1, D-96)', () => {
  it('requires a live ingest-only heartbeat', () => {
    expect(checkWorkers(null, NOW)).toMatchObject({ ok: false, reason: 'no_ingest_only_worker' });
    const old = checkWorkers({ w1: beat(HEARTBEAT_FRESH_MS + 1, true) }, NOW);
    expect(old).toMatchObject({ ok: false, reason: 'no_ingest_only_worker' });
    if (!old.ok) expect(old.message).toContain('EVAL_INGEST_ONLY=true');
    expect(checkWorkers({ w1: beat(30_000, true) }, NOW)).toMatchObject({ ok: true });
  });

  it('refuses while any live worker is not ingest-only, even next to an ingest-only one', () => {
    const check = checkWorkers({ w1: beat(10_000, true), w2: beat(80_000, false) }, NOW);
    expect(check).toMatchObject({ ok: false, reason: 'ordinary_worker_live' });
    if (!check.ok) expect(check.message).toContain('w2');
    // A stale ordinary entry (the process is gone) does not block.
    expect(
      checkWorkers({ w1: beat(10_000, true), w2: beat(HEARTBEAT_FRESH_MS + 5_000, false) }, NOW),
    ).toMatchObject({ ok: true });
  });

  it('requires the fetch and extract queues to be consumed', () => {
    expect(checkWorkers({ w1: beat(1_000, true, ['feed.schedule']) }, NOW)).toMatchObject({
      ok: false,
      reason: 'queues_not_consumed',
    });
    expect(
      checkWorkers(
        { w1: beat(1_000, true, ['feed.fetch']), w2: beat(1_000, true, ['article.extract']) },
        NOW,
      ),
    ).toMatchObject({ ok: true });
  });

  it('rejects a malformed heartbeat value', () => {
    expect(() => checkWorkers({ w1: { at: 'yesterday' } }, NOW)).toThrow();
  });
});

describe('ingest-sample --dry-run', () => {
  let server: FixtureServer;
  let listPath: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    server.route('/en.rss', {
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>EN</title><link>${server.url('/')}</link>
<description>x</description><language>en</language>
<item><title>One</title><link>${server.url('/a1')}</link><guid>a1</guid></item>
<item><title>Two</title><link>${server.url('/a2')}</link><guid>a2</guid></item>
</channel></rss>`,
    });
    server.route('/sk.atom', {
      status: 200,
      headers: { 'content-type': 'application/atom+xml' },
      body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xml:lang="sk"><title>SK</title>
<id>urn:sk</id><updated>2026-10-01T10:00:00Z</updated>
<entry><title>Jeden</title><id>urn:1</id><link href="${server.url('/s1')}"/><updated>2026-10-01T10:00:00Z</updated></entry>
</feed>`,
    });
    server.route('/gone.rss', { status: 404, body: 'not here' });
    server.route('/page.html', {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><html><body><p>no feed</p></body></html>',
    });
    listPath = path.join(tmpdir(), `feeds-golden-${process.pid}.txt`);
    await writeFile(
      listPath,
      [
        '# fixture list',
        `en news ${server.url('/en.rss')} google-news`,
        `sk tech ${server.url('/sk.atom')}`,
        `cs news ${server.url('/gone.rss')}`,
        `cs local ${server.url('/page.html')} poor-excerpts`,
      ].join('\n'),
    );
  });

  afterAll(async () => {
    await server?.close();
  });

  it('lists every feed with its reachability and never opens the database', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    const runtime = createEvalRuntime({
      // The database is unreachable on purpose: a dry run must not query it.
      env: {
        DATABASE_URL_WORKER: 'postgres://nobody:x@127.0.0.1:1/none',
        FETCH_ALLOW_PRIVATE: 'true',
      },
      io,
    });
    await buildCli({ io, openRuntime: () => runtime }).parseAsync([
      'node',
      'cli',
      'ingest-sample',
      '--dry-run',
      '--feeds',
      listPath,
    ]);
    const text = out.join('');
    expect(text).toContain('4 golden feeds');
    expect(text).toMatch(/ok {4}en {2}news .*\/en\.rss {2}rss, 2 items, lang en/);
    expect(text).toMatch(/ok {4}sk {2}tech .*\/sk\.atom {2}atom, 1 items, lang sk/);
    expect(text).toMatch(/FAIL {2}cs {2}news .*\/gone\.rss {2}FEED_HTTP_404 \(HTTP 404\)/);
    expect(text).toMatch(/FAIL {2}cs {2}local .*FEED_NOT_A_FEED/);
    expect(text).toContain('en: 1/1 reachable');
    expect(text).toContain('cs: 0/2 reachable');
    expect(text).toContain('2 feed(s) unreachable or not parseable');
    // The fixture list misses the spec mix: warned, not fatal.
    expect(err.join('')).toContain('warning: en: 1 feeds');
    expect(server.requests.map((r) => r.path).sort()).toEqual(
      expect.arrayContaining(['/en.rss', '/gone.rss', '/page.html', '/sk.atom']),
    );
  });

  it('reports the outcome in list order with bounded concurrency', async () => {
    const feeds = parseFeedList(
      [`en news ${server.url('/en.rss')}`, `cs news ${server.url('/gone.rss')}`].join('\n'),
      { allowPrivate: true },
    );
    const results = await probeFeeds(feeds, {
      userAgent: 'BantooziBot/1.0 (+https://bantoozi.test/bot)',
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      allowPrivate: true,
      concurrency: 1,
    });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(formatProbeReport(results)).toContain('1 feed(s) unreachable');
  });

  it('rejects a malformed feed list with every problem', async () => {
    const bad = path.join(tmpdir(), `feeds-bad-${process.pid}.txt`);
    await writeFile(bad, 'xx news https://example.com/feed\nen news not-a-url\n');
    const runtime = createEvalRuntime({
      env: { DATABASE_URL_WORKER: 'postgres://nobody:x@127.0.0.1:1/none' },
    });
    await expect(
      buildCli({ openRuntime: () => runtime }).parseAsync([
        'node',
        'cli',
        'ingest-sample',
        '--dry-run',
        '--feeds',
        bad,
      ]),
    ).rejects.toMatchObject({
      name: 'EvalCommandError',
      message: expect.stringContaining('line 2'),
    });
  });
});
