import {
  cardPairDemand,
  loadCardInputs,
  readCardAnswers,
  readFacets,
  readL2Answers,
  type Executor,
} from '@bantoozi/db';
import type { CardTextMode } from '@bantoozi/shared';

import { builtCardQuestion, isCurrentCardAnswer, type MatchFingerprint } from './card-questions.js';
import { isCurrentL2, l2Branches } from './features.js';

/**
 * Whether an article's classification is complete for its current demand (spec 05 §5.5 step 8):
 * current facets of the active enrich set, a current answer for every demanded card pair (fallback
 * answers and prefilter markers count as completed provisional work) and a current answer for every
 * selected level-2 branch. A single successful pack never decides this alone.
 */
export async function classificationComplete(
  db: Executor,
  input: {
    articleId: string;
    enrichSetId: string;
    fingerprint: MatchFingerprint;
    cardTextMode: CardTextMode;
  },
): Promise<boolean> {
  const { articleId, fingerprint } = input;
  const facets = await readFacets(db, articleId, input.enrichSetId);
  if (facets === null || facets.articleRevision !== fingerprint.articleRevision) return false;

  const demand = await cardPairDemand(db, articleId);
  if (demand.length > 0) {
    const ids = demand.map((d) => d.cardId);
    const cards = await loadCardInputs(db, ids);
    const answers = new Map((await readCardAnswers(db, articleId, ids)).map((a) => [a.cardId, a]));
    for (const id of ids) {
      const card = cards.get(id);
      const answer = answers.get(id);
      if (card === undefined || answer === undefined) return false;
      const { sha256 } = builtCardQuestion(card, input.cardTextMode);
      if (!isCurrentCardAnswer(answer, fingerprint, sha256)) return false;
    }
  }

  const branches = l2Branches(facets.answers);
  if (branches.length === 0) return true;
  const rows = await readL2Answers(db, articleId);
  return branches.every((l1) =>
    rows.some((row) => row.l1Id === l1 && isCurrentL2(row, fingerprint)),
  );
}
