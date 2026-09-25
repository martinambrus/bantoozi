import type { JobIntent, JobSender } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { NEXT_STAGES, STAGES, after, type PipelineGate } from '../src/pipeline.js';

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
  overrides: Partial<{ demand: boolean; translate: boolean; users: string[] }> = {},
): PipelineGate {
  return {
    hasInferenceDemand: async () => overrides.demand ?? true,
    needsTranslation: async () => overrides.translate ?? false,
    usersToRank: async () => overrides.users ?? [],
  };
}

const U1 = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f61';
const U2 = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f62';

const queues = (sender: { intents: JobIntent[] }) => sender.intents.map((i) => i.queue);

describe('pipeline.after (spec 03 §1 stage order)', () => {
  it('lists the stages in pipeline order', () => {
    expect(STAGES).toEqual(['fetch', 'extract', 'translate', 'enrich', 'cluster', 'match', 'rank']);
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

  it('match → rank for the affected users; cluster and rank end the pipeline', async () => {
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
    for (const stage of ['cluster', 'rank'] as const) {
      const sender = recorder();
      await after(
        stage,
        '1',
        { status: 'ok', revision: '1' },
        { sender, gate: gate({ users: [userId] }) },
      );
      expect(queues(sender)).toEqual([]);
    }
  });
});
