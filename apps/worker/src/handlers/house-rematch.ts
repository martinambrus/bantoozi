import {
  activeUserIds,
  cardPairDemand,
  listTranslations,
  loadCardInputs,
  loadClassificationArticles,
  readCardAnswers,
  recordRankIntents,
  reprocessWindowPage,
  retryTransaction,
  reviveInvalidMatchRows,
  upsertMatchQueue,
  workerOutbox,
  type CardAnswerRow,
  type ReprocessCursor,
} from '@bantoozi/db';
import { RANK_WINDOW_DAYS, enqueueMatch, enqueueRematch } from '@bantoozi/shared';

import { primaryAvailability } from '../classify/availability.js';
import {
  builtCardQuestion,
  isCurrentCardAnswer,
  type MatchFingerprint,
} from '../classify/card-questions.js';
import { loadClassificationConfig } from '../classify/config.js';
import { buildState, modelInput } from '../classify/model-input.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import { REPROCESS_BATCH, REPROCESS_CONTINUATION_DELAY_MS } from './house-reenrich.js';
import { recordRebuildProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';
import { assertWorkerCurrent, lockWorkerCurrent } from '../stale-worker.js';

const JOB = 'house.rematch' as const;
/** Users active in the app within this many days get a full rerank (spec 06 §7). */
const ACTIVE_USER_DAYS = 7;

/**
 * `house.rematch {since?, cardId?, cursor?}` (spec 05 §2, spec 11 §6, §8): after a match-set,
 * card-text-mode, prefilter or model-pin change, or a library topic correction (`cardId`), pages
 * the still-demanded window (as `house.reenrich`) and requeues, in bulk priority, the demanded
 * pairs whose stored answer is missing, incompatible with the current match set, card text or
 * article state, a prefilter marker, or a superseded Jev model's; current primary and LLM answers
 * stay (the recovery job re-asks the latter). An exhausted `invalid_request` row is revived only
 * when its stored answer is incompatible, because the blocker changed. A card-scoped run looks
 * only at articles with an answer for that card. Requeued pairs enqueue `article.match`, and
 * holders active in the last 7 days get a full rerank. Runs only while the primary engine is
 * available; a pass continues with a keyset cursor under a continuation key of its own.
 */
export function createRematchHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'house.rematch'> {
  return async (payload) => {
    await assertWorkerCurrent(deps.db, classification);
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
      deps.logger.info({ job: JOB, skipped: availability.reason }, 'rematch skipped');
      return;
    }
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    if (config.match === null) {
      deps.logger.info({ job: JOB, skipped: 'no_match_set' }, 'rematch skipped');
      return;
    }
    const matchSetSha = config.match.sha256;
    const page = await reprocessWindowPage(deps.db, {
      since,
      ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
      limit: REPROCESS_BATCH,
      states: ['enriched', 'matched'],
      enrichSetId: config.enrich?.id ?? null,
      ...(payload.cardId === undefined ? {} : { cardId: payload.cardId }),
    });

    const articles = await loadClassificationArticles(
      deps.db,
      page.map((entry) => entry.articleId),
    );
    const demands = new Map<string, Awaited<ReturnType<typeof cardPairDemand>>>();
    for (const entry of page) {
      demands.set(
        entry.articleId,
        await cardPairDemand(
          deps.db,
          entry.articleId,
          payload.cardId === undefined ? undefined : [payload.cardId],
        ),
      );
    }
    const cards = await loadCardInputs(
      deps.db,
      [...demands.values()].flatMap((list) => list.map((demand) => demand.cardId)),
    );
    const digests = new Map<string, string>();
    const digest = (cardId: string): string | null => {
      const known = digests.get(cardId);
      if (known !== undefined) return known;
      const card = cards.get(cardId);
      if (card === undefined) return null;
      const sha = builtCardQuestion(card, config.cardTextMode).sha256;
      digests.set(cardId, sha);
      return sha;
    };

    let requeuedPairs = 0;
    let revivedRows = 0;
    let matchArticles = 0;
    const holders = new Set<string>();
    for (const entry of page) {
      const article = articles.get(entry.articleId);
      const demand = demands.get(entry.articleId) ?? [];
      if (article === undefined || article.revision !== entry.revision || demand.length === 0) {
        continue;
      }
      const fingerprint: MatchFingerprint = {
        articleRevision: article.revision,
        matchSetSha,
        stateSha256: buildState(
          modelInput(
            article,
            await listTranslations(deps.db, article.id, article.revision),
            config,
          ),
          'match',
        ).sha256,
      };
      const answers = new Map<string, CardAnswerRow>(
        (
          await readCardAnswers(
            deps.db,
            article.id,
            demand.map((d) => d.cardId),
          )
        ).map((answer) => [answer.cardId, answer]),
      );
      const requeue: string[] = [];
      const revive: string[] = [];
      for (const pair of demand) {
        const cardSha = digest(pair.cardId);
        if (cardSha === null) continue;
        const answer = answers.get(pair.cardId);
        const current = answer !== undefined && isCurrentCardAnswer(answer, fingerprint, cardSha);
        const superseded =
          answer !== undefined &&
          answer.engine === 'typesafe' &&
          answer.model !== classification.primaryModel;
        const marker = answer !== undefined && answer.engine === 'prefilter';
        if (answer !== undefined && !marker && !current) revive.push(pair.cardId);
        else if (superseded) revive.push(pair.cardId);
        if (answer === undefined || marker || !current || superseded) requeue.push(pair.cardId);
      }
      if (requeue.length === 0) continue;
      await retryTransaction(deps.db, async (tx) => {
        // Decisions rest on this process's model: a moved restart-class value or pin discards them.
        const stale = await lockWorkerCurrent(tx, classification);
        if (stale !== null) throw stale;
        revivedRows += await reviveInvalidMatchRows(tx, article.id, article.revision, revive);
        requeuedPairs += await upsertMatchQueue(tx, {
          articleId: article.id,
          revision: article.revision,
          cardIds: requeue,
        });
        await enqueueMatch(
          workerOutbox(tx),
          { articleId: article.id },
          { revision: article.revision },
        );
      });
      matchArticles += 1;
      for (const pair of demand) {
        if (requeue.includes(pair.cardId)) for (const h of pair.holders) holders.add(h.userId);
      }
    }

    if (holders.size > 0) {
      const active = new Set(await activeUserIds(deps.db, ACTIVE_USER_DAYS));
      const ranked = [...holders].filter((userId) => active.has(userId));
      await retryTransaction(deps.db, (tx) =>
        recordRankIntents(tx, workerOutbox(tx), ranked, { reason: 'rematch', full: true }),
      );
    }

    const last = page.at(-1);
    const remaining = page.length >= REPROCESS_BATCH && last !== undefined;
    if (remaining) {
      const cursor: ReprocessCursor = { key: last.key, articleId: last.articleId };
      await retryTransaction(deps.db, async (tx) => {
        await enqueueRematch(
          workerOutbox(tx, {
            availableAt: new Date(started.getTime() + REPROCESS_CONTINUATION_DELAY_MS),
          }),
          { since, cursor, ...(payload.cardId === undefined ? {} : { cardId: payload.cardId }) },
        );
      });
    }
    await recordRebuildProgress(deps, JOB, started, { complete: !remaining });
    deps.logger.info(
      {
        job: JOB,
        durationMs: nowOf(deps).getTime() - started.getTime(),
        affected: { examined: page.length, matchArticles, requeuedPairs, revivedRows },
        remaining,
      },
      'rematch pass',
    );
  };
}
