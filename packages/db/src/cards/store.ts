import {
  AppError,
  CardTextModeSchema,
  compareBigIntStrings,
  enqueueBackfill,
  enqueueLearn,
  enqueueTranslateCards,
  planLimits,
  QuotaExceededError,
  type PlanLimits,
} from '@bantoozi/shared';
import { cardTextHash, normCardText } from '@bantoozi/shared/server';
import { sql } from 'drizzle-orm';

import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { recordRankIntents } from '../ingest/rank-intents.js';
import { tenantOutbox } from '../outbox.js';
import { readStoredSetting } from '../settings.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import {
  examplesOf,
  hasExamples,
  parseCardBody,
  sameCardText,
  serializeCardBody,
  translationOf,
  type ParsedCardBody,
  type CardExamples,
} from './body.js';
import type { CardEffects, CardIdChange, CardKind, CardOrigin, CardVisibility } from './types.js';
import {
  exampleFromArticleTitle,
  invalidField,
  type CardStrength,
  type CardTranslationPair,
} from './validation.js';

/**
 * Shared internals of the card lifecycle (spec 05 §5.1, §5.3; spec 02 §5.2, §6 "Callers"). Every
 * mutation runs in the caller's `TenantTx` in the documented lock order: the user's `users` row
 * first (`FOR NO KEY UPDATE`, which also serializes it with the deferred label checks), then the
 * affected feed rows in numeric order, then card rows (reuse takes the card row lock that
 * `house.retire-cards` also takes). Ownership, kind, scope and quotas are rechecked after the locks.
 */

// ── Errors ────────────────────────────────────────────────────────────────────────────────────────

/** `404 NOT_FOUND`: a card, label, article or holding this user cannot use (no private detail). */
export function notFound(what: string): AppError {
  return new AppError('NOT_FOUND', `${what} not found`, { details: { resource: what } });
}

const CONFLICT_MESSAGES: Readonly<Record<string, string>> = {
  already_held: 'The card is already held with different settings',
  target_held: 'The resulting card is already held with different settings',
  superseded: 'A newer version of this library card exists',
  private_holding: 'A private customization is held; edit it explicitly instead',
  holding_mismatch: 'The expected current card is not the held library version',
  card_contention: 'The card changed concurrently; retry',
};

/** `409 CONFLICT` with a machine-readable `reason` (documented per function). */
export function conflict(reason: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('CONFLICT', CONFLICT_MESSAGES[reason] ?? 'Conflicting card state', {
    details: { reason, ...details },
  });
}

// ── Ids ───────────────────────────────────────────────────────────────────────────────────────────

/** Decimal id strings in numeric order, without duplicates. */
export function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareBigIntStrings);
}

// ── Tenant ────────────────────────────────────────────────────────────────────────────────────────

export interface Tenant {
  userId: string;
  limits: Readonly<PlanLimits>;
}

/**
 * Lock the tenant's `users` row (first in the lock order) and read its plan. A soft-deleted or
 * missing account cannot change cards.
 */
export async function lockTenant(tx: TenantTx): Promise<Tenant> {
  const userId = tenantUserId(tx);
  const result = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`);
  const row = result.rows[0];
  if (row === undefined) throw new AppError('UNAUTHENTICATED', 'No active account');
  return { userId, limits: planLimits(row.plan) };
}

// ── Card rows ─────────────────────────────────────────────────────────────────────────────────────

/** An `interest_cards` row as the tenant sees it. */
export interface CardRow {
  id: string;
  kind: CardKind;
  title: string;
  body: ParsedCardBody;
  textHash: string;
  lang: string;
  topicIds: string[];
  origin: CardOrigin;
  visibility: CardVisibility;
  parentCardId: string | null;
  ownerUserId: string | null;
  slug: string | null;
  i18n: Record<string, unknown>;
  retired: boolean;
}

// A type alias (not an interface) so it satisfies the row constraint of `execute`.
type CardSqlRow = {
  id: string;
  kind: CardKind;
  title: string;
  body: unknown;
  text_hash: string;
  lang: string;
  topic_ids: string[];
  origin: CardOrigin;
  visibility: CardVisibility;
  parent_card_id: string | null;
  owner_user_id: string | null;
  slug: string | null;
  i18n: unknown;
  retired: boolean;
};

const CARD_COLUMNS = sql.raw(`c.id::text AS id, c.kind, c.title, c.body, c.text_hash, c.lang,
  c.topic_ids, c.origin, c.visibility, c.parent_card_id::text AS parent_card_id,
  c.owner_user_id::text AS owner_user_id, c.slug, c.i18n, c.retired_at IS NOT NULL AS retired`);

function cardRow(row: CardSqlRow): CardRow {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: parseCardBody(row.body),
    textHash: row.text_hash,
    lang: row.lang,
    topicIds: row.topic_ids,
    origin: row.origin,
    visibility: row.visibility,
    parentCardId: row.parent_card_id,
    ownerUserId: row.owner_user_id,
    slug: row.slug,
    i18n:
      typeof row.i18n === 'object' && row.i18n !== null && !Array.isArray(row.i18n)
        ? (row.i18n as Record<string, unknown>)
        : {},
    retired: row.retired,
  };
}

/**
 * A card the tenant may read (RLS: public, shared, or the tenant's own private fork). Another
 * user's fork is indistinguishable from a missing id.
 */
export async function loadCard(tx: TenantTx, cardId: string): Promise<CardRow | null> {
  const result = await tx.execute<CardSqlRow>(
    sql`SELECT ${CARD_COLUMNS} FROM interest_cards c WHERE c.id = ${cardId}::bigint`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const card = cardRow(row);
  // Defense in depth: never act on a private row of another owner, whatever the session policy.
  if (card.visibility === 'private' && card.ownerUserId !== tenantUserId(tx)) return null;
  return card;
}

/** A readable card of `kind`, else `404`. */
export async function requireCard(tx: TenantTx, cardId: string, kind: CardKind): Promise<CardRow> {
  const card = await loadCard(tx, cardId);
  if (card === null || card.kind !== kind) throw notFound(kind === 'label' ? 'label' : 'card');
  return card;
}

/** The text and provenance of a card row to create or reuse by `text_hash`. */
export interface CardSpec {
  kind: CardKind;
  /** The row's title if inserted; for a label it is hashed text (spec 05 §5.1). */
  title: string;
  interest: string;
  notFor: string | null;
  examplesYes: readonly string[];
  examplesNo: readonly string[];
  /** A private fork owned by the tenant; otherwise a shared text row. */
  private: boolean;
  parentCardId: string | null;
  lang: string;
  topicIds: readonly string[];
  i18n: Record<string, unknown>;
  /** Stored only when this call inserts the row; a reused row keeps its own pair. */
  translation: CardTranslationPair | null;
}

/** The private fork of `base` with `examples` (spec 05 §5.1 "Forks"). */
export function forkSpec(base: CardRow, examples: CardExamples): CardSpec {
  return {
    kind: base.kind,
    title: base.title,
    interest: base.body.interest,
    notFor: base.body.notFor,
    examplesYes: examples.yes,
    examplesNo: examples.no,
    private: true,
    // Always the original shared/library card: a fork of a fork points at the same parent.
    parentCardId: base.visibility === 'private' ? base.parentCardId : base.id,
    lang: base.lang,
    topicIds: base.topicIds,
    i18n: base.i18n,
    translation: translationOf(base.body),
  };
}

/** The shared text-only card of `base`'s text (a fork whose last example was removed). */
export function textOnlySpec(base: CardRow): CardSpec {
  return {
    kind: base.kind,
    title: base.title,
    interest: base.body.interest,
    notFor: base.body.notFor,
    examplesYes: [],
    examplesNo: [],
    private: false,
    parentCardId: null,
    lang: base.lang,
    topicIds: [],
    i18n: {},
    translation: translationOf(base.body),
  };
}

/**
 * The card an example edit leads to (spec 05 §5.1): the user's private fork of `current`'s text with
 * `examples`. When no example remains and `current` is a fork of a text-only original with the same
 * text, that original (reused by hash, un-retired if needed) instead of an empty private fork.
 */
export async function exampleTarget(
  tx: TenantTx,
  userId: string,
  current: CardRow,
  examples: CardExamples,
): Promise<CardRow> {
  if (!hasExamples(examples) && current.visibility === 'private' && current.parentCardId !== null) {
    const parent = await loadCard(tx, current.parentCardId);
    if (
      parent !== null &&
      parent.kind === current.kind &&
      !hasExamples(examplesOf(parent.body)) &&
      sameCardText(parent.body, current.body) &&
      (current.kind !== 'label' || normCardText(parent.title) === normCardText(current.title))
    ) {
      return (await obtainCard(tx, userId, textOnlySpec(current))).card;
    }
  }
  return (await obtainCard(tx, userId, forkSpec(current, examples))).card;
}

/**
 * The examples an edit of `current`'s text carries over: the user's own (a private fork's). A
 * library card's built-in examples belong to its text and do not follow an edit.
 */
export function carriedExamples(current: CardRow): CardExamples {
  return current.visibility === 'private' ? examplesOf(current.body) : { yes: [], no: [] };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((e, i) => e === b[i]);
}

/** Whether a stored row carries exactly the spec's hashed text (guards against a hash collision). */
function matchesSpec(card: CardRow, spec: CardSpec, userId: string): boolean {
  const access = spec.private
    ? card.visibility === 'private' && card.ownerUserId === userId
    : card.visibility !== 'private';
  return (
    access &&
    card.kind === spec.kind &&
    normCardText(card.body.interest) === normCardText(spec.interest) &&
    normCardText(card.body.notFor ?? '') === normCardText(spec.notFor ?? '') &&
    (spec.kind !== 'label' || normCardText(card.title) === normCardText(spec.title)) &&
    sameList(card.body.examplesYes, spec.examplesYes) &&
    sameList(card.body.examplesNo, spec.examplesNo)
  );
}

/** Attempts before a card row that keeps vanishing under a concurrent delete is a conflict. */
const OBTAIN_ATTEMPTS = 3;

/**
 * Create or reuse the immutable card row for `spec` by `text_hash` (spec 05 §5.1). Concurrent
 * identical inserts meet in `INSERT … ON CONFLICT DO NOTHING`; the loser then selects and verifies
 * the committed row under the row lock `house.retire-cards` also takes, and un-retires it when a
 * retirement won the race. A row deleted meanwhile is inserted again. New shared rows record the
 * tenant as `creator_user_id`; reuse never changes authorship.
 */
export async function obtainCard(
  tx: TenantTx,
  userId: string,
  spec: CardSpec,
): Promise<{ card: CardRow; inserted: boolean; unretired: boolean }> {
  const visibility = spec.private ? 'private' : 'shared';
  const owner = spec.private ? userId : null;
  const textHash = cardTextHash({
    kind: spec.kind,
    title: spec.title,
    interest: spec.interest,
    not_for: spec.notFor,
    examples_yes: spec.examplesYes,
    examples_no: spec.examplesNo,
    visibility,
    owner_user_id: owner,
  });
  const body = serializeCardBody({
    interest: spec.interest,
    notFor: spec.notFor,
    interestEn: spec.translation?.interestEn ?? null,
    notForEn: spec.translation === null ? null : spec.translation.notForEn,
    examplesYes: [...spec.examplesYes],
    examplesNo: [...spec.examplesNo],
  });
  for (let attempt = 0; attempt < OBTAIN_ATTEMPTS; attempt += 1) {
    const inserted = await tx.execute<CardSqlRow>(sql`
      INSERT INTO interest_cards AS c (kind, title, body, text_hash, lang, topic_ids, origin,
                                       visibility, parent_card_id, owner_user_id, creator_user_id,
                                       i18n)
      VALUES (${spec.kind}, ${spec.title}, ${JSON.stringify(body)}::jsonb, ${textHash}, ${spec.lang},
              ${sql.param([...spec.topicIds])}::text[], ${spec.private ? 'fork' : 'user'},
              ${visibility}, ${spec.parentCardId}::bigint, ${owner}::uuid, ${userId}::uuid,
              ${JSON.stringify(spec.i18n)}::jsonb)
      ON CONFLICT (text_hash) DO NOTHING
      RETURNING ${CARD_COLUMNS}`);
    const created = inserted.rows[0];
    if (created !== undefined) return { card: cardRow(created), inserted: true, unretired: false };

    const existing = await tx.execute<CardSqlRow>(sql`
      SELECT ${CARD_COLUMNS} FROM interest_cards c WHERE c.text_hash = ${textHash}
         FOR NO KEY UPDATE`);
    const row = existing.rows[0];
    if (row === undefined) continue; // deleted after the conflict check: insert it again
    const card = cardRow(row);
    if (!matchesSpec(card, spec, userId)) {
      throw new AppError('INTERNAL', 'Card text hash does not match the stored card');
    }
    if (!card.retired) return { card, inserted: false, unretired: false };
    await tx.execute(sql`
      UPDATE interest_cards SET retired_at = NULL
       WHERE id = ${card.id}::bigint AND retired_at IS NOT NULL`);
    return { card: { ...card, retired: false }, inserted: false, unretired: true };
  }
  throw conflict('card_contention');
}

// ── Subscriptions, scope and demand ───────────────────────────────────────────────────────────────

export interface Subscription {
  feedId: string;
  mode: 'off' | 'training' | 'active';
}

/** The tenant's subscriptions in numeric feed order (stable under the `users` row lock). */
export async function loadSubscriptions(tx: TenantTx, userId: string): Promise<Subscription[]> {
  const result = await tx.execute<{ feed_id: string; inference_mode: Subscription['mode'] }>(sql`
    SELECT feed_id::text AS feed_id, inference_mode
      FROM subscriptions WHERE user_id = ${userId}::uuid ORDER BY feed_id`);
  return result.rows.map((row) => ({ feedId: row.feed_id, mode: row.inference_mode }));
}

/** A scope must be one of the tenant's subscriptions (the composite FK enforces it as well). */
export function requireScope(subscriptions: readonly Subscription[], scopeFeedId: string | null) {
  if (scopeFeedId !== null && !subscriptions.some((s) => s.feedId === scopeFeedId)) {
    throw invalidField('scopeFeedId', 'not_subscribed');
  }
}

/** The subscriptions a holding with `scopeFeedId` applies to (`null`: all of them). */
export function coveredFeeds(
  subscriptions: readonly Subscription[],
  scopeFeedId: string | null,
): Subscription[] {
  return scopeFeedId === null
    ? [...subscriptions]
    : subscriptions.filter((s) => s.feedId === scopeFeedId);
}

/**
 * Feeds whose `feed_cards` a holding change affects: `refresh_feed_cards` materializes only
 * `active` subscriptions (spec 05 §5.3), so off/training feeds have nothing to recompute.
 */
export function activeFeedIds(...sets: ReadonlyArray<readonly Subscription[]>): string[] {
  return sortedIds(
    sets
      .flat()
      .filter((s) => s.mode === 'active')
      .map((s) => s.feedId),
  );
}

/** Subscriptions in `next` that `previous` did not cover (a scope change's newly included feeds). */
export function newlyCovered(
  previous: readonly Subscription[],
  next: readonly Subscription[],
): Subscription[] {
  const before = new Set(previous.map((s) => s.feedId));
  return next.filter((s) => !before.has(s.feedId));
}

/** Lock feed rows in numeric id order (second in the lock order, spec 02 §6 "Callers"). */
export async function lockFeeds(tx: TenantTx, feedIds: readonly string[]): Promise<void> {
  if (feedIds.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM feeds WHERE id = ANY(${sql.param(sortedIds(feedIds))}::bigint[])
     ORDER BY id FOR NO KEY UPDATE`);
}

/**
 * The feeds among `covered` with **admitted** demand for this user (spec 05 §1.1, §5.4): an
 * `active` subscription, or a `training`/`active` one with a current selected request (pending,
 * running or complete, inside the selection window, at the subscription's inference version and the
 * article's current revision). A card change never authorizes off or unselected training feeds.
 */
export async function demandFeedIds(
  tx: TenantTx,
  userId: string,
  covered: readonly Subscription[],
): Promise<string[]> {
  if (covered.length === 0) return [];
  const active = covered.filter((s) => s.mode === 'active').map((s) => s.feedId);
  const training = covered.filter((s) => s.mode === 'training').map((s) => s.feedId);
  if (training.length === 0) return sortedIds(active);
  const selected = await tx.execute<{ feed_id: string }>(sql`
    SELECT DISTINCT r.feed_id::text AS feed_id
      FROM analysis_requests r
      JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
      JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                          AND s.inference_mode IN ('training', 'active')
                          AND s.inference_version = r.inference_version
     WHERE r.user_id = ${userId}::uuid
       AND r.feed_id = ANY(${sql.param(training)}::bigint[])
       AND r.status IN ('pending', 'running', 'complete')
       AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})`);
  return sortedIds([...active, ...selected.rows.map((row) => row.feed_id)]);
}

// ── Holdings ──────────────────────────────────────────────────────────────────────────────────────

export interface CardHolding {
  cardId: string;
  strength: CardStrength;
  scopeFeedId: string | null;
  titleOverride: string | null;
}

/** The tenant's `user_cards` row for `cardId`, locked for this transaction. */
export async function lockCardHolding(
  tx: TenantTx,
  userId: string,
  cardId: string,
): Promise<CardHolding | null> {
  const result = await tx.execute<{
    card_id: string;
    strength: CardStrength;
    scope_feed_id: string | null;
    title_override: string | null;
  }>(sql`
    SELECT card_id::text AS card_id, strength, scope_feed_id::text AS scope_feed_id, title_override
      FROM user_cards WHERE user_id = ${userId}::uuid AND card_id = ${cardId}::bigint
       FOR UPDATE`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        cardId: row.card_id,
        strength: row.strength,
        scopeFeedId: row.scope_feed_id,
        titleOverride: row.title_override,
      };
}

/** A card the tenant holds, else `404` (a stale id never creates an implicit holding). */
export async function requireCardHolding(
  tx: TenantTx,
  userId: string,
  cardId: string,
): Promise<CardHolding> {
  const holding = await lockCardHolding(tx, userId, cardId);
  if (holding === null) throw notFound('card');
  return holding;
}

export interface LabelHolding {
  cardId: string;
  name: string;
  color: string;
}

/** The tenant's `user_labels` row for `cardId`, locked for this transaction. */
export async function lockLabelHolding(
  tx: TenantTx,
  userId: string,
  cardId: string,
): Promise<LabelHolding | null> {
  const result = await tx.execute<{ card_id: string; name: string; color: string }>(sql`
    SELECT card_id::text AS card_id, name, color
      FROM user_labels WHERE user_id = ${userId}::uuid AND card_id = ${cardId}::bigint
       FOR UPDATE`);
  const row = result.rows[0];
  return row === undefined ? null : { cardId: row.card_id, name: row.name, color: row.color };
}

/** A label the tenant holds, else `404`. */
export async function requireLabelHolding(
  tx: TenantTx,
  userId: string,
  cardId: string,
): Promise<LabelHolding> {
  const holding = await lockLabelHolding(tx, userId, cardId);
  if (holding === null) throw notFound('label');
  return holding;
}

// ── Quotas (spec 08 §6) ───────────────────────────────────────────────────────────────────────────

/** Current interest-card holdings and, among them, held private forks. */
export async function countCardHoldings(
  tx: TenantTx,
  userId: string,
): Promise<{ cards: number; forks: number }> {
  const result = await tx.execute<{ cards: number; forks: number }>(sql`
    SELECT count(*)::int AS cards, count(*) FILTER (WHERE c.visibility = 'private')::int AS forks
      FROM user_cards uc JOIN interest_cards c ON c.id = uc.card_id
     WHERE uc.user_id = ${userId}::uuid`);
  return result.rows[0] ?? { cards: 0, forks: 0 };
}

export async function countLabelHoldings(tx: TenantTx, userId: string): Promise<number> {
  const result = await tx.execute<{ labels: number }>(sql`
    SELECT count(*)::int AS labels FROM user_labels WHERE user_id = ${userId}::uuid`);
  return result.rows[0]?.labels ?? 0;
}

/**
 * Block a change that grows usage beyond the plan (`409 QUOTA_EXCEEDED {limit, used, max}`). Quotas
 * count the resulting distinct holdings; rows kept over a reduced plan stay usable, and a change
 * that does not grow usage (a re-point, fork → fork) is never blocked.
 */
export function checkQuota(
  limit: 'maxCards' | 'maxForks' | 'maxLabels',
  used: number,
  after: number,
  max: number,
): void {
  if (after > used && after > max) throw new QuotaExceededError(limit, used, max);
}

// ── Articles as examples ──────────────────────────────────────────────────────────────────────────

/**
 * The example an article contributes (its title, spec 05 §5.1), for an article the tenant can see:
 * carried by one of the tenant's subscriptions, or already on the tenant's reading list. Anything
 * else is `404`, like a missing id.
 */
export async function articleExample(
  tx: TenantTx,
  userId: string,
  articleId: string,
): Promise<string> {
  const result = await tx.execute<{ title: string }>(sql`
    SELECT a.title FROM articles a
     WHERE a.id = ${articleId}::bigint
       AND (EXISTS (SELECT 1 FROM feed_items fi
                      JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${userId}::uuid
                     WHERE fi.article_id = a.id)
            OR EXISTS (SELECT 1 FROM user_article ua
                        WHERE ua.user_id = ${userId}::uuid AND ua.article_id = a.id))`);
  const row = result.rows[0];
  if (row === undefined) throw notFound('article');
  const example = exampleFromArticleTitle(row.title);
  if (example === null) throw invalidField('articleId', 'no_title');
  return example;
}

// ── Label ids on articles ─────────────────────────────────────────────────────────────────────────

/**
 * Move the tenant's article labels and suggestions from `from` to `to` (spec 05 §5.1 `array_replace`)
 * in the same transaction as the re-point. When the article already carried `to`, the arrays are
 * deduplicated (first position wins) and a suggestion equal to an assigned label is dropped, so the
 * deferred label check sees distinct held ids (spec 02 §5.2). Rows whose `label_ids` changed advance
 * `state_version` (their reader state changed).
 */
export async function migrateLabelIds(
  tx: TenantTx,
  userId: string,
  change: CardIdChange,
): Promise<void> {
  await tx.execute(sql`
    UPDATE user_article ua
       SET label_ids = n.ids,
           label_suggestions = ARRAY(
             SELECT s.e FROM unnest(n.sugg) WITH ORDINALITY AS s(e, i)
              WHERE s.e <> ALL (n.ids) GROUP BY s.e ORDER BY min(s.i)),
           state_version = ua.state_version
                           + CASE WHEN n.ids IS DISTINCT FROM ua.label_ids THEN 1 ELSE 0 END
      FROM (SELECT x.article_id,
                   ARRAY(SELECT l.e
                           FROM unnest(array_replace(x.label_ids, ${change.from}::bigint,
                                                     ${change.to}::bigint)) WITH ORDINALITY AS l(e, i)
                          GROUP BY l.e ORDER BY min(l.i)) AS ids,
                   array_replace(x.label_suggestions, ${change.from}::bigint, ${change.to}::bigint)
                     AS sugg
              FROM user_article x
             WHERE x.user_id = ${userId}::uuid
               AND (${change.from}::bigint = ANY (x.label_ids)
                    OR ${change.from}::bigint = ANY (x.label_suggestions))) n
     WHERE ua.user_id = ${userId}::uuid AND ua.article_id = n.article_id`);
}

/** Remove a deleted label from the tenant's article labels and suggestions (spec 08 §7). */
export async function removeLabelIds(tx: TenantTx, userId: string, labelId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE user_article
       SET label_ids = array_remove(label_ids, ${labelId}::bigint),
           label_suggestions = array_remove(label_suggestions, ${labelId}::bigint),
           state_version = state_version
                           + CASE WHEN ${labelId}::bigint = ANY (label_ids) THEN 1 ELSE 0 END
     WHERE user_id = ${userId}::uuid
       AND (${labelId}::bigint = ANY (label_ids) OR ${labelId}::bigint = ANY (label_suggestions))`);
}

// ── Effects ───────────────────────────────────────────────────────────────────────────────────────

export interface EffectsPlan {
  refreshFeedIds: readonly string[];
  /** Card ids and the admitted-demand feeds to backfill them on (nothing when either is empty). */
  backfill: { cardIds: readonly string[]; feedIds: readonly string[] } | null;
  rankFull: boolean;
  learn: boolean;
  labelIdChange: CardIdChange | null;
  /** The `user.rank` reason. */
  reason: 'cards' | 'labels';
}

/** `card.backfill` accepts at most this many feed ids per intent (packages/shared jobs). */
const BACKFILL_FEEDS_PER_INTENT = 2000;

/** Nothing to refresh or enqueue (an idempotent replay, a rename, a colour change). */
export function noEffects(): CardEffects {
  return { refreshFeedIds: [], rankFull: false, learn: false };
}

async function cardTextMode(tx: TenantTx): Promise<'as_written' | 'english'> {
  const parsed = CardTextModeSchema.safeParse(
    (await readStoredSetting(tx, 'card_text_mode')) ?? 'as_written',
  );
  return parsed.success ? parsed.data : 'as_written';
}

/**
 * Run `refresh_feed_cards` for the affected feeds and record the job intents in the tenant's outbox,
 * all in the caller's transaction (spec 05 §5.1, §5.3; spec 06 §7, §8.4): the backfill, and while
 * `card_text_mode = 'english'` the user's `house.translate-cards` (a backfill gives cards new
 * authorized demand, spec 07 §5); a full rank with its `rank_revision` increment; `user.learn`.
 */
export async function applyEffects(
  tx: TenantTx,
  userId: string,
  plan: EffectsPlan,
): Promise<CardEffects> {
  const refreshFeedIds = sortedIds(plan.refreshFeedIds);
  if (refreshFeedIds.length > 0) {
    await tx.execute(sql`SELECT refresh_feed_cards(${sql.param(refreshFeedIds)}::bigint[])`);
  }
  const sender = tenantOutbox(tx);
  let backfill: CardEffects['backfill'];
  if (plan.backfill !== null && plan.backfill.cardIds.length > 0) {
    const cardIds = sortedIds(plan.backfill.cardIds);
    const feedIds = sortedIds(plan.backfill.feedIds);
    if (feedIds.length > 0) {
      for (let start = 0; start < feedIds.length; start += BACKFILL_FEEDS_PER_INTENT) {
        await enqueueBackfill(sender, {
          userId,
          cardIds,
          feedIds: feedIds.slice(start, start + BACKFILL_FEEDS_PER_INTENT),
        });
      }
      if ((await cardTextMode(tx)) === 'english') await enqueueTranslateCards(sender, { userId });
      backfill = { cardIds, feedIds };
    }
  }
  if (plan.rankFull) {
    await recordRankIntents(tx, sender, [userId], { reason: plan.reason, full: true });
  }
  if (plan.learn) await enqueueLearn(sender, { userId });
  return {
    refreshFeedIds,
    ...(backfill === undefined ? {} : { backfill }),
    rankFull: plan.rankFull,
    learn: plan.learn,
    ...(plan.labelIdChange === null ? {} : { labelIdChange: plan.labelIdChange }),
  };
}
