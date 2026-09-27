import {
  cardPairDemand,
  enrichRecoveryPage,
  llmAnswerRecoveryPage,
  readStoredSetting,
  recoverMatchQueue,
  retryTransaction,
  updateSettingLocked,
  upsertMatchQueue,
  workerOutbox,
  type RecoveryCursor,
} from '@bantoozi/db';
import {
  HOUSE_PROGRESS_CURSORS,
  RANK_WINDOW_DAYS,
  enqueueEnrich,
  enqueueMatch,
  parseSetting,
  readSetting,
  type HouseProgressCursor,
} from '@bantoozi/shared';

import { primaryAvailability } from '../classify/availability.js';
import { loadClassificationConfig } from '../classify/config.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.rescore-degraded' as const;
/** Articles re-enqueued for Call A per run (degraded, or enriched by the LLM fallback). */
export const RESCORE_ENRICH_PAGE = 100;
/** Articles whose current LLM card/L2 answers are requeued per run. */
export const RESCORE_ANSWER_PAGE = 100;
/** Exhausted `match_queue` rows reset per run, and articles with due rows dispatched. */
export const RESCORE_MATCH_BATCH = 200;

/** The persisted keyset positions of the two recovery pages; an absent page starts a fresh pass. */
type ProgressCursor = HouseProgressCursor<typeof JOB>;

/**
 * `house.rescore-degraded` (every 10 minutes, spec 04 §5, spec 11 §6). While the breaker mirror,
 * credentials and the bulk budget show the primary engine available, it recovers the 14-day window
 * fairly with persisted keyset cursors (newest first, wrapping after the oldest page, so new
 * arrivals never starve older work):
 * - `article.enrich` (bulk) for degraded articles and articles enriched by the LLM fallback whose
 *   demand is still authorized (a current primary Call A is reused, never rebilled), except LLM
 *   articles whose revision Jev already rejected as invalid under the active enrich set;
 * - the still-demanded pairs of current LLM card answers requeued, and `article.match` for them and
 *   for current LLM level-2 answers (re-asked in bulk packs, which only Jev serves);
 * - a bounded batch of exhausted `match_queue` rows whose blocker has lifted: service failures six
 *   hours after they gave up, never permanent invalid requests; and `article.match` for articles
 *   with due rows.
 * Off or cancelled demand is never revived: every page recomputes authorization.
 */
export function createRescoreDegradedHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'house.rescore-degraded'> {
  return async () => {
    const started = nowOf(deps);
    const availability = await primaryAvailability(
      deps.db,
      classification.router,
      deps.settingsEnv,
      started,
    );
    if (!availability.available) {
      deps.logger.info({ job: JOB, skipped: availability.reason }, 'recovery skipped');
      return;
    }
    const cursor = await readCursor(deps);
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    const enrich = await enrichRecoveryPage(deps.db, {
      windowDays: RANK_WINDOW_DAYS,
      ...(cursor.enrich === undefined ? {} : { cursor: cursor.enrich }),
      limit: RESCORE_ENRICH_PAGE,
      enrichSetId: config.enrich?.id ?? null,
    });
    const answers = await llmAnswerRecoveryPage(deps.db, {
      windowDays: RANK_WINDOW_DAYS,
      ...(cursor.answers === undefined ? {} : { cursor: cursor.answers }),
      limit: RESCORE_ANSWER_PAGE,
    });

    const report = await retryTransaction(deps.db, async (tx) => {
      const sender = workerOutbox(tx);
      for (const article of enrich) {
        await enqueueEnrich(
          sender,
          { articleId: article.articleId, priority: 'bulk' },
          { revision: article.revision },
        );
      }
      let requeuedPairs = 0;
      for (const article of answers) {
        const demanded = (await cardPairDemand(tx, article.articleId, article.llmCardIds)).map(
          (d) => d.cardId,
        );
        if (demanded.length > 0) {
          requeuedPairs += await upsertMatchQueue(tx, {
            articleId: article.articleId,
            revision: article.revision,
            cardIds: demanded,
          });
        }
        if (demanded.length > 0 || article.llmL2) {
          await enqueueMatch(
            sender,
            { articleId: article.articleId },
            { revision: article.revision },
          );
        }
      }
      const recovered = await recoverMatchQueue(tx, { limit: RESCORE_MATCH_BATCH });
      for (const articleId of recovered.articleIds) {
        await enqueueMatch(sender, { articleId });
      }
      const next: ProgressCursor = {
        ...pageCursor('enrich', enrich, RESCORE_ENRICH_PAGE),
        ...pageCursor('answers', answers, RESCORE_ANSWER_PAGE),
      };
      const passComplete = next.enrich === undefined && next.answers === undefined;
      await saveCursor(tx, next, passComplete, nowOf(deps));
      return {
        enrich: enrich.length,
        answers: answers.length,
        requeuedPairs,
        resetRows: recovered.resetRows,
        matchArticles: recovered.articleIds.length,
        passComplete,
      };
    });
    deps.logger.info(
      {
        job: JOB,
        durationMs: nowOf(deps).getTime() - started.getTime(),
        affected: report,
        remaining: !report.passComplete,
      },
      'recovery pass',
    );
  };
}

/** The next cursor of one page: its last key while the page was full, else a fresh pass. */
function pageCursor(
  name: 'enrich' | 'answers',
  page: ReadonlyArray<{ key: string; articleId: string }>,
  limit: number,
): ProgressCursor {
  const last = page.at(-1);
  return page.length < limit || last === undefined
    ? {}
    : { [name]: { key: last.key, articleId: last.articleId } satisfies RecoveryCursor };
}

async function readCursor(deps: WorkerDeps): Promise<ProgressCursor> {
  const progress = readSetting(
    'house.progress',
    await readStoredSetting(deps.db, 'house.progress'),
    deps.settingsEnv,
  );
  return parseProgressCursor(progress?.[JOB]?.cursor);
}

/** The registered cursor schema (spec 02 §2); a malformed or foreign cursor restarts the pass. */
export function parseProgressCursor(value: unknown): ProgressCursor {
  const parsed = HOUSE_PROGRESS_CURSORS[JOB].safeParse(value);
  return parsed.success ? parsed.data : {};
}

async function saveCursor(
  tx: Parameters<typeof updateSettingLocked>[0],
  cursor: ProgressCursor,
  passComplete: boolean,
  now: Date,
): Promise<void> {
  await updateSettingLocked(tx, 'house.progress', {}, (current) => {
    const progress = parseSetting('house.progress', current ?? {});
    const previous = progress[JOB];
    return parseSetting('house.progress', {
      ...progress,
      [JOB]: {
        cursor,
        updatedAt: now.toISOString(),
        version: 1,
        ...(passComplete
          ? { completedAt: now.toISOString() }
          : previous?.completedAt === undefined
            ? {}
            : { completedAt: previous.completedAt }),
      },
    });
  });
}
