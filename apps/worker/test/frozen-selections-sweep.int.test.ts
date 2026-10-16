import { createUserRankHandler } from '../src/handlers/user-rank.js';
import { enqueueEnrich, enqueueMatch } from '@bantoozi/shared';
import { workerOutbox } from '@bantoozi/db';
import { parseJobPayload } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness, DAY, HOUR, MINUTE, ago } from './support/classify.js';

/**
 * D-254 sweep: `house.reconcile` deletes `match_queue` rows that can never run (extracted/translated
 * articles with only a selection or no demand, unleased, older than an hour, with no undelivered
 * pipeline intent) and leaves every other row alone.
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

async function rowArticles(articleIds: readonly string[]): Promise<string[]> {
  const result = await h.owner.query<{ article_id: string }>(
    `SELECT DISTINCT article_id::text AS article_id FROM match_queue
      WHERE article_id = ANY($1::bigint[]) ORDER BY 1`,
    [articleIds],
  );
  return result.rows.map((row) => row.article_id);
}

async function age(articleId: string, by: number): Promise<void> {
  await h.owner.query(
    `UPDATE match_queue SET enqueued_at = now() - make_interval(secs => $2::double precision)
      WHERE article_id = $1`,
    [articleId, by / 1000],
  );
}

describe('house.reconcile sweeps rows that can never run (D-254)', () => {
  it('deletes stalled selection-only and demandless rows, keeps every control', async () => {
    const userId = await h.user();
    const card = await h.heldCard(userId);
    const training = await h.feed();
    const active = await h.feed();
    const dropped = await h.feed();
    await h.subscribe(userId, training, 'training');
    await h.subscribe(userId, active, 'active', ago(30 * DAY));
    await h.subscribe(userId, dropped, 'off');

    const mk = async (feedId: string, state: string, select: boolean) => {
      const id = await h.article({ feedIds: [feedId] });
      await h.enrichDirect(id, { state });
      if (select) await h.select(userId, feedId, id);
      await h.queue(id, [card], { userId });
      return id;
    };
    const selectionOnly = await mk(training, 'extracted', true);
    const translated = await mk(training, 'translated', true);
    const demandless = await mk(dropped, 'extracted', false);
    const young = await mk(training, 'extracted', true);
    const leased = await mk(training, 'extracted', true);
    const intent = await mk(training, 'extracted', true);
    const matchIntent = await mk(training, 'translated', true);
    const enriched = await mk(training, 'enriched', true);
    const arrival = await mk(active, 'extracted', false);
    const all = [
      selectionOnly,
      translated,
      demandless,
      young,
      leased,
      intent,
      matchIntent,
      enriched,
      arrival,
    ];
    for (const id of all) await age(id, 2 * HOUR);
    await age(young, 10 * MINUTE);
    await h.owner.query(
      `UPDATE match_queue SET lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes'
        WHERE article_id = $1`,
      [leased],
    );
    await h.clearOutbox();
    await h.db.transaction(async (tx) => {
      const sender = workerOutbox(tx);
      await enqueueEnrich(sender, { articleId: intent, priority: 'bulk' }, { revision: '1' });
      await enqueueMatch(sender, { articleId: matchIntent }, { revision: '1' });
    });

    await h.dispatch('house.reconcile', {});

    expect(await rowArticles(all)).toEqual(
      [young, leased, intent, matchIntent, enriched, arrival].sort(),
    );
    expect(h.router.asks).toEqual([]);
  });

  it('re-ranks the users whose stalled row it deleted, so the pending demotion clears', async () => {
    const userId = await h.user();
    const first = await h.heldCard(userId);
    const feedId = await h.feed();
    await h.subscribe(userId, feedId, 'training');
    const id = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(id, { state: 'extracted' });
    await h.answerCard(id, first, { engine: 'typesafe', p: 0.05 });
    const card = await h.heldCard(userId);
    await h.select(userId, feedId, id);
    await h.queue(id, [card], { userId });
    await age(id, 2 * HOUR);
    const rank = async () => {
      await createUserRankHandler(h.deps)(
        parseJobPayload('user.rank', { userId, reason: 'test', full: true }),
        { queue: 'user.rank', jobId: 'test' },
      );
      const result = await h.owner.query<{ rules_fired: string[] }>(
        `SELECT rules_fired FROM user_article WHERE user_id = $1 AND article_id = $2`,
        [userId, id],
      );
      return result.rows[0]?.rules_fired ?? [];
    };
    expect(await rank()).toContain('pending_cards');
    await h.clearOutbox();

    await h.dispatch('house.reconcile', {});

    expect(await rowArticles([id])).toEqual([]);
    const intents = await h.owner.query(
      `SELECT 1 FROM job_outbox
        WHERE queue = 'user.rank' AND delivered_at IS NULL AND payload ->> 'userId' = $1`,
      [userId],
    );
    expect(intents.rowCount).toBeGreaterThan(0);
    expect(await rank()).not.toContain('pending_cards');
  });
});
