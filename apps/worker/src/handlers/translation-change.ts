import {
  listTranslations,
  lockArticleRevision,
  readFacets,
  resetArticleAnswers,
  workerOutbox,
  type ClassificationArticle,
  type Transaction,
} from '@bantoozi/db';

import type { ClassificationConfig } from '../classify/config.js';
import { buildState, modelInput } from '../classify/model-input.js';
import { after } from '../pipeline.js';
import { pipelineContext, type WorkerDeps } from './deps.js';

/**
 * Spec 07 §3 re-translation, after translation rows of `article.revision` were stored in `tx`: an
 * enriched or matched article whose current facets were built from another model input than the
 * one its rows now give (native text, or another tie-winning translation) is reset with its body
 * and translations kept at the new revision, and re-enters enrichment through the pipeline. The
 * state is read under the article's row lock, never from the caller's snapshot, so an enrichment
 * that completed while the translation ran is compared too, and the facets' own `state_sha256`
 * names the input they were built from (D-94). The reset deletes every answer of the old input and
 * queues current demand again, so no reader keeps a card answer of text the article no longer uses.
 * An identical input changes nothing, and an article not yet enriched uses the best row when it is:
 * its completion reads the rows again under the same lock. True when the article was reset.
 */
export async function resetOnChangedText(
  tx: Transaction,
  deps: WorkerDeps,
  config: ClassificationConfig,
  article: ClassificationArticle,
): Promise<boolean> {
  const locked = await lockArticleRevision(tx, article.id, 'update');
  if (locked === null || locked.revision !== article.revision) return false;
  if (locked.pipelineState !== 'enriched' && locked.pipelineState !== 'matched') return false;
  const enrichSet = config.enrich;
  if (enrichSet === null) return false;
  const facets = await readFacets(tx, article.id, enrichSet.id);
  if (facets === null || facets.articleRevision !== article.revision) return false;
  const rows = await listTranslations(tx, article.id, article.revision);
  if (buildState(modelInput(article, rows, config), 'enrich').sha256 === facets.stateSha256) {
    return false;
  }
  const sender = workerOutbox(tx);
  const reset = await resetArticleAnswers(tx, sender, article.id, {
    reason: 'translation_changed',
    nextState: 'translated',
    keepBody: true,
    keepTranslations: true,
    expectedRevision: article.revision,
  });
  if (reset.status !== 'reset') return false;
  await after(
    'translate',
    article.id,
    { status: 'ok', revision: reset.revision },
    pipelineContext(deps, tx, sender),
  );
  return true;
}
