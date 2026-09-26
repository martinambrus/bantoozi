import { createHash } from 'node:crypto';

import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
} from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ingestItem, type IngestItemInput } from '../../src/ingest/articles.js';
import { newCarrierDemand } from '../../src/ingest/carriers.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, sqlStateOf, type DbTestContext } from '../support/test-db.js';

/**
 * The demand of a newly inserted `feed_items` association (spec 03 §7 "A feed newly carrying an
 * already-processed article", spec 05 §1.1, §5.3): activation time, mode, account state and scope
 * are checked for the new carrier only, and answered pairs are not queued again.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let seq = 0;
const next = (): number => {
  seq += 1;
  return seq;
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (ids: readonly string[]) => [...ids].sort();

async function matchSetSha(): Promise<string> {
  const digest = sha(['match', next()]);
  await ctx.owner.query(
    `INSERT INTO question_sets (kind, version, sha256, definition) VALUES ('match', $1, $2, '{}')`,
    [`match-test-${digest.slice(0, 12)}`, digest],
  );
  return digest;
}

async function holdCard(
  userId: string,
  options: { scopeFeedId?: string; kind?: 'interest' | 'label' } = {},
): Promise<string> {
  const card = await createCard(ctx.owner, { kind: options.kind ?? 'interest' });
  if (options.kind === 'label') {
    await ctx.owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'L')`, [
      userId,
      card.id,
    ]);
  } else {
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES ($1, $2, 'like', $3)`,
      [userId, card.id, options.scopeFeedId ?? null],
    );
  }
  return card.id;
}

async function answerCard(
  articleId: string,
  cardId: string,
  engine: 'typesafe' | 'llm' | 'laya' | 'prefilter',
  revision: number,
  setSha: string,
): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                               state_sha256, card_input_sha256, state_variant)
     VALUES ($1, $2, 0.7, $3, $4, $5, 's', 'c', 'native')`,
    [articleId, cardId, engine, setSha, revision],
  );
}

async function setState(articleId: string, state: string, revision?: number): Promise<void> {
  await ctx.owner.query(
    `UPDATE articles SET pipeline_state = $2, content_revision = coalesce($3, content_revision)
      WHERE id = $1`,
    [articleId, state, revision ?? null],
  );
}

/**
 * An article first carried by `earlier`, newly carried (an hour ago) by `carrier` and by `quiet`.
 * `carrier` readers: `reader` (active since before the arrival), `offReader`, `trainee`, `late`
 * (activated after the arrival) and `gone` (a deleted account, active). `quiet` has the same
 * readers except `reader`. `otherReader` is active on `earlier` only.
 */
async function carrierFixture() {
  const earlier = await createFeed(ctx.owner);
  const carrier = await createFeed(ctx.owner);
  const quiet = await createFeed(ctx.owner);
  const reader = await createUser(ctx.owner);
  const offReader = await createUser(ctx.owner);
  const trainee = await createUser(ctx.owner);
  const late = await createUser(ctx.owner);
  const gone = await createUser(ctx.owner, { deletedAt: new Date() });
  const otherReader = await createUser(ctx.owner);
  for (const feedId of [carrier.id, quiet.id]) {
    await createSubscription(ctx.owner, { userId: offReader.id, feedId, mode: 'off' });
    await createSubscription(ctx.owner, { userId: trainee.id, feedId, mode: 'training' });
    await createSubscription(ctx.owner, {
      userId: late.id,
      feedId,
      mode: 'active',
      activatedAt: hoursAgo(0.5),
    });
    await createSubscription(ctx.owner, {
      userId: gone.id,
      feedId,
      mode: 'active',
      activatedAt: hoursAgo(3),
    });
  }
  await createSubscription(ctx.owner, {
    userId: reader.id,
    feedId: carrier.id,
    mode: 'active',
    activatedAt: hoursAgo(2),
  });
  await createSubscription(ctx.owner, { userId: reader.id, feedId: earlier.id, mode: 'off' });
  await createSubscription(ctx.owner, {
    userId: otherReader.id,
    feedId: earlier.id,
    mode: 'active',
    activatedAt: hoursAgo(9),
  });

  const article = await createArticle(ctx.owner, {
    feedIds: [earlier.id],
    firstSeenAt: hoursAgo(5),
  });
  for (const feedId of [carrier.id, quiet.id]) {
    await ctx.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, NULL, $3)`,
      [feedId, article.id, hoursAgo(1)],
    );
  }

  const cards = {
    everywhere: await holdCard(reader.id),
    scopedHere: await holdCard(reader.id, { scopeFeedId: carrier.id }),
    scopedElsewhere: await holdCard(reader.id, { scopeFeedId: earlier.id }),
    label: await holdCard(reader.id, { kind: 'label' }),
    viaLaya: await holdCard(reader.id),
    prefiltered: await holdCard(reader.id),
    offReaders: await holdCard(offReader.id),
    trainees: await holdCard(trainee.id),
    lateReaders: await holdCard(late.id),
    goneReaders: await holdCard(gone.id),
    otherFeedReaders: await holdCard(otherReader.id),
  };
  return {
    earlier,
    carrier,
    quiet,
    users: { reader, offReader, trainee, late, gone, otherReader },
    article,
    cards,
  };
}

describe('newCarrierDemand (spec 03 §7, spec 05 §5.3)', () => {
  it('lists the carrier’s admitted cards that lack a current primary answer (enriched, matched)', async () => {
    const f = await carrierFixture();
    const setSha = await matchSetSha();
    await setState(f.article.id, 'enriched', 2);
    await answerCard(f.article.id, f.cards.everywhere, 'typesafe', 2, setSha);
    await answerCard(f.article.id, f.cards.viaLaya, 'laya', 2, setSha);
    // Provisional and outdated answers do not satisfy a pair.
    await answerCard(f.article.id, f.cards.scopedHere, 'llm', 2, setSha);
    await answerCard(f.article.id, f.cards.prefiltered, 'prefilter', 2, setSha);
    await answerCard(f.article.id, f.cards.label, 'typesafe', 1, setSha);

    const expected = {
      articleId: f.article.id,
      feedId: f.carrier.id,
      revision: '2',
      createsDemand: true,
      subscriberIds: sorted([
        f.users.reader.id,
        f.users.offReader.id,
        f.users.trainee.id,
        f.users.late.id,
      ]),
    };
    // Off, training, late-activated and deleted readers, other carriers' readers and cards
    // scoped to another feed add nothing.
    const missing = sorted([f.cards.scopedHere, f.cards.prefiltered, f.cards.label]);
    for (const state of ['enriched', 'matched']) {
      await setState(f.article.id, state);
      const demand = await newCarrierDemand(ctx.worker, f.article.id, f.carrier.id);
      expect(demand).toMatchObject({ ...expected, pipelineState: state });
      expect(sorted(demand!.missingCardIds)).toEqual(missing);
    }
  });

  it('reports demand at the demand gate by mode, account and activation time', async () => {
    const f = await carrierFixture();
    for (const state of ['extracted', 'translated', 'degraded']) {
      await setState(f.article.id, state);
      expect(await newCarrierDemand(ctx.worker, f.article.id, f.carrier.id)).toMatchObject({
        pipelineState: state,
        createsDemand: true,
      });
      // Off, training, a deleted account and an activation after the arrival create no demand.
      expect(await newCarrierDemand(ctx.worker, f.article.id, f.quiet.id)).toMatchObject({
        pipelineState: state,
        createsDemand: false,
        missingCardIds: [],
        subscriberIds: sorted([f.users.offReader.id, f.users.trainee.id, f.users.late.id]),
      });
    }
    // The boundary is inclusive: an arrival at the activation instant is a new arrival.
    await ctx.owner.query(
      `UPDATE feed_items fi SET first_seen_at = s.inference_activated_at
         FROM subscriptions s
        WHERE s.user_id = $1 AND s.feed_id = fi.feed_id AND fi.feed_id = $2 AND fi.article_id = $3`,
      [f.users.late.id, f.quiet.id, f.article.id],
    );
    const boundary = await newCarrierDemand(ctx.worker, f.article.id, f.quiet.id);
    expect(boundary).toMatchObject({ createsDemand: true });
    expect(boundary!.missingCardIds).toEqual([f.cards.lateReaders]);
  });

  it('creates no demand for a stale article, whatever the subscriptions', async () => {
    const f = await carrierFixture();
    await setState(f.article.id, 'stale');
    expect(await newCarrierDemand(ctx.worker, f.article.id, f.carrier.id)).toMatchObject({
      pipelineState: 'stale',
      createsDemand: false,
      missingCardIds: [],
    });
    // Every other state reports the subscription facts; the pipeline decides what they start.
    for (const state of ['ingested', 'failed']) {
      await setState(f.article.id, state);
      expect(await newCarrierDemand(ctx.worker, f.article.id, f.carrier.id)).toMatchObject({
        pipelineState: state,
        createsDemand: true,
      });
    }
  });

  it('returns null when the association or the article does not exist', async () => {
    const f = await carrierFixture();
    const stranger = await createFeed(ctx.owner);
    expect(await newCarrierDemand(ctx.worker, f.article.id, stranger.id)).toBeNull();
    expect(await newCarrierDemand(ctx.worker, '999999999', f.carrier.id)).toBeNull();
  });

  it('resolves the demand of an association ingestItem just inserted, in the same transaction', async () => {
    const offFeed = await createFeed(ctx.owner);
    const activeFeed = await createFeed(ctx.owner);
    const offUser = await createUser(ctx.owner);
    const activeUser = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: offUser.id, feedId: offFeed.id, mode: 'off' });
    await createSubscription(ctx.owner, {
      userId: activeUser.id,
      feedId: activeFeed.id,
      mode: 'active',
      activatedAt: hoursAgo(1),
    });
    const activeCard = await holdCard(activeUser.id);
    await holdCard(offUser.id);
    const url = `https://news.example.test/carried/${next()}`;
    const input: IngestItemInput = {
      feedId: offFeed.id,
      urlKey: url,
      canonicalUrl: url,
      url,
      guid: `g-${next()}`,
      title: 'Carried',
      titleNorm: 'carried',
      author: null,
      categories: [],
      excerpt: 'Carried everywhere',
      excerptHtml: null,
      imageUrl: null,
      publishedAt: hoursAgo(2),
      contentHash: sha(url),
      feedBody: null,
    };
    const first = await ctx.worker.transaction((tx) =>
      ingestItem(tx, workerOutbox(tx), input, { maxAgeDays: 14 }),
    );
    // Only the off feed carried it: it stopped at the demand gate earlier and was matched since.
    await setState(first.articleId, 'matched');
    const { result, demand } = await ctx.worker.transaction(async (tx) => {
      const carried = await ingestItem(
        tx,
        workerOutbox(tx),
        { ...input, feedId: activeFeed.id, guid: null },
        { maxAgeDays: 14 },
      );
      return {
        result: carried,
        demand: await newCarrierDemand(tx, carried.articleId, activeFeed.id),
      };
    });
    expect(result).toMatchObject({
      articleId: first.articleId,
      outcome: 'existing',
      newAssociation: true,
    });
    expect(demand).toEqual({
      articleId: first.articleId,
      feedId: activeFeed.id,
      revision: '1',
      pipelineState: 'matched',
      createsDemand: true,
      missingCardIds: [activeCard],
      subscriberIds: [activeUser.id],
    });
  });

  it('share-locks the article until commit, so no reset can replace the revision meanwhile', async () => {
    const f = await carrierFixture();
    await ctx.worker.transaction(async (tx) => {
      await newCarrierDemand(tx, f.article.id, f.carrier.id);
      expect(
        await sqlStateOf(
          ctx.workerPool.query('SELECT 1 FROM articles WHERE id = $1 FOR UPDATE NOWAIT', [
            f.article.id,
          ]),
        ),
      ).toBe('55P03');
    });
    const after = await ctx.workerPool.query(
      'SELECT 1 FROM articles WHERE id = $1 FOR UPDATE NOWAIT',
      [f.article.id],
    );
    expect(after.rowCount).toBe(1);
  });
});
