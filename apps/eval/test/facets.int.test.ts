import { listFacetLabels, sampleArticleLangs } from '@bantoozi/db';
import { dropCreatedTestDatabases } from '@bantoozi/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { parseHTML } from 'linkedom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FACET_KEYS,
  facetSeed,
  selectFacetSet,
  selectOverlap,
} from '../src/rating-server/facets.js';
import { buildRatingServer, SESSION_COOKIE } from '../src/rating-server/server.js';
import { csrfToken } from '../src/rating-server/tokens.js';
import {
  addArticles,
  addGoldenFeeds,
  addRater,
  createGoldenDataset,
  setupRatingDb,
  type RatingDb,
} from './rating-server-support.js';

/**
 * M3a-T4 (spec 10 §2.3): the facet-labelling page stores all six fields per article; the owner (the
 * earliest rater's participant, whatever context they sign in with) labels 100 articles per
 * language; a second labeller gets a deterministic 50-article overlap spread across languages.
 */

const PUBLIC_URL = 'http://localhost:5180';

let rdb: RatingDb;
let app: FastifyInstance;
const titleToId = new Map<string, string>();
let ownerKey: string;
let owner: Session;
let ownerOtherContext: Session;
let second: Session;

interface Session {
  cookie: string;
}

async function signIn(token: string): Promise<Session> {
  const res = await app.inject({ method: 'GET', url: `/facets?t=${token}` });
  expect(res.statusCode).toBe(303);
  const cookie = /=([^;]+)/u.exec(String(res.headers['set-cookie']))?.[1];
  if (cookie === undefined) throw new Error('no cookie');
  return { cookie };
}

const get = (s: Session, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE}=${s.cookie}` } });

const post = (s: Session, url: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    payload: new URLSearchParams({ ...form, _csrf: csrfToken(s.cookie) }).toString(),
    headers: {
      cookie: `${SESSION_COOKIE}=${s.cookie}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
  });

const articleOf = (res: LightMyRequestResponse): string => {
  const title = parseHTML(res.body).document.querySelector('h1')?.textContent ?? '';
  const id = titleToId.get(title);
  if (id === undefined) throw new Error(`unknown article ${title}`);
  return id;
};

const totalOf = (res: LightMyRequestResponse): number =>
  Number(/Article \d+ of (\d+)/u.exec(res.body)?.[1]);

const LABELS = {
  content_type: 'analysis',
  topic_l1: 'technology',
  depth: '3',
  clickbait: 'no',
  promotional: 'uncertain',
  time_sensitive: 'yes',
};

beforeAll(async () => {
  rdb = await setupRatingDb('eval-facets');
  const ids: string[] = [];
  const seen = new Date(Date.now() - 86_400_000);
  for (const [lang, feeds, perFeed] of [
    ['en', 2, 60],
    ['sk', 2, 60],
    ['cs', 1, 30],
  ] as const) {
    for (const feed of await addGoldenFeeds(rdb, lang, feeds)) {
      const added = await addArticles(rdb, feed.id, lang, perFeed, seen);
      ids.push(...added);
    }
  }
  const titles = await rdb.owner.query<{ id: string; title: string }>(
    'SELECT id::text, title FROM articles WHERE id = ANY($1::bigint[])',
    [ids],
  );
  for (const row of titles.rows) titleToId.set(row.title, row.id);
  await createGoldenDataset(rdb, ids);
  app = await buildRatingServer({ db: rdb.db, publicUrl: PUBLIC_URL });

  const science = await addRater(rdb, {
    name: 'Owner',
    langs: ['en'],
    contextName: 'science',
    now: new Date(),
  });
  ownerKey = science.rater.participantKey;
  const cooking = await addRater(rdb, {
    name: 'Owner',
    langs: ['en'],
    contextName: 'cooking',
    participantKey: ownerKey,
    now: new Date(),
  });
  const friend = await addRater(rdb, { name: 'Friend', langs: ['sk'], now: new Date() });
  owner = await signIn(science.token);
  ownerOtherContext = await signIn(cooking.token);
  second = await signIn(friend.token);
});

afterAll(async () => {
  await app?.close();
  await rdb?.close();
  await dropCreatedTestDatabases();
});

describe('facet labelling page', () => {
  it('gives the owner 100 articles per language (all 30 Czech ones)', async () => {
    expect((await get(owner, '/facets')).headers.location).toBe('/facets/0');
    const first = await get(owner, '/facets/0');
    expect(first.statusCode).toBe(200);
    expect(totalOf(first)).toBe(230);
    const { document } = parseHTML(first.body);
    for (const key of FACET_KEYS) {
      expect(
        document.querySelectorAll(`input[type="radio"][name="${key}"]`).length,
      ).toBeGreaterThan(2);
      expect(document.querySelector(`input[name="${key}"][value="uncertain"]`)).not.toBeNull();
      expect(document.querySelector(`input[name="${key}"][value="not_applicable"]`)).not.toBeNull();
    }
    // The owner's other topic profile is the same labeller.
    expect(articleOf(await get(ownerOtherContext, '/facets/0'))).toBe(articleOf(first));
  });

  it('stores all six fields per article for the labeller (its participant key)', async () => {
    const page = await get(owner, '/facets/0');
    const articleId = articleOf(page);
    const saved = await post(owner, '/facets/0', LABELS);
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe('/facets/1');
    const labels = (await listFacetLabels(rdb.db)).filter((l) => l.articleId === articleId);
    expect(Object.fromEntries(labels.map((l) => [l.questionKey, l.value]))).toEqual(LABELS);
    expect(new Set(labels.map((l) => l.labeler))).toEqual(new Set([ownerKey]));

    // The other context sees the stored values and moves on past the labelled article.
    const again = await get(ownerOtherContext, '/facets/0');
    const { document } = parseHTML(again.body);
    expect(document.querySelector('input[name="depth"][value="3"]')?.hasAttribute('checked')).toBe(
      true,
    );
    expect((await get(ownerOtherContext, '/facets')).headers.location).toBe('/facets/1');

    // A correction replaces the value, still one row per field.
    await post(ownerOtherContext, '/facets/0', { ...LABELS, depth: '1' });
    const corrected = (await listFacetLabels(rdb.db)).filter((l) => l.articleId === articleId);
    expect(corrected).toHaveLength(6);
    expect(corrected.find((l) => l.questionKey === 'depth')?.value).toBe('1');
  });

  it('refuses incomplete or invalid labels and stores nothing', async () => {
    const before = (await listFacetLabels(rdb.db)).length;
    const { time_sensitive: _missing, ...partial } = LABELS;
    const incomplete = await post(owner, '/facets/1', partial);
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.body).toContain('Please answer all six questions.');
    expect((await post(owner, '/facets/1', { ...LABELS, depth: '7' })).statusCode).toBe(400);
    expect((await post(owner, '/facets/1', { ...LABELS, topic_l1: 'nonsense' })).statusCode).toBe(
      400,
    );
    expect((await listFacetLabels(rdb.db)).length).toBe(before);
    expect((await get(owner, '/facets/230')).statusCode).toBe(404);
  });

  it('gives a second labeller a deterministic 50-article overlap spread across languages', async () => {
    const first = await get(second, '/facets/0');
    expect(first.body).toContain('overlap set (second labeller)');
    expect(totalOf(first)).toBe(50);
    const seen: string[] = [];
    for (let i = 0; i < 50; i += 1) seen.push(articleOf(await get(second, `/facets/${i}`)));

    const candidates = await sampleArticleLangs(rdb.db, 'golden-v1');
    const seed = facetSeed('seed-1');
    const primary = selectFacetSet({ seed, candidates, keep: new Set() });
    const expected = selectOverlap({ seed, primary });
    expect(seen).toEqual(expected.map((c) => c.articleId));
    const langOf = new Map(candidates.map((c) => [c.articleId, c.lang]));
    const counts: Record<string, number> = {};
    for (const id of seen) counts[langOf.get(id)!] = (counts[langOf.get(id)!] ?? 0) + 1;
    expect(counts).toEqual({ cs: 17, en: 17, sk: 16 });
    const primaryIds = new Set(primary.map((c) => c.articleId));
    expect(seen.every((id) => primaryIds.has(id))).toBe(true);

    // Their labels are kept separately from the owner's.
    await post(second, '/facets/0', { ...LABELS, clickbait: 'yes' });
    const labels = (await listFacetLabels(rdb.db)).filter((l) => l.articleId === seen[0]);
    expect(labels.filter((l) => l.labeler !== ownerKey)).toHaveLength(6);
  });
});
