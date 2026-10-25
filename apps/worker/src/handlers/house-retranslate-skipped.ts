import {
  readStoredSetting,
  reprocessWindowPage,
  retryTransaction,
  tier2CallsToday,
  workerOutbox,
  type ReprocessCursor,
} from '@bantoozi/db';
import {
  parseStoredSetting,
  RANK_WINDOW_DAYS,
  TRANSLATE_SKIP_REASONS,
  enqueueTranslate,
  settingDefault,
} from '@bantoozi/shared';

import { languageModeOf, loadClassificationConfig } from '../classify/config.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import { recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.retranslate-skipped' as const;
/** Window articles read per page of a run (spec 11 §6). */
export const RETRANSLATE_PAGE = 200;

/** Articles a tier-2 replacement may be sent for (`article.translate`'s retranslatable states). */
const STATES = ['extracted', 'translated', 'enriched', 'matched', 'degraded'] as const;

/**
 * `house.retranslate-skipped {reasons?}` (spec 07 §3, spec 11 §6): the administrative reprocess of
 * tier-2 rows skipped for lack of a key, the daily cap or the budget. Pages the still-demanded
 * window newest first and sends `article.translate {forceTier2, replaceSkipped}` for each article
 * of a `translate` language whose current tier-2 row was skipped for one of `reasons` (default
 * all), in batches of 200 per transaction. It stops when the tier-2 daily cap or the bulk budget is
 * used up; articles left stay skipped until the next reprocess. It sends nothing to a provider
 * itself.
 */
export function createRetranslateSkippedHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'house.retranslate-skipped'> {
  return async (payload) => {
    const started = nowOf(deps);
    const reasons = payload.reasons ?? TRANSLATE_SKIP_REASONS;
    const since = new Date(started.getTime() - RANK_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
    if (!(await classification.router.canSpend(0, 'bulk'))) {
      deps.logger.info({ job: JOB, skipped: 'budget' }, 'retranslate-skipped skipped');
      return;
    }
    const stored = await readStoredSetting(deps.db, 'translate.tier2_daily_cap');
    const fallback = settingDefault('translate.tier2_daily_cap', deps.settingsEnv) ?? 0;
    let cap = fallback;
    try {
      if (stored !== undefined) cap = parseStoredSetting('translate.tier2_daily_cap', stored);
    } catch {
      deps.logger.warn({ job: JOB }, 'stored tier-2 cap is malformed; using its default');
    }
    let room = cap - (await tier2CallsToday(deps.db));
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);

    let sent = 0;
    let examined = 0;
    let cursor: ReprocessCursor | undefined;
    while (room > 0) {
      const page = await reprocessWindowPage(deps.db, {
        since,
        ...(cursor === undefined ? {} : { cursor }),
        limit: RETRANSLATE_PAGE,
        states: STATES,
        enrichSetId: config.enrich?.id ?? null,
        skippedReasons: reasons,
      });
      examined += page.length;
      const chosen = page
        .filter(
          (article) =>
            article.lang !== null &&
            article.lang !== 'en' &&
            article.lang !== 'und' &&
            languageModeOf(config, article.lang) === 'translate',
        )
        .slice(0, room);
      if (chosen.length > 0) {
        await retryTransaction(deps.db, async (tx) => {
          const sender = workerOutbox(tx);
          for (const article of chosen) {
            await enqueueTranslate(
              sender,
              {
                articleId: article.articleId,
                forceTier2: true,
                replaceSkipped: true,
                priority: 'bulk',
              },
              { revision: article.revision },
            );
          }
        });
        sent += chosen.length;
        room -= chosen.length;
      }
      const last = page.at(-1);
      if (page.length < RETRANSLATE_PAGE || last === undefined) break;
      cursor = { key: last.key, articleId: last.articleId };
    }
    deps.logger.info(
      {
        job: JOB,
        durationMs: nowOf(deps).getTime() - started.getTime(),
        affected: { examined, sent },
      },
      'retranslate-skipped pass',
    );
    await recordHouseProgress(deps, JOB, nowOf(deps), true);
  };
}
