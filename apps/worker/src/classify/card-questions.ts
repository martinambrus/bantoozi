import type { CardAnswerRow, CardInput } from '@bantoozi/db';
import {
  cardInputSha256,
  cardQuestion,
  labelQuestion,
  type NoulQuestion,
} from '@bantoozi/questions';
import type { CardTextMode } from '@bantoozi/shared';

/**
 * Call B card questions and their cache identity (spec 05 §2, §5.2): the exact built question of a
 * card or label under the card text mode, and the fingerprints a stored answer must match to be
 * current for this article state.
 */

export interface BuiltCardQuestion {
  question: NoulQuestion;
  /** `card_input_sha256`: the hash of the exact built question. */
  sha256: string;
}

/** A label is asked with its shared card title (part of its text hash), never `user_labels.name`. */
export function builtCardQuestion(card: CardInput, mode: CardTextMode): BuiltCardQuestion {
  const question =
    card.kind === 'label'
      ? labelQuestion({ title: card.title, body: card.body }, mode)
      : cardQuestion(card.body, mode);
  return { question, sha256: cardInputSha256(question) };
}

/** The fingerprints of one article state under the active match set. */
export interface MatchFingerprint {
  articleRevision: string;
  matchSetSha: string;
  stateSha256: string;
}

/** Whether a stored answer answers exactly this input (any engine: fallback and prefilter count). */
export function isCurrentCardAnswer(
  answer: Pick<
    CardAnswerRow,
    'articleRevision' | 'questionSetSha' | 'stateSha256' | 'cardInputSha256'
  >,
  fingerprint: MatchFingerprint,
  cardSha256: string,
): boolean {
  return (
    answer.articleRevision === fingerprint.articleRevision &&
    answer.questionSetSha === fingerprint.matchSetSha &&
    answer.stateSha256 === fingerprint.stateSha256 &&
    answer.cardInputSha256 === cardSha256
  );
}
