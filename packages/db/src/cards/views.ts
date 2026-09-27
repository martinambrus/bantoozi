import { sql, type SQL } from 'drizzle-orm';

import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, type RawTimestamp } from '../timestamps.js';
import { parseCardBody } from './body.js';
import type { CardOrigin, CardVisibility, HeldCard, HeldLabel } from './types.js';
import type { CardStrength } from './validation.js';

/**
 * The user's own cards and labels (spec 08 §7 `GET /cards`, `GET /labels`), read in the caller's
 * tenant transaction: holdings are the user's rows under RLS, and a card row is readable only when it
 * is public/shared or the user's own private fork. Nothing here reveals other holders or creators.
 */

// A type alias (not an interface) so it satisfies the row constraint of `execute`.
type HeldCardRow = {
  id: string;
  card_title: string;
  title_override: string | null;
  body: unknown;
  strength: CardStrength;
  scope_feed_id: string | null;
  origin: CardOrigin;
  visibility: CardVisibility;
  parent_card_id: string | null;
  topic_ids: string[];
  lang: string;
  slug: string | null;
  i18n: unknown;
  created_at: RawTimestamp;
  updated_at: RawTimestamp;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function heldCard(row: HeldCardRow): HeldCard {
  const body = parseCardBody(row.body);
  return {
    id: row.id,
    kind: 'interest',
    title: row.title_override ?? row.card_title,
    titleOverride: row.title_override,
    cardTitle: row.card_title,
    interest: body.interest,
    notFor: body.notFor,
    interestEn: body.interestEn,
    notForEn: body.notForEn,
    strength: row.strength,
    scopeFeedId: row.scope_feed_id,
    origin: row.origin,
    visibility: row.visibility,
    isPrivateFork: row.visibility === 'private',
    parentCardId: row.parent_card_id,
    examplesYes: body.examplesYes,
    examplesNo: body.examplesNo,
    topicIds: row.topic_ids,
    lang: row.lang,
    librarySlug: row.slug,
    i18n: asRecord(row.i18n),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

async function selectHeldCards(tx: TenantTx, filter: SQL): Promise<HeldCard[]> {
  const result = await tx.execute<HeldCardRow>(sql`
    SELECT c.id::text AS id, c.title AS card_title, uc.title_override, c.body, uc.strength,
           uc.scope_feed_id::text AS scope_feed_id, c.origin, c.visibility,
           c.parent_card_id::text AS parent_card_id, c.topic_ids, c.lang, c.slug, c.i18n,
           uc.created_at, uc.updated_at
      FROM user_cards uc
      JOIN interest_cards c ON c.id = uc.card_id AND c.kind = 'interest'
     WHERE uc.user_id = ${tenantUserId(tx)}::uuid ${filter}
     ORDER BY uc.created_at, uc.card_id`);
  return result.rows.map(heldCard);
}

/** The user's interest cards, oldest holding first. */
export async function listUserCards(tx: TenantTx): Promise<HeldCard[]> {
  return selectHeldCards(tx, sql``);
}

/** One of the user's interest cards, or `null` when the user does not hold `cardId`. */
export async function getUserCard(tx: TenantTx, cardId: string): Promise<HeldCard | null> {
  const [card] = await selectHeldCards(tx, sql`AND uc.card_id = ${cardId}::bigint`);
  return card ?? null;
}

// A type alias (not an interface) so it satisfies the row constraint of `execute`.
type HeldLabelRow = {
  id: string;
  name: string;
  color: string;
  card_title: string;
  body: unknown;
  origin: CardOrigin;
  visibility: CardVisibility;
  lang: string;
  count: number;
  created_at: RawTimestamp;
};

function heldLabel(row: HeldLabelRow): HeldLabel {
  const body = parseCardBody(row.body);
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    cardTitle: row.card_title,
    definition: body.interest,
    notFor: body.notFor,
    definitionEn: body.interestEn,
    notForEn: body.notForEn,
    examplesYes: body.examplesYes,
    examplesNo: body.examplesNo,
    origin: row.origin,
    visibility: row.visibility,
    isPrivateFork: row.visibility === 'private',
    lang: row.lang,
    count: row.count,
    createdAt: toDate(row.created_at),
  };
}

async function selectHeldLabels(tx: TenantTx, filter: SQL): Promise<HeldLabel[]> {
  const result = await tx.execute<HeldLabelRow>(sql`
    SELECT c.id::text AS id, ul.name, ul.color, c.title AS card_title, c.body, c.origin,
           c.visibility, c.lang, ul.created_at,
           (SELECT count(*) FROM user_article ua
             WHERE ua.user_id = ul.user_id AND ul.card_id = ANY (ua.label_ids))::int AS count
      FROM user_labels ul
      JOIN interest_cards c ON c.id = ul.card_id AND c.kind = 'label'
     WHERE ul.user_id = ${tenantUserId(tx)}::uuid ${filter}
     ORDER BY ul.created_at, ul.card_id`);
  return result.rows.map(heldLabel);
}

/** The user's labels, oldest first, with the number of articles carrying each. */
export async function listUserLabels(tx: TenantTx): Promise<HeldLabel[]> {
  return selectHeldLabels(tx, sql``);
}

/** One of the user's labels, or `null` when the user does not hold `labelId`. */
export async function getUserLabel(tx: TenantTx, labelId: string): Promise<HeldLabel | null> {
  const [label] = await selectHeldLabels(tx, sql`AND ul.card_id = ${labelId}::bigint`);
  return label ?? null;
}
