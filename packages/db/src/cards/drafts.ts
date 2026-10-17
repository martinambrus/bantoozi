import { readerReleaseClock, releasedCarrier } from '../api/releases.js';
import { randomUUID } from 'node:crypto';

import { enqueueCardDraft, mostSimilarCard } from '@bantoozi/shared';
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
/** The kind of card a draft proposes (D-265). */
export type CardDraftKind = 'interest' | 'never';

export interface CardDraftView {
  id: string;
  status: CardDraftStatus;
  title: string | null;
  interest: string | null;
  source: CardDraftSource | null;
  /** A held card of the same kind the proposal restates (D-265), when there is one. */
  similar: { cardId: string; title: string } | null;
}

/** A held card's own text, as a draft compares or mentions it. */
export interface HeldCardText {
  cardId: string;
  title: string;
  interest: string;
}

/** At most this many of the user's cards go into a draft's prompt, newest classification first. */
export const CARD_DRAFT_CONTEXT_CARDS = 30;

/** The user's held cards of `kind` (Never cards, or every other strength), newest first. */
export async function heldCardTexts(
  db: Executor,
  userId: string,
  kind: CardDraftKind,
  limit?: number,
): Promise<HeldCardText[]> {
  const result = await db.execute<{ card_id: string; title: string; interest: string }>(sql`
    SELECT uc.card_id::text AS card_id, coalesce(uc.title_override, ic.title) AS title,
           coalesce(ic.body ->> 'interest', '') AS interest
      FROM user_cards uc JOIN interest_cards ic ON ic.id = uc.card_id
     WHERE uc.user_id = ${userId}::uuid
       AND ${kind === 'never' ? sql`uc.strength = 'never'` : sql`uc.strength <> 'never'`}
     ORDER BY uc.class_since DESC, uc.card_id DESC
     ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}`);
  return result.rows.map((row) => ({
    cardId: row.card_id,
    title: row.title,
    interest: row.interest,
  }));
}

/**
 * Record a draft of the tenant's articles and its `card.draft` intent. Every article must be one the
 * user can see (a subscribed feed carries it, or the user has reader state on it), as for "make a
 * card from this"; otherwise `404`. Drafts older than {@link CARD_DRAFT_TTL_HOURS} go first.
 *
 * The same articles, kind and language asked again reuse the user's latest draft of them while it
 * is complete, or pending and still awaited (D-265): the suggestion stays the same instead of a new
 * wording, and costs one provider call.
 */
export async function createCardDraft(
  tx: TenantTx,
  input: { articleIds: readonly string[]; locale: string; kind: CardDraftKind },
): Promise<{ id: string; reused: boolean }> {
  const userId = tenantUserId(tx);
  const clock = await readerReleaseClock(tx);
  const visible = await tx.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM articles a
     WHERE a.id = ANY(${sql.param([...input.articleIds])}::bigint[])
       AND (EXISTS (SELECT 1 FROM feed_items fi
                      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${userId}::uuid
                     WHERE fi.article_id = a.id AND ${releasedCarrier(clock)})
            OR EXISTS (SELECT 1 FROM user_article ua
                        WHERE ua.user_id = ${userId}::uuid AND ua.article_id = a.id
                          AND (ua.opened_at IS NOT NULL OR ua.read_at IS NOT NULL OR ua.rating IS NOT NULL OR ua.bookmarked_at IS NOT NULL OR cardinality(ua.label_ids) > 0)))`);
  if (visible.rows.length !== new Set(input.articleIds).size) throw notFound('article');
  await tx.execute(sql`
    DELETE FROM card_drafts
     WHERE user_id = ${userId}::uuid
       AND created_at < now() - make_interval(hours => ${CARD_DRAFT_TTL_HOURS})`);
  const reuse = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM card_drafts
     WHERE user_id = ${userId}::uuid AND kind = ${input.kind} AND locale = ${input.locale}
       AND article_ids = ${sql.param([...input.articleIds])}::bigint[]
       AND (status = 'complete'
            OR (status = 'pending'
                AND created_at > now() - make_interval(mins => ${CARD_DRAFT_DEMAND_MINUTES})))
     ORDER BY created_at DESC
     LIMIT 1`);
  const reused = reuse.rows[0]?.id;
  if (reused !== undefined) return { id: reused, reused: true };
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO card_drafts (id, user_id, article_ids, locale, kind)
    VALUES (${id}::uuid, ${userId}::uuid, ${sql.param([...input.articleIds])}::bigint[],
            ${input.locale}, ${input.kind})`);
  await enqueueCardDraft(tenantOutbox(tx), { draftId: id });
  return { id, reused: false };
}

/**
 * One of the tenant's drafts (RLS: another user's id reads as missing). A complete one names the
 * held card of its kind it restates, if any (D-265), against the cards held now.
 */
export async function getCardDraft(tx: TenantTx, id: string): Promise<CardDraftView | null> {
  const userId = tenantUserId(tx);
  const result = await tx.execute<{
    id: string;
    status: CardDraftStatus;
    title: string | null;
    interest: string | null;
    source: CardDraftSource | null;
    kind: CardDraftKind;
  }>(sql`
    SELECT id::text AS id, status, title, interest, source, kind FROM card_drafts
     WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`);
  const row = result.rows[0];
  if (row === undefined) return null;
  const { kind, ...draft } = row;
  if (draft.status !== 'complete' || draft.interest === null) return { ...draft, similar: null };
  const match = mostSimilarCard(
    { title: draft.title, interest: draft.interest },
    await heldCardTexts(tx, userId, kind),
  );
  return {
    ...draft,
    similar: match === null ? null : { cardId: match.card.cardId, title: match.card.title },
  };
}

/** What the worker needs to write a pending draft; null when it is gone or already answered. */
export interface CardDraftWork {
  id: string;
  userId: string;
  locale: string;
  kind: CardDraftKind;
  articleIds: string[];
  createdAt: Date;
}

export async function loadCardDraftWork(db: Executor, id: string): Promise<CardDraftWork | null> {
  const result = await db.execute<{
    id: string;
    user_id: string;
    locale: string;
    kind: CardDraftKind;
    article_ids: string[];
    created_at: RawTimestamp;
  }>(sql`
    SELECT id::text AS id, user_id::text AS user_id, locale, kind,
           article_ids::text[] AS article_ids, created_at
      FROM card_drafts WHERE id = ${id}::uuid AND status = 'pending'`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        userId: row.user_id,
        locale: row.locale,
        kind: row.kind,
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
