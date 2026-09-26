import type { JobIntent, JobSender } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  NEXT_STAGES,
  STAGES,
  after,
  afterNewCarrier,
  type NewCarrierDemand,
  type PipelineGate,
} from '../src/pipeline.js';

function recorder(): JobSender & { intents: JobIntent[] } {
  const intents: JobIntent[] = [];
  return {
    intents,
    enqueue: async (intent) => {
      intents.push(intent);
    },
  };
}

function gate(
  overrides: Partial<{
    demand: boolean;
    translate: boolean;
    users: string[];
    carrier: NewCarrierDemand | null;
    queued: Array<{ articleId: string; revision: string; cardIds: readonly string[] }>;
  }> = {},
): PipelineGate {
  return {
    hasInferenceDemand: async () => overrides.demand ?? true,
    needsTranslation: async () => overrides.translate ?? false,
    usersToRank: async () => overrides.users ?? [],
    newCarrierDemand: async () => overrides.carrier ?? null,
    queueMatch: async (articleId, revision, cardIds) => {
      overrides.queued?.push({ articleId, revision, cardIds });
    },
  };
}

const U1 = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f61';
const U2 = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f62';

const queues = (sender: { intents: JobIntent[] }) => sender.intents.map((i) => i.queue);

describe('pipeline.after (spec 03 §1 stage order)', () => {
  it('lists the stages in pipeline order', () => {
    expect(STAGES).toEqual(['fetch', 'extract', 'translate', 'enrich', 'cluster', 'match', 'rank']);
    expect(NEXT_STAGES.cluster).toEqual(['rank']);
    expect(NEXT_STAGES.rank).toEqual([]);
  });

  it('fetch → extract, fingerprinted by the content revision', async () => {
    const sender = recorder();
    await after('fetch', '10', { status: 'ok', revision: '3' }, { sender, gate: gate() });
    expect(sender.intents).toEqual([
      {
        queue: 'article.extract',
        payload: { articleId: '10' },
        send: { kind: 'send', singletonKey: 'extract:10' },
        dedupeKey: '{"payload":{"articleId":"10"},"revision":"3"}',
      },
    ]);
  });

  it('extract → translate only when required, else enrich; nothing without inference demand', async () => {
    for (const status of ['ok', 'failed'] as const) {
      const translate = recorder();
      await after(
        'extract',
        '1',
        { status, revision: '1' },
        { sender: translate, gate: gate({ translate: true }) },
      );
      expect(queues(translate)).toEqual(['article.translate']);
      const enrich = recorder();
      await after('extract', '1', { status, revision: '1' }, { sender: enrich, gate: gate() });
      expect(queues(enrich)).toEqual(['article.enrich']);
      const off = recorder();
      await after(
        'extract',
        '1',
        { status, revision: '1' },
        { sender: off, gate: gate({ demand: false }) },
      );
      expect(queues(off)).toEqual([]);
    }
  });

  it('translate → enrich even when both tiers failed (native text)', async () => {
    const sender = recorder();
    await after('translate', '1', { status: 'failed', revision: '2' }, { sender, gate: gate() });
    expect(queues(sender)).toEqual(['article.enrich']);
  });

  it('enrich → cluster and match; a degraded or failed enrichment ranks every subscriber instead', async () => {
    const ok = recorder();
    await after('enrich', '1', { status: 'ok', revision: '1' }, { sender: ok, gate: gate() });
    expect(queues(ok)).toEqual(['article.cluster', 'article.match']);
    for (const status of ['degraded', 'invalid_request'] as const) {
      const sender = recorder();
      await after(
        'enrich',
        '1',
        { status, revision: '1' },
        { sender, gate: gate({ users: [U1, U2] }) },
      );
      expect(sender.intents.map((i) => [i.queue, i.payload])).toEqual([
        ['user.rank', { userId: U1, reason: 'degraded' }],
        ['user.rank', { userId: U2, reason: 'degraded' }],
      ]);
    }
  });

  it('match → rank for the affected users; rank ends the pipeline', async () => {
    const userId = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f60';
    const match = recorder();
    await after(
      'match',
      '1',
      { status: 'ok', revision: '1' },
      { sender: match, gate: gate({ users: [userId] }) },
    );
    expect(match.intents.map((i) => [i.queue, i.send])).toEqual([
      ['user.rank', { kind: 'debounced', key: `rank:${userId}`, seconds: 3 }],
    ]);
    const rank = recorder();
    await after(
      'rank',
      '1',
      { status: 'ok', revision: '1' },
      { sender: rank, gate: gate({ users: [userId] }) },
    );
    expect(queues(rank)).toEqual([]);
  });

  it('cluster → a full rank for the affected users only when the membership changed', async () => {
    const asked: string[] = [];
    const clusterGate: PipelineGate = {
      ...gate(),
      usersToRank: async (_articleId, stage) => {
        asked.push(stage);
        return [U1, U2];
      },
    };
    const changed = recorder();
    await after(
      'cluster',
      '1',
      { status: 'ok', revision: '1', clusterChanged: true },
      { sender: changed, gate: clusterGate },
    );
    expect(asked).toEqual(['cluster']);
    expect(changed.intents.map((i) => [i.queue, i.payload, i.send])).toEqual([
      [
        'user.rank',
        { userId: U1, reason: 'cluster', full: true },
        { kind: 'send', singletonKey: `rank-full:${U1}` },
      ],
      [
        'user.rank',
        { userId: U2, reason: 'cluster', full: true },
        { kind: 'send', singletonKey: `rank-full:${U2}` },
      ],
    ]);
    // A singleton, an unchanged re-delivery or a failed clustering leaves every ranking as it is.
    for (const outcome of [
      { status: 'ok', revision: '1' },
      { status: 'ok', revision: '1', clusterChanged: false },
      { status: 'failed', revision: '1' },
    ] as const) {
      const sender = recorder();
      await after('cluster', '1', outcome, { sender, gate: clusterGate });
      expect(queues(sender)).toEqual([]);
    }
    expect(asked).toEqual(['cluster']);
  });
});

describe('pipeline.afterNewCarrier (spec 03 §7, a feed newly carrying an article)', () => {
  const carrier = (overrides: Partial<NewCarrierDemand>): NewCarrierDemand => ({
    revision: '4',
    pipelineState: 'ingested',
    createsDemand: true,
    missingCardIds: [],
    subscriberIds: [U1, U2],
    ...overrides,
  });
  const ranks = [
    ['user.rank', { userId: U1, reason: 'ingest' }],
    ['user.rank', { userId: U2, reason: 'ingest' }],
  ];
  const run = async (
    demand: NewCarrierDemand | null,
    extra: Partial<{ translate: boolean }> = {},
  ) => {
    const sender = recorder();
    const queued: Array<{ articleId: string; revision: string; cardIds: readonly string[] }> = [];
    await afterNewCarrier('9', '5', {
      sender,
      gate: gate({ carrier: demand, queued, ...extra }),
    });
    return { intents: sender.intents.map((i) => [i.queue, i.payload]), queued, sender };
  };

  it('ranks the subscribers in every state, including stale and failed articles', async () => {
    for (const pipelineState of ['ingested', 'stale', 'failed']) {
      const { intents, queued } = await run(carrier({ pipelineState }));
      expect(intents).toEqual(ranks);
      expect(queued).toEqual([]);
    }
  });

  it('queues only the missing admitted cards of an enriched or matched article, then matches', async () => {
    for (const pipelineState of ['enriched', 'matched']) {
      const { intents, queued, sender } = await run(
        carrier({ pipelineState, missingCardIds: ['7', '8'] }),
      );
      expect(queued).toEqual([{ articleId: '9', revision: '4', cardIds: ['7', '8'] }]);
      expect(intents).toEqual([...ranks, ['article.match', { articleId: '9' }]]);
      expect(sender.intents.at(-1)?.dedupeKey).toBe('{"payload":{"articleId":"9"},"revision":"4"}');
      // Valid answers are reused: nothing missing, no match work.
      const none = await run(carrier({ pipelineState, missingCardIds: [] }));
      expect(none.intents).toEqual(ranks);
      expect(none.queued).toEqual([]);
    }
  });

  it('continues an article that stopped at the demand gate only for new eligible demand', async () => {
    expect((await run(carrier({ pipelineState: 'extracted' }))).intents).toEqual([
      ...ranks,
      ['article.enrich', { articleId: '9' }],
    ]);
    expect(
      (await run(carrier({ pipelineState: 'extracted' }), { translate: true })).intents,
    ).toEqual([...ranks, ['article.translate', { articleId: '9' }]]);
    expect((await run(carrier({ pipelineState: 'translated' }))).intents).toEqual([
      ...ranks,
      ['article.enrich', { articleId: '9' }],
    ]);
    for (const pipelineState of ['extracted', 'translated', 'degraded']) {
      expect((await run(carrier({ pipelineState, createsDemand: false }))).intents).toEqual(ranks);
    }
  });

  it('re-enriches a degraded article (never straight to matching)', async () => {
    const { intents, queued } = await run(
      carrier({ pipelineState: 'degraded', missingCardIds: ['7'] }),
    );
    expect(intents).toEqual([...ranks, ['article.enrich', { articleId: '9' }]]);
    expect(queued).toEqual([]);
  });

  it('does nothing when the association or article is gone', async () => {
    expect((await run(null)).intents).toEqual([]);
  });
});
