import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureServer, type FixtureServer } from '../src/index.js';

let root: string;
let server: FixtureServer;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bantoozi-fixtures-'));
  await mkdir(path.join(root, 'feeds'));
  await writeFile(path.join(root, 'feeds', 'rss.xml'), '<rss version="2.0"><channel/></rss>');
  await writeFile(path.join(root, 'page.html'), '<html><body>hi</body></html>');
  server = await startFixtureServer({ root });
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('fixture HTTP server', () => {
  it('serves files with a content type on a random loopback port', async () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(server.url('/feeds/rss.xml'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(await res.text()).toContain('<rss');
    const other = await startFixtureServer();
    try {
      expect(other.port).not.toBe(server.port);
    } finally {
      await other.close();
    }
  });

  it('serves scripted redirects and statuses', async () => {
    server.redirect('/old', '/feeds/rss.xml', 301);
    const redirected = await fetch(server.url('/old'), { redirect: 'manual' });
    expect(redirected.status).toBe(301);
    expect(redirected.headers.get('location')).toBe('/feeds/rss.xml');
    const followed = await fetch(server.url('/old'));
    expect(followed.status).toBe(200);
    server.route('/limited', { status: 429, headers: { 'retry-after': '120' }, body: 'slow down' });
    const limited = await fetch(server.url('/limited'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('120');
    expect((await fetch(server.url('/nope'))).status).toBe(404);
  });

  it('scripts sequences, custom headers for files and delays, and records requests', async () => {
    server.route('/flaky', (_req, hit) =>
      hit === 1 ? { status: 503 } : { status: 200, body: 'ok' },
    );
    expect((await fetch(server.url('/flaky'))).status).toBe(503);
    expect((await fetch(server.url('/flaky'))).status).toBe(200);
    server.route('/cp1250', {
      file: 'page.html',
      headers: { 'content-type': 'text/html; charset=windows-1250' },
    });
    const page = await fetch(server.url('/cp1250'));
    expect(page.headers.get('content-type')).toBe('text/html; charset=windows-1250');
    server.route('/slow', { delayMs: 150, body: 'late' });
    const started = Date.now();
    await (await fetch(server.url('/slow'))).text();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    await fetch(server.url('/feeds/rss.xml?x=1'), {
      headers: { 'user-agent': 'BantooziBot/test' },
    });
    const last = server.requests.at(-1);
    expect(last).toMatchObject({ method: 'GET', path: '/feeds/rss.xml?x=1' });
    expect(last?.headers['user-agent']).toBe('BantooziBot/test');
  });

  it('never serves files outside its root', async () => {
    const res = await fetch(`${server.origin}/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(404);
  });
});
