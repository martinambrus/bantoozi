import { randomUUID } from 'node:crypto';

import {
  activeUserIds,
  cardsAwaitingTranslation,
  fillCardTranslation,
  readStoredSetting,
  markCardTranslationAttempt,
  recordRankIntents,
  retryTransaction,
  workerOutbox,
  type CardAwaitingTranslation,
} from '@bantoozi/db';
import { enqueueRematch, HOUSE_PROGRESS_CURSORS } from '@bantoozi/shared';
import {
  assessTranslation,
  isBlankText,
  sourceFields,
  toExternalCall,
  type CardTextField,
} from '@bantoozi/translate';

import type { TranslationDeps } from '../classify/translation.js';
import { loadClassificationConfig } from '../classify/config.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.translate-cards' as const;
/** Cards read per page of a run. */
export const TRANSLATE_CARDS_PAGE = 100;
/** Users active in the app within this many days get a full rerank (spec 06 §7). */
const ACTIVE_USER_DAYS = 7;
/** An unrestricted run does not send a card again within this long of its last (weak or failed) attempt. */
export const TRANSLATE_RETRY_BACKOFF_MS = 6 * 60 * 60_000;

/**
 * `house.translate-cards {userId?}` (spec 07 §5, spec 11 §6): while `card_text_mode = 'english'`,
 * gives each non-retired interest or label card of a supported source language, with current
 * authorized demand and no English pair, one validated tier-1 pair from its stored `lang`. Demand
 * is rechecked before every HTTP attempt and in the storing transaction; only an `ok` assessment is
 * stored, so a weak or failed translation keeps the original until the next user event. Storing
 * the pair records `house.rematch {cardId}` and a full rerank of the holders active in the last 7
 * days in the same transaction. Every attempt is accounted through the router.
 *
 * Run budget: like the other housekeeping sweeps the run stops starting pages after
 * `HOUSE_RUN_BUDGET_MS`, saves the last card id in `house.progress` and the next unrestricted run
 * resumes after it. Backoff: an unrestricted run skips a card attempted within
 * `TRANSLATE_RETRY_BACKOFF_MS` (`interest_cards.translation_attempted_at`); a `{userId}` run always retries.
 */
export function createTranslateCardsHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  translation: TranslationDeps,
): QueueHandler<'house.translate-cards'> {
  return async (payload) => {
    const started = nowOf(deps);
    const startedMs = Date.now();
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    if (config.cardTextMode !== 'english') {
      deps.logger.info({ job: JOB, skipped: 'as_written' }, 'translate-cards skipped');
      return;
    }
    const supported = await translation.supportedSources?.();
    if (supported === undefined || supported.size === 0) {
      deps.logger.info({ job: JOB, skipped: 'languages_unknown' }, 'translate-cards skipped');
      return;
    }
    const langs = [...supported].filter((lang) => lang !== 'en' && lang !== 'und');
    const counts = { examined: 0, translated: 0, kept: 0 };
    const unrestricted = payload.userId === undefined;
    const saved = unrestricted
      ? HOUSE_PROGRESS_CURSORS[JOB].safeParse(
          (
            (await readStoredSetting(deps.db, 'house.progress')) as
              Record<string, { cursor?: unknown } | undefined> | undefined
          )?.[JOB]?.cursor,
        )
      : undefined;
    let after: string | undefined = saved?.success ? saved.data.after : undefined;
    let complete = true;
    const retryAfter = new Date(started.getTime() - TRANSLATE_RETRY_BACKOFF_MS);
    for (;;) {
      if (Date.now() - startedMs > HOUSE_RUN_BUDGET_MS) {
        complete = false;
        break;
      }
      const page = await cardsAwaitingTranslation(deps.db, {
        langs,
        ...(unrestricted ? { notAttemptedSince: retryAfter } : {}),
        ...(payload.userId === undefined ? {} : { userId: payload.userId }),
        ...(after === undefined ? {} : { after }),
        limit: TRANSLATE_CARDS_PAGE,
      });
      for (const card of page) {
        counts.examined += 1;
        const outcome = await translateOne(deps, classification, translation, supported, card);
        if (outcome === 'translated') {
          counts.translated += 1;
        } else {
          counts.kept += 1;
          // Only a real weak or failed attempt backs the card off; a lapsed or already filled one does not.
          if (outcome === 'attempted') {
            await markCardTranslationAttempt(deps.db, card.cardId, nowOf(deps));
          }
        }
      }
      const last = page.at(-1);
      if (page.length < TRANSLATE_CARDS_PAGE || last === undefined) break;
      after = last.cardId;
    }
    deps.logger.info(
      {
        job: JOB,
        durationMs: nowOf(deps).getTime() - started.getTime(),
        affected: counts,
        remaining: complete ? 0 : null,
      },
      'translate-cards pass',
    );
    // Only the unrestricted pass owns the global progress entry: a {userId} run neither reads
    // (above), writes, completes nor clears it.
    if (unrestricted) {
      await recordHouseProgress(
        deps,
        JOB,
        nowOf(deps),
        complete,
        complete || after === undefined ? undefined : { after },
      );
    }
  };
}

/**
 * Translate and store one card's pair: `translated` when stored, `attempted` when the translator
 * ran for current demand but the result was not usable, `skipped` when demand lapsed or vanished
 * or a concurrent run filled the card.
 */
async function translateOne(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  translation: TranslationDeps,
  supported: ReadonlySet<string>,
  card: CardAwaitingTranslation,
): Promise<'translated' | 'attempted' | 'skipped'> {
  const notFor = isBlankText(card.notFor) ? null : card.notFor;
  const source: Record<CardTextField, string | null> = { interest: card.interest, not_for: notFor };
  const demanded = async (): Promise<boolean> =>
    (await cardsAwaitingTranslation(deps.db, { langs: [card.lang], cardId: card.cardId })).length >
    0;
  let lapsed = false;
  const result = await translation.libretranslate.translate({
    fields: sourceFields(source, ['interest', 'not_for'] as const),
    source: card.lang,
    supportedSources: supported,
    beforeAttempt: async () => {
      lapsed = !(await demanded());
      return !lapsed;
    },
  });
  const logicalRequestId = randomUUID();
  for (const attempt of result.attempts) {
    await classification.router.recordExternalCall(toExternalCall(attempt, { logicalRequestId }));
  }
  if (lapsed) return 'skipped';
  if (result.status !== 'translated') return 'attempted';

  const output: Record<CardTextField, string | null> = { interest: null, not_for: null };
  for (const { field, text } of result.translations) output[field] = text;
  const assessment = assessTranslation(source, output, card.lang);
  if (assessment.skipped || assessment.quality !== 'ok' || output.interest === null)
    return 'attempted';
  if (notFor !== null && output.not_for === null) return 'attempted';

  return retryTransaction(deps.db, async (tx) => {
    const [current] = await cardsAwaitingTranslation(tx, {
      langs: [card.lang],
      cardId: card.cardId,
    });
    if (current === undefined) return 'skipped' as const;
    const filled = await fillCardTranslation(tx, {
      cardId: card.cardId,
      interestEn: output.interest ?? '',
      notForEn: notFor === null ? null : output.not_for,
    });
    if (filled !== 'filled') return 'skipped' as const;
    const sender = workerOutbox(tx);
    await enqueueRematch(sender, { cardId: card.cardId });
    const active = new Set(await activeUserIds(tx, ACTIVE_USER_DAYS));
    await recordRankIntents(
      tx,
      sender,
      current.holders.filter((userId) => active.has(userId)),
      { reason: 'card_translation', full: true },
    );
    return 'translated' as const;
  });
}
