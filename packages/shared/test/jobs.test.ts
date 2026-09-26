import { describe, expect, it } from 'vitest';

import {
  HOUSE_CRON_QUEUES,
  LAYA_QUEUES,
  QUEUES,
  QUEUE_NAMES,
  buildJobIntent,
  enqueueAnalysis,
  enqueueEnrich,
  enqueueFetch,
  enqueueHouse,
  enqueueRank,
  enqueueTranslate,
  parseJobPayload,
  resolveWorkerQueues,
  type JobIntent,
  type JobSender,
} from '../src/index.js';

const USER = '0190d4a7-1234-7abc-8def-0123456789ab';
const REQ = '0190d4a7-1234-7abc-8def-0123456789ac';

/** Queue → consumer concurrency from the spec 03 §2 table. */
const SPEC_03_QUEUES: Record<string, number> = {
  'feed.schedule': 1,
  'feed.fetch': 16,
  'article.extract': 8,
  'analysis.process': 4,
  'analysis.process.laya': 1,
  'article.capture-bookmark': 4,
  'article.translate': 4,
  'article.enrich': 8,
  'article.enrich.laya': 1,
  'article.cluster': 4,
  'article.match': 8,
  'card.backfill': 2,
  'user.rank': 4,
  'user.learn': 2,
  'user.suggest': 1,
  'house.rescore-degraded': 1,
  'house.expire-rules': 1,
  'house.purge-auth': 1,
  'house.reconcile': 1,
  'house.archive': 1,
  'house.purge-articles': 1,
  'house.purge-bodies': 1,
  'house.purge-engine-calls': 1,
  'house.retire-cards': 1,
  'house.purge-users': 1,
  'house.nightly-learn': 1,
  'house.metrics': 1,
  'house.alerts': 1,
  'provider.validate': 1,
  'house.reenrich': 1,
  'house.translate-cards': 1,
  'house.retranslate-skipped': 1,
  'house.rematch': 1,
};

function capture(): { sender: JobSender; intents: JobIntent[] } {
  const intents: JobIntent[] = [];
  return { intents, sender: { enqueue: (i) => (intents.push(i), Promise.resolve()) } };
}

describe('jobs registry (spec 03 §2)', () => {
  it('defines every queue of the spec with its concurrency, payload schema and options', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(Object.keys(SPEC_03_QUEUES).sort());
    for (const [name, concurrency] of Object.entries(SPEC_03_QUEUES)) {
      const q = QUEUES[name as keyof typeof QUEUES];
      expect(q.concurrency, name).toBe(concurrency);
      expect(q.payload, name).toBeDefined();
      expect(['standard', 'short', 'singleton', 'stately']).toContain(q.options.policy);
    }
  });

  it('uses the spec policies, retries and expirations', () => {
    expect(QUEUES['feed.schedule'].options).toMatchObject({ policy: 'standard', retryLimit: 0 });
    expect(QUEUES['feed.fetch'].options).toMatchObject({
      policy: 'stately',
      retryLimit: 0,
      expireInSeconds: 120,
    });
    expect(QUEUES['article.extract'].options).toMatchObject({
      policy: 'stately',
      retryLimit: 2,
      retryDelay: 30,
      expireInSeconds: 180,
    });
    expect(QUEUES['card.backfill'].options).toMatchObject({ policy: 'standard', retryLimit: 2 });
    expect(QUEUES['provider.validate'].options).toMatchObject({ policy: 'stately', retryLimit: 0 });
    for (const house of HOUSE_CRON_QUEUES) {
      expect(QUEUES[house].options).toMatchObject({ policy: 'singleton', retryLimit: 1 });
    }
    expect(QUEUES['house.reenrich'].options.policy).toBe('singleton');
    expect(QUEUES['house.retranslate-skipped'].options.policy).toBe('singleton');
  });

  it('excludes the dedicated Laya queues from WORKER_QUEUES=*', () => {
    expect([...LAYA_QUEUES].sort()).toEqual(['analysis.process.laya', 'article.enrich.laya']);
    const all = resolveWorkerQueues('*');
    expect(all).toHaveLength(QUEUE_NAMES.length - 2);
    expect(all).not.toContain('article.enrich.laya');
    expect(resolveWorkerQueues('article.enrich.laya,analysis.process.laya')).toEqual([
      'article.enrich.laya',
      'analysis.process.laya',
    ]);
    expect(() => resolveWorkerQueues('feed.fetch,unknown')).toThrow(/unknown/);
    expect(() => resolveWorkerQueues(' , ')).toThrow();
  });

  it('validates payloads strictly with bigint-safe string ids', () => {
    expect(parseJobPayload('feed.fetch', { feedId: '9223372036854775807' })).toEqual({
      feedId: '9223372036854775807',
    });
    expect(() => parseJobPayload('feed.fetch', { feedId: 42 })).toThrow();
    expect(() => parseJobPayload('feed.fetch', { feedId: '42', extra: 1 })).toThrow();
    expect(() => parseJobPayload('article.extract', { articleId: '0' })).toThrow();
    expect(() => parseJobPayload('user.rank', { userId: 'not-a-uuid', reason: 'match' })).toThrow();
    expect(() => parseJobPayload('house.metrics', { x: 1 })).toThrow();
    expect(() => parseJobPayload('house.retranslate-skipped', { reasons: ['nope'] })).toThrow();
  });

  it('uses the spec singleton and debounce keys', () => {
    expect(buildJobIntent('feed.fetch', { feedId: '7' }).send).toEqual({
      kind: 'send',
      singletonKey: 'feed:7',
    });
    expect(buildJobIntent('article.translate', { articleId: '5' }).send).toEqual({
      kind: 'send',
      singletonKey: 'translate:5',
    });
    expect(buildJobIntent('article.translate', { articleId: '5', forceTier2: true }).send).toEqual({
      kind: 'send',
      singletonKey: 'translate-t2:5',
    });
    expect(
      buildJobIntent('article.translate', { articleId: '5', replaceSkipped: true }).send,
    ).toEqual({ kind: 'send', singletonKey: 'retranslate:5' });
    expect(buildJobIntent('article.translate', { articleId: '5', modeChange: true }).send).toEqual({
      kind: 'send',
      singletonKey: 'translate-mode:5',
    });
    expect(buildJobIntent('user.rank', { userId: USER, reason: 'match' }).send).toEqual({
      kind: 'debounced',
      key: `rank:${USER}`,
      seconds: 3,
    });
    expect(buildJobIntent('user.rank', { userId: USER, reason: 'cards', full: true }).send).toEqual(
      { kind: 'send', singletonKey: `rank-full:${USER}` },
    );
    expect(buildJobIntent('user.learn', { userId: USER }).send).toEqual({
      kind: 'debounced',
      key: `learn:${USER}`,
      seconds: 60,
    });
    expect(buildJobIntent('analysis.process', { analysisRequestId: REQ }).send).toEqual({
      kind: 'send',
      singletonKey: `analysis:${REQ}`,
    });
    expect(
      buildJobIntent('provider.validate', { provider: 'ollama', candidateVersion: '3' }).send,
    ).toEqual({ kind: 'send', singletonKey: 'provider-validate:ollama:3' });
    expect(buildJobIntent('house.translate-cards', {}).send).toEqual({
      kind: 'send',
      singletonKey: 'translate-cards:all',
    });
    expect(buildJobIntent('house.rematch', { cardId: '9' }).send).toEqual({
      kind: 'send',
      singletonKey: 'rematch:9',
    });
    expect(buildJobIntent('card.backfill', { userId: USER, cardIds: ['1'] }).send).toEqual({
      kind: 'send',
    });
  });

  it('fingerprints the complete payload and revision for outbox deduplication', () => {
    const a = buildJobIntent('article.enrich', { articleId: '5' }, { revision: '2' });
    const b = buildJobIntent('article.enrich', { articleId: '5' }, { revision: '3' });
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    const inc = buildJobIntent('user.rank', { userId: USER, reason: 'match' });
    const full = buildJobIntent('user.rank', { userId: USER, reason: 'match', full: true });
    expect(inc.dedupeKey).not.toBe(full.dedupeKey);
    expect(buildJobIntent('card.backfill', { userId: USER, cardIds: ['1'] }).dedupeKey).not.toBe(
      buildJobIntent('card.backfill', { userId: USER, cardIds: ['2'] }).dedupeKey,
    );
  });

  it('enqueue helpers send validated intents through the JobSender', async () => {
    const { sender, intents } = capture();
    await enqueueFetch(sender, { feedId: '1', force: true });
    await enqueueRank(sender, { userId: USER, reason: 'ingest' });
    await enqueueEnrich(sender, { articleId: '3' }, { laya: true });
    await enqueueAnalysis(sender, { analysisRequestId: REQ });
    await enqueueTranslate(sender, { articleId: '4', forceTier2: true });
    await enqueueHouse(sender, 'house.reconcile');
    expect(intents.map((i) => i.queue)).toEqual([
      'feed.fetch',
      'user.rank',
      'article.enrich.laya',
      'analysis.process',
      'article.translate',
      'house.reconcile',
    ]);
    await expect(enqueueFetch(sender, { feedId: 'x' })).rejects.toThrow();
    expect(intents).toHaveLength(6);
  });
});
