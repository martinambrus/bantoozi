import {
  rankEstimatePage,
  recordEstimateLastRun,
  retryTransaction,
  workerOutbox,
  writeRankBatch,
  type RankCursor,
  type RankWrite,
  type RankWriteFence,
  type StoredRankRow,
} from '@bantoozi/db';
import { rankArticle, type RankResult, type UserRankContext } from '@bantoozi/ranker';
import { canonicalJson, enqueueRank, RANK_WINDOW_DAYS, type JobPayload } from '@bantoozi/shared';

import { loadRankItems, type RankItemsRun } from '../rank/items.js';
import type { WorkerDeps } from './deps.js';

/** A stored P and a new one closer than this are the same estimate. */
const ESTIMATE_P_EPSILON = 0.01;

type EstimateOutcome = 'done' | 'superseded' | 'gone' | 'continued';

export interface EstimateRunInput {
  deps: WorkerDeps;
  payload: JobPayload<'user.rank'>;
  userId: string;
  now: Date;
  started: number;
  ctx: UserRankContext;
  run: RankItemsRun;
  hashes: ReadonlyMap<string, string>;
  fence: RankWriteFence;
  pageSize: number;
  batchSize: number;
  budgetMs: number;
  beforeWrite?: ((articleIds: readonly string[]) => Promise<void>) | undefined;
}

/** Whether the stored row already holds what the estimate refresh would write. */
function sameEstimate(stored: StoredRankRow, result: RankResult): boolean {
  const suggestions = result.labelSuggestions.filter((id) => !stored.labelIds.includes(id));
  const sameP =
    stored.pLike === null || result.pLike === null
      ? stored.pLike === result.pLike
      : Math.abs(result.pLike - stored.pLike) < ESTIMATE_P_EPSILON;
  return (
    stored.lane === result.lane &&
    stored.scoreSource === result.scoreSource &&
    stored.tier === result.tier &&
    canonicalJson(stored.rulesFired) === canonicalJson(result.rulesFired) &&
    canonicalJson([...stored.labelSuggestions].sort()) === canonicalJson([...suggestions].sort()) &&
    sameP
  );
}

/**
 * The estimate refresh of `user.rank` (visible-learning §4.4, spec 06 §8.6): walks the user's `new`
 * rows stored as `none` or `estimate`, ranks them without the BM25 corpus and writes only the
 * estimate results that moved. Results of other sources are left to the plain run.
 */
export async function rankEstimateRun(input: EstimateRunInput): Promise<void> {
  const { deps, payload, userId, now, ctx, run, hashes, fence, pageSize, batchSize, budgetMs } =
    input;
  const sources: Array<'none' | 'estimate'> = ctx.estimate ? ['none', 'estimate'] : ['estimate'];
  const version = payload.estimate?.version ?? ctx.estimate?.version;
  const versionKept = ctx.estimate !== undefined && ctx.estimate.version === version;
  const moved = new Set<string>();
  let up = payload.estimate?.up ?? 0;
  let down = payload.estimate?.down ?? 0;
  let visited = 0;
  let ranked = 0;
  let written = 0;
  let deferred = 0;
  let cursor: RankCursor | undefined = payload.cursor;
  let outcome: EstimateOutcome = 'done';
  let continued = false;
  const continuation = (at: RankCursor | undefined, upNow: number, downNow: number) =>
    ({
      userId,
      reason: 'continuation',
      ...(at === undefined ? {} : { cursor: at }),
      estimate: {
        ...(version === undefined ? {} : { version }),
        up: upNow,
        down: downNow,
      },
    }) satisfies JobPayload<'user.rank'>;

  pages: for (;;) {
    const page = await rankEstimatePage(deps.db, {
      userId,
      now,
      windowDays: RANK_WINDOW_DAYS,
      sources,
      cursor,
      limit: pageSize,
    });
    visited += page.length;
    const unread = new Map(page.map((row) => [row.articleId, row.unread]));
    const batches: Array<{
      writes: RankWrite[];
      shift: Map<string, 1 | -1 | 0>;
    }> = [];
    for (let i = 0; i < page.length; i += batchSize) {
      const ids = page.slice(i, i + batchSize).map((row) => row.articleId);
      const loaded = await loadRankItems(deps.db, run, hashes, ids);
      const writes: RankWrite[] = [];
      const shift = new Map<string, 1 | -1 | 0>();
      for (const { item, stored } of loaded) {
        const result = rankArticle(ctx, item, now);
        ranked += 1;
        const candidate =
          (result.scoreSource === 'none' || result.scoreSource === 'estimate') &&
          result.lane === 'new';
        if (!candidate) {
          deferred += 1;
          continue;
        }
        if (stored !== undefined && sameEstimate(stored, result)) continue;
        const from = stored?.tier ?? null;
        const change = (result.tier ?? 1) - (from ?? 1);
        shift.set(
          item.articleId,
          unread.get(item.articleId) === true ? (Math.sign(change) as 1 | -1 | 0) : 0,
        );
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
      if (writes.length > 0) batches.push({ writes, shift });
    }
    const last = page[page.length - 1];
    const pageCursor =
      last === undefined ? undefined : { arrival: last.arrival, articleId: last.articleId };
    const morePages = pageCursor !== undefined && page.length === pageSize;
    const spent = () => Date.now() - input.started >= budgetMs;
    const checkpoint = { committed: false };
    for (const [index, { writes, shift }] of batches.entries()) {
      await input.beforeWrite?.(writes.map((write) => write.articleId));
      const final = index === batches.length - 1;
      let batchUp = 0;
      let batchDown = 0;
      const result = await retryTransaction(deps.db, async (tx) => {
        checkpoint.committed = false;
        batchUp = 0;
        batchDown = 0;
        const outcomeTx = await writeRankBatch(tx, fence, writes);
        if (outcomeTx.status === 'written') {
          for (const id of outcomeTx.written) {
            const direction = shift.get(id) ?? 0;
            if (direction > 0) batchUp += 1;
            else if (direction < 0) batchDown += 1;
          }
          if (final && morePages && spent()) {
            const sender = workerOutbox(tx);
            await enqueueRank(sender, continuation(pageCursor, up + batchUp, down + batchDown));
            if (moved.size > 0 || outcomeTx.movedArticleIds.length > 0) {
              await enqueueRank(sender, { userId, reason: 'article_moved' });
            }
            checkpoint.committed = true;
          }
        }
        return outcomeTx;
      });
      if (result.status !== 'written') {
        outcome = result.status;
        break pages;
      }
      written += result.written.length;
      up += batchUp;
      down += batchDown;
      for (const id of result.movedArticleIds) moved.add(id);
    }
    if (!morePages) break;
    cursor = pageCursor;
    if (batches.length > 0 ? checkpoint.committed : spent()) {
      outcome = 'continued';
      continued = checkpoint.committed;
      break;
    }
  }

  if (outcome === 'done' && versionKept && ctx.estimate !== undefined) {
    await recordEstimateLastRun(deps.db, userId, ctx.estimate.version, {
      at: now.toISOString(),
      movedUp: up,
      movedDown: down,
    });
  }
  const followUps: Array<JobPayload<'user.rank'>> = [];
  if (outcome === 'superseded') followUps.push({ userId, reason: 'superseded' });
  if (outcome === 'done' && moved.size > 0) followUps.push({ userId, reason: 'article_moved' });
  if (outcome === 'continued' && !continued) {
    followUps.push(continuation(cursor, up, down));
    if (moved.size > 0) followUps.push({ userId, reason: 'article_moved' });
  }
  if (followUps.length > 0) {
    await retryTransaction(deps.db, async (tx) => {
      const sender = workerOutbox(tx);
      for (const intent of followUps) await enqueueRank(sender, intent);
    });
  }
  deps.logger.info(
    {
      job: 'user.rank',
      mode: 'estimate',
      userId,
      outcome,
      visited,
      ranked,
      written,
      deferred,
      up,
      down,
    },
    'rank run finished',
  );
}
