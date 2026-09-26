import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { parseCardBody } from './body.js';
import { CARD_TEXT_LIMITS, codePointLength } from './validation.js';

/**
 * The worker's one-time fill of a card's derived English pair (`house.translate-cards`, spec 07 §5;
 * spec 05 §5.1). The original text and `text_hash` never change; the pair is written only while it
 * is absent, as one complete validated pair (the `interest_cards_guard` trigger allows exactly this
 * transition). An existing pair is never overwritten here: replacing a valid pair is the separate,
 * audited retranslation flow. The caller rechecks demand before calling and records the rematch of
 * the card's current answers and its holders' reranks in the same transaction (spec 07 §5).
 */

export type CardTranslationFill =
  /** The pair was absent and is now stored. */
  | 'filled'
  /** The card already has a pair (or an unreadable one): nothing was written. */
  | 'unchanged'
  /** No such card (deleted meanwhile). */
  | 'missing';

export interface CardTranslationFillInput {
  cardId: string;
  interestEn: string;
  /** Required exactly when the card has a `not_for`. */
  notForEn: string | null;
}

function checkedText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || codePointLength(trimmed) > CARD_TEXT_LIMITS.translationMax) {
    throw new RangeError(`invalid ${field}`);
  }
  return trimmed;
}

/**
 * Fill the absent English pair of `cardId` under its row lock (a worker transaction). Throws a
 * `RangeError` for an incomplete or oversized pair (a translator bug, never stored).
 */
export async function fillCardTranslation(
  tx: Transaction,
  input: CardTranslationFillInput,
): Promise<CardTranslationFill> {
  const locked = await tx.execute<{ body: unknown }>(sql`
    SELECT body FROM interest_cards WHERE id = ${input.cardId}::bigint FOR NO KEY UPDATE`);
  const row = locked.rows[0];
  if (row === undefined) return 'missing';
  const raw = (typeof row.body === 'object' && row.body !== null ? row.body : {}) as Record<
    string,
    unknown
  >;
  const absent =
    (raw['interest_en'] === undefined || raw['interest_en'] === null) &&
    (raw['not_for_en'] === undefined || raw['not_for_en'] === null);
  if (!absent) return 'unchanged';

  const body = parseCardBody(row.body);
  const interestEn = checkedText(input.interestEn, 'interestEn');
  let notForEn: string | null = null;
  if (body.notFor !== null) {
    if (input.notForEn === null) throw new RangeError('notForEn is required for this card');
    notForEn = checkedText(input.notForEn, 'notForEn');
  } else if (input.notForEn !== null && input.notForEn.trim() !== '') {
    throw new RangeError('notForEn given for a card without not_for');
  }
  await tx.execute(sql`
    UPDATE interest_cards
       SET body = body || jsonb_build_object('interest_en', ${interestEn}::text,
                                            'not_for_en', ${notForEn}::text)
     WHERE id = ${input.cardId}::bigint`);
  return 'filled';
}
