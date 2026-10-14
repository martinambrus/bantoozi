import { randomUUID } from 'node:crypto';

import { enqueueCardDraft } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { tenantOutbox } from '../outbox.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, type RawTimestamp } from '../timestamps.js';
import { notFound } from './store.js';

/**
 * Card drafts (D-240): the API records one for articles its user can see and the worker's
 * `card.draft` job writes the proposed name and interest. A draft is only a proposal for the card
 * editor; nothing is created until the person saves the card.
 */

/** A user's drafts older than this are removed when they ask for a new one. */
export const CARD_DRAFT_TTL_HOURS = 24;
/** A pending draft older than this no longer authorizes a provider call: nobody waits for it. */
export const CARD_DRAFT_DEMAND_MINUTES = 30;

export type CardDraftStatus = 'pending' | 'complete' | 'failed';
export type CardDraftSource = 'llm' | 'fallback';

export interface CardDraftView {
  id: string;
  status: CardDraftStatus;
  title: string | null;
  interest: string | null;
  source: CardDraftSource | null;
}

/**
 * Record a draft of the tenant's articles and its `card.draft` intent. Every article must be one the
 * user can see (a subscribed feed carries it, or the user has reader state on it), as for "make a
 * card from this"; otherwise `404`. Drafts older than {@link CARD_DRAFT_TTL_HOURS} go first.
 */
export async function createCardDraft(
  tx: TenantTx,
  input: { articleIds: readonly string[]; locale: string },
): Promise<{ id: string }> {
  const userId = tenantUserId(tx);
  const visible = await tx.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM articles a
     WHERE a.id = ANY(${sql.param([...input.articleIds])}::bigint[])
       AND (EXISTS (SELECT 1 FROM feed_items fi
                      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${userId}::uuid
                     WHERE fi.article_id = a.id)
            OR EXISTS (SELECT 1 FROM user_article ua
                        WHERE ua.user_id = ${userId}::uuid AND ua.article_id = a.id))`);
  if (visible.rows.length !== new Set(input.articleIds).size) throw notFound('article');
  await tx.execute(sql`
    DELETE FROM card_drafts
     WHERE user_id = ${userId}::uuid
       AND created_at < now() - make_interval(hours => ${CARD_DRAFT_TTL_HOURS})`);
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO card_drafts (id, user_id, article_ids, locale)
    VALUES (${id}::uuid, ${userId}::uuid, ${sql.param([...input.articleIds])}::bigint[],
            ${input.locale})`);
  await enqueueCardDraft(tenantOutbox(tx), { draftId: id });
  return { id };
}

/** One of the tenant's drafts (RLS: another user's id reads as missing). */
export async function getCardDraft(tx: TenantTx, id: string): Promise<CardDraftView | null> {
  const result = await tx.execute<{
    id: string;
    status: CardDraftStatus;
    title: string | null;
    interest: string | null;
    source: CardDraftSource | null;
  }>(sql`
    SELECT id::text AS id, status, title, interest, source FROM card_drafts
     WHERE id = ${id}::uuid AND user_id = ${tenantUserId(tx)}::uuid`);
  return result.rows[0] ?? null;
}

/** What the worker needs to write a pending draft; null when it is gone or already answered. */
export interface CardDraftWork {
  id: string;
  userId: string;
  locale: string;
  articleIds: string[];
  createdAt: Date;
}

export async function loadCardDraftWork(db: Executor, id: string): Promise<CardDraftWork | null> {
  const result = await db.execute<{
    id: string;
    user_id: string;
    locale: string;
    article_ids: string[];
    created_at: RawTimestamp;
  }>(sql`
    SELECT id::text AS id, user_id::text AS user_id, locale,
           article_ids::text[] AS article_ids, created_at
      FROM card_drafts WHERE id = ${id}::uuid AND status = 'pending'`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        userId: row.user_id,
        locale: row.locale,
        articleIds: row.article_ids,
        createdAt: toDate(row.created_at),
      };
}

/** An article as a draft describes it: its own text and its enrichment facets, when any. */
export interface CardDraftArticle {
  id: string;
  title: string;
  excerpt: string | null;
  lang: string | null;
  /** The current enrichment features (`t1.*`, `t2.*` …), or null before enrichment. */
  facets: Record<string, unknown> | null;
}

/** The draft's articles in the order the user gave them; ones that went away are left out. */
export async function loadCardDraftArticles(
  db: Executor,
  articleIds: readonly string[],
): Promise<CardDraftArticle[]> {
  const result = await db.execute<{
    id: string;
    title: string;
    excerpt: string | null;
    lang: string | null;
    facets: Record<string, unknown> | null;
  }>(sql`
    SELECT a.id::text AS id, a.title, a.excerpt, a.lang, f.features AS facets
      FROM unnest(${sql.param([...articleIds])}::bigint[]) WITH ORDINALITY AS w(id, n)
      JOIN articles a ON a.id = w.id
      LEFT JOIN LATERAL (
        SELECT af.features FROM article_facets af
         WHERE af.article_id = a.id AND af.article_revision = a.content_revision
         ORDER BY af.updated_at DESC LIMIT 1) f ON true
     ORDER BY w.n`);
  return result.rows;
}

/**
 * Answer a pending draft once: `complete` with a name (may be null) and an interest, or `failed`.
 * Returns false when the draft was already answered or is gone.
 */
export async function finishCardDraft(
  db: Executor,
  id: string,
  answer:
    | { status: 'complete'; title: string | null; interest: string; source: CardDraftSource }
    | { status: 'failed'; errorCode: string },
): Promise<boolean> {
  const result =
    answer.status === 'complete'
      ? await db.execute(sql`
          UPDATE card_drafts
             SET status = 'complete', title = ${answer.title}, interest = ${answer.interest},
                 source = ${answer.source}, completed_at = now()
           WHERE id = ${id}::uuid AND status = 'pending'`)
      : await db.execute(sql`
          UPDATE card_drafts
             SET status = 'failed', error_code = ${answer.errorCode}, completed_at = now()
           WHERE id = ${id}::uuid AND status = 'pending'`);
  return (result.rowCount ?? 0) > 0;
}

/** The spend fence of a draft's provider call: still pending, recent, and its user's. */
export async function cardDraftAuthorized(
  db: Executor,
  authorization: { userId: string; draftId: string },
): Promise<boolean> {
  const result = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM card_drafts d JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL
       WHERE d.id = ${authorization.draftId}::uuid AND d.user_id = ${authorization.userId}::uuid
         AND d.status = 'pending'
         AND d.created_at > now() - make_interval(mins => ${CARD_DRAFT_DEMAND_MINUTES})) AS ok`);
  return result.rows[0]?.ok === true;
}
