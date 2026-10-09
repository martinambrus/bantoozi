import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startControlApi, type ControlApi } from '../src/e2e/control.js';
import { E2E_FEED_KEYS } from '../src/e2e/env.js';
import { startFeeds, type E2eFeed } from '../src/e2e/feeds.js';
import type { HookDb } from '../src/e2e/hooks.js';
import { startFakeTypeSafe, type FakeTypeSafeServer } from '../src/fake-typesafe.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const DEFAULTS = { latencyMs: 5 };
const FEED_URL = 'http://127.0.0.1:4601/feed.xml';

interface Query {
  text: string;
  values: unknown[] | undefined;
}

const queries: Query[] = [];
let answer: (query: Query) => { rows: unknown[] } = () => ({ rows: [] });
const db: HookDb = {
  async query(text, values) {
    const query = { text, values };
    queries.push(query);
    return answer(query);
  },
};

let feeds: Record<(typeof E2E_FEED_KEYS)[number], E2eFeed>;
let fake: FakeTypeSafeServer;
let control: ControlApi;

beforeAll(async () => {
  feeds = await startFeeds({ tech: 0, science: 0, culture: 0 }, { now: () => NOW });
  fake = await startFakeTypeSafe(DEFAULTS);
  control = await startControlApi({ port: 0, feeds, fake, fakeDefaults: DEFAULTS, db });
});

afterAll(async () => {
  await control.close();
  await fake.close();
  await Promise.all(E2E_FEED_KEYS.map((key) => feeds[key].close()));
});

beforeEach(async () => {
  await send('POST', '/reset', { json: {} });
  queries.length = 0;
  answer = () => ({ rows: [] });
});

interface Reply {
  status: number;
  json: unknown;
}

async function send(
  method: string,
  path: string,
  body: { json?: unknown; raw?: string } = {},
): Promise<Reply> {
  const payload = body.raw ?? (body.json === undefined ? undefined : JSON.stringify(body.json));
  const response = await fetch(`${control.url}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { body: payload, headers: { 'content-type': 'application/json' } }),
  });
  return { status: response.status, json: await response.json() };
}

const failure = (code: string, message: string | RegExp) => ({
  error: {
    code,
    message: (typeof message === 'string'
      ? expect.stringContaining(message)
      : expect.stringMatching(message)) as unknown,
  },
});

function fakeProbe(path = '/probe'): Promise<Response> {
  return fetch(`${fake.url}${path}`);
}

function fakeQuestion(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${fake.url}/v1/systemone`, { method: 'POST', body: '{}', headers });
}

describe('the control server', () => {
  it('listens on loopback', () => {
    expect(control.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('answers /ready', async () => {
    expect(await send('GET', '/ready')).toEqual({ status: 200, json: { ready: true } });
  });

  it('answers unknown paths with 404 and wrong methods with 405', async () => {
    expect(await send('GET', '/nope')).toEqual({
      status: 404,
      json: failure('not_found', /no route for \/nope/),
    });
    expect(await send('POST', '/ready', { json: {} })).toMatchObject({ status: 405 });
    expect(await send('GET', '/reset')).toMatchObject({ status: 405 });
    expect(await send('GET', '/sql/articleStates')).toMatchObject({ status: 405 });
  });

  it('rejects a body that is not JSON, not an object, or too large', async () => {
    expect(await send('POST', '/reset', { raw: '{not json' })).toEqual({
      status: 400,
      json: failure('invalid_json', /not valid JSON/),
    });
    expect(await send('POST', '/reset', { json: [] })).toEqual({
      status: 400,
      json: failure('invalid_body', /must be a JSON object/),
    });
    expect(await send('POST', '/reset', { raw: 'null' })).toMatchObject({ status: 400 });
    expect(
      await send('POST', '/reset', { raw: JSON.stringify({ a: 'x'.repeat(70_000) }) }),
    ).toEqual({
      status: 413,
      json: failure('body_too_large', /too large/),
    });
  });

  it('rejects a path that is not valid percent-encoding', async () => {
    expect(await send('POST', '/sql/%E0%A4%A', { json: {} })).toEqual({
      status: 400,
      json: failure('invalid_path', /percent-encoding/),
    });
  });
});

describe('/worker-ready', () => {
  it('is 200 when the worker has a heartbeat and the feed.schedule cron exists', async () => {
    answer = () => ({ rows: [{ heartbeat: true, schedule: true }] });
    expect(await send('GET', '/worker-ready')).toEqual({
      status: 200,
      json: { ready: true, heartbeat: true, schedule: true },
    });
    const [query] = queries;
    expect(query?.text).toContain("key = 'worker.heartbeat'");
    expect(query?.text).toContain("name = 'feed.schedule'");
    expect(query?.text).toContain('pgboss.schedule');
  });

  it.each([
    ['no heartbeat', { heartbeat: false, schedule: true }],
    ['no schedule', { heartbeat: true, schedule: false }],
    ['neither', { heartbeat: false, schedule: false }],
  ])('is 503 with %s', async (_name, row) => {
    answer = () => ({ rows: [row] });
    expect(await send('GET', '/worker-ready')).toEqual({
      status: 503,
      json: { ready: false, ...row },
    });
  });

  it('is 503 when the query returns nothing or fails', async () => {
    expect(await send('GET', '/worker-ready')).toEqual({
      status: 503,
      json: { ready: false, heartbeat: false, schedule: false },
    });
    answer = () => {
      throw new Error('relation "pgboss.schedule" does not exist');
    };
    expect(await send('GET', '/worker-ready')).toEqual({
      status: 503,
      json: { ready: false, error: 'Error: relation "pgboss.schedule" does not exist' },
    });
  });
});

describe('feeds', () => {
  it('lists the three feeds with their URLs and items', async () => {
    const { status, json } = await send('GET', '/feeds');
    expect(status).toBe(200);
    const body = json as {
      feeds: Record<
        string,
        { key: string; title: string; origin: string; url: string; items: unknown[] }
      >;
    };
    expect(Object.keys(body.feeds)).toEqual([...E2E_FEED_KEYS]);
    for (const key of E2E_FEED_KEYS) {
      expect(body.feeds[key]).toMatchObject({
        key,
        title: feeds[key].title,
        origin: feeds[key].origin,
        url: feeds[key].url,
      });
      expect(body.feeds[key]?.items).toHaveLength(3);
    }
  });

  it('appends an item that the feed then serves', async () => {
    const { status, json } = await send('POST', '/feeds/science/items', {
      json: { title: 'Lunar rover finds ice', image: true },
    });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      slug: 'science-extra-1',
      title: 'Lunar rover finds ice',
      topic: 'lunar',
      url: `${feeds.science.origin}/articles/science-extra-1.html`,
      imageUrl: `${feeds.science.origin}/img/science-extra-1.png`,
    });
    const listed = (await send('GET', '/feeds')).json as {
      feeds: { science: { items: Array<{ slug: string }> } };
    };
    expect(listed.feeds.science.items.map((item) => item.slug)).toContain('science-extra-1');
    expect(await (await fetch(feeds.science.url)).text()).toContain('Lunar rover finds ice');
    expect((await fetch(`${feeds.science.origin}/img/science-extra-1.png`)).status).toBe(200);
  });

  it.each([
    ['no title', {}, 'title is required'],
    ['a numeric title', { title: 5 }, 'title must be a string'],
    ['an unknown field', { title: 'x', colour: 'red' }, 'unknown field: colour'],
    ['a non-boolean image', { title: 'x', image: 'yes' }, 'image must be a boolean'],
    ['a bad slug', { title: 'x', slug: 'No Good' }, 'slug must match'],
    ['a bad date', { title: 'x', publishedAt: 'soon' }, 'ISO 8601'],
    ['a long title', { title: 'x'.repeat(201) }, 'title must be 1-200'],
  ])('rejects an item with %s', async (_name, json, message) => {
    expect(await send('POST', '/feeds/tech/items', { json })).toEqual({
      status: 400,
      json: failure('invalid_body', message),
    });
    expect(feeds.tech.items()).toHaveLength(3);
  });

  it('answers 404 for a feed that does not exist', async () => {
    const missing = failure('unknown_feed', /one of tech, science, culture/);
    expect(await send('POST', '/feeds/news/items', { json: { title: 'x' } })).toEqual({
      status: 404,
      json: missing,
    });
    expect(await send('POST', '/feeds/news/routes', { json: { path: '/x', status: 500 } })).toEqual(
      {
        status: 404,
        json: missing,
      },
    );
    expect(await send('GET', '/feeds/news/requests')).toEqual({ status: 404, json: missing });
    expect(await send('GET', '/feeds/__proto__/requests')).toMatchObject({ status: 404 });
  });

  it('scripts and clears a failure on a path', async () => {
    expect(
      await send('POST', '/feeds/tech/routes', { json: { path: '/feed.xml', status: 503 } }),
    ).toEqual({ status: 200, json: { path: '/feed.xml', status: 503 } });
    expect((await fetch(feeds.tech.url)).status).toBe(503);
    expect(
      await send('POST', '/feeds/tech/routes', { json: { path: '/feed.xml', status: null } }),
    ).toEqual({ status: 200, json: { path: '/feed.xml', status: null } });
    expect((await fetch(feeds.tech.url)).status).toBe(200);
  });

  it.each([
    ['no path', { status: 500 }, 'path and status are required'],
    ['no status', { path: '/x' }, 'path and status are required'],
    ['a text status', { path: '/x', status: 'bad' }, 'status must be a number or null'],
    [
      'a status below 400',
      { path: '/x', status: 200 },
      'status must be an integer from 400 to 599',
    ],
    ['a path without a slash', { path: 'x', status: 500 }, 'path must start with /'],
    ['an unknown field', { path: '/x', status: 500, delay: 1 }, 'unknown field: delay'],
  ])('rejects a route with %s', async (_name, json, message) => {
    expect(await send('POST', '/feeds/tech/routes', { json })).toEqual({
      status: 400,
      json: failure('invalid_body', message),
    });
  });

  it('reports the requests a feed received', async () => {
    await fetch(feeds.culture.url, { headers: { 'user-agent': 'probe/2' } });
    const { status, json } = await send('GET', '/feeds/culture/requests');
    expect(status).toBe(200);
    expect(json).toMatchObject({
      requests: [{ method: 'GET', path: '/feed.xml', userAgent: 'probe/2', referer: null }],
    });
  });
});

describe('the fake TypeSafe server', () => {
  it('counts the requests since the last reset and nothing before', async () => {
    expect(await send('GET', '/fake')).toEqual({ status: 200, json: { count: 0 } });
    await fakeProbe();
    await fakeProbe('/other');
    expect(await send('GET', '/fake')).toEqual({ status: 200, json: { count: 2 } });
    const total = fake.requestCount();
    expect(total).toBeGreaterThanOrEqual(2);

    expect(await send('POST', '/reset', { json: {} })).toEqual({
      status: 200,
      json: { reset: true },
    });
    expect(await send('GET', '/fake')).toEqual({ status: 200, json: { count: 0 } });
    expect(fake.requestCount()).toBe(total);
    await fakeProbe();
    expect(await send('GET', '/fake')).toEqual({ status: 200, json: { count: 1 } });
  });

  it('shows the options and applies a patch', async () => {
    expect(await send('POST', '/fake/options')).toEqual({
      status: 200,
      json: { options: { latencyMs: 5, failRate: 0, failStatus: null, apiKeyRequired: false } },
    });
    expect(await send('POST', '/fake/options', { json: { latencyMs: 0 } })).toMatchObject({
      json: { options: { latencyMs: 0 } },
    });
  });

  it('requires an API key until it is lifted', async () => {
    expect(await send('POST', '/fake/options', { json: { apiKey: 'secret' } })).toMatchObject({
      json: { options: { apiKeyRequired: true } },
    });
    expect((await fakeQuestion()).status).toBe(401);
    expect((await fakeQuestion({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await fakeQuestion({ authorization: 'Bearer secret' })).status).not.toBe(401);

    expect(await send('POST', '/fake/options', { json: { apiKey: null } })).toMatchObject({
      json: { options: { apiKeyRequired: false } },
    });
    expect((await fakeQuestion()).status).not.toBe(401);
    await send('POST', '/fake/options', { json: { apiKey: 'again' } });
    await send('POST', '/fake/options', { json: { apiKey: '' } });
    expect((await fakeQuestion()).status).not.toBe(401);
  });

  it('fails every request with the given status when failRate is 1', async () => {
    expect(
      await send('POST', '/fake/options', { json: { failRate: 1, failStatus: 502 } }),
    ).toMatchObject({ json: { options: { failRate: 1, failStatus: 502 } } });
    expect((await fakeQuestion()).status).toBe(502);
  });

  it.each([
    ['a negative latency', { latencyMs: -1 }, 'latencyMs must be 0-60000'],
    ['an endless latency', { latencyMs: 60_001 }, 'latencyMs must be 0-60000'],
    ['a text latency', { latencyMs: 'slow' }, 'latencyMs must be a number'],
    ['a success failStatus', { failStatus: 200 }, 'failStatus must be an integer from 400 to 599'],
    ['a fractional failStatus', { failStatus: 500.5 }, 'failStatus must be an integer'],
    ['a failRate above 1', { failRate: 1.5 }, 'failRate must be in'],
    ['a numeric apiKey', { apiKey: 5 }, 'apiKey must be a string or null'],
    ['an unknown option', { statusOverride: 1 }, 'unknown field: statusOverride'],
  ])('rejects %s and changes nothing', async (_name, json, message) => {
    expect(await send('POST', '/fake/options', { json })).toEqual({
      status: 400,
      json: failure('invalid_body', message),
    });
    expect(await send('POST', '/fake/options')).toMatchObject({
      json: { options: { latencyMs: 5, failRate: 0, failStatus: null, apiKeyRequired: false } },
    });
  });
});

describe('POST /reset', () => {
  it('restores feeds, fake options and the fake count', async () => {
    feeds.tech.append({ title: 'Temporary item' });
    feeds.science.script('/feed.xml', 500);
    await fetch(feeds.culture.url);
    await send('POST', '/fake/options', {
      json: { latencyMs: 0, failRate: 1, failStatus: 500, apiKey: 'x' },
    });
    await fakeProbe();

    expect(await send('POST', '/reset', { json: {} })).toEqual({
      status: 200,
      json: { reset: true },
    });

    expect(feeds.tech.items()).toHaveLength(3);
    expect((await fetch(feeds.science.url)).status).toBe(200);
    expect(feeds.culture.requests()).toEqual([]);
    expect(await send('GET', '/fake')).toEqual({ status: 200, json: { count: 0 } });
    expect(await send('POST', '/fake/options')).toMatchObject({
      json: { options: { latencyMs: 5, failRate: 0, failStatus: null, apiKeyRequired: false } },
    });
    expect((await fakeQuestion()).status).not.toBe(401);
    expect((await fakeQuestion()).status).not.toBe(500);
  });

  it('takes no arguments', async () => {
    expect(await send('POST', '/reset', { json: { feeds: ['tech'] } })).toEqual({
      status: 400,
      json: failure('invalid_body', 'unknown field: feeds'),
    });
  });
});

describe('POST /sql/:hook', () => {
  it('runs articleStates with the feed URL as a bound parameter', async () => {
    const rows = [
      { id: '7', title: 'Quantum', pipelineState: 'extracted', contentRevision: '1' },
      { id: '8', title: 'Robots', pipelineState: 'ingested', contentRevision: '1' },
    ];
    answer = () => ({ rows });
    expect(await send('POST', '/sql/articleStates', { json: { feedUrl: FEED_URL } })).toEqual({
      status: 200,
      json: rows,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.values).toEqual([FEED_URL]);
    expect(queries[0]?.text).toContain('FROM feeds f');
    expect(queries[0]?.text).toContain('f.url = $1 OR f.fetch_url = $1');
    expect(queries[0]?.text).not.toContain(FEED_URL);
  });

  it.each([
    ['no body', undefined, 'feedUrl must be a URL'],
    ['an empty object', {}, 'feedUrl must be a URL'],
    ['an array', [], 'parameters must be a JSON object'],
    ['a numeric feedUrl', { feedUrl: 5 }, 'feedUrl must be a URL'],
    ['an empty feedUrl', { feedUrl: '' }, 'feedUrl must be a URL'],
    ['a very long feedUrl', { feedUrl: `http://a/${'x'.repeat(2049)}` }, 'feedUrl must be a URL'],
    ['a non-URL feedUrl', { feedUrl: 'not a url' }, 'feedUrl must be an http(s) URL'],
    ['an ftp feedUrl', { feedUrl: 'ftp://x/y' }, 'feedUrl must be an http(s) URL'],
    ['an extra parameter', { feedUrl: FEED_URL, limit: 1 }, 'unknown parameter: limit'],
  ])('rejects %s without querying', async (_name, json, message) => {
    expect(await send('POST', '/sql/articleStates', json === undefined ? {} : { json })).toEqual({
      status: 400,
      json: failure('invalid_params', message),
    });
    expect(queries).toEqual([]);
  });

  it.each([
    'nothing',
    '__proto__',
    'constructor',
    'toString',
    'articleStates%2F..',
    'ARTICLESTATES',
  ])('answers 404 for the hook %s', async (name) => {
    expect(await send('POST', `/sql/${name}`, { json: {} })).toEqual({
      status: 404,
      json: failure('unknown_hook', /unknown SQL hook/),
    });
    expect(queries).toEqual([]);
  });

  it('answers 500 when the query fails', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      answer = () => {
        throw new Error('connection terminated');
      };
      expect(await send('POST', '/sql/articleStates', { json: { feedUrl: FEED_URL } })).toEqual({
        status: 500,
        json: failure('internal', 'connection terminated'),
      });
      expect(write).toHaveBeenCalledWith(
        expect.stringContaining('[e2e-control] POST /sql/articleStates'),
      );
    } finally {
      write.mockRestore();
    }
  });
});
