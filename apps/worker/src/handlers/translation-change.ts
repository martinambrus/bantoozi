import {
  listTranslations,
  readFacets,
  resetArticleAnswers,
  workerOutbox,
  type ClassificationArticle,
  type Transaction,
  type TranslationRow,
} from '@bantoozi/db';
import { sameTranslationText, type TranslationTexts } from '@bantoozi/translate';

import type { ClassificationConfig } from '../classify/config.js';
import { effectiveTranslationTexts } from '../classify/model-input.js';
import { after } from '../pipeline.js';
import { pipelineContext, type WorkerDeps } from './deps.js';

/**
 * Spec 07 §3 re-translation, after translation rows of `article.revision` were stored in `tx`: an
 * enriched or matched article whose current facets were built from other effective text (native, or
 * another tie-winning translation among `before`, the rows before the store) is reset with its body
 * and translations kept at the new revision, and re-enters enrichment through the pipeline. The
 * reset deletes every answer of the old text and queues current demand again, so no reader keeps a
 * card answer of text the article no longer uses. Identical effective text changes nothing, and an
 * article not yet enriched uses the best row when it is. True when the article was reset.
 */
export async function resetOnChangedText(
  tx: Transaction,
  deps: WorkerDeps,
  config: ClassificationConfig,
  article: Pick<ClassificationArticle, 'id' | 'revision' | 'pipelineState'>,
  before: readonly TranslationRow[],
): Promise<boolean> {
  if (article.pipelineState !== 'enriched' && article.pipelineState !== 'matched') return false;
  const enrichSet = config.enrich;
  if (enrichSet === null) return false;
  const facets = await readFacets(tx, article.id, enrichSet.id);
  if (facets === null || facets.articleRevision !== article.revision) return false;
  const used: TranslationTexts | null =
    facets.stateVariant === 'translated'
      ? effectiveTranslationTexts(before, article.revision)
      : null;
  const current = effectiveTranslationTexts(
    await listTranslations(tx, article.id, article.revision),
    article.revision,
  );
  if (sameTranslationText(used, current)) return false;
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
