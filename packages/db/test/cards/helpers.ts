import { randomUUID } from 'node:crypto';

import { isAppError } from '@bantoozi/shared';
import { cardTextHash } from '@bantoozi/shared/server';
import { createFeed, createSubscription, createUser } from '@bantoozi/testing';
import { expect } from 'vitest';

import { withTenant, type TenantTx } from '../../src/tenant.js';
import type { DbTestContext } from '../support/test-db.js';

/** Shared fixtures and assertions of the card repository tests (spec 05 §5.1). */

/** Decimal ids in numeric order. */
export const numeric = (ids: readonly string[]): string[] =>
  [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));

/** A reader with two active feeds, one training feed (no selection) and one off feed. */
export interface Reader {
  id: string;
  active: [string, string];
  training: string;
  off: string;
}

export async function createReader(
  ctx: DbTestContext,
  options: { plan?: 'beta' | 'admin' } = {},
): Promise<Reader> {
  const user = await createUser(
    ctx.owner,
    options.plan === undefined ? {} : { plan: options.plan },
  );
  const [a1, a2, training, off] = [
    await createFeed(ctx.owner),
    await createFeed(ctx.owner),
    await createFeed(ctx.owner),
    await createFeed(ctx.owner),
  ];
  await createSubscription(ctx.owner, { userId: user.id, feedId: a1.id, mode: 'active' });
  await createSubscription(ctx.owner, { userId: user.id, feedId: a2.id, mode: 'active' });
  await createSubscription(ctx.owner, { userId: user.id, feedId: training.id, mode: 'training' });
  await createSubscription(ctx.owner, { userId: user.id, feedId: off.id, mode: 'off' });
  return { id: user.id, active: [a1.id, a2.id], training: training.id, off: off.id };
}

/** `fn` in a committed tenant transaction of the API role (`bantoozi_app`, RLS enforced). */
export function asUser<T>(
  ctx: DbTestContext,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenant(ctx.app, userId, fn);
}

export interface Intent {
  queue: string;
  payload: Record<string, unknown>;
}

/**
 * The undelivered outbox intents `userId` requested, oldest first; they are then marked delivered,
 * so an identical later intent is recorded again (pending intents coalesce on their dedupe key).
 */
export async function takeOutbox(ctx: DbTestContext, userId: string): Promise<Intent[]> {
  const { rows } = await ctx.owner.query<{ id: string; queue: string; payload: Intent['payload'] }>(
    `SELECT id::text AS id, queue, payload FROM job_outbox
      WHERE user_id = $1 AND delivered_at IS NULL ORDER BY id`,
    [userId],
  );
  await ctx.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE id = ANY($1::bigint[])', [
    rows.map((r) => r.id),
  ]);
  return rows.map(({ queue, payload }) => ({ queue, payload }));
}

/** The intents of a card change with refresh/backfill/rank/learn (spec 05 §5.1). */
export function cardIntents(
  userId: string,
  options: {
    backfill?: { cardIds: string[]; feedIds: string[] };
    learn?: boolean;
    reason?: string;
  },
): Intent[] {
  return [
    ...(options.backfill === undefined
      ? []
      : [{ queue: 'card.backfill', payload: { userId, ...options.backfill } }]),
    {
      queue: 'user.rank',
      payload: { userId, reason: options.reason ?? 'cards', full: true },
    },
    ...(options.learn === false ? [] : [{ queue: 'user.learn', payload: { userId } }]),
  ];
}

export async function rankRevision(ctx: DbTestContext, userId: string): Promise<string> {
  const { rows } = await ctx.owner.query<{ rank_revision: string }>(
    'SELECT rank_revision FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.rank_revision ?? 'missing';
}

/** `feed_cards` rows of `feedIds` as `feed:card:holders`, sorted. */
export async function feedCards(ctx: DbTestContext, feedIds: readonly string[]): Promise<string[]> {
  const { rows } = await ctx.owner.query<{ row: string }>(
    `SELECT feed_id || ':' || card_id || ':' || holders AS row FROM feed_cards
      WHERE feed_id = ANY($1::bigint[]) ORDER BY feed_id, card_id`,
    [feedIds],
  );
  return rows.map((r) => r.row);
}

export interface StoredCard {
  id: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  text_hash: string;
  lang: string;
  topic_ids: string[];
  origin: string;
  visibility: string;
  parent_card_id: string | null;
  owner_user_id: string | null;
  creator_user_id: string | null;
  retired_at: Date | null;
}

export async function storedCard(ctx: DbTestContext, id: string): Promise<StoredCard> {
  const { rows } = await ctx.owner.query<StoredCard>(
    `SELECT id::text AS id, kind, title, body, text_hash, lang, topic_ids, origin, visibility,
            parent_card_id::text AS parent_card_id, owner_user_id::text AS owner_user_id,
            creator_user_id::text AS creator_user_id, retired_at
       FROM interest_cards WHERE id = $1`,
    [id],
  );
  const [row] = rows;
  if (row === undefined) throw new Error(`card ${id} is missing`);
  return row;
}

/** The user's holdings as `card:strength:scope:override`. */
export async function holdings(ctx: DbTestContext, userId: string): Promise<string[]> {
  const { rows } = await ctx.owner.query<{ row: string }>(
    `SELECT card_id || ':' || strength || ':' || coalesce(scope_feed_id::text, '*') || ':'
            || coalesce(title_override, '-') AS row
       FROM user_cards WHERE user_id = $1 ORDER BY card_id`,
    [userId],
  );
  return rows.map((r) => r.row);
}

/**
 * A card row inserted directly (as the owner), with examples and any provenance: library cards with
 * built-in examples, pre-existing forks for quota fixtures. The hash follows spec 05 §5.1.
 */
export async function insertCard(
  ctx: DbTestContext,
  card: {
    kind?: 'interest' | 'label';
    visibility: 'public' | 'shared' | 'private';
    origin?: 'library' | 'user' | 'fork';
    title?: string;
    interest: string;
    notFor?: string | null;
    examplesYes?: string[];
    examplesNo?: string[];
    ownerUserId?: string | null;
    creatorUserId?: string | null;
    parentCardId?: string | null;
    slug?: string | null;
  },
): Promise<string> {
  const kind = card.kind ?? 'interest';
  const title = card.title ?? card.interest.slice(0, 60);
  const owner = card.visibility === 'private' ? (card.ownerUserId ?? null) : null;
  const textHash = cardTextHash({
    kind,
    title,
    interest: card.interest,
    not_for: card.notFor ?? null,
    examples_yes: card.examplesYes ?? [],
    examples_no: card.examplesNo ?? [],
    visibility: card.visibility,
    owner_user_id: owner,
  });
  const body = {
    interest: card.interest,
    not_for: card.notFor ?? null,
    interest_en: null,
    not_for_en: null,
    examples_yes: card.examplesYes ?? [],
    examples_no: card.examplesNo ?? [],
  };
  const origin =
    card.origin ??
    (card.visibility === 'private' ? 'fork' : card.visibility === 'public' ? 'library' : 'user');
  const { rows } = await ctx.owner.query<{ id: string }>(
    `INSERT INTO interest_cards (kind, slug, title, body, text_hash, origin, visibility, parent_card_id,
                                 owner_user_id, creator_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
    [
      kind,
      card.slug ?? null,
      title,
      JSON.stringify(body),
      textHash,
      origin,
      card.visibility,
      card.parentCardId ?? null,
      owner,
      card.creatorUserId === undefined ? owner : card.creatorUserId,
    ],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('card insert returned nothing');
  return row.id;
}

/** A pending selected analysis request (spec 05 §1.1 manual demand) for a training feed article. */
export async function selectArticle(
  ctx: DbTestContext,
  input: { userId: string; feedId: string; articleId: string },
): Promise<string> {
  const id = randomUUID();
  const client = await ctx.owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [input.userId]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       SELECT $1, $2, $3, a.id, a.content_revision, s.inference_version, '{"article":"frozen"}',
              encode(sha256(convert_to('{"article":"frozen"}'::jsonb::text, 'UTF8')), 'hex')
         FROM articles a JOIN subscriptions s ON s.user_id = $2 AND s.feed_id = $3
        WHERE a.id = $4`,
      [id, input.userId, input.feedId, input.articleId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

/** The application error a promise rejects with (fails when it resolves or throws another error). */
export async function appErrorOf(
  promise: Promise<unknown>,
): Promise<{ code: string; details: Record<string, unknown> | undefined }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error('expected an application error');
}

/** Every row of `interest_cards` as its immutable identity (all but `retired_at`/metadata). */
export async function cardIdentities(ctx: DbTestContext): Promise<Map<string, string>> {
  const { rows } = await ctx.owner.query<{ id: string; identity: string }>(
    `SELECT id::text AS id,
            jsonb_build_array(kind, text_hash, lang, origin, visibility, owner_user_id,
                              creator_user_id, parent_card_id, created_at, body,
                              CASE WHEN kind = 'label' THEN title END)::text AS identity
       FROM interest_cards`,
  );
  return new Map(rows.map((r) => [r.id, r.identity]));
}

/** Assert that every card of `before` still has exactly the same identity (spec 05 §5.1). */
export async function expectCardsUnchanged(
  ctx: DbTestContext,
  before: Map<string, string>,
): Promise<void> {
  const after = await cardIdentities(ctx);
  for (const [id, identity] of before) {
    expect(after.get(id), `card ${id}`).toBe(identity);
  }
}
