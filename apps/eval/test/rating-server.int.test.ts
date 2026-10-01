import {
  createDataset,
  createRater,
  createRaterSession,
  findRaterByToken,
  freezeDataset,
  getDataset,
  headDataset,
  listDatasets,
  loadSample,
  raterProgress,
  reissueRaterToken,
  revokeRater,
  setRaterFeeds,
  type RaterRow,
} from '@bantoozi/db';
import { dropCreatedTestDatabases } from '@bantoozi/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { parseHTML } from 'linkedom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRatingServer, SESSION_COOKIE } from '../src/rating-server/server.js';
import { csrfToken, hashSecret, issueToken } from '../src/rating-server/tokens.js';
import {
  addArticles,
  addGoldenFeeds,
  addRater,
  createGoldenDataset,
  setupRatingDb,
  type GoldenFeedFixture,
  type RatingDb,
} from './rating-server-support.js';

/**
 * M3a-T3 (spec 10 §2.2, §2.4): the rating server end to end over a real database: link-token
 * exchange and redaction, cookie sessions, revocation and reissue, CSRF/origin checks, security
 * headers, rater-scoped access, the card and feed steps, assignments, the blind rating page, rating
 * persistence and change, skip and the keyboard hooks.
 */

const PUBLIC_URL = 'https://rate.example.test';
const ORIGIN = PUBLIC_URL;
const now = () => new Date();

let rdb: RatingDb;
let app: FastifyInstance;
let feeds: GoldenFeedFixture[];
const logs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  rdb = await setupRatingDb('eval-rating');
  feeds = [...(await addGoldenFeeds(rdb, 'en', 6)), ...(await addGoldenFeeds(rdb, 'sk', 6))];
  const ids: string[] = [];
  const seen = new Date(Date.now() - 86_400_000);
  for (const feed of feeds) ids.push(...(await addArticles(rdb, feed.id, feed.lang, 4, seen)));
  // Excerpts longer than the page shows (spec 10 §2.2: at most 600 characters).
  await rdb.owner.query(
    "UPDATE articles SET excerpt = title || ': ' || repeat('Long excerpt words. ', 100) WHERE id = ANY($1::bigint[])",
    [ids],
  );
  await createGoldenDataset(rdb, ids);
  app = await buildRatingServer({
    db: rdb.db,
    publicUrl: PUBLIC_URL,
    now,
    assignmentTarget: 20,
    logger: {
      info: (obj) => logs.push(obj),
      warn: (obj) => logs.push(obj),
      error: (obj) => logs.push(obj),
    },
  });
});

afterAll(async () => {
  await app?.close();
  await rdb?.close();
  await dropCreatedTestDatabases();
});

/** A cookie-keeping client, like a browser on one device. */
class Browser {
  cookie: string | null = null;

  async get(url: string, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { ...this.headers(), ...headers },
    });
    this.take(res);
    return res;
  }

  async post(
    url: string,
    form: Record<string, string | string[]> = {},
    options: { csrf?: boolean; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
    }
    if (options.csrf !== false && this.cookie !== null)
      body.append('_csrf', csrfToken(this.cookie));
    const res = await app.inject({
      method: 'POST',
      url,
      payload: body.toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: ORIGIN,
        ...this.headers(),
        ...options.headers,
      },
    });
    this.take(res);
    return res;
  }

  private headers(): Record<string, string> {
    return this.cookie === null ? {} : { cookie: `${SESSION_COOKIE}=${this.cookie}` };
  }

  private take(res: LightMyRequestResponse): void {
    const header = res.headers['set-cookie'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined) return;
    const match = new RegExp(`^${SESSION_COOKIE}=([^;]*)`, 'u').exec(value);
    if (match !== null) this.cookie = match[1] === '' ? null : (match[1] ?? null);
  }
}

async function signIn(token: string): Promise<Browser> {
  const browser = new Browser();
  const res = await browser.get(`/r?t=${token}`);
  expect(res.statusCode).toBe(303);
  return browser;
}

async function addCards(browser: Browser, count: number, strength = 'like', prefix = 'Topic') {
  for (let i = 0; i < count; i += 1) {
    const res = await browser.post('/r/cards', {
      interest: `${prefix} ${i}: new battery chemistry for electric vehicles and grid storage`,
      strength,
    });
    expect(res.statusCode).toBe(303);
  }
}

async function ratingsOf(raterId: string) {
  const result = await rdb.owner.query<{
    article_id: string;
    rating: number;
    reason: string | null;
  }>('SELECT article_id::text, rating, reason FROM eval.ratings WHERE rater_id = $1 ORDER BY 1', [
    raterId,
  ]);
  return result.rows;
}

async function assignmentRow(raterId: string, position: number) {
  const result = await rdb.owner.query<{
    article_id: string;
    status: string;
    skip_reason: string | null;
  }>(
    `SELECT article_id::text, status, skip_reason FROM eval.assignments
      WHERE rater_id = $1 AND position = $2`,
    [raterId, position],
  );
  return result.rows[0];
}

/** A rater past the card and feed steps, with assignments built. */
async function readyRater(
  name: string,
): Promise<{ rater: RaterRow; token: string; browser: Browser }> {
  const { rater, token } = await addRater(rdb, { name, langs: ['en', 'sk'], now: now() });
  const browser = await signIn(token);
  await addCards(browser, 5, 'like', name);
  expect((await browser.post('/r/feeds', { feed: feeds.map((f) => f.id) })).headers.location).toBe(
    '/r',
  );
  const start = await browser.post('/r/start');
  expect(start.statusCode).toBe(303);
  return { rater, token, browser };
}

describe('link token exchange and sessions', () => {
  it('exchanges the URL token for an HttpOnly SameSite cookie and redirects to a token-free URL', async () => {
    const { rater, token } = await addRater(rdb, { langs: ['en'], now: now() });
    const res = await app.inject({ method: 'GET', url: `/r?t=${token}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/r');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; `, 'u'));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain(token);
    const value = /=([^;]+)/u.exec(cookie)?.[1] ?? '';
    const sessions = await rdb.owner.query<{ session_hash: string; expires_at: Date }>(
      'SELECT session_hash, expires_at FROM eval.rater_sessions WHERE rater_id = $1',
      [rater.id],
    );
    expect(sessions.rows.map((r) => r.session_hash)).toEqual([hashSecret(value)]);
    expect(sessions.rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(
      rater.tokenExpiresAt.getTime(),
    );
    // The facets link exchanges the same way.
    const facets = await app.inject({ method: 'GET', url: `/facets?t=${token}` });
    expect(facets.statusCode).toBe(303);
    expect(facets.headers.location).toBe('/facets');
  });

  it('a session never outlives its token', async () => {
    const { rater, token } = await addRater(rdb, { langs: ['en'], now: now(), days: 2 });
    await signIn(token);
    const sessions = await rdb.owner.query<{ expires_at: Date }>(
      'SELECT expires_at FROM eval.rater_sessions WHERE rater_id = $1',
      [rater.id],
    );
    expect(sessions.rows[0]!.expires_at.getTime()).toBe(rater.tokenExpiresAt.getTime());
  });

  it('refuses expired, revoked, unknown and malformed tokens', async () => {
    const issued = issueToken(new Date(Date.now() - 40 * 86_400_000), 30);
    await createRater(rdb.db, {
      name: 'Expired',
      participantKey: crypto.randomUUID(),
      contextName: null,
      langs: ['en'],
      tokenHash: issued.tokenHash,
      tokenExpiresAt: issued.expiresAt,
    });
    const revoked = await addRater(rdb, { langs: ['en'], now: now() });
    await revokeRater(rdb.db, revoked.rater.id, now());
    for (const token of [issued.token, revoked.token, 'A'.repeat(43), 'short', '']) {
      const res = await app.inject({ method: 'GET', url: `/r?t=${token}` });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toContain('Link expired');
    }
  });

  it('requires a session for every page', async () => {
    for (const url of ['/r', '/r/cards', '/r/feeds', '/r/a/0', '/facets', '/facets/0']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    const forged = await app.inject({
      method: 'GET',
      url: '/r',
      headers: { cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` },
    });
    expect(forged.statusCode).toBe(401);
    expect(String(forged.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('revocation ends existing sessions at once; a reissued token works with the ratings intact', async () => {
    const { rater, browser } = await readyRater('reissue');
    const first = await browser.get('/r');
    const position = Number(/\/r\/a\/(\d+)/u.exec(String(first.headers.location))?.[1]);
    await browser.post(`/r/a/${position}/rate`, { rating: 'like' });
    const before = await ratingsOf(rater.id);
    expect(before).toHaveLength(1);

    await revokeRater(rdb.db, rater.id, now());
    expect((await browser.get('/r')).statusCode).toBe(401);
    expect(browser.cookie).toBeNull();

    // A second device that kept an old session cookie is cut off by the reissue too.
    const issued = issueToken(now(), 30);
    await rdb.owner.query(
      `INSERT INTO eval.rater_sessions (session_hash, rater_id, expires_at)
       VALUES ($1, $2, now() + interval '1 day')`,
      [hashSecret('o'.repeat(43)), rater.id],
    );
    await reissueRaterToken(rdb.db, rater.id, {
      tokenHash: issued.tokenHash,
      tokenExpiresAt: issued.expiresAt,
    });
    const stale = await app.inject({
      method: 'GET',
      url: '/r',
      headers: { cookie: `${SESSION_COOKIE}=${'o'.repeat(43)}` },
    });
    expect(stale.statusCode).toBe(401);

    const again = await signIn(issued.token);
    const page = await again.get(`/r/a/${position}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('You liked this.');
    expect(await ratingsOf(rater.id)).toEqual(before);
  });

  it('rate-limits token exchange per client address', async () => {
    const limited = await buildRatingServer({
      db: rdb.db,
      publicUrl: PUBLIC_URL,
      now,
      exchangeLimit: { max: 2, windowMs: 60_000 },
    });
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push(
        (await limited.inject({ method: 'GET', url: `/r?t=${'B'.repeat(43)}` })).statusCode,
      );
    }
    // Behind the tunnel every request comes from loopback; the limit follows the forwarded client,
    // and an address a client prepends to X-Forwarded-For does not move it to another bucket.
    const viaTunnel = async (forwardedFor: string) =>
      (
        await limited.inject({
          method: 'GET',
          url: `/r?t=${'B'.repeat(43)}`,
          remoteAddress: '127.0.0.1',
          headers: { 'x-forwarded-for': forwardedFor },
        })
      ).statusCode;
    const tunnelled: number[] = [];
    for (let i = 0; i < 3; i += 1) tunnelled.push(await viaTunnel('203.0.113.7'));
    tunnelled.push(await viaTunnel('198.51.100.1, 203.0.113.7'));
    tunnelled.push(await viaTunnel('198.51.100.9'));
    await limited.close();
    expect(codes).toEqual([401, 401, 429]);
    expect(tunnelled).toEqual([401, 401, 429, 429, 401]);
  });

  it('never logs the link token', async () => {
    const { token } = await addRater(rdb, { langs: ['en'], now: now() });
    logs.length = 0;
    await app.inject({ method: 'GET', url: `/r?t=${token}` });
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(logs.some((l) => l['url'] === '/r?t=[redacted]')).toBe(true);
  });
});

describe('security headers, CSRF and origin checks', () => {
  it('sets a strict CSP, no-referrer and frame-ancestors none on pages and assets', async () => {
    for (const url of ['/r', '/static/app.js', '/static/app.css', '/nowhere']) {
      const res = await app.inject({ method: 'GET', url });
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
    const js = await app.inject({ method: 'GET', url: '/static/app.js' });
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.body).toContain("addEventListener('keydown'");
  });

  it('rejects POSTs without the CSRF token or from another origin', async () => {
    const { rater, token } = await addRater(rdb, { langs: ['en'], now: now() });
    const browser = await signIn(token);
    const card = { interest: 'Local politics in Bratislava and its suburbs', strength: 'like' };
    expect((await browser.post('/r/cards', card, { csrf: false })).statusCode).toBe(403);
    expect(
      (
        await browser.post(
          '/r/cards',
          { ...card, _csrf: csrfToken('another-session') },
          { csrf: false },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await browser.post('/r/cards', card, { headers: { origin: 'https://evil.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await browser.post('/r/cards', card, { headers: { 'sec-fetch-site': 'cross-site' } }))
        .statusCode,
    ).toBe(403);
    const cards = await rdb.owner.query('SELECT 1 FROM eval.rater_cards WHERE rater_id = $1', [
      rater.id,
    ]);
    expect(cards.rowCount).toBe(0);
    expect((await browser.post('/r/cards', card)).statusCode).toBe(303);
  });
});

describe('card-writing and feed steps', () => {
  it('no rating before 5 cards and 10 feeds', async () => {
    const { rater, token } = await addRater(rdb, { langs: ['en', 'sk'], now: now() });
    const browser = await signIn(token);
    expect((await browser.get('/r')).headers.location).toBe('/r/cards');
    await addCards(browser, 4);
    expect((await browser.get('/r')).headers.location).toBe('/r/cards');
    expect((await browser.post('/r/start')).statusCode).toBe(409);
    expect((await browser.post('/r/a/0/rate', { rating: 'like' })).statusCode).toBe(409);
    expect((await browser.get('/r/a/0')).statusCode).toBe(409);
    await addCards(browser, 1, 'love', 'Fifth');
    expect((await browser.get('/r')).headers.location).toBe('/r/feeds');
    expect((await browser.post('/r/start')).statusCode).toBe(409);

    const nine = await browser.post('/r/feeds', { feed: feeds.slice(0, 9).map((f) => f.id) });
    expect(nine.statusCode).toBe(400);
    expect(nine.body).toContain('pick at least 10 feeds');
    expect((await browser.post('/r/start')).statusCode).toBe(409);
    const assignments = await rdb.owner.query(
      'SELECT 1 FROM eval.assignments WHERE rater_id = $1',
      [rater.id],
    );
    expect(assignments.rowCount).toBe(0);
    expect(await ratingsOf(rater.id)).toEqual([]);

    // Ten golden feeds (a non-golden feed id is ignored).
    const other = await rdb.owner.query<{ id: string }>(
      "INSERT INTO feeds (url, fetch_url) VALUES ('https://x.test/f', 'https://x.test/f') RETURNING id::text AS id",
    );
    const ten = await browser.post('/r/feeds', {
      feed: [...feeds.slice(0, 10).map((f) => f.id), other.rows[0]!.id],
    });
    expect(ten.headers.location).toBe('/r');
    const stored = await rdb.owner.query<{ feed_id: string }>(
      'SELECT feed_id::text FROM eval.rater_feeds WHERE rater_id = $1',
      [rater.id],
    );
    expect(stored.rowCount).toBe(10);
    const start = await browser.get('/r');
    expect(start.statusCode).toBe(200);
    expect(start.body).toContain('Start rating');
  });

  it('stores cards as shared interest cards with strength, examples and language', async () => {
    const { rater, token } = await addRater(rdb, { langs: ['sk', 'en'], now: now() });
    const browser = await signIn(token);
    const res = await browser.post('/r/cards', {
      title: 'Električky',
      interest: 'Nové električkové trate a verejná doprava v Bratislave a okolí',
      notFor: 'Dopravné nehody',
      strength: 'must',
      examplesYes: 'Mesto schválilo novú trať\n\nPetržalka dostane električku',
      examplesNo: 'Nehoda na Mlynských nivách',
      lang: 'auto',
    });
    expect(res.statusCode).toBe(303);
    const neverCard = await browser.post('/r/cards', {
      interest: 'Celebrity gossip and royal family news',
      strength: 'never',
      lang: 'en',
    });
    expect(neverCard.statusCode).toBe(303);
    const rows = await rdb.owner.query<{
      strength: string;
      title: string;
      body: Record<string, unknown>;
      lang: string;
      visibility: string;
      origin: string;
    }>(
      `SELECT rc.strength, c.title, c.body, c.lang, c.visibility, c.origin
         FROM eval.rater_cards rc JOIN interest_cards c ON c.id = rc.card_id
        WHERE rc.rater_id = $1 ORDER BY c.id`,
      [rater.id],
    );
    expect(rows.rows).toEqual([
      {
        strength: 'must',
        title: 'Električky',
        body: {
          interest: 'Nové električkové trate a verejná doprava v Bratislave a okolí',
          not_for: 'Dopravné nehody',
          interest_en: null,
          not_for_en: null,
          examples_yes: ['Mesto schválilo novú trať', 'Petržalka dostane električku'],
          examples_no: ['Nehoda na Mlynských nivách'],
        },
        lang: 'sk',
        visibility: 'shared',
        origin: 'user',
      },
      expect.objectContaining({
        strength: 'never',
        lang: 'en',
        title: 'Celebrity gossip and royal family news',
      }),
    ]);
    const page = await browser.get('/r/cards');
    expect(page.body).toContain('Električky');
    expect(page.body).toContain('Never show me this');
  });

  it('enforces the card limits of spec 05 §5.1 and spec 10 §2.2', async () => {
    const { token } = await addRater(rdb, { langs: ['en'], now: now() });
    const browser = await signIn(token);
    const tooShort = await browser.post('/r/cards', { interest: 'ab', strength: 'like' });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.body).toContain('role="alert"');
    const tooManyExamples = await browser.post('/r/cards', {
      interest: 'Space exploration and rocket launches',
      strength: 'like',
      examplesYes: 'a\nb\nc\nd\ne\nf',
    });
    expect(tooManyExamples.statusCode).toBe(400);
    const longExample = await browser.post('/r/cards', {
      interest: 'Space exploration and rocket launches',
      strength: 'like',
      examplesYes: 'x'.repeat(201),
    });
    expect(longExample.statusCode).toBe(400);
    await addCards(browser, 3, 'never', 'Never');
    const fourthNever = await browser.post('/r/cards', {
      interest: 'Horoscopes and astrology columns',
      strength: 'never',
    });
    expect(fourthNever.statusCode).toBe(409);
    await addCards(browser, 10, 'like', 'Many');
    const eleventh = await browser.post('/r/cards', {
      interest: 'One interest too many for the limit',
      strength: 'love',
    });
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.body).toContain('At most 10 interest cards.');
  });
});

describe('rating', () => {
  let a: { rater: RaterRow; token: string; browser: Browser };

  beforeAll(async () => {
    a = await readyRater('alice');
  });

  it('builds the assignments on start and locks cards and feeds', async () => {
    const rows = await rdb.owner.query<{ n: number; langs: string[] }>(
      `SELECT count(*)::int AS n, array_agg(DISTINCT ar.lang) AS langs
         FROM eval.assignments a JOIN articles ar ON ar.id = a.article_id WHERE a.rater_id = $1`,
      [a.rater.id],
    );
    expect(rows.rows[0]).toEqual({ n: 20, langs: ['en', 'sk'] });
    expect(
      (await a.browser.post('/r/cards', { interest: 'Late card text here', strength: 'like' }))
        .statusCode,
    ).toBe(409);
    expect((await a.browser.post('/r/feeds', { feed: feeds.map((f) => f.id) })).statusCode).toBe(
      409,
    );
    expect((await a.browser.get('/r/cards')).body).toContain('Your cards are final');
    // Deleting a card is refused under the same lock and state check.
    const card = await rdb.owner.query<{ card_id: string }>(
      'SELECT card_id::text FROM eval.rater_cards WHERE rater_id = $1 LIMIT 1',
      [a.rater.id],
    );
    const del = await a.browser.post(`/r/cards/${card.rows[0]!.card_id}/delete`);
    expect(del.statusCode).toBe(409);
    expect(del.body).toContain('Cards are final');
    const left = await rdb.owner.query('SELECT 1 FROM eval.rater_cards WHERE rater_id = $1', [
      a.rater.id,
    ]);
    expect(left.rowCount).toBe(5);
  });

  it('shows a blind page: feed, title, excerpt (≤ 600 characters) and open original, no model fields', async () => {
    // Model output for every assigned article exists in the database.
    const run = await rdb.owner.query<{ id: string }>(
      `INSERT INTO eval.runs (experiment, dataset_version, config, git_sha)
       VALUES ('E1', 'golden-v1', '{}'::jsonb, 'abc') RETURNING id::text AS id`,
    );
    await rdb.owner.query(
      `INSERT INTO eval.run_answers (run_id, article_id, card_id, question_key, answer)
       SELECT $1, article_id, NULL, 'score.r' || rater_id,
              '{"score": 0.8731, "lane": "for_you", "tier": 4}'::jsonb
         FROM eval.assignments WHERE rater_id = $2`,
      [run.rows[0]!.id, a.rater.id],
    );
    for (const position of [0, 1, 2, 19]) {
      const res = await a.browser.get(`/r/a/${position}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('0.8731');
      expect(res.body).not.toMatch(/score|lane|tier|for_you|for you|probabilit|maybe/iu);
      const { document } = parseHTML(res.body);
      expect(document.querySelector('.feed')?.textContent).toMatch(/feed \d/u);
      expect(document.querySelector('h1')?.textContent).toMatch(/story/u);
      const excerpt = document.querySelector('.excerpt')?.textContent ?? '';
      expect([...excerpt].length).toBeLessThanOrEqual(600);
      expect(excerpt.endsWith('…')).toBe(true);
      const open = document.querySelector('#open');
      expect(open?.getAttribute('href')).toMatch(/^https:\/\/news\.example\.test\//u);
      expect(open?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(document.querySelector('#progress')?.textContent).toContain('of 20');
    }
  });

  it('has the keyboard hooks of spec 10 §2.2 and the static script', async () => {
    const res = await a.browser.get('/r/a/1');
    const { document } = parseHTML(res.body);
    const keys = [...document.querySelectorAll('[data-key]')].map((e) =>
      e.getAttribute('data-key'),
    );
    expect(keys).toEqual(
      expect.arrayContaining(['+', '-', '1', '2', '3', '4', '5', '6', 's', 'j', 'k', 'o']),
    );
    expect(document.querySelector('script')?.getAttribute('src')).toBe('/static/app.js');
  });

  it('persists every click, lets a rating change, and keeps skips distinct', async () => {
    const id = a.rater.id;
    const like = await a.browser.post('/r/a/0/rate', { rating: 'like' });
    expect(like.headers.location).toBe('/r/a/1');
    const article0 = (await assignmentRow(id, 0))!;
    expect(article0.status).toBe('rated');
    expect(await ratingsOf(id)).toEqual([
      { article_id: article0.article_id, rating: 1, reason: null },
    ]);

    // Change to a dislike: saved at once, the reason bar opens on the same article.
    const dislike = await a.browser.post('/r/a/0/rate', { rating: 'dislike' });
    expect(dislike.headers.location).toBe('/r/a/0?why=1');
    expect(await ratingsOf(id)).toEqual([
      { article_id: article0.article_id, rating: -1, reason: null },
    ]);
    const reasonBar = await a.browser.get('/r/a/0?why=1');
    expect(reasonBar.body).toContain('Saved. Why not?');
    const reason = await a.browser.post('/r/a/0/rate', { rating: 'dislike', reason: 'clickbait' });
    expect(reason.headers.location).toBe('/r/a/1');
    expect(await ratingsOf(id)).toEqual([
      { article_id: article0.article_id, rating: -1, reason: 'clickbait' },
    ]);
    // Back to a like: the reason goes with the dislike.
    await a.browser.post('/r/a/0/rate', { rating: 'like' });
    expect(await ratingsOf(id)).toEqual([
      { article_id: article0.article_id, rating: 1, reason: null },
    ]);
    expect(
      (await a.browser.post('/r/a/0/rate', { rating: 'dislike', reason: 'bogus' })).statusCode,
    ).toBe(400);

    // Skip: status skipped, no rating, never read as a dislike; the next pending follows.
    const skip = await a.browser.post('/r/a/1/skip');
    expect(skip.headers.location).toBe('/r/a/2');
    expect((await assignmentRow(id, 1))!.status).toBe('skipped');
    expect((await ratingsOf(id)).map((r) => r.article_id)).toEqual([article0.article_id]);
    // Returning to a skipped article and rating it.
    expect((await a.browser.get('/r/a/1')).body).toContain('You skipped this.');
    await a.browser.post('/r/a/1/rate', { rating: 'dislike', reason: 'off_topic' });
    expect((await assignmentRow(id, 1))!.status).toBe('rated');
    // Skipping a rated article withdraws its rating.
    await a.browser.post('/r/a/0/skip');
    expect((await assignmentRow(id, 0))!.status).toBe('skipped');
    expect(await ratingsOf(id)).toHaveLength(1);

    // /r goes to the first pending article; the counter reflects the clicks.
    expect((await a.browser.get('/r')).headers.location).toBe('/r/a/2');
    const page = await a.browser.get('/r/a/2');
    expect(page.body).toContain('1 rated · 1 skipped · 18 left of 20');
  });

  it('stores an optional skip reason, clears it on a later rating, and keeps status counts', async () => {
    const id = a.rater.id;
    const counts = async () => (await raterProgress(rdb.db)).find((r) => r.raterId === id);
    const before = await counts();
    expect(before).toMatchObject({ rated: 1, skipped: 1, pending: 18 });

    // The page offers an optional short note next to Skip (keyboard `s` still skips without one).
    const { document } = parseHTML((await a.browser.get('/r/a/3')).body);
    const input = document.querySelector('form.skip input[name="skipReason"]');
    expect(input?.getAttribute('maxlength')).toBe('500');
    expect(document.querySelector('form.skip button[data-key="s"]')).not.toBeNull();

    const skip = await a.browser.post('/r/a/3/skip', { skipReason: '  paywalled, cannot judge  ' });
    expect(skip.headers.location).toBe('/r/a/4');
    expect(await assignmentRow(id, 3)).toMatchObject({
      status: 'skipped',
      skip_reason: 'paywalled, cannot judge',
    });
    expect((await a.browser.get('/r/a/3')).body).toContain(
      'You skipped this (paywalled, cannot judge).',
    );
    // Skip status counts are the same with or without a reason.
    expect(await counts()).toMatchObject({ rated: 1, skipped: 2, pending: 17 });

    // Blank → no reason; too long → refused without change.
    await a.browser.post('/r/a/4/skip', { skipReason: '   ' });
    expect(await assignmentRow(id, 4)).toMatchObject({ status: 'skipped', skip_reason: null });
    expect((await a.browser.post('/r/a/4/skip', { skipReason: 'x'.repeat(501) })).statusCode).toBe(
      400,
    );
    expect((await assignmentRow(id, 4))!.skip_reason).toBeNull();
    await a.browser.post('/r/a/4/skip', { skipReason: 'ž'.repeat(500) });
    expect((await assignmentRow(id, 4))!.skip_reason).toBe('ž'.repeat(500));

    // A later rating clears the reason in the same update that changes the status.
    await a.browser.post('/r/a/3/rate', { rating: 'like' });
    expect(await assignmentRow(id, 3)).toMatchObject({ status: 'rated', skip_reason: null });
    await a.browser.post('/r/a/4/rate', { rating: 'dislike', reason: 'seen' });
    expect(await assignmentRow(id, 4)).toMatchObject({ status: 'rated', skip_reason: null });
    expect(await counts()).toMatchObject({ rated: 3, skipped: 1, pending: 16 });
  });

  it('shows the done page once nothing is pending', async () => {
    const { browser, rater } = await readyRater('finisher');
    for (let p = 0; p < 20; p += 1) await browser.post(`/r/a/${p}/rate`, { rating: 'like' });
    const done = await browser.get('/r');
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Nothing left to rate');
    expect(await ratingsOf(rater.id)).toHaveLength(20);
  });

  it('scopes every read and write to the session rater', async () => {
    const b = await readyRater('bob');
    const aCards = await rdb.owner.query<{ card_id: string }>(
      'SELECT card_id::text FROM eval.rater_cards WHERE rater_id = $1',
      [a.rater.id],
    );
    const aBefore = await ratingsOf(a.rater.id);
    // Bob's position 2 is Bob's own assignment; rating it never touches Alice's rows.
    await b.browser.post('/r/a/2/rate', { rating: 'dislike', reason: 'seen' });
    expect(await ratingsOf(a.rater.id)).toEqual(aBefore);
    const bob = await ratingsOf(b.rater.id);
    expect(bob).toHaveLength(1);
    expect(bob[0]!.article_id).toBe((await assignmentRow(b.rater.id, 2))!.article_id);
    // Positions beyond Bob's queue do not exist for him.
    expect((await b.browser.get('/r/a/20')).statusCode).toBe(404);
    expect((await b.browser.post('/r/a/25/rate', { rating: 'like' })).statusCode).toBe(404);
    // Removing Alice's card through Bob's session changes nothing.
    await b.browser.post(`/r/cards/${aCards.rows[0]!.card_id}/delete`);
    const after = await rdb.owner.query('SELECT 1 FROM eval.rater_cards WHERE rater_id = $1', [
      a.rater.id,
    ]);
    expect(after.rowCount).toBe(aCards.rowCount);
    // Bob's CSRF token does not work with Alice's cookie.
    const crossed = await app.inject({
      method: 'POST',
      url: '/r/a/3/rate',
      payload: `rating=like&_csrf=${csrfToken(b.browser.cookie!)}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${a.browser.cookie}`,
      },
    });
    expect(crossed.statusCode).toBe(403);
  });
});

describe('feed picking uses the golden feeds only', () => {
  it('lists the feeds the evaluation user subscribes to, grouped by language', async () => {
    const { token } = await addRater(rdb, { langs: ['en'], now: now() });
    const browser = await signIn(token);
    const page = await browser.get('/r/feeds');
    const { document } = parseHTML(page.body);
    const boxes = [...document.querySelectorAll('input[type="checkbox"][name="feed"]')];
    expect(boxes.map((b) => b.getAttribute('value')).sort()).toEqual(feeds.map((f) => f.id).sort());
    expect([...document.querySelectorAll('legend')].map((l) => l.textContent)).toEqual([
      'en',
      'sk',
    ]);
  });

  it('setRaterFeeds ignores feeds outside the golden list', async () => {
    const { rater } = await addRater(rdb, { langs: ['en'], now: now() });
    const stored = await rdb.db.transaction((tx) =>
      setRaterFeeds(tx, rater.id, [feeds[0]!.id, '999999']),
    );
    expect(stored).toEqual([feeds[0]!.id]);
  });
});

describe('session creation races a reissue or revocation', () => {
  it('creates no session for a token that was replaced or revoked after validation', async () => {
    for (const change of ['reissue', 'revoke'] as const) {
      const { rater, token } = await addRater(rdb, { langs: ['en'], now: now() });
      const tokenHash = hashSecret(token);
      // The exchange validated the token…
      expect((await findRaterByToken(rdb.db, tokenHash, now()))?.id).toBe(rater.id);
      // …then the token changed before the session insert.
      if (change === 'reissue') {
        const issued = issueToken(now(), 30);
        await reissueRaterToken(rdb.db, rater.id, {
          tokenHash: issued.tokenHash,
          tokenExpiresAt: issued.expiresAt,
        });
      } else {
        await revokeRater(rdb.db, rater.id, now());
      }
      const created = await createRaterSession(rdb.db, {
        sessionHash: hashSecret(`session-${change}`),
        raterId: rater.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
        now: now(),
      });
      expect(created).toBeNull();
      const sessions = await rdb.owner.query(
        'SELECT 1 FROM eval.rater_sessions WHERE rater_id = $1',
        [rater.id],
      );
      expect(sessions.rowCount).toBe(0);
    }
  });
});

describe('rating corrections after a freeze (spec 10 §2.1)', () => {
  let r: { rater: RaterRow; token: string; browser: Browser };

  beforeAll(async () => {
    r = await readyRater('corrector');
  });

  it('create the next open version once; the frozen version stays unchanged', async () => {
    await r.browser.post('/r/a/0/rate', { rating: 'like' });
    const head = (await headDataset(rdb.db))!;
    const frozen = await rdb.db.transaction((tx) => freezeDataset(tx, head.version));
    const frozenRows = await loadSample(rdb.db, head.version);
    const versionsBefore = (await listDatasets(rdb.db)).length;

    // Changing a rating while the head is frozen first opens the next version.
    await r.browser.post('/r/a/0/rate', { rating: 'dislike', reason: 'seen' });
    const next = (await headDataset(rdb.db))!;
    expect(next.version).not.toBe(head.version);
    expect(next).toMatchObject({ parentVersion: head.version, frozenAt: null, seed: head.seed });
    expect(next.params).toMatchObject({ correctionOf: head.version });
    const nextRows = await loadSample(rdb.db, next.version);
    expect(nextRows.map((row) => [row.articleId, row.snapshotSha, row.split])).toEqual(
      frozenRows.map((row) => [row.articleId, row.snapshotSha, row.split]),
    );
    const after = (await getDataset(rdb.db, head.version))!;
    expect(after.manifest).toEqual(frozen.manifest);
    expect(after.frozenAt?.getTime()).toBe(frozen.frozenAt?.getTime());
    expect(await loadSample(rdb.db, head.version)).toEqual(frozenRows);

    // Further changes go to the open version: no other version is created.
    await r.browser.post('/r/a/1/rate', { rating: 'like' });
    await r.browser.post('/r/a/0/skip');
    expect((await listDatasets(rdb.db)).length).toBe(versionsBefore + 1);

    // After the next freeze, a skip that withdraws a rating also opens a version; a skip of an
    // unrated article does not.
    await rdb.db.transaction((tx) => freezeDataset(tx, next.version));
    await r.browser.post('/r/a/2/skip');
    expect((await listDatasets(rdb.db)).length).toBe(versionsBefore + 1);
    await r.browser.post('/r/a/1/skip');
    expect((await listDatasets(rdb.db)).length).toBe(versionsBefore + 2);
    expect((await headDataset(rdb.db))!.parentVersion).toBe(next.version);
  });

  it('an independent lineage (eval sample --version) keeps serving articles only an older one holds', async () => {
    // A new, unrelated head that holds none of the rater's articles.
    await createDataset(rdb.db, { version: 'golden-x1', seed: 'seed-x', params: {} });
    expect((await headDataset(rdb.db))!.version).toBe('golden-x1');
    expect(await loadSample(rdb.db, 'golden-x1')).toEqual([]);

    const res = await r.browser.get('/r/a/3');
    expect(res.statusCode).toBe(200);
    expect(parseHTML(res.body).document.querySelector('h1')?.textContent).toMatch(/story/u);
  });
});
