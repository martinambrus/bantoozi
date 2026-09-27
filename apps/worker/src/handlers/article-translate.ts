import {
  eligibleInferenceDemand,
  listTranslations,
  loadClassificationArticle,
  lockArticleRevision,
  retryTransaction,
  storeTranslation,
  transitionPipelineState,
  workerOutbox,
  type ClassificationArticle,
  type TranslationInput,
  type TranslationRow,
} from '@bantoozi/db';
import { enqueueTranslate, type InferenceAuthorization, type JobPayload } from '@bantoozi/shared';
import {
  articleTranslationSource,
  decideTier2,
  mayRunTier2,
  translationSourceSha256,
} from '@bantoozi/translate';

import { languageModeOf, loadClassificationConfig } from '../classify/config.js';
import {
  runTier1,
  runTier2,
  type TranslationDeps,
  type TranslationJob,
} from '../classify/translation.js';
import { after } from '../pipeline.js';
import { nowOf, pipelineContext, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';
import { hasRetriesLeft } from './transient.js';
import { resetOnChangedText } from './translation-change.js';

/** Articles a flagged job (tier-2 escalation, skipped-row reprocess, mode change) may translate. */
const RETRANSLATABLE_STATES = ['extracted', 'translated', 'enriched', 'matched', 'degraded'];

/**
 * The longest provider retry time a job's retry waits for (D-74). A server asking for longer is not
 * waited for: the job continues without that tier's row at once.
 */
const MAX_TRANSLATION_RETRY_WAIT_MS = 10 * 60_000;

/** Thrown to make pg-boss retry the job after a transient tier-1 or tier-2 translation failure. */
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
 * A transient tier-1 or tier-2 failure uses the job's one retry (see {@link retryTransient}); the
 * last attempt continues without that tier's row (native text when tier 1 has none) rather than
 * blocking the article (spec 07 §3, D-74).
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
    // The job's one retry: pg-boss's queue retry, or a delayed job marked `retried`.
    const retriesLeft = payload.retried !== true && hasRetriesLeft(context);

    let tier1Quality = rows.find((row) => row.engine === 'libretranslate')?.quality ?? null;
    if (payload.forceTier2 !== true && tier1Quality === null) {
      const tier1 = await runTier1(deps.db, classification.router, translation, job);
      if (tier1.kind === 'no_demand') return;
      if (tier1.kind === 'transient') {
        if (retriesLeft && (await retryTransient(deps, article, payload, produced, tier1))) {
          return;
        }
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
      else if (tier2.kind === 'transient' && retriesLeft) {
        if (await retryTransient(deps, article, payload, produced, tier2)) return;
      }
    }

    if (initial) {
      await continueInitial(deps, article, produced, replaceSkipped);
      return;
    }
    await installRetranslation(deps, config, article, rows, produced, replaceSkipped);
  };
}

/**
 * The job's one retry after a transient tier-1 or tier-2 failure (spec 07 §3, D-74). The rows the
 * job produced before it (a tier-1 translation before a transient tier 2) are stored first, so the
 * retry reuses them instead of running tier 1 again. Without a provider retry time the retry is
 * pg-boss's immediate queue retry: this throws. With one it is a delayed job at that time, marked
 * `retried` so it is the last attempt, and this job ends (true). A retry time beyond
 * {@link MAX_TRANSLATION_RETRY_WAIT_MS} is not waited for (false): nothing is stored here, and the
 * job continues without that tier's row.
 */
async function retryTransient(
  deps: WorkerDeps,
  article: ClassificationArticle,
  payload: JobPayload<'article.translate'>,
  produced: readonly TranslationInput[],
  failure: { reason: string; retryAt?: Date },
): Promise<boolean> {
  const { retryAt } = failure;
  const waitMs = retryAt === undefined ? 0 : retryAt.getTime() - nowOf(deps).getTime();
  if (waitMs > MAX_TRANSLATION_RETRY_WAIT_MS) return false;
  if (produced.length > 0 || retryAt !== undefined) {
    await retryTransaction(deps.db, async (tx) => {
      if (produced.length > 0) {
        await storeRows(tx, article, produced, payload.replaceSkipped === true);
      }
      if (retryAt === undefined) return;
      await enqueueTranslate(
        workerOutbox(tx, { availableAt: retryAt }),
        { ...payload, retried: true },
        { revision: article.revision },
      );
    });
  }
  if (retryAt === undefined) throw new TransientTranslationError(failure.reason);
  return true;
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
 * revision read at dispatch, and an article whose current facets were built from different
 * effective text is reset and re-enriched ({@link resetOnChangedText}). The comparison runs even
 * when this job produced no row: a language switched back to `translate` finds its current-revision
 * rows already stored, while the facets were built from native text.
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
    await resetOnChangedText(tx, deps, config, article, before);
  });
}
