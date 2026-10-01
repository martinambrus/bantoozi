import { createCard } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collected,
  goldenFeed,
  runCli,
  setupEvalTest,
  type EvalTestContext,
} from './sample-fixtures.js';

/**
 * M3a-T2 (spec 10 §2.1): `eval status` prints per-language sample counts, then per rater the cards
 * written, feeds picked, assigned, rated and skipped articles, and the facet-label counts per
 * language, reading `eval.raters`, `rater_cards`, `rater_feeds`, `assignments`, `ratings` and
 * `facet_labels` directly.
 */

let ctx: EvalTestContext;

async function rater(name: string, context: string | null, participant: string, langs: string[]) {
  const result = await ctx.owner.query<{ id: string }>(
    `INSERT INTO eval.raters (name, participant_key, context_name, token_hash, token_expires_at, langs)
     VALUES ($1, $2, $3, md5(random()::text), now() + interval '30 days', $4) RETURNING id::text AS id`,
    [name, participant, context, langs],
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await setupEvalTest();
  const en = await goldenFeed(ctx, 'status-en');
  const sk = await goldenFeed(ctx, 'status-sk');
  const enIds: string[] = [];
  const skIds: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    enIds.push(await collected(ctx, { feedIds: [en], lang: 'en', title: `en ${i}` }));
    skIds.push(await collected(ctx, { feedIds: [sk], lang: 'sk', title: `sk ${i}` }));
  }
  await collected(ctx, { feedIds: [en], lang: 'en', state: 'stale' });
  await runCli(ctx, ['sample', '--per-lang', '10', '--feed-cap', '1', '--langs', 'en,sk']);

  const participant = '11111111-2222-4333-8444-555555555555';
  const web = await rater('Owner', 'web development', participant, ['en', 'sk']);
  await rater('Owner', 'cooking', participant, ['sk']);
  for (let i = 0; i < 6; i += 1) {
    const card = await createCard(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO eval.rater_cards (rater_id, card_id, strength) VALUES ($1, $2, $3)`,
      [web, card.id, i === 5 ? 'never' : 'like'],
    );
  }
  await ctx.owner.query(
    `INSERT INTO eval.rater_feeds (rater_id, feed_id) VALUES ($1, $2), ($1, $3)`,
    [web, en, sk],
  );
  const assigned = [...enIds.slice(0, 5), ...skIds.slice(0, 3)];
  for (const [position, articleId] of assigned.entries()) {
    const status = position < 4 ? 'rated' : position === 4 ? 'skipped' : 'pending';
    await ctx.owner.query(
      `INSERT INTO eval.assignments (rater_id, article_id, position, status) VALUES ($1, $2, $3, $4)`,
      [web, articleId, position, status],
    );
    if (status === 'rated') {
      await ctx.owner.query(
        `INSERT INTO eval.ratings (rater_id, article_id, rating) VALUES ($1, $2, $3)`,
        [web, articleId, position % 2 === 0 ? 1 : -1],
      );
    }
  }
  for (const articleId of [enIds[0]!, enIds[1]!, skIds[0]!]) {
    for (const key of ['content_type', 'topic_l1', 'depth']) {
      await ctx.owner.query(
        `INSERT INTO eval.facet_labels (labeler, article_id, question_key, value) VALUES ('owner', $1, $2, 'x')`,
        [articleId, key],
      );
    }
  }
  await ctx.owner.query(
    `INSERT INTO eval.facet_labels (labeler, article_id, question_key, value) VALUES ('second', $1, 'depth', '2')`,
    [enIds[0]],
  );
});

afterAll(async () => {
  await ctx?.close();
});

describe('eval status (M3a-T2)', () => {
  it('prints per-language and per-rater counts and facet labels per language', async () => {
    const { out } = await runCli(ctx, ['status']);
    expect(out).toContain('dataset golden-v1, seed "golden-v1", open (no model run yet)');
    // en: 13 collected (one stale), 12 candidates, 10 sampled; sk: 12, 12, 10.
    expect(out).toMatch(/en\s+13\s+12\s+10\s+7\s+3/);
    expect(out).toMatch(/sk\s+12\s+12\s+10\s+7\s+3/);
    expect(out).toMatch(/all\s+25\s+24\s+20\s+14\s+6/);
    // cards 5 (+1 never), feeds 2, assigned 8, rated 4, skipped 1, pending 3, 2 likes, 2 dislikes.
    expect(out).toMatch(
      /\d+\s+Owner \(web development\)\s+11111111\s+en,sk\s+5\s+1\s+2\s+8\s+4\s+1\s+3\s+2\s+2/,
    );
    expect(out).toMatch(
      /\d+\s+Owner \(cooking\)\s+11111111\s+sk\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0/,
    );
    expect(out).toContain('2 context(s) of 1 participant(s)');
    expect(out).toMatch(/owner\s+en\s+2\s+6/);
    expect(out).toMatch(/owner\s+sk\s+1\s+3/);
    expect(out).toMatch(/second\s+en\s+1\s+1/);
  });

  it('shows a named version and rejects an unknown one', async () => {
    const { out } = await runCli(ctx, ['status', '--version', 'golden-v1']);
    expect(out).toContain('dataset golden-v1');
    await expect(runCli(ctx, ['status', '--version', 'golden-v9'])).rejects.toMatchObject({
      name: 'EvalCommandError',
      message: 'dataset version golden-v9 does not exist',
    });
  });
});
