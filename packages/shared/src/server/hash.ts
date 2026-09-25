import { createHash } from 'node:crypto';

import { canonicalJson } from '../text/canonical-json.js';

/** Lower-case hex SHA-256 of a UTF-8 string or bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** SHA-256 of the canonical JSON of a value (question sets, states, card inputs; spec 05 §2). */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export interface CardTextInput {
  kind: 'interest' | 'label';
  title: string;
  interest: string;
  not_for?: string | null;
  examples_yes?: readonly string[] | null;
  examples_no?: readonly string[] | null;
  visibility: 'public' | 'shared' | 'private';
  owner_user_id?: string | null;
}

/** `norm(s) = NFC, trim, collapse whitespace, lower-case` (spec 05 §5.1). */
export function normCardText(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * `interest_cards.text_hash` (spec 05 §5.1). The label title is part of a label's meaning; the
 * owner is included only for private cards (forks), so a fork never collides with shared text.
 * Examples are hashed as written.
 */
export function cardTextHash(card: CardTextInput): string {
  if (card.visibility === 'private' && (card.owner_user_id ?? null) === null) {
    throw new TypeError('private cards need owner_user_id');
  }
  return sha256Hex(
    canonicalJson({
      kind: card.kind,
      interest: normCardText(card.interest),
      not_for: normCardText(card.not_for ?? ''),
      title: card.kind === 'label' ? normCardText(card.title) : null,
      examples_yes: card.examples_yes ?? [],
      examples_no: card.examples_no ?? [],
      owner: card.visibility === 'private' ? card.owner_user_id : null,
    }),
  );
}
