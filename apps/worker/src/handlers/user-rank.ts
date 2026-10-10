import {
  loadCardInputs,
  loadHeldCardIds,
  loadRankUser,
  rankWindowPage,
  retryTransaction,
  workerOutbox,
  writeRankBatch,
  type RankCursor,
  type RankWrite,
  type StoredRankRow,
  type TranslationRow,
} from '@bantoozi/db';
import { rankArticle, type RankResult } from '@bantoozi/ranker';
import { currentTier2Row, selectBestTranslation } from '@bantoozi/translate';
import {
  canonicalJson,
  compareBigIntStrings,
  enqueueLearn,
  enqueueRank,
  enqueueTranslate,
  RANK_WINDOW_DAYS,
  type JobPayload,
} from '@bantoozi/shared';

import { loadClassificationConfig } from '../classify/config.js';
import { loadRankContext } from '../rank/context.js';
import { cardInputHashes, loadRankItems, type RankItemsRun } from '../rank/items.js';
import { buildActiveModel, loadRankModelState } from '../rank/model.js';
import { loadRankerSettings } from '../rank/settings.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/** Window articles per dirty-set page (spec 06 §7 step 2: a batch size, not an eligibility cap). */
export const RANK_PAGE = 5_000;
/** Rows ranked and upserted per transaction (spec 06 §7 step 5). */
export const RANK_WRITE_BATCH = 500;
/**
 * Inputs written this long before a row's `scored_at` are checked again (D-141): a transaction that
 * started before the run's snapshot can commit after it with an older timestamp.
 */
export const RANK_RECHECK_MARGIN_MS = 15 * 60_000;
/** Wall time after which a run commits a continuation instead of its next page (spec 03 §2.1). */
export const RANK_JOB_BUDGET_MS = 5 * 60_000;

export interface UserRankOptions {
  pageSize?: number;
  batchSize?: number;
  budgetMs?: number;
  /** Test seam: runs before each batch's write transaction. */
  beforeWrite?: (articleIds: readonly string[]) => Promise<void>;
}

/** Whether a stored row already holds `result` (a recheck writes only a changed result). */
export function sameRank(stored: StoredRankRow | undefined, result: RankResult): boolean {
  if (stored === undefined || stored.scoredAt === null) return false;
  const suggestions = result.labelSuggestions.filter((id) => !stored.labelIds.includes(id));
  return (
    stored.lane === result.lane &&
    stored.tier === result.tier &&
    stored.scoreSource === result.scoreSource &&
    canonicalJson(stored.rulesFired) === canonicalJson(result.rulesFired) &&
    canonicalJson([...stored.labelSuggestions].sort()) === canonicalJson([...suggestions].sort()) &&
    (stored.nextRankAt?.getTime() ?? null) === (result.nextRankAt?.getTime() ?? null) &&
    canonicalJson(stored.explain) === canonicalJson(JSON.parse(JSON.stringify(result.explain)))
  );
}

/**
 * Weak-translation escalation (spec 06 §7 step 6, spec 07 §3): the best current translation is a
 * tier-1 `weak` one and no `ollama` row exists yet (a skipped attempt leaves one too), so the
 * escalation happens once per article.
 */
export function needsTier2(translations: readonly TranslationRow[], revision: string): boolean {
  const best = selectBestTranslation(translations, revision);
  return (
    best !== null &&
    best.engine === 'libretranslate' &&
    best.quality === 'weak' &&
    currentTier2Row(translations, revision) === undefined
  );
}

type RunOutcome = 'done' | 'superseded' | 'gone' | 'continued';

/**
 * `user.rank {userId, reason, full?, snapshotAt?}` (spec 06 §7). One run captures `now`, the
 * ranking settings and the user's rank revision, loads the user context (the BM25 corpus over the
 * whole window), then walks the window in `(arrival, id)` keyset pages newest first. Each page's
 * dirty items, and the items whose ranking may be stale without a durable sign (`recheck`, written
 * only when the result changed), are batch-loaded, ranked, and upserted in batches, every batch
 * fenced by the captured revision and settings version (`writeRankBatch`).
 *
 * A full run also re-ranks every row scored before its snapshot. When the wall-time budget runs out
 * it commits a continuation through the outbox that resumes strictly below the last visited window
 * position (a full run's also carries its snapshot time) and ends;
 * a superseded run enqueues a replacement, whose dirty set then holds every row of the old
 * revision or settings; articles whose revision moved during the run get an incremental rank. An
 * item newly placed in `maybe` with only a weak tier-1 translation enqueues
 * `article.translate {forceTier2: true}` in its batch's transaction (step 6).
 */
export function createUserRankHandler(
  deps: WorkerDeps,
  options: UserRankOptions = {},
): QueueHandler<'user.rank'> {
  const pageSize = options.pageSize ?? RANK_PAGE;
  const batchSize = options.batchSize ?? RANK_WRITE_BATCH;
  const budgetMs = options.budgetMs ?? RANK_JOB_BUDGET_MS;
  return async (payload) => {
    const started = Date.now();
    const now = nowOf(deps);
    const settings = await loadRankerSettings(deps.db);
    const user = await loadRankUser(deps.db, payload.userId);
    if (user === null) return;
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    const cardInputs = await loadCardInputs(deps.db, await loadHeldCardIds(deps.db, user.userId));
    const hashes = cardInputHashes(cardInputs, config);
    const modelState = await loadRankModelState(deps.db, {
      userId: user.userId,
      config: settings.config,
      hashes,
    });
    if (modelState.status === 'stale') {
      await retryTransaction(deps.db, async (tx) => {
        await enqueueLearn(workerOutbox(tx), { userId: user.userId });
      });
    }
    const loaded = await loadRankContext(deps.db, {
      user,
      settings,
      now,
      classification: {
        enrichSetId: config.enrich?.id ?? null,
        matchSetSha: config.match?.sha256 ?? null,
        cardTextMode: config.cardTextMode,
        languageModes: config.languageModes,
        cards: [...hashes].sort(([a], [b]) => compareBigIntStrings(a, b)),
      },
      model:
        modelState.status === 'current'
          ? { version: modelState.row.version, contextSha: modelState.contextSha }
          : null,
    });
    const ctx =
      modelState.status === 'current'
        ? { ...loaded, model: buildActiveModel(modelState, loaded) }
        : loaded;
    const run: RankItemsRun = { userId: user.userId, now, ctx, config, cardInputs };
    const forceBefore =
      payload.full === true
        ? payload.snapshotAt === undefined
          ? now
          : new Date(payload.snapshotAt)
        : undefined;
    const fence = {
      userId: user.userId,
      rankRevision: user.rankRevision,
      settingsVersion: settings.settingsVersion,
      scoreVersion: settings.scoreVersion,
      scoredAt: now,
    };
    const moved = new Set<string>();
    let written = 0;
    let ranked = 0;
    let cursor: RankCursor | undefined = payload.cursor;
    let outcome: RunOutcome = 'done';
    // Whether the continuation already committed with the run's last write.
    let continued = false;

    pages: for (;;) {
      const page = await rankWindowPage(deps.db, {
        userId: user.userId,
        now,
        windowDays: RANK_WINDOW_DAYS,
        scoreVersion: settings.scoreVersion,
        rankRevision: user.rankRevision,
        contextSha: ctx.contextSha,
        degradedContextSha: ctx.degradedContextSha,
        enrichSetId: config.enrich?.id ?? null,
        recheckMarginMs: RANK_RECHECK_MARGIN_MS,
        forceBefore,
        cursor,
        limit: pageSize,
      });
      const todo = page.filter((row) => row.dirty || row.recheck);
      // Rank the whole page first, so its last write is known: a continuation (when the budget is
      // spent) commits with that write, never in a separate transaction after it.
      const batches: Array<{ writes: RankWrite[]; escalate: Set<string> }> = [];
      for (let i = 0; i < todo.length; i += batchSize) {
        const chunk = todo.slice(i, i + batchSize);
        const dirty = new Set(chunk.filter((row) => row.dirty).map((row) => row.articleId));
        const loaded = await loadRankItems(
          deps.db,
          run,
          hashes,
          chunk.map((row) => row.articleId),
        );
        const writes: RankWrite[] = [];
        const escalate = new Set<string>();
        for (const { item, stored, translations } of loaded) {
          const result = rankArticle(ctx, item, now);
          ranked += 1;
          if (!dirty.has(item.articleId) && sameRank(stored, result)) continue;
          if (
            result.lane === 'maybe' &&
            stored?.lane !== 'maybe' &&
            needsTier2(translations, item.contentRevision)
          ) {
            escalate.add(item.articleId);
          }
          writes.push({
            articleId: item.articleId,
            contentRevision: item.contentRevision,
            mediaRevision: item.mediaRevision,
            lane: result.lane,
            tier: result.tier,
            pLike: result.pLike,
            scoreSource: result.scoreSource,
            rulesFired: result.rulesFired,
            explain: result.explain,
            labelSuggestions: result.labelSuggestions,
            nextRankAt: result.nextRankAt,
          });
        }
        if (writes.length > 0) batches.push({ writes, escalate });
      }
      const last = page[page.length - 1];
      const pageCursor =
        last === undefined ? undefined : { arrival: last.arrival, articleId: last.articleId };
      const morePages = pageCursor !== undefined && page.length === pageSize;
      const spent = () => Date.now() - started >= budgetMs;
      const checkpoint = { committed: false };
      for (const [index, { writes, escalate }] of batches.entries()) {
        await options.beforeWrite?.(writes.map((write) => write.articleId));
        const final = index === batches.length - 1;
        const result = await retryTransaction(deps.db, async (tx) => {
          checkpoint.committed = false;
          const outcome = await writeRankBatch(tx, fence, writes);
          if (outcome.status === 'written') {
            const sender = workerOutbox(tx);
            for (const articleId of outcome.written) {
              if (escalate.has(articleId)) {
                await enqueueTranslate(sender, { articleId, forceTier2: true });
              }
            }
            // The decision to stop is taken here, once: the run stops exactly when this commit
            // carries the continuation (and an incremental rank for any article that moved).
            if (final && morePages && spent()) {
              const anyMoved = moved.size > 0 || outcome.movedArticleIds.length > 0;
              for (const intent of stopIntents(payload, forceBefore, pageCursor, anyMoved)) {
                await enqueueRank(sender, intent);
              }
              checkpoint.committed = true;
            }
          }
          return outcome;
        });
        if (result.status !== 'written') {
          outcome = result.status;
          break pages;
        }
        written += result.written.length;
        for (const id of result.movedArticleIds) moved.add(id);
      }
      if (!morePages) break;
      cursor = pageCursor;
      // A page that wrote something stops only with its committed continuation; a page that wrote
      // nothing left no write behind, so its continuation is recorded below.
      if (batches.length > 0 ? checkpoint.committed : spent()) {
        outcome = 'continued';
        continued = checkpoint.committed;
        break;
      }
    }

    // A continuation not committed with a write (the last page wrote nothing) is recorded here.
    const followUps = continued
      ? []
      : followUpIntents(payload, outcome, forceBefore, cursor, moved.size > 0);
    if (followUps.length > 0) {
      await retryTransaction(deps.db, async (tx) => {
        const sender = workerOutbox(tx);
        for (const intent of followUps) await enqueueRank(sender, intent);
      });
    }
    deps.logger.info(
      {
        job: 'user.rank',
        userId: user.userId,
        reason: payload.reason,
        full: payload.full === true,
        outcome,
        ranked,
        written,
        moved: moved.size,
      },
      'rank run finished',
    );
  };
}

/** The continuation of a run, resuming strictly below `cursor` (a full run's keeps its snapshot). */
function continuationIntent(
  payload: JobPayload<'user.rank'>,
  forceBefore: Date | undefined,
  cursor: RankCursor | undefined,
): JobPayload<'user.rank'> {
  return {
    userId: payload.userId,
    reason: 'continuation',
    ...(cursor === undefined ? {} : { cursor }),
    ...(forceBefore === undefined ? {} : { full: true, snapshotAt: forceBefore.toISOString() }),
  };
}

/** The jobs of a run that stops for its budget: the continuation, and an incremental rank for moved articles. */
function stopIntents(
  payload: JobPayload<'user.rank'>,
  forceBefore: Date | undefined,
  cursor: RankCursor | undefined,
  anyMoved: boolean,
): Array<JobPayload<'user.rank'>> {
  const continuation = continuationIntent(payload, forceBefore, cursor);
  return anyMoved
    ? [continuation, { userId: payload.userId, reason: 'article_moved' }]
    : [continuation];
}

/**
 * The jobs a run leaves behind: a continuation that resumes below the last visited position when the
 * budget ran out (a full run's keeps its snapshot), a replacement when the run was superseded, an
 * incremental rank for moved articles (also next to a continuation, which never revisits them).
 */
function followUpIntents(
  payload: JobPayload<'user.rank'>,
  outcome: RunOutcome,
  forceBefore: Date | undefined,
  cursor: RankCursor | undefined,
  anyMoved: boolean,
): Array<JobPayload<'user.rank'>> {
  switch (outcome) {
    case 'gone':
      return [];
    case 'continued':
      return stopIntents(payload, forceBefore, cursor, anyMoved);
    case 'superseded':
      return [{ userId: payload.userId, reason: 'superseded' }];
    case 'done':
      return anyMoved ? [{ userId: payload.userId, reason: 'article_moved' }] : [];
  }
}
