import { workerOutbox } from '@bantoozi/db';
import { buildJobIntent } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { after, afterNewCarrier, type PipelineGate } from '../src/pipeline.js';
import { ClassifyHarness } from './support/classify.js';

let h: ClassifyHarness;
let users: string[];

beforeAll(async () => {
  h = await ClassifyHarness.start();
  users = [await h.user(), await h.user(), await h.user()].reverse();
  await h.owner.query(`
    CREATE TABLE test_outbox_statements (id bigint GENERATED ALWAYS AS IDENTITY, queues text[]);
    CREATE FUNCTION test_count_outbox_statements() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    BEGIN
      INSERT INTO test_outbox_statements (queues) SELECT array_agg(DISTINCT queue) FROM inserted;
      RETURN NULL;
    END $$;
    CREATE TRIGGER test_count_outbox_statements AFTER INSERT ON job_outbox
      REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT
      EXECUTE FUNCTION test_count_outbox_statements()`);
}, 240_000);

afterAll(async () => h?.close());
beforeEach(async () => {
  await h.clearOutbox();
  await h.owner.query('TRUNCATE test_outbox_statements');
});

it.each(['enrich', 'match', 'cluster', 'carry'] as const)(
  '%s ranks N subscribers with one INSERT, preserving input order and payloads',
  async (stage) => {
    const gate: PipelineGate = {
      hasInferenceDemand: async () => true,
      hasExtractionDemand: async () => true,
      pendingSelections: async () => [],
      needsTranslation: async () => false,
      usersToRank: async () => users,
      newCarrierDemand: async () => ({
        revision: '1',
        pipelineState: 'ingested',
        createsDemand: false,
        missingCardIds: [],
        subscriberIds: users,
      }),
      queueMatch: async () => {},
    };
    await h.db.transaction(async (tx) => {
      const context = { sender: workerOutbox(tx), gate };
      if (stage === 'carry') await afterNewCarrier('1', '1', context);
      else
        await after(
          stage,
          '1',
          stage === 'enrich'
            ? { status: 'degraded', revision: '1' }
            : { status: 'ok', revision: '1', clusterChanged: true },
          context,
        );
    });
    const rows = await h.owner.query(
      'SELECT queue, payload, dedupe_key, user_id FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
    );
    expect(rows.rows).toEqual(
      users.map((userId) => {
        const intent = buildJobIntent('user.rank', {
          userId,
          reason: stage === 'enrich' ? 'degraded' : stage === 'carry' ? 'ingest' : stage,
          ...(stage === 'cluster' ? { full: true } : {}),
        });
        return {
          queue: intent.queue,
          payload: intent.payload,
          dedupe_key: intent.dedupeKey,
          user_id: null,
        };
      }),
    );
    const statements = await h.owner.query('SELECT queues FROM test_outbox_statements ORDER BY id');
    expect(statements.rows).toEqual([{ queues: ['user.rank'] }]);
  },
);
