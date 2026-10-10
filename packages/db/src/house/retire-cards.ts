import { sql, type SQL } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { bigintArray, daysBefore } from './snapshots.js';

/** Days a retired card is kept before it and its answers are deleted (spec 05 §5.1, spec 11 §5). */
export const CARD_RETIRED_GRACE_DAYS = 30;

export interface CardsPage {
  examined: number;
  changed: number;
  lastId: string | null;
}

const held = (c: string): SQL =>
  sql.raw(`(
  EXISTS (SELECT 1 FROM user_cards uc WHERE uc.card_id = ${c}.id)
  OR EXISTS (SELECT 1 FROM user_labels ul WHERE ul.card_id = ${c}.id)
  OR EXISTS (SELECT 1 FROM eval.rater_cards rc WHERE rc.card_id = ${c}.id))`);

/**
 * Marks one page of unheld non-public cards retired at `now` (spec 05 §5.1, spec 11 §5): no
 * `user_cards`, `user_labels` or `eval.rater_cards` row. Candidates are locked
 * `FOR NO KEY UPDATE` (the lock card reuse takes) and rechecked before the write.
 */
export async function retireUnheldCardsPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<CardsPage> {
  const found = await tx.execute<{ id: string }>(sql`
    SELECT c.id::text AS id FROM interest_cards c
     WHERE c.id > ${input.after ?? '0'}::bigint AND c.visibility <> 'public' AND c.retired_at IS NULL
       AND NOT ${held('c')}
     ORDER BY c.id LIMIT ${input.limit} FOR NO KEY UPDATE OF c SKIP LOCKED`);
  const ids = found.rows.map((row) => row.id);
  let changed = 0;
  if (ids.length > 0) {
    const updated = await tx.execute(sql`
      UPDATE interest_cards c SET retired_at = ${input.now.toISOString()}::timestamptz
       WHERE c.id = ANY(${bigintArray(ids)}) AND c.retired_at IS NULL AND NOT ${held('c')}`);
    changed = updated.rowCount ?? 0;
  }
  return { examined: ids.length, changed, lastId: ids.at(-1) ?? null };
}

/**
 * Clears `retired_at` on one page of retired cards that are held again (a reuse during the
 * grace period; spec 05 §5.1), under the card lock.
 */
export async function unretireHeldCardsPage(
  tx: Transaction,
  input: { after: string | null; limit: number },
): Promise<CardsPage> {
  const found = await tx.execute<{ id: string }>(sql`
    SELECT c.id::text AS id FROM interest_cards c
     WHERE c.id > ${input.after ?? '0'}::bigint AND c.retired_at IS NOT NULL AND ${held('c')}
     ORDER BY c.id LIMIT ${input.limit} FOR NO KEY UPDATE OF c SKIP LOCKED`);
  const ids = found.rows.map((row) => row.id);
  let changed = 0;
  if (ids.length > 0) {
    const updated = await tx.execute(sql`
      UPDATE interest_cards c SET retired_at = NULL
       WHERE c.id = ANY(${bigintArray(ids)}) AND c.retired_at IS NOT NULL AND ${held('c')}`);
    changed = updated.rowCount ?? 0;
  }
  return { examined: ids.length, changed, lastId: ids.at(-1) ?? null };
}

export interface DeleteCardsPage extends CardsPage {
  /** Cards whose answers went but that a library version or publication or eval row keeps. */
  kept: number;
  answers: number;
}

/**
 * Deletes one page of cards retired 30 days or more before `now` (spec 05 §5.1, spec 11 §5): each
 * is locked `FOR UPDATE` and rechecked as still retired and unheld, its `card_answers` go, and the
 * card goes unless a library version, a publication request or an `eval.run_answers` row
 * references it. Forks keep working (`parent_card_id` is set to NULL by the foreign key).
 */
export async function deleteRetiredCardsPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<DeleteCardsPage> {
  const cutoff = daysBefore(input.now, CARD_RETIRED_GRACE_DAYS);
  const eligible = sql`c.retired_at <= ${cutoff}::timestamptz AND c.visibility <> 'public' AND NOT ${held('c')}`;
  const found = await tx.execute<{ id: string }>(sql`
    SELECT c.id::text AS id FROM interest_cards c
     WHERE c.id > ${input.after ?? '0'}::bigint AND ${eligible}
     ORDER BY c.id LIMIT ${input.limit} FOR UPDATE OF c SKIP LOCKED`);
  const candidates = found.rows.map((row) => row.id);
  const lastId = candidates.at(-1) ?? null;
  if (candidates.length === 0) return { examined: 0, changed: 0, kept: 0, answers: 0, lastId };
  const rechecked = await tx.execute<{ id: string }>(sql`
    SELECT c.id::text AS id FROM interest_cards c
     WHERE c.id = ANY(${bigintArray(candidates)}) AND ${eligible}`);
  const ids = rechecked.rows.map((row) => row.id);
  if (ids.length === 0)
    return { examined: candidates.length, changed: 0, kept: 0, answers: 0, lastId };
  const answers = await tx.execute(sql`
    DELETE FROM card_answers WHERE card_id = ANY(${bigintArray(ids)})`);
  const deleted = await tx.execute(sql`
    DELETE FROM interest_cards c
     WHERE c.id = ANY(${bigintArray(ids)})
       AND NOT EXISTS (SELECT 1 FROM library_card_versions v
                        WHERE v.card_id = c.id OR v.previous_card_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM card_publication_requests p WHERE p.card_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM eval.run_answers a WHERE a.card_id = c.id)`);
  const changed = deleted.rowCount ?? 0;
  return {
    examined: candidates.length,
    changed,
    kept: ids.length - changed,
    answers: answers.rowCount ?? 0,
    lastId,
  };
}
