import { createDatabase, seedQuestionSets } from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  LATEST_QUESTION_SETS,
  QUESTION_SET_KINDS,
  type QuestionSetKind,
} from '@bantoozi/questions';
import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M8-T2 API half of `house.translate-cards` (spec 07 §5, spec 11 §6): while
 * `card_text_mode = 'english'`, each event that gives a user's cards new authorized demand records
 * `house.translate-cards {userId}` in the same transaction: activating a feed
 * (`POST /subscriptions/:feedId/inference`) and selecting articles
 * (`POST /subscriptions/:feedId/analyze`). Nothing is recorded while card text is as written. The
 * worker half is tested in `apps/worker/test/house-translate.int.test.ts`.
 */

let h: ApiHarness;

const SLOVAK_INTEREST =
  'Nové chémie batérií pre elektrické autá, ich výroba a výskum na Slovensku a v Česku';

beforeAll(async () => {
  h = await createApiHarness();
  const versions = {} as Record<QuestionSetKind, string>;
  for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
  await createDatabase(h.owner).transaction((tx) =>
    seedQuestionSets(tx, ALL_QUESTION_SETS, versions),
  );
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
});

async function setCardTextMode(mode: 'as_written' | 'english'): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('card_text_mode', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(mode)],
  );
}

let sequence = 0;

/** A user with an off subscription and a Slovak card that still lacks its English pair. */
async function holder(): Promise<{ user: TestUser; feedId: string; articleId: string }> {
  const user = await createTestUser(h, { locale: 'sk' });
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
  const card = await createCard(h.owner, {
    visibility: 'shared',
    lang: 'sk',
    interest: `${SLOVAK_INTEREST} ${(sequence += 1)}`,
  });
  await h.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
    [user.id, card.id],
  );
  const article = await createArticle(h.owner, { feedIds: [feed.id] });
  return { user, feedId: feed.id, articleId: article.id };
}

/** The `house.translate-cards` intents recorded for the user (delivered or not). */
async function translateIntents(userId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await h.owner.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM job_outbox
      WHERE queue = 'house.translate-cards' AND payload->>'userId' = $1 ORDER BY id`,
    [userId],
  );
  return rows.map((row) => row.payload);
}

const activate = (user: TestUser, feedId: string) =>
  apiClient(h.server, user).post(`/subscriptions/${feedId}/inference`, {
    mode: 'active',
    expectedVersion: '0',
  });

const select = (user: TestUser, feedId: string, articleId: string) =>
  apiClient(h.server, user).post(`/subscriptions/${feedId}/analyze`, {
    articles: [{ id: articleId, contentRevision: '1' }],
    expectedInferenceVersion: '0',
    startTraining: true,
  });

describe("card_text_mode = 'english'", () => {
  it('records house.translate-cards {userId} when the user activates a feed', async () => {
    await setCardTextMode('english');
    const { user, feedId } = await holder();
    const res = await activate(user, feedId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().subscription.inferenceMode).toBe('active');
    expect(await translateIntents(user.id)).toEqual([{ userId: user.id }]);
  });

  it('records house.translate-cards {userId} when the user selects articles', async () => {
    await setCardTextMode('english');
    const { user, feedId, articleId } = await holder();
    const res = await select(user, feedId, articleId);
    expect(res.statusCode, res.body).toBe(202);
    expect(await translateIntents(user.id)).toEqual([{ userId: user.id }]);
  });

  it('records it for the acting user only', async () => {
    await setCardTextMode('english');
    const actor = await holder();
    const bystander = await holder();
    expect((await activate(actor.user, actor.feedId)).statusCode).toBe(200);
    expect(await translateIntents(actor.user.id)).toEqual([{ userId: actor.user.id }]);
    expect(await translateIntents(bystander.user.id)).toEqual([]);
  });
});

describe("card_text_mode = 'as_written'", () => {
  it('records nothing when the user activates a feed', async () => {
    await setCardTextMode('as_written');
    const { user, feedId } = await holder();
    expect((await activate(user, feedId)).statusCode).toBe(200);
    expect(await translateIntents(user.id)).toEqual([]);
  });

  it('records nothing when the user selects articles', async () => {
    await setCardTextMode('as_written');
    const { user, feedId, articleId } = await holder();
    expect((await select(user, feedId, articleId)).statusCode).toBe(202);
    expect(await translateIntents(user.id)).toEqual([]);
  });
});
