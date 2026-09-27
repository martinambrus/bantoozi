import {
  readL2Answers,
  updateFacetFeatures,
  type FacetRow,
  type L2AnswerRow,
  type Transaction,
} from '@bantoozi/db';
import {
  flattenFacets,
  selectL2Branches,
  type Answer,
  type ChoiceAnswer,
} from '@bantoozi/questions';

/**
 * Facet features and level-2 branches (spec 05 §3.4, §4). Features combine the Call A answers with
 * the level-2 answers of the branches those answers select, and only with L2 rows of the same
 * article revision, active match set and exact Call B state: L2 from an old revision/set/state is
 * never mixed into current facets.
 */

function isChoiceAnswer(value: unknown): value is ChoiceAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const answer = value as Partial<ChoiceAnswer>;
  return (
    answer.type === 'choice' &&
    typeof answer.choice === 'string' &&
    typeof answer.probabilities === 'object' &&
    answer.probabilities !== null
  );
}

/** The `topic_l1` Choice probabilities of Call A answers (keyed by plain L1 id). */
export function topicL1Probabilities(
  answers: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const topic = answers['topic_l1'];
  return isChoiceAnswer(topic) ? { ...topic.probabilities } : {};
}

/** The L1 branches Call B asks level-2 questions for (spec 05 §4). */
export function l2Branches(answers: Readonly<Record<string, unknown>>): string[] {
  return selectL2Branches(topicL1Probabilities(answers));
}

/** The fingerprint an L2 answer must match to count as current (spec 05 §2, §4). */
export interface L2Fingerprint {
  articleRevision: string;
  matchSetSha: string;
  stateSha256: string;
}

export function isCurrentL2(row: L2AnswerRow, fingerprint: L2Fingerprint): boolean {
  return (
    row.articleRevision === fingerprint.articleRevision &&
    row.questionSetSha === fingerprint.matchSetSha &&
    row.stateSha256 === fingerprint.stateSha256 &&
    isChoiceAnswer(row.answer)
  );
}

/** Current L2 answers of the selected branches, keyed by L1 id. */
export function currentL2Answers(
  rows: readonly L2AnswerRow[],
  branches: readonly string[],
  fingerprint: L2Fingerprint,
): Record<string, ChoiceAnswer> {
  const result: Record<string, ChoiceAnswer> = {};
  for (const row of rows) {
    if (!branches.includes(row.l1Id) || !isCurrentL2(row, fingerprint)) continue;
    result[row.l1Id] = row.answer as unknown as ChoiceAnswer;
  }
  return result;
}

/** `article_facets.features` from Call A answers and the current L2 answers of their branches. */
export function facetFeatures(
  answers: Readonly<Record<string, unknown>>,
  l2: Readonly<Record<string, ChoiceAnswer>>,
): Record<string, number> {
  return flattenFacets(answers as Record<string, Answer>, l2);
}

/**
 * Rebuild the features of stored facets, locked by the caller, from the current L2 rows of the
 * branches their answers select (spec 05 §3.4: recomputed when L2 answers arrive). A facet row of
 * another revision is left alone.
 */
export async function refreshFacetFeatures(
  tx: Transaction,
  facets: FacetRow,
  fingerprint: L2Fingerprint,
): Promise<void> {
  if (facets.articleRevision !== fingerprint.articleRevision) return;
  const l2 = currentL2Answers(
    await readL2Answers(tx, facets.articleId),
    l2Branches(facets.answers),
    fingerprint,
  );
  await updateFacetFeatures(tx, { ...facets, features: facetFeatures(facets.answers, l2) });
}
