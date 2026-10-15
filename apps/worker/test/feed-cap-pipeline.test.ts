import type { JobIntent, JobSender } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  after,
  afterNewCarrier,
  type NewCarrierDemand,
  type PipelineGate,
} from '../src/pipeline.js';

/**
 * D-252 (supersedes part of D-67): the automatic enrichment the pipeline starts after extract /
 * translate, and the degraded re-enrichment on a new carrier, run with priority `bulk` (no spend
 * headroom above the limit, no LLM fallback). Nothing else about the payload changes.
 */

function recorder(): JobSender & { intents: JobIntent[] } {
  const intents: JobIntent[] = [];
  return {
    intents,
    enqueue: async (intent) => {
      intents.push(intent);
    },
  };
}

function gate(carrier: NewCarrierDemand | null = null, translate = false): PipelineGate {
  return {
    hasInferenceDemand: async () => true,
    hasExtractionDemand: async () => true,
    pendingSelections: async () => [],
    needsTranslation: async () => translate,
    usersToRank: async () => [],
    newCarrierDemand: async () => carrier,
    queueMatch: async () => {},
  };
}

const enrichPayloads = (sender: { intents: JobIntent[] }) =>
  sender.intents.filter((i) => i.queue === 'article.enrich').map((i) => i.payload);

describe('automatic enrichment is bulk (D-252)', () => {
  it('extract → enrich carries priority bulk', async () => {
    const sender = recorder();
    await after('extract', '10', { status: 'ok', revision: '2' }, { sender, gate: gate() });
    expect(enrichPayloads(sender)).toEqual([{ articleId: '10', priority: 'bulk' }]);
  });

  it('a failed extraction still enriches in bulk', async () => {
    const sender = recorder();
    await after('extract', '10', { status: 'failed', revision: '2' }, { sender, gate: gate() });
    expect(enrichPayloads(sender)).toEqual([{ articleId: '10', priority: 'bulk' }]);
  });

  it('translate → enrich is bulk even when the translate job had no priority', async () => {
    const sender = recorder();
    await after('translate', '10', { status: 'ok', revision: '2' }, { sender, gate: gate() });
    expect(enrichPayloads(sender)).toEqual([{ articleId: '10', priority: 'bulk' }]);
  });

  it('a new carrier of a degraded article re-enriches in bulk', async () => {
    const sender = recorder();
    const demand: NewCarrierDemand = {
      revision: '4',
      pipelineState: 'degraded',
      createsDemand: true,
      missingCardIds: [],
      subscriberIds: [],
    };
    await afterNewCarrier('10', '5', { sender, gate: gate(demand) });
    expect(enrichPayloads(sender)).toEqual([{ articleId: '10', priority: 'bulk' }]);
  });

  it('a new carrier of an extracted or translated article continues in bulk', async () => {
    for (const pipelineState of ['extracted', 'translated']) {
      const sender = recorder();
      const demand: NewCarrierDemand = {
        revision: '4',
        pipelineState,
        createsDemand: true,
        missingCardIds: [],
        subscriberIds: [],
      };
      await afterNewCarrier('10', '5', { sender, gate: gate(demand) });
      expect(enrichPayloads(sender), pipelineState).toEqual([
        { articleId: '10', priority: 'bulk' },
      ]);
    }
  });
});
