import {
  isPrimaryAnswer,
  lockArticleRevision,
  readFacets,
  reprocessWindowPage,
  resetArticleAnswers,
  retryTransaction,
  workerOutbox,
  type ReprocessArticle,
  type ReprocessCursor,
} from '@bantoozi/db';
import {
  RANK_WINDOW_DAYS,
  enqueueEnrich,
  enqueueReenrich,
  enqueueTranslate,
} from '@bantoozi/shared';

import { primaryAvailability } from '../classify/availability.js';
import { languageModeOf, loadClassificationConfig } from '../classify/config.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import { recordRebuildProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.reenrich' as const;
/** Window articles examined per run (spec 11 §6); the rest continues in a follow-up job. */
export const REPROCESS_BATCH = 200;
/** Pause before a continuation job, so a long window does not flood the queues at once. */
export const REPROCESS_CONTINUATION_DELAY_MS = 30_000;

const STATES = ['extracted', 'translated', 'degraded', 'enriched', 'matched'] as const;

export type ReenrichAction = 'none' | 'enrich' | 'translate' | 'reset-native';

/**
 * `house.reenrich {since?, lang?, cursor?}` (spec 05 §2, spec 11 §6, §8): after an enrich-set,
 * language-mode or model-pin change, pages the still-demanded window (eligible carrier arrivals
 * since `since`, default the ranking window, plus completed selections) newest first, 200 articles
 * a run, and re-enters each at the stage its language mode needs, always in bulk priority (never
 * the LLM fallback). A language now in `translate` mode goes through `article.translate` with
 * `modeChange`; a translated article of a native language is reset through `resetArticleAnswers`
 * and enriched again; anything else gets `article.enrich`, which reuses a current primary answer
 * at no cost. Articles already current under the primary model and desired variant are skipped.
 * Runs only while the primary engine is available; a pass continues with a keyset cursor and a
 * frozen `since` under a continuation key of its own.
 */
export function createReenrichHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'house.reenrich'> {
  return async (payload) => {
    const started = nowOf(deps);
    const since =
      payload.since ??
      new Date(started.getTime() - RANK_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
    const availability = await primaryAvailability(
      deps.db,
      classification.router,
      deps.settingsEnv,
      started,
    );
    if (!availability.available) {
      // The trigger is kept, with its frozen `since` and position, for `house.reconcile`.
      await recordRebuildProgress(deps, JOB, started, {
        complete: false,
        pending: { ...payload, since },
      });
      deps.logger.info({ job: JOB, skipped: availability.reason }, 'reenrich skipped');
      return;
    }
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    if (config.enrich === null) {
      deps.logger.info({ job: JOB, skipped: 'no_enrich_set' }, 'reenrich skipped');
      return;
    }
    const page = await reprocessWindowPage(deps.db, {
      since,
      ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
      limit: REPROCESS_BATCH,
      states: STATES,
      enrichSetId: config.enrich.id,
      ...(payload.lang === undefined ? {} : { lang: payload.lang }),
    });

    const counts = { enrich: 0, translate: 0, reset: 0 };
    for (const article of page) {
      const action = decideReenrich(article, config, classification.primaryModel);
      if (action === 'none') continue;
      await retryTransaction(deps.db, async (tx) => {
        const sender = workerOutbox(tx);
        if (action === 'translate') {
          await enqueueTranslate(
            sender,
            { articleId: article.articleId, modeChange: true, priority: 'bulk' },
            { revision: article.revision },
          );
          counts.translate += 1;
        } else if (action === 'enrich') {
          await enqueueEnrich(
            sender,
            { articleId: article.articleId, priority: 'bulk' },
            { revision: article.revision },
          );
          counts.enrich += 1;
        } else if (config.enrich !== null) {
          const locked = await lockArticleRevision(tx, article.articleId, 'update');
          if (
            locked === null ||
            locked.revision !== article.revision ||
            (locked.pipelineState !== 'enriched' && locked.pipelineState !== 'matched')
          ) {
            return;
          }
          const facets = await readFacets(tx, article.articleId, config.enrich.id);
          if (facets === null || facets.stateVariant !== 'translated') return;
          const reset = await resetArticleAnswers(tx, sender, article.articleId, {
            reason: 'language_mode',
            nextState: 'translated',
            keepBody: true,
            keepTranslations: true,
            expectedRevision: article.revision,
          });
          if (reset.status !== 'reset') return;
          await enqueueEnrich(
            sender,
            { articleId: article.articleId, priority: 'bulk' },
            { revision: reset.revision },
          );
          counts.reset += 1;
        }
      });
    }

    const last = page.at(-1);
    const remaining = page.length >= REPROCESS_BATCH && last !== undefined;
    if (remaining) {
      const cursor: ReprocessCursor = { key: last.key, articleId: last.articleId };
      await retryTransaction(deps.db, async (tx) => {
        await enqueueReenrich(
          workerOutbox(tx, {
            availableAt: new Date(started.getTime() + REPROCESS_CONTINUATION_DELAY_MS),
          }),
          { since, cursor, ...(payload.lang === undefined ? {} : { lang: payload.lang }) },
        );
      });
    }
    await recordRebuildProgress(deps, JOB, started, { complete: !remaining });
    deps.logger.info(
      {
        job: JOB,
        durationMs: nowOf(deps).getTime() - started.getTime(),
        affected: { examined: page.length, ...counts },
        remaining,
      },
      'reenrich pass',
    );
  };
}

/** The re-entry an article needs under the current configuration (spec 05 §2, spec 07 §3, spec 11 §6). */
export function decideReenrich(
  article: ReprocessArticle,
  config: Awaited<ReturnType<typeof loadClassificationConfig>>,
  primaryModel: string,
): ReenrichAction {
  const { facets } = article;
  const settled = article.pipelineState === 'enriched' || article.pipelineState === 'matched';
  const translates =
    article.lang !== null &&
    article.lang !== 'en' &&
    article.lang !== 'und' &&
    languageModeOf(config, article.lang) === 'translate';
  const current =
    settled &&
    facets !== null &&
    facets.revision === article.revision &&
    isPrimaryAnswer(facets, primaryModel);
  if (
    current &&
    facets !== null &&
    facets.stateVariant === (translates ? 'translated' : 'native')
  ) {
    return 'none';
  }
  if (translates) {
    if (article.pipelineState === 'extracted') return 'translate';
    if (settled && facets !== null && facets.stateVariant !== 'translated') return 'translate';
    return 'enrich';
  }
  if (settled && facets !== null && facets.stateVariant === 'translated') {
    return facets.revision === article.revision ? 'reset-native' : 'enrich';
  }
  return 'enrich';
}
