import type { CardAnswerRow } from '@bantoozi/db';

/**
 * Call B card questions and their cache identity (spec 05 §2, §5.2): the exact built question of a
 * card or label under the card text mode (`builtCardQuestion`, shared with the training API in
 * `@bantoozi/questions`, D-71), and the fingerprints a stored answer must match to be current for
 * this article state.
 */
export { builtCardQuestion, type BuiltCardQuestion } from '@bantoozi/questions';

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
