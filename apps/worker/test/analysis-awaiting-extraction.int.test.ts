import { listTranslations, loadClassificationArticle } from '@bantoozi/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadClassificationConfig } from '../src/classify/config.js';
import { buildState, modelInput } from '../src/classify/model-input.js';
import { dispatch } from '../src/handlers/index.js';
import {
  ClassifyHarness,
  DAY,
  MINUTE,
  ago,
  witnessesOf,
  type AskRecord,
} from './support/classify.js';

/**
 * A selection made before the article's extraction (spec 05 §1.1, spec 08 §4.1): `analysis.process`
 * waits for the extraction and then runs once on the extracted text, instead of answering the
 * excerpt and leaving a second, automatic enrich/cluster/match chain to the extraction.
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

let titles = 0;

type Mode = 'training' | 'active';

/**
 * A reader with one held card and an `ingested` article without language or body, linkless so its
 * extraction makes no HTTP request (it keeps the feed text).
 */
async function ingested(
  options: { state?: string; mode?: Mode; url?: string | null; firstSeenAt?: Date } = {},
) {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, options.mode ?? 'training');
  const cardId = await h.heldCard(userId, { topicIds: ['technology'] });
  titles += 1;
  const unextracted = options.state === undefined || options.state === 'ingested';
  const articleId = await h.article({
    feedIds: [feedId],
    title: `Selected before extraction number ${titles} about solar panels`,
    excerpt: `Solar panels keep getting cheaper, number ${titles}, and installers report record demand.`,
    state: options.state ?? 'ingested',
    lang: unextracted ? null : 'en',
    ...(unextracted ? { bodyLead: null } : {}),
    wordCount: 0,
    firstSeenAt: options.firstSeenAt ?? ago(3 * DAY),
  });
  const url = options.url === undefined ? null : options.url;
  await h.owner.query('UPDATE articles SET url = $2, word_count = NULL WHERE id = $1', [
    articleId,
    url,
  ]);
  return { feedId, userId, cardId, articleId };
}

const requestAsks = (requestId: string): AskRecord[] =>
  h.router.asks.filter((ask) =>
    ask.witnesses.some((w) => w.kind === 'manual' && w.analysisRequestId === requestId),
  );

const processRequest = (requestId: string): Promise<number> =>
  h.run('analysis.process', (payload) => payload['analysisRequestId'] === requestId);

const pending = async (queue: string, since: string, articleId?: string) =>
  (await h.intents(queue, { since, pending: true })).filter(
    (intent) => articleId === undefined || intent.payload['articleId'] === articleId,
  );

async function requestRow(requestId: string) {
  const result = await h.owner.query<{
    input_snapshot: Record<string, unknown> & {
      awaitingExtraction?: true;
      article: { lang: string | null; bodyLead: string | null; wordCount: number | null };
    };
    input_sha: string;
    created_at: Date;
  }>('SELECT input_snapshot, input_sha, created_at FROM analysis_requests WHERE id = $1', [
    requestId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('no request');
  return row;
}

const extract = (articleId: string) => h.dispatch('article.extract', { articleId });

const CHAIN = ['article.translate', 'article.enrich', 'article.cluster', 'article.match'] as const;

describe('a selection made before extraction', () => {
  it('waits for the extraction, then runs once on the extracted text', async () => {
    const t = await ingested();
    const { requestId, snapshot } = await h.select(t.userId, t.feedId, t.articleId);
    expect(snapshot.awaitingExtraction).toBe(true);
    expect(snapshot.article.lang).toBeNull();
    expect(snapshot.article.bodyLead).toBeNull();
    const frozenSha = (await requestRow(requestId)).input_sha;

    // Before the extraction: no model call, pending again, a delayed safety-net intent.
    const waiting = await h.mark();
    expect(await processRequest(requestId)).toBe(1);
    expect(requestAsks(requestId)).toHaveLength(0);
    expect(h.router.asks).toHaveLength(0);
    const deferred = await h.analysis(requestId);
    expect(deferred).toMatchObject({
      status: 'pending',
      attempts: 0,
      lastErrorCode: 'awaiting_extraction',
    });
    const safetyNet = await pending('analysis.process', waiting);
    expect(safetyNet).toHaveLength(1);
    expect(safetyNet[0]?.payload).toEqual({ analysisRequestId: requestId });
    expect(safetyNet[0]?.availableAt.getTime()).toBeGreaterThan(Date.now() + 4 * MINUTE);
    // A duplicate or early delivery changes nothing and costs nothing.
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    expect(h.router.asks).toHaveLength(0);
    expect((await requestRow(requestId)).input_sha).toBe(frozenSha);

    // The extraction starts no automatic chain; the selection is woken instead.
    const extracting = await h.mark();
    await extract(t.articleId);
    expect((await h.articleRow(t.articleId)).state).toBe('extracted');
    for (const queue of CHAIN) expect(await h.intents(queue, { since: extracting })).toEqual([]);
    // The delayed safety-net intent is made due (an identical pending one would coalesce a new one).
    const woken = await pending('analysis.process', waiting);
    expect(woken.map((intent) => intent.payload)).toEqual([{ analysisRequestId: requestId }]);
    expect(woken[0]?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());

    // The snapshot is recaptured only when the request runs.
    expect((await requestRow(requestId)).input_sha).toBe(frozenSha);
    await h.drain(['analysis.process'], (payload) => payload['analysisRequestId'] === requestId);

    const row = await requestRow(requestId);
    expect(row.input_snapshot.awaitingExtraction).toBeUndefined();
    expect(row.input_snapshot.article.lang).toBe('en');
    expect(row.input_snapshot.article.bodyLead).toContain('Solar panels keep getting cheaper');
    expect(row.input_snapshot.article.wordCount).toBeGreaterThan(0);
    expect(row.input_sha).not.toBe(frozenSha);

    // Exactly one enrich and one match ask, under the manual witness alone.
    const asks = requestAsks(requestId);
    expect(asks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect(h.router.asks).toHaveLength(2);
    expect(witnessesOf(asks)).toEqual({ users: [], requests: [requestId] });

    const done = await h.analysis(requestId);
    expect(done.status).toBe('complete');
    const result = done.resultSnapshot as {
      inputSha: string;
      match: { stateSha256: string; cards: Array<{ cardId: string }> };
    };
    expect(result.inputSha).toBe(row.input_sha);
    expect(result.match.cards.map((card) => card.cardId)).toEqual([t.cardId]);

    // The card answer is current for the live article state.
    const article = await loadClassificationArticle(h.db, t.articleId);
    if (article === null) throw new Error('no article');
    const live = buildState(
      modelInput(
        article,
        await listTranslations(h.db, t.articleId, article.revision),
        await loadClassificationConfig(h.db, h.settingsEnv),
      ),
      'match',
    );
    const stored = await h.owner.query<{ state_sha256: string }>(
      'SELECT state_sha256 FROM card_answers WHERE article_id = $1 AND card_id = $2',
      [t.articleId, t.cardId],
    );
    expect(stored.rows.map((r) => r.state_sha256)).toEqual([live.sha256]);
    expect(result.match.stateSha256).toBe(live.sha256);

    // Duplicate deliveries add no model asks.
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    await extract(t.articleId);
    await h.drain(['analysis.process', 'article.enrich', 'article.match', 'article.cluster']);
    expect(h.router.asks).toHaveLength(2);
  });

  it('runs on the excerpt once the 30-minute ceiling has passed', async () => {
    const t = await ingested();
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    const late = h.handlersWith({ now: () => new Date(Date.now() + 31 * MINUTE) });
    await dispatch(
      late,
      'analysis.process',
      { analysisRequestId: requestId },
      { queue: 'analysis.process', jobId: 'direct' },
    );
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect((await h.analysis(requestId)).status).toBe('complete');
    const row = await requestRow(requestId);
    expect(row.input_snapshot.awaitingExtraction).toBeUndefined();
    expect(row.input_snapshot.article.lang).toBeNull();
    expect(row.input_snapshot.article.bodyLead).toBeNull();
  });

  it('still runs when the extraction failed', async () => {
    const t = await ingested({ url: 'http://127.0.0.1:9/unreachable' });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    await processRequest(requestId);
    expect(h.router.asks).toHaveLength(0);
    await extract(t.articleId);
    expect((await h.articleRow(t.articleId)).state).toBe('extracted');
    await h.drain(['analysis.process', 'article.enrich', 'article.match', 'article.cluster']);
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect(h.router.asks).toHaveLength(2);
    expect((await h.analysis(requestId)).status).toBe('complete');
    expect((await requestRow(requestId)).input_snapshot.awaitingExtraction).toBeUndefined();
  });

  it('runs the frozen snapshot when the article moved to another revision', async () => {
    const t = await ingested();
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    await h.owner.query('UPDATE articles SET content_revision = 2 WHERE id = $1', [t.articleId]);
    await processRequest(requestId);
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect((await h.analysis(requestId)).status).toBe('complete');
    expect((await requestRow(requestId)).input_snapshot.awaitingExtraction).toBe(true);
  });
});

describe('selections that do not wait', () => {
  it('runs an already extracted selection at once, unflagged', async () => {
    const t = await ingested({ state: 'extracted' });
    const { requestId, snapshot } = await h.select(t.userId, t.feedId, t.articleId);
    expect(snapshot.awaitingExtraction).toBeUndefined();
    await processRequest(requestId);
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect((await h.analysis(requestId)).status).toBe('complete');
  });

  it('runs a stale selection at once, unflagged', async () => {
    const t = await ingested({ state: 'stale' });
    const { requestId, snapshot } = await h.select(t.userId, t.feedId, t.articleId);
    expect(snapshot.awaitingExtraction).toBeUndefined();
    await processRequest(requestId);
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect((await h.analysis(requestId)).status).toBe('complete');
  });

  it('still enriches automatically for an active feed', async () => {
    const t = await ingested({ mode: 'active', firstSeenAt: ago(DAY) });
    const since = await h.mark();
    await extract(t.articleId);
    expect(await pending('article.enrich', since, t.articleId)).toHaveLength(1);
    expect(await pending('analysis.process', since)).toEqual([]);
  });

  it('keeps the automatic chain for a manual request that did not wait', async () => {
    const t = await ingested({ state: 'extracted' });
    await h.select(t.userId, t.feedId, t.articleId);
    await h.owner.query(`UPDATE articles SET pipeline_state = 'ingested' WHERE id = $1`, [
      t.articleId,
    ]);
    const since = await h.mark();
    await extract(t.articleId);
    expect(await pending('article.enrich', since, t.articleId)).toHaveLength(1);
  });
});
