import { createArticle, createFeed, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { subscribeToFeed } from '../src/ingest/dev-cli.js';
import { workerOutbox } from '../src/outbox.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;
beforeAll(async () => {
  ctx = await setupDbTest();
});
afterAll(async () => {
  await ctx?.close();
});

it('the CLI subscription writer wakes an existing explicit rater once, in its state transaction', async () => {
  const feed = await createFeed(ctx.owner);
  const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
  const user = await createUser(ctx.owner);
  await ctx.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, 1, now())`,
    [user.id, article.id],
  );
  const subscribe = () =>
    ctx.worker.transaction((tx) =>
      subscribeToFeed(tx, workerOutbox(tx), {
        userId: user.id,
        url: feed.url,
        fetchUrl: feed.url,
        title: null,
      }),
    );
  expect((await subscribe()).createdSubscription).toBe(true);
  const pending = () =>
    ctx.owner.query(
      `SELECT 1 FROM job_outbox WHERE queue = 'user.estimate' AND payload->>'userId' = $1 AND delivered_at IS NULL`,
      [user.id],
    );
  expect((await pending()).rowCount).toBe(1);
  await ctx.owner.query(`DELETE FROM job_outbox`);
  expect((await subscribe()).createdSubscription).toBe(false);
  expect((await pending()).rowCount).toBe(0);
});
