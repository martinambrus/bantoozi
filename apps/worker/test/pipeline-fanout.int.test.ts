import { workerOutbox } from '@bantoozi/db';
import { buildJobIntent } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { enqueueStaleEstimates } from '../src/estimate/sweep.js';
import { createNightlyLearnHandler } from '../src/handlers/house-nightly-learn.js';
import { loadLearnInputs } from '../src/learn/inputs.js';
import { after, afterNewCarrier, type PipelineGate } from '../src/pipeline.js';
import { loadRankerSettings } from '../src/rank/settings.js';
import { ClassifyHarness } from './support/classify.js';
import { EstimateWorld } from './support/estimate-world.js';

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

it('batches nightly learn and suggest per queue with each reader revision preserved', async () => {
  const w = await EstimateWorld.create(h);
  try {
    for (const [index, userId] of users.entries()) {
      await h.subscribe(userId, w.feedId, 'active');
      await w.rateClasses(userId, 6 + index, 6);
    }
    await h.owner.query('UPDATE users SET last_active_at = now() WHERE id = ANY($1::uuid[])', [
      users,
    ]);
    await w.setPreferences(users[0]!, { implicitFeedback: true });
    const now = new Date();
    await createNightlyLearnHandler({ ...h.deps, now: () => now })(
      {},
      {
        queue: 'house.nightly-learn',
        jobId: 'fanout',
      },
    );
    const revisions = new Map<string, string>();
    for (const userId of users) {
      revisions.set(userId, (await loadLearnInputs(h.db, h.deps, userId, now)).inputSha);
    }
    expect(new Set(revisions.values()).size).toBeGreaterThan(1);
    for (const queue of ['user.learn', 'user.suggest'] as const) {
      const rows = await h.owner.query(
        'SELECT queue, payload, dedupe_key, user_id FROM job_outbox WHERE queue = $1 AND delivered_at IS NULL ORDER BY id',
        [queue],
      );
      expect(rows.rows).toEqual(
        [...users].sort().map((userId) => {
          const revision =
            queue === 'user.learn'
              ? revisions.get(userId)!
              : `nightly:${now.toISOString().slice(0, 10)}`;
          const intent = buildJobIntent(queue, { userId }, { revision });
          return { queue, payload: intent.payload, dedupe_key: intent.dedupeKey, user_id: null };
        }),
      );
    }
    const statements = await h.owner.query('SELECT queues FROM test_outbox_statements ORDER BY id');
    expect(statements.rows).toEqual([
      { queues: ['user.learn'] },
      { queues: ['user.suggest'] },
      { queues: ['user.estimate'] },
    ]);
  } finally {
    await w.close();
  }
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

it('sweeps N due readers with one estimate INSERT per page in user order', async () => {
  const w = await EstimateWorld.create(h);
  try {
    for (const userId of users) {
      await h.subscribe(userId, w.feedId, 'active');
      await w.rateClasses(userId, 6, 6);
    }
    const { config } = await loadRankerSettings(h.db);
    const result = await enqueueStaleEstimates(h.deps, {
      now: new Date(),
      config,
      pageSize: 2,
    });
    expect(result).toMatchObject({ examined: 3, enqueued: 3, failed: 0 });
    const rows = await h.owner.query(
      'SELECT queue, payload, dedupe_key, user_id FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
    );
    expect(rows.rows).toEqual(
      [...users].sort().map((userId) => {
        const intent = buildJobIntent('user.estimate', { userId });
        return {
          queue: intent.queue,
          payload: intent.payload,
          dedupe_key: intent.dedupeKey,
          user_id: null,
        };
      }),
    );
    const statements = await h.owner.query('SELECT queues FROM test_outbox_statements ORDER BY id');
    expect(statements.rows).toEqual([{ queues: ['user.estimate'] }, { queues: ['user.estimate'] }]);
  } finally {
    await w.close();
  }
});
