import {
  bindTenant,
  lockUserForVerify,
  restoreSoftDeletedUser,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import {
  buildJobIntent,
  enqueueEstimate,
  type JobPayloadInput,
  type QueueName,
} from '@bantoozi/shared';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pgBossBroker } from '../src/boss.js';
import { relayOnce, type JobBroker } from '../src/outbox-relay.js';
import { ClassifyHarness } from './support/classify.js';
import { EstimateWorld } from './support/estimate-world.js';

/**
 * EST-2 (visible-learning §4.4): which reader actions record `user.estimate {userId}`, how the
 * identical pending intents of one user coalesce, how the relay sends the intent (debounced per
 * user) and how a pending `rank-est:` job covers a second estimate refresh intent.
 */

let h: ClassifyHarness;
let w: EstimateWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = await EstimateWorld.create(h);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

beforeEach(async () => {
  await h.clearOutbox();
});

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const pendingEstimates = (userId: string) => w.pending('user.estimate', userId);

describe('actions that change an explicit rating record one user.estimate intent', () => {
  it('records it for a rating', async () => {
    const userId = await w.user();
    await w.rate(userId, 0, 1);
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
  });

  it('records it for an un-rate', async () => {
    const userId = await w.user();
    await w.setRating(userId, 0, 1);
    await w.rate(userId, 0, null);
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
  });

  it('records it for a prompt answer', async () => {
    const userId = await w.user();
    await w.answer(userId, 1, false);
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
  });

  it('records one for a bulk rate of several articles', async () => {
    const userId = await w.user();
    await w.rateBulk(userId, [0, 1, 2, 3], 1);
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
  });

  it('records it for the undo of a rating', async () => {
    const userId = await w.user();
    const { key } = await w.rate(userId, 0, 1);
    await h.clearOutbox();
    await w.undo(userId, key!);
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
  });

  it('records it for the undo of a bulk rate', async () => {
    const userId = await w.user();
    const { key } = await w.rateBulk(userId, [0, 1, 2], -1);
    await h.clearOutbox();
    await w.undo(userId, key!);
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
  });

  it('records one pending intent for 12 ratings in a row', async () => {
    const userId = await w.user();
    for (let i = 0; i < 12; i += 1) await w.rate(userId, i);
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
    const all = await h.intents('user.estimate');
    expect(all.filter((intent) => intent.payload['userId'] === userId)).toHaveLength(1);
  });

  it('records it when an account is restored', async () => {
    const userId = await w.user();
    await w.softDelete(userId);
    await h.clearOutbox();
    await h.db.transaction(async (tx) => {
      const row = await lockUserForVerify(tx, userId);
      expect(row?.restorable).toBe(true);
      await restoreSoftDeletedUser(await bindTenant(tx, userId));
    });
    expect(await pendingEstimates(userId)).toEqual([{ userId }]);
  });
});

describe('actions that leave the ratings alone record no user.estimate intent', () => {
  it('records none for a bookmark', async () => {
    const userId = await w.user();
    await w.bookmark(userId, 0);
    expect(await pendingEstimates(userId)).toEqual([]);
  });

  it('records none for an unbookmark', async () => {
    const userId = await w.user();
    await w.bookmark(userId, 0);
    await h.clearOutbox();
    await w.unbookmark(userId, 0);
    expect(await pendingEstimates(userId)).toEqual([]);
  });

  it('records none for the undo of a bookmark', async () => {
    const userId = await w.user();
    const { key } = await w.bookmark(userId, 0);
    await h.clearOutbox();
    await w.undo(userId, key!);
    expect(await pendingEstimates(userId)).toEqual([]);
  });

  it('records none for a label and an unlabel', async () => {
    const userId = await w.user();
    const labelId = await w.labelCard(userId);
    await w.label(userId, 0, labelId);
    expect(await pendingEstimates(userId)).toEqual([]);
    await w.unlabel(userId, 0, labelId);
    expect(await pendingEstimates(userId)).toEqual([]);
  });

  it('records none for marking an article read', async () => {
    const userId = await w.user();
    await w.markRead(userId, 0);
    expect(await pendingEstimates(userId)).toEqual([]);
  });

  it('records none for opening an article', async () => {
    const userId = await w.user();
    await w.open(userId, 0);
    expect(await pendingEstimates(userId)).toEqual([]);
  });

  it('records none for hiding an unrated article', async () => {
    const userId = await w.user();
    await w.hide(userId, 0);
    expect(await pendingEstimates(userId)).toEqual([]);
  });
});

/** A broker that records what the relay sends and accepts everything. */
function recordingBroker() {
  const sent: Array<{ queue: string; data: object; singletonKey: string | undefined }> = [];
  const debounced: Array<{ queue: string; data: object; seconds: number; key: string }> = [];
  const broker: JobBroker = {
    send: async (queue, data, singletonKey) => {
      sent.push({ queue, data, singletonKey });
      return 'job';
    },
    sendDebounced: async (queue, data, seconds, key) => {
      debounced.push({ queue, data, seconds, key });
      return 'job';
    },
  };
  return { broker, sent, debounced };
}

/** Everything except the estimate intents is delivered already: a relay pass sends only those. */
async function keepOnlyEstimateIntents(): Promise<void> {
  await h.owner.query(
    `UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL AND queue <> 'user.estimate'`,
  );
}

async function estimateRows(userId: string) {
  const result = await h.owner.query<{ delivered: boolean }>(
    `SELECT delivered_at IS NOT NULL AS delivered FROM job_outbox
      WHERE queue = 'user.estimate' AND payload->>'userId' = $1 ORDER BY id`,
    [userId],
  );
  return result.rows;
}

describe('relay of user.estimate', () => {
  it('sends an intent written directly debounced per user, 20 seconds', async () => {
    const userId = await w.user();
    await h.db.transaction(async (tx) => {
      await enqueueEstimate(workerOutbox(tx), { userId });
    });
    const { broker, sent, debounced } = recordingBroker();
    const report = await relayOnce(h.db, broker, { handlers: h.handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(debounced).toEqual([
      { queue: 'user.estimate', data: { userId }, seconds: 20, key: `estimate:${userId}` },
    ]);
  });

  it('sends the intent of a burst of 12 ratings once and marks every row delivered', async () => {
    const userId = await w.user();
    for (let i = 0; i < 12; i += 1) await w.rate(userId, i);
    await keepOnlyEstimateIntents();
    const { broker, debounced } = recordingBroker();
    await relayOnce(h.db, broker, { handlers: h.handlers, logger: silent });
    expect(debounced).toEqual([
      { queue: 'user.estimate', data: { userId }, seconds: 20, key: `estimate:${userId}` },
    ]);
    const rows = await estimateRows(userId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.delivered)).toBe(true);
    expect((await pendingEstimates(userId)).length).toBe(0);
  });
});

describe('a pending rank-est job covers an estimate refresh intent (real pg-boss)', () => {
  let boss: PgBoss;
  let broker: JobBroker;
  const db = (): Database => h.db;

  beforeAll(async () => {
    boss = new PgBoss({
      connectionString: h.testDb.urls.worker,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    broker = pgBossBroker(boss);
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
  });

  beforeEach(async () => {
    await h.owner.query('DELETE FROM pgboss.job');
  });

  async function enqueueRank(payload: JobPayloadInput<'user.rank'>) {
    await db().transaction(async (tx) => {
      await workerOutbox(tx).enqueue(buildJobIntent('user.rank', payload));
    });
  }

  async function pendingJobs(singletonKey: string, queue: QueueName = 'user.rank') {
    const result = await h.owner.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job
        WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry')`,
      [queue, singletonKey],
    );
    return result.rows;
  }

  const cursor = { arrival: '2026-10-01T10:00:00.000Z', articleId: '41' };
  const refreshed = { version: 3, up: 1, down: 0 };

  async function sendEstimateJob(userId: string) {
    return broker.send(
      'user.rank',
      { userId, reason: 'estimate', estimate: {} },
      `rank-est:${userId}`,
    );
  }

  it('delivers a second estimate refresh intent with another payload without a second job', async () => {
    const userId = await w.user();
    expect(await sendEstimateJob(userId)).not.toBeNull();
    await enqueueRank({ userId, reason: 'estimate', estimate: refreshed });
    const report = await relayOnce(db(), broker, { handlers: h.handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0, failed: 0 });
    const jobs = await pendingJobs(`rank-est:${userId}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ userId, estimate: {} });
  });

  it('does not let it cover a full-rank intent', async () => {
    const userId = await w.user();
    expect(await sendEstimateJob(userId)).not.toBeNull();
    await enqueueRank({ userId, reason: 'list', full: true });
    const report = await relayOnce(db(), broker, { handlers: h.handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect(await pendingJobs(`rank-full:${userId}`)).toHaveLength(1);
    expect(await pendingJobs(`rank-est:${userId}`)).toHaveLength(1);
  });

  it('does not let it cover an incremental rank intent', async () => {
    const userId = await w.user();
    expect(await sendEstimateJob(userId)).not.toBeNull();
    await enqueueRank({ userId, reason: 'match' });
    const report = await relayOnce(db(), broker, { handlers: h.handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect((await pendingJobs(`rank:${userId}`)).length).toBeGreaterThan(0);
    expect(await pendingJobs(`rank-est:${userId}`)).toHaveLength(1);
  });

  it('does not let it cover a continuation of the estimate refresh', async () => {
    const userId = await w.user();
    expect(await sendEstimateJob(userId)).not.toBeNull();
    await enqueueRank({
      userId,
      reason: 'rank-continuation',
      estimate: refreshed,
      snapshotAt: '2026-10-01T11:00:00.000Z',
      cursor,
    });
    const report = await relayOnce(db(), broker, { handlers: h.handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect(
      await pendingJobs(`rank-est-cont:${userId}:${cursor.arrival}:${cursor.articleId}`),
    ).toHaveLength(1);
    expect(await pendingJobs(`rank-est:${userId}`)).toHaveLength(1);
  });

  it('does not let another user pending refresh cover the intent', async () => {
    const userId = await w.user();
    const other = await w.user();
    expect(await sendEstimateJob(other)).not.toBeNull();
    await enqueueRank({ userId, reason: 'estimate', estimate: refreshed });
    const report = await relayOnce(db(), broker, { handlers: h.handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect(await pendingJobs(`rank-est:${userId}`)).toHaveLength(1);
    expect(await pendingJobs(`rank-est:${other}`)).toHaveLength(1);
  });
});
