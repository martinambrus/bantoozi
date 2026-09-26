import {
  eligibleInferenceDemand,
  listTranslations,
  loadClassificationArticle,
  lockArticleRevision,
  readFacets,
  resetArticleAnswers,
  retryTransaction,
  storeTranslation,
  transitionPipelineState,
  workerOutbox,
  type ClassificationArticle,
  type TranslationInput,
  type TranslationRow,
} from '@bantoozi/db';
import type { InferenceAuthorization } from '@bantoozi/shared';
import {
  articleTranslationSource,
  decideTier2,
  mayRunTier2,
  sameTranslationText,
  translationSourceSha256,
  type TranslationTexts,
} from '@bantoozi/translate';

import { languageModeOf, loadClassificationConfig } from '../classify/config.js';
import { effectiveTranslationTexts } from '../classify/model-input.js';
import {
  runTier1,
  runTier2,
  type TranslationDeps,
  type TranslationJob,
} from '../classify/translation.js';
import { after } from '../pipeline.js';
import { pipelineContext, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';
import { hasRetriesLeft } from './transient.js';

/** Articles a flagged job (tier-2 escalation, skipped-row reprocess, mode change) may translate. */
const RETRANSLATABLE_STATES = ['extracted', 'translated', 'enriched', 'matched', 'degraded'];

/** Thrown to make pg-boss retry after a transient tier-1 failure while the queue has retries left. */
export class TransientTranslationError extends Error {
  constructor(reason: string) {
    super(`transient translation failure (${reason}); the queue retries the job`);
    this.name = 'TransientTranslationError';
  }
}

/**
 * `article.translate {articleId, forceTier2?, replaceSkipped?, modeChange?}` (spec 07 §3).
 *
 * Runs only for current manual/active demand and a language in `translate` mode (never `en` or
 * `und`); off/untrained demand is a no-op. Tier 1 runs once per revision (a replay reuses the
 * stored row); tier 2 when wanted (tier-1 `fail`, `forceTier2`, the feed's `translate_strong`) and
 * allowed, once per revision unless the administrative reprocess replaces a skipped row. A result
 * is stored only while the article still has the revision read at dispatch. Then:
 * - the initial pipeline (an `extracted` article) moves to `translated` with the enrich intent;
 * - a later job re-enriches an enriched/matched article through `resetArticleAnswers` (keeping
 *   the body and translations at the new revision) only when the effective model input changes;
 *   identical effective text is a no-op, and other states pick the best row up at enrichment.
 * A transient tier-1 failure retries the job while the queue allows; the last attempt continues
 * with native text rather than blocking the article (spec 07 §3).
 */
export function createArticleTranslateHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  translation: TranslationDeps,
): QueueHandler<'article.translate'> {
  return async (payload, context) => {
    const { articleId } = payload;
    const flagged =
      payload.forceTier2 === true || payload.replaceSkipped === true || payload.modeChange === true;
    const article = await loadClassificationArticle(deps.db, articleId);
    if (article === null) return;
    const initial = article.pipelineState === 'extracted';
    // A plain job reaching an article past this stage is a late duplicate (spec 03 §2).
    if (!initial && !(flagged && RETRANSLATABLE_STATES.includes(article.pipelineState))) return;

    const witnesses = await eligibleInferenceDemand(deps.db, articleId);
    if (witnesses.length === 0) return;
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    const lang = article.lang;
    if (
      lang === null ||
      lang === 'und' ||
      lang === 'en' ||
      languageModeOf(config, lang) !== 'translate'
    ) {
      // The mode changed since the job was recorded (or there is nothing to translate): the
      // initial pipeline continues with native text.
      if (initial) await continueInitial(deps, article, []);
      return;
    }

    const source = articleTranslationSource({
      title: article.title,
      excerpt: article.excerpt,
      body_lead: article.bodyLead,
    });
    const job: TranslationJob = {
      articleId,
      articleRevision: article.revision,
      sourceLang: lang,
      source,
      sourceSha256: translationSourceSha256(lang, source),
      authorization: authorizationOf(article, witnesses),
    };
    const rows = await listTranslations(deps.db, articleId, article.revision);
    const produced: TranslationInput[] = [];

    let tier1Quality = rows.find((row) => row.engine === 'libretranslate')?.quality ?? null;
    if (payload.forceTier2 !== true && tier1Quality === null) {
      const tier1 = await runTier1(deps.db, classification.router, translation, job);
      if (tier1.kind === 'no_demand') return;
      if (tier1.kind === 'transient') {
        if (hasRetriesLeft(context)) throw new TransientTranslationError(tier1.reason);
        deps.logger.warn(
          { articleId, reason: tier1.reason },
          'tier-1 translation unavailable; continuing with native text',
        );
      } else if (tier1.kind === 'row') {
        produced.push(tier1.row);
        tier1Quality = tier1.row.quality;
      }
    }

    const decision = decideTier2({
      tier1Quality,
      ...(payload.forceTier2 === true ? { forceTier2: true } : {}),
      translateStrong: article.feed?.fetchOptions['translate_strong'] === true,
    });
    const replaceSkipped = payload.replaceSkipped === true;
    if (decision.wanted && mayRunTier2(rows, article.revision, { replaceSkipped })) {
      const model =
        decision.modelTier === 'strong' ? translation.modelStrong : translation.modelFast;
      const tier2 = await runTier2(deps.db, classification.router, translation, job, model);
      if (tier2.kind === 'no_demand') return;
      if (tier2.kind === 'row') produced.push(tier2.row);
      else if (tier2.kind === 'transient' && hasRetriesLeft(context)) {
        throw new TransientTranslationError(tier2.reason);
      }
    }

    if (initial) {
      await continueInitial(deps, article, produced, replaceSkipped);
      return;
    }
    await installRetranslation(deps, config, article, rows, produced, replaceSkipped);
  };
}

function authorizationOf(
  article: ClassificationArticle,
  witnesses: Extract<InferenceAuthorization, { type: 'article' }>['witnesses'],
): InferenceAuthorization {
  return { type: 'article', articleId: article.id, articleRevision: article.revision, witnesses };
}

/** Store the produced rows of `article.revision`; false when the article moved on meanwhile. */
async function storeRows(
  tx: Parameters<typeof storeTranslation>[0],
  article: ClassificationArticle,
  rows: readonly TranslationInput[],
  replaceSkipped: boolean,
): Promise<boolean> {
  const locked = await lockArticleRevision(tx, article.id, 'update');
  if (locked === null || locked.revision !== article.revision) return false;
  for (const row of rows) {
    await storeTranslation(tx, row, {
      replace: replaceSkipped && row.engine === 'ollama' ? 'skipped' : 'none',
    });
  }
  return true;
}

/**
 * Spec 07 §3 step 5: store the rows and atomically set `translated` with the enrich intent. A
 * duplicate that finds the article already moved on changes nothing.
 */
async function continueInitial(
  deps: WorkerDeps,
  article: ClassificationArticle,
  rows: readonly TranslationInput[],
  replaceSkipped = false,
): Promise<void> {
  await retryTransaction(deps.db, async (tx) => {
    if (!(await storeRows(tx, article, rows, replaceSkipped))) return;
    const moved = await transitionPipelineState(tx, {
      articleId: article.id,
      revision: article.revision,
      to: 'translated',
      from: ['extracted'],
    });
    if (!moved) return;
    const sender = workerOutbox(tx);
    await after(
      'translate',
      article.id,
      { status: 'ok', revision: article.revision },
      pipelineContext(deps, tx, sender),
    );
  });
}

/**
 * Re-translation and mode-change installs (spec 07 §3, spec 05 §2). The rows are stored at the
 * revision read at dispatch; an enriched/matched article whose current facets were built from
 * different effective text (native, or another tie-winning translation) is reset with its body and
 * translations kept at the new revision, and re-enters enrichment through the pipeline. Identical
 * effective text is a no-op, and an article not yet enriched uses the best row when it is. The
 * comparison runs even when this job produced no row: a language switched back to `translate`
 * finds its current-revision rows already stored, while the facets were built from native text.
 */
async function installRetranslation(
  deps: WorkerDeps,
  config: Awaited<ReturnType<typeof loadClassificationConfig>>,
  article: ClassificationArticle,
  before: readonly TranslationRow[],
  produced: readonly TranslationInput[],
  replaceSkipped: boolean,
): Promise<void> {
  await retryTransaction(deps.db, async (tx) => {
    if (!(await storeRows(tx, article, produced, replaceSkipped))) return;
    if (article.pipelineState !== 'enriched' && article.pipelineState !== 'matched') return;
    const enrichSet = config.enrich;
    if (enrichSet === null) return;
    const facets = await readFacets(tx, article.id, enrichSet.id);
    if (facets === null || facets.articleRevision !== article.revision) return;
    const used: TranslationTexts | null =
      facets.stateVariant === 'translated'
        ? effectiveTranslationTexts(before, article.revision)
        : null;
    const current = effectiveTranslationTexts(
      await listTranslations(tx, article.id, article.revision),
      article.revision,
    );
    if (sameTranslationText(used, current)) return;
    const sender = workerOutbox(tx);
    const reset = await resetArticleAnswers(tx, sender, article.id, {
      reason: 'translation_changed',
      nextState: 'translated',
      keepBody: true,
      keepTranslations: true,
      expectedRevision: article.revision,
    });
    if (reset.status !== 'reset') return;
    await after(
      'translate',
      article.id,
      { status: 'ok', revision: reset.revision },
      pipelineContext(deps, tx, sender),
    );
  });
}
