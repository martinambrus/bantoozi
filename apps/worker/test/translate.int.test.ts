import { eligibleInferenceDemand, loadClassificationArticle } from '@bantoozi/db';
import type { CredentialResolver } from '@bantoozi/shared/server';
import {
  createFeed,
  fixturePath,
  pseudoTranslate,
  startFakeLibreTranslate,
  startFakeOllama,
  startFixtureServer,
  type FakeLibreTranslate,
  type FakeOllamaServer,
  type FixtureServer,
} from '@bantoozi/testing';
import {
  articleTranslationSource,
  createLibreTranslateClient,
  createOllamaTranslator,
  translationSourceSha256,
} from '@bantoozi/translate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  runTier2,
  type TranslationDeps,
  type TranslationJob,
} from '../src/classify/translation.js';
import { TransientTranslationError } from '../src/handlers/article-translate.js';

import {
  ClassifyHarness,
  DAY,
  HOUR,
  LLM_MODEL,
  ago,
  forArticles,
  witnessesOf,
} from './support/classify.js';

/**
 * M2-T9 `article.translate` (spec 07 §3) with the fake LibreTranslate and Ollama servers, and the
 * `pipeline.after` chain end to end: fetch → extract → (translate) → enrich → cluster + match through
 * the real handlers and the outbox run loop. No live provider is ever reached.
 */

const TRAM = {
  title: 'Nové električky v Bratislave jazdia od pondelka',
  excerpt: 'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky.',
  bodyLead:
    'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky. Dopravný podnik ' +
    'ich nasadil najskôr na linku, ktorá vedie cez Starý most, pretože tam je najviac cestujúcich.',
};
const BATTERY_TITLE = 'Solid-state batteries move from the lab to the pilot line';
/** The end-to-end Slovak story: unlike the tram articles above, it has no similar story. */
const LIBRARY = {
  title: 'Košická knižnica predĺži otváracie hodiny počas letných prázdnin',
  excerpt: 'Mestská knižnica bude cez leto otvorená každý deň až do ôsmej hodiny večer.',
  paragraphs: [
    'Mestská knižnica v Košiciach bude počas letných prázdnin otvorená každý deň až do ôsmej ' +
      'hodiny večer. Riaditeľka knižnice povedala, že o dlhšie otváracie hodiny žiadali najmä ' +
      'študenti a rodiny s deťmi, ktoré cez leto nemajú kam ísť.',
    'Knižnica zároveň pripravila čitateľské dielne pre deti, večerné besedy so spisovateľmi a ' +
      'kurzy práce s počítačom pre seniorov. Všetky podujatia sú bezplatné a prihlásiť sa na ne ' +
      'dá priamo pri pulte alebo cez webovú stránku.',
    'Dlhšie otváracie hodiny si vyžiadajú aj viac zamestnancov. Mesto preto na leto prijme ' +
      'brigádnikov, ktorí budú pomáhať pri výpožičkách a pri upratovaní čitární.',
    'Ak bude o večerné hodiny záujem, knižnica ich chce ponechať aj počas školského roka. ' +
      'Rozhodnutie padne na jeseň, keď vedenie vyhodnotí, koľko ľudí po šiestej hodine prišlo.',
  ],
};

let h: ClassifyHarness;
let lt: FakeLibreTranslate;
let ollama: FakeOllamaServer;
let server: FixtureServer;
let translation: TranslationDeps;
let credential: Awaited<ReturnType<CredentialResolver['metadata']>>;
let ollamaBase = 0;
const closers: Array<() => Promise<void>> = [];

/** Tier-2 HTTP requests received since the test began (the fake's count is cumulative). */
const ollamaCalls = () => ollama.requestCount() - ollamaBase;

/** A tier-2 reply: the pseudo-translation of every field of the JSON the translator sent. */
function translatedReply(body: unknown): string {
  const messages = (body as { messages: Array<{ role: string; content: string }> }).messages;
  const source = JSON.parse(messages.at(-1)?.content ?? '{}') as Record<string, string>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(source).map(([field, text]) => [
        field,
        text === '' ? '' : pseudoTranslate(text),
      ]),
    ),
  );
}

beforeAll(async () => {
  lt = await startFakeLibreTranslate();
  ollama = await startFakeOllama({ apiKey: 'test-key', reply: translatedReply });
  server = await startFixtureServer({ root: fixturePath('ingestion') });
  const libretranslate = createLibreTranslateClient({ baseUrl: lt.url, maxAttempts: 1 });
  const translator = createOllamaTranslator({ baseUrl: ollama.url });
  closers.push(
    () => libretranslate.close(),
    () => translator.close(),
    () => lt.close(),
    () => ollama.close(),
    () => server.close(),
  );
  const credentials: CredentialResolver = {
    metadata: async () => credential,
    useActive: async (_provider, _signal, send) =>
      send({ apiKey: 'test-key', source: 'db', credentialVersion: '3' }),
    useCandidate: async () => {
      throw new Error('candidate keys are not used here');
    },
  };
  translation = {
    libretranslate,
    ollama: translator,
    credentials,
    modelFast: LLM_MODEL,
    modelStrong: 'glm-5.3',
  };
  h = await ClassifyHarness.start({
    languageModes: { en: 'native', sk: 'translate', cs: 'native' },
    translation,
  });
});

afterAll(async () => {
  await h?.close();
  for (const close of closers) await close();
});

beforeEach(async () => {
  h.router.reset();
  lt.reset({ mode: 'ok' });
  ollama.setOptions({
    mode: 'ok',
    reply: translatedReply,
    status: undefined,
    headers: undefined,
    statusOverride: undefined,
  });
  ollama.requests.length = 0;
  ollamaBase = ollama.requestCount();
  credential = { source: 'db', enabled: true, activeVersion: '3' };
  await h.clearOutbox();
});

/** A Slovak article of a feed with an active reader (or the given reader modes). */
async function slovak(modes: ReadonlyArray<'off' | 'training' | 'active'> = ['active']) {
  const feedId = await h.feed();
  const users: string[] = [];
  for (const mode of modes) {
    const userId = await h.user();
    await h.subscribe(userId, feedId, mode);
    users.push(userId);
  }
  const articleId = await h.article({ feedIds: [feedId], lang: 'sk', ...TRAM });
  return { feedId, users, articleId };
}

async function translations(articleId: string) {
  const result = await h.owner.query<{
    engine: string;
    model: string | null;
    quality: string;
    revision: string;
    title: string | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT engine, model, quality, article_revision::text AS revision, title,
            quality_detail AS detail
       FROM article_translations WHERE article_id = $1 ORDER BY engine`,
    [articleId],
  );
  return result.rows;
}

const translateRequests = () => lt.requests.filter((request) => request.path === '/translate');

/** The tier-2 job of a Slovak article's current revision, as the handler builds it. */
async function tier2Job(articleId: string): Promise<TranslationJob> {
  const article = await loadClassificationArticle(h.deps.db, articleId);
  if (article === null) throw new Error(`article ${articleId} is gone`);
  const source = articleTranslationSource({
    title: article.title,
    excerpt: article.excerpt,
    body_lead: article.bodyLead,
  });
  const witnesses = await eligibleInferenceDemand(h.deps.db, articleId);
  return {
    articleId,
    articleRevision: article.revision,
    sourceLang: 'sk',
    source,
    sourceSha256: translationSourceSha256('sk', source),
    authorization: { type: 'article', articleId, articleRevision: article.revision, witnesses },
  };
}

describe('article.translate tiers (spec 07 §3)', () => {
  it('the initial pipeline stores the tier-1 row, moves extracted → translated and records enrichment', async () => {
    const s = await slovak();
    const since = await h.mark();
    await h.dispatch('article.translate', { articleId: s.articleId });

    expect(translateRequests()).toHaveLength(1);
    expect(translateRequests()[0]?.body).toMatchObject({ source: 'sk', target: 'en' });
    expect(ollamaCalls()).toBe(0);
    const rows = await translations(s.articleId);
    expect(rows).toMatchObject([
      {
        engine: 'libretranslate',
        model: null,
        quality: 'ok',
        revision: '1',
        title: pseudoTranslate(TRAM.title),
      },
    ]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'translated', revision: '1' });
    expect(await h.payloads('article.enrich', since)).toEqual([{ articleId: s.articleId }]);
    // Every tier-1 attempt is recorded (free) through the router; nothing was reserved.
    expect(h.router.external.map((e) => e.call.engine)).toEqual(['libretranslate']);
    expect(h.router.reservations).toEqual([]);

    // Enrichment then asks the translated variant.
    await h.run('article.enrich', forArticles(s.articleId));
    const [ask] = h.router.asksFor(s.articleId, 'enrich');
    expect(JSON.stringify(ask?.request.state)).toContain(pseudoTranslate(TRAM.title));
    expect(await h.facetRow(s.articleId)).toMatchObject({ variant: 'translated' });
  });

  it('a failed tier 1 with an enabled key runs tier 2 once; its ollama row is used', async () => {
    lt.setOptions({ mode: 'fail' });
    const s = await slovak();
    const since = await h.mark();
    await h.dispatch('article.translate', { articleId: s.articleId });

    expect(ollamaCalls()).toBe(1);
    expect(ollama.requests[0]?.headers['authorization']).toBe('Bearer test-key');
    const rows = await translations(s.articleId);
    expect(rows).toMatchObject([
      // A graded failure (an empty translation), unlike a terminal error, keeps its output.
      { engine: 'libretranslate', quality: 'fail', title: '' },
      { engine: 'ollama', model: LLM_MODEL, quality: 'ok', title: pseudoTranslate(TRAM.title) },
    ]);
    expect(rows[1]?.detail).toMatchObject({ credentialVersion: '3' });
    // The paid attempt reserved spend under the article's demand before the HTTP call.
    expect(
      h.router.reservations.map((r) => [r.input.engine, r.input.kind, r.input.priority]),
    ).toEqual([['llm', 'translate', 'bulk']]);
    expect(h.router.external.find((e) => e.call.engine === 'llm')?.reservationId).toBe(
      h.router.reservations[0]?.id,
    );
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'translated' });
    expect(await h.payloads('article.enrich', since)).toEqual([{ articleId: s.articleId }]);

    // Tier 2 runs once per revision: a later escalation does not send it again.
    await h.dispatch('article.translate', { articleId: s.articleId, forceTier2: true });
    expect(ollamaCalls()).toBe(1);
    expect(translateRequests()).toHaveLength(1);
  });

  it('without a key a skipped row records the attempt; the reprocess replaces it once a key exists', async () => {
    lt.setOptions({ mode: 'fail' });
    credential = { source: 'none', enabled: false };
    const s = await slovak();
    const since = await h.mark();
    await h.dispatch('article.translate', { articleId: s.articleId });

    expect(ollamaCalls()).toBe(0);
    expect(h.router.reservations).toEqual([]);
    const rows = await translations(s.articleId);
    expect(rows.map((row) => [row.engine, row.quality, row.title])).toEqual([
      ['libretranslate', 'fail', ''],
      ['ollama', 'fail', null],
    ]);
    expect(rows[1]?.detail).toMatchObject({ skipped: 'no_key' });
    // Native text is better than blocking the article.
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'translated' });
    expect(await h.payloads('article.enrich', since)).toEqual([{ articleId: s.articleId }]);

    credential = { source: 'db', enabled: true, activeVersion: '3' };
    await h.dispatch('article.translate', { articleId: s.articleId, replaceSkipped: true });
    expect(ollamaCalls()).toBe(1);
    expect((await translations(s.articleId)).map((row) => [row.engine, row.quality])).toEqual([
      ['libretranslate', 'fail'],
      ['ollama', 'ok'],
    ]);
  });

  it('a transient tier-2 failure uses the job retry; the last attempt continues without an ollama row', async () => {
    lt.setOptions({ mode: 'fail' });
    ollama.setOptions({ mode: 'status', status: 503 });
    const s = await slovak();
    const since = await h.mark();
    const attempt = (count: number) =>
      h.dispatch('article.translate', { articleId: s.articleId }, { retry: { count, limit: 1 } });

    // One HTTP attempt, then the queue retry: no in-process retry, and nothing stored.
    await expect(attempt(0)).rejects.toThrow(TransientTranslationError);
    expect(ollamaCalls()).toBe(1);
    expect(await translations(s.articleId)).toEqual([]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'extracted' });

    // The last attempt continues from native text, and no `fail` row claims the revision's tier 2.
    await attempt(1);
    expect(ollamaCalls()).toBe(2);
    expect((await translations(s.articleId)).map((row) => [row.engine, row.quality])).toEqual([
      ['libretranslate', 'fail'],
    ]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'translated' });
    expect(await h.payloads('article.enrich', since)).toEqual([{ articleId: s.articleId }]);
    expect(
      h.router.external.filter((e) => e.call.engine === 'llm').map((e) => e.call.status),
    ).toEqual(['error', 'error']);

    // So a later escalation may still run it.
    ollama.setOptions({ mode: 'ok' });
    await h.dispatch('article.translate', { articleId: s.articleId, forceTier2: true });
    expect(ollamaCalls()).toBe(3);
    expect((await translations(s.articleId)).map((row) => [row.engine, row.quality])).toEqual([
      ['libretranslate', 'fail'],
      ['ollama', 'ok'],
    ]);
  });

  it('a flagged re-translation that changes the effective text resets the article; identical text is a no-op', async () => {
    // Enriched with a weak tier-1 translation (the source echoed).
    lt.setOptions({ mode: 'weak' });
    const s = await slovak();
    await h.dispatch('article.translate', { articleId: s.articleId });
    await h.run('article.enrich', forArticles(s.articleId));
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched', revision: '1' });
    expect(await h.facetRow(s.articleId)).toMatchObject({ variant: 'translated' });

    // The weak-translation escalation: tier 2 produces a better translation.
    const since = await h.mark();
    await h.dispatch('article.translate', { articleId: s.articleId, forceTier2: true });
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'translated', revision: '2' });
    expect(
      (await translations(s.articleId)).map((row) => [row.engine, row.quality, row.revision]),
    ).toEqual([
      ['libretranslate', 'weak', '2'],
      ['ollama', 'ok', '2'],
    ]);
    expect(await h.facetRow(s.articleId)).toBeNull();
    expect(await h.payloads('article.enrich', since)).toEqual([{ articleId: s.articleId }]);
    await h.run('article.enrich', forArticles(s.articleId));
    const reenriched = h.router.asksFor(s.articleId, 'enrich').at(-1);
    expect(reenriched?.articleRevision).toBe('2');
    expect(JSON.stringify(reenriched?.request.state)).toContain(pseudoTranslate(TRAM.title));

    // Enriched with a good tier-1 translation; the escalation's tier 2 only echoes (weak).
    lt.setOptions({ mode: 'ok' });
    ollama.setOptions({ reply: undefined });
    const t = await slovak();
    await h.dispatch('article.translate', { articleId: t.articleId });
    await h.run('article.enrich', forArticles(t.articleId));
    const facets = await h.facetRow(t.articleId);
    const same = await h.mark();
    await h.dispatch('article.translate', { articleId: t.articleId, forceTier2: true });
    expect((await translations(t.articleId)).map((row) => [row.engine, row.quality])).toEqual([
      ['libretranslate', 'ok'],
      ['ollama', 'weak'],
    ]);
    expect(await h.articleRow(t.articleId)).toMatchObject({ state: 'enriched', revision: '1' });
    expect(await h.facetRow(t.articleId)).toEqual(facets);
    expect(await h.payloads('article.enrich', same)).toEqual([]);
    expect(await h.payloads('user.rank', same)).toEqual([]);
  });

  it('a mode change back to translate re-enriches an article enriched from native text over its kept translation', async () => {
    const translateModes = { en: 'native', sk: 'translate', cs: 'native' };
    const s = await slovak();
    await h.dispatch('article.translate', { articleId: s.articleId });
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'translated', revision: '1' });
    // Switched to native before enrichment: the facets use native text, the tier-1 row stays.
    await h.setSetting('language_modes', { ...translateModes, sk: 'native' });
    try {
      await h.run('article.enrich', forArticles(s.articleId));
    } finally {
      await h.setSetting('language_modes', translateModes);
    }
    expect(await h.facetRow(s.articleId)).toMatchObject({ revision: '1', variant: 'native' });

    // Back in translate mode, the mode-change job calls no tier: it installs the stored row.
    const requests = translateRequests().length;
    const since = await h.mark();
    await h.dispatch('article.translate', { articleId: s.articleId, modeChange: true });
    expect(translateRequests()).toHaveLength(requests);
    expect(ollamaCalls()).toBe(0);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'translated', revision: '2' });
    expect(
      (await translations(s.articleId)).map((row) => [row.engine, row.quality, row.revision]),
    ).toEqual([['libretranslate', 'ok', '2']]);
    expect(await h.facetRow(s.articleId)).toBeNull();
    expect(await h.payloads('article.enrich', since)).toEqual([{ articleId: s.articleId }]);
    await h.run('article.enrich', forArticles(s.articleId));
    expect(await h.facetRow(s.articleId)).toMatchObject({ revision: '2', variant: 'translated' });

    // A repeated mode-change job finds the facets built from that translation: a no-op.
    const again = await h.mark();
    await h.dispatch('article.translate', { articleId: s.articleId, modeChange: true });
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'enriched', revision: '2' });
    expect(await h.payloads('article.enrich', again)).toEqual([]);
  });

  it('is a no-op for off or unselected demand: no HTTP request, no row, no stage change', async () => {
    const s = await slovak(['off', 'training']);
    const since = await h.mark();
    await h.dispatch('article.translate', { articleId: s.articleId });
    await h.dispatch('article.translate', { articleId: s.articleId, forceTier2: true });
    expect(lt.requests).toEqual([]);
    expect(ollamaCalls()).toBe(0);
    expect(await translations(s.articleId)).toEqual([]);
    expect(await h.articleRow(s.articleId)).toMatchObject({ state: 'extracted' });
    expect(await h.payloads('article.enrich', since)).toEqual([]);
    expect(h.router.external).toEqual([]);
  });
});

describe('tier-2 attempts (spec 07 §3 step 3)', () => {
  it('returns a transport failure with the server retry time after one attempt, storing nothing', async () => {
    const s = await slovak();
    const job = await tier2Job(s.articleId);
    ollama.setOptions({ mode: 'status', status: 429, headers: { 'retry-after': '30' } });
    const before = Date.now();
    const outcome = await runTier2(h.deps.db, h.router, translation, job, LLM_MODEL);
    const after = Date.now();
    expect(outcome).toMatchObject({ kind: 'transient', reason: 'rate_limited' });
    const retryAt = outcome.kind === 'transient' ? outcome.retryAt?.getTime() : undefined;
    expect(retryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(retryAt).toBeLessThanOrEqual(after + 30_000);
    expect(ollamaCalls()).toBe(1);
    expect(h.router.reservations).toHaveLength(1);
  });

  it('repairs invalid output once: invalid again is a fail row, a failed repair call is transient', async () => {
    const s = await slovak();
    const job = await tier2Job(s.articleId);
    ollama.setOptions({ mode: 'malformed' });
    const invalid = await runTier2(h.deps.db, h.router, translation, job, LLM_MODEL);
    expect(ollamaCalls()).toBe(2);
    expect(invalid).toMatchObject({
      kind: 'row',
      row: { engine: 'ollama', quality: 'fail', qualityDetail: { failure: 'invalid_response' } },
    });

    let calls = 0;
    ollama.setOptions({
      statusOverride: () => {
        calls += 1;
        return calls === 2 ? { status: 503, body: { error: 'overloaded' } } : undefined;
      },
    });
    expect(await runTier2(h.deps.db, h.router, translation, job, LLM_MODEL)).toEqual({
      kind: 'transient',
      reason: 'server_error',
    });
    expect(ollamaCalls()).toBe(4);
  });
});

describe('pipeline.after end to end (spec 03 §1)', () => {
  it('runs fetch → extract → translate (when required) → enrich → cluster + match', async () => {
    server.route('/articles/battery.html', { file: 'pages/battery.html' });
    server.route('/articles/library.html', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<!doctype html><html lang="sk"><head><meta charset="utf-8"><title>${LIBRARY.title}</title>
</head><body><main><article><h1>${LIBRARY.title}</h1>
${LIBRARY.paragraphs.map((text) => `<p>${text}</p>`).join('\n')}
</article></main></body></html>`,
    });
    const published = new Date(Date.now() - HOUR).toUTCString();
    server.route('/city.xml', {
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>City Desk</title><link>${server.url('/')}</link>
<description>News</description>
<item><title>${LIBRARY.title}</title><link>${server.url('/articles/library.html')}</link>
<guid>library-1</guid><pubDate>${published}</pubDate><description>${LIBRARY.excerpt}</description></item>
<item><title>${BATTERY_TITLE}</title><link>${server.url('/articles/battery.html')}</link>
<guid>battery-1</guid><pubDate>${published}</pubDate>
<description>Three European manufacturers moved solid-state cells into pilot production.</description></item>
</channel></rss>`,
    });
    const feedId = (await createFeed(h.owner, { url: server.url('/city.xml'), title: 'City Desk' }))
      .id;
    const reader = await h.user();
    await h.subscribe(reader, feedId, 'active', ago(DAY));
    const card = await h.heldCard(reader, { topicIds: ['technology'] });
    // An authorized, classified similar story from another feed: the cluster call has a candidate.
    const wireFeed = await h.feed('Tech Wire');
    const wireReader = await h.user();
    await h.subscribe(wireReader, wireFeed, 'active');
    const wire = await h.article({
      feedIds: [wireFeed],
      title: BATTERY_TITLE,
      firstSeenAt: ago(2 * HOUR),
    });
    await h.enrichDirect(wire);
    await h.owner.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
      [feedId, wireFeed],
      JSON.stringify({ beta: 900, admin: 300 }),
    ]);
    await h.owner.query('SELECT refresh_feed_cards($1::bigint[])', [[feedId, wireFeed]]);
    h.router.clusterChoice = 'c1';

    const since = await h.mark();
    await h.dispatch('feed.fetch', { feedId, force: true });
    const ids = await h.owner.query<{ id: string; title: string }>(
      `SELECT a.id::text AS id, a.title FROM articles a JOIN feed_items fi ON fi.article_id = a.id
        WHERE fi.feed_id = $1`,
      [feedId],
    );
    const idOf = (title: string) => ids.rows.find((row) => row.title === title)?.id as string;
    const library = idOf(LIBRARY.title);
    const battery = idOf(BATTERY_TITLE);
    expect(library).toBeDefined();
    expect(battery).toBeDefined();

    await h.drain([
      'article.extract',
      'article.translate',
      'article.enrich',
      'article.cluster',
      'article.match',
    ]);

    // The stage chain each article took, from its own outbox intents.
    const stagesOf = async (articleId: string) => {
      const stages: string[] = [];
      for (const queue of [
        'article.extract',
        'article.translate',
        'article.enrich',
        'article.cluster',
        'article.match',
      ]) {
        if ((await h.payloads(queue, since)).some((p) => p['articleId'] === articleId)) {
          stages.push(queue.slice('article.'.length));
        }
      }
      return stages;
    };
    expect(await stagesOf(library)).toEqual(['extract', 'translate', 'enrich', 'cluster', 'match']);
    expect(await stagesOf(battery)).toEqual(['extract', 'enrich', 'cluster', 'match']);

    // The Slovak article was translated by tier 1 and classified in its translated variant; with
    // no similar story its cluster stage asks nothing and leaves it unclustered.
    expect(await h.articleRow(library)).toMatchObject({ state: 'matched', clusterId: null });
    expect((await translations(library)).map((row) => [row.engine, row.quality])).toEqual([
      ['libretranslate', 'ok'],
    ]);
    expect(await h.facetRow(library)).toMatchObject({ variant: 'translated' });
    expect(h.router.asksFor(library).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    // The English article needs no translation; its cluster call folds it with the wire story.
    expect(await translations(battery)).toEqual([]);
    expect(h.router.asksFor(battery).map((ask) => ask.kind)).toEqual([
      'enrich',
      'cluster',
      'match',
    ]);
    const placed = await h.articleRow(battery);
    expect(placed).toMatchObject({ state: 'matched', clusterSetId: h.sets.cluster });
    expect((await h.articleRow(wire)).clusterId).toBe(placed.clusterId);
    for (const articleId of [library, battery]) {
      expect((await h.cardAnswers(articleId)).map((a) => [a.cardId, a.engine])).toEqual([
        [card, 'typesafe'],
      ]);
      expect(witnessesOf(h.router.asksFor(articleId))).toEqual({ users: [reader], requests: [] });
    }
    expect(translateRequests()).toHaveLength(1);
    expect(ollamaCalls()).toBe(0);

    const ranked = (await h.payloads('user.rank', since)).map((p) => [
      p['userId'],
      p['reason'],
      p['full'] ?? false,
    ]);
    expect(ranked).toContainEqual([reader, 'match', false]);
    expect(ranked).toContainEqual([reader, 'cluster', true]);
    expect(ranked).toContainEqual([wireReader, 'cluster', true]);
  });
});
