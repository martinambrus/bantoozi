import {
  answerPrompt,
  articleContexts,
  articleViewIds,
  bookmarkArticle,
  calibrationArticles,
  countArticles,
  getArticleDetail,
  labelArticle,
  listArticlePage,
  loadArticleItems,
  lockReaderUser,
  markArticleRead,
  markArticleUnread,
  markArticlesRead,
  muteArticleStory,
  openArticle,
  pinUnbookmark,
  rateArticle,
  rateArticlesBulk,
  readOwnUser,
  recordDwell,
  retryBookmarkCapture,
  tenantOutbox,
  unbookmarkArticle,
  undoArticleMutation,
  unhideArticle,
  unlabelArticle,
  type ActionResult,
  type ArticleListKey,
  type ArticleListSort,
  type ArticleScope,
  type ReaderFence,
  type TenantTx,
} from '@bantoozi/db';
import { suggestExample } from '@bantoozi/ranker';
import {
  AppError,
  ArticleCountsQuerySchema,
  ArticleCountsSchema,
  ArticleDetailQuerySchema,
  ArticleDetailSchema,
  ArticleFenceSchema,
  ArticleIdParamsSchema,
  ArticleItemResponseSchema,
  ArticleLabelParamsSchema,
  ArticleListQuerySchema,
  ArticleListResponseSchema,
  BookmarkBodySchema,
  BulkItemsResponseSchema,
  CalibrationResponseSchema,
  DwellBodySchema,
  DwellResponseSchema,
  LabelBodySchema,
  MAX_MARK_READ_FILTER_TARGETS,
  MarkReadBodySchema,
  MarkReadResponseSchema,
  MuteStoryBodySchema,
  MuteStoryResponseSchema,
  PromptAnswerBodySchema,
  RateBulkBodySchema,
  RatingBodySchema,
  RatingResponseSchema,
  ReadBodySchema,
  RetryCaptureBodySchema,
  UndoBodySchema,
  enqueueRank,
  readUserPreferences,
  type ArticleFence,
  type ArticleListItem,
  type ArticleStatus,
  type ArticleViewLane,
  type MarkReadLane,
  type UserPreferences,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { queryHash } from '../services/cursor.js';
import { currentScoreVersion } from '../services/score-version.js';
import type { MutationContext, MutationOutcome } from '../types.js';
import { ruleDto } from './rules.js';

/**
 * M4-T6/T7: the reader's article list, counts, detail and calibration round, and every reader
 * action with exact undo (spec 08 §5). Views and actions live in `@bantoozi/db` (`api/articles.ts`,
 * `api/article-actions.ts`); this module resolves the caller's defaults, signs cursors and wraps
 * actions in idempotent mutations.
 */

/** Cursor validity of the article list (spec 08 §5.1). */
export const ARTICLE_CURSOR_TTL_SECONDS = 15 * 60;

/** The `user.rank` reason of a read-side catch-up (spec 08 §5.1 "Outdated scores"). */
const CATCH_UP_REASON = 'list';

const TAGS = ['articles'];
const USER = { auth: 'user' as const };

async function readPrefs(tx: TenantTx): Promise<UserPreferences> {
  return readUserPreferences((await readOwnUser(tx)).preferences);
}

/**
 * Request a catch-up full rank when a view has outdated eligible scores (spec 08 §5.1). The intent
 * goes through the outbox without advancing `users.rank_revision`: the rows are already outdated,
 * and a bump would make every later read outdated again.
 */
async function requestCatchUp(tx: TenantTx, userId: string): Promise<void> {
  await enqueueRank(tenantOutbox(tx), { userId, reason: CATCH_UP_REASON, full: true });
}

/** The status, tier and sort a view uses when the query leaves them out (spec 08 §5.1). */
function viewDefaults(
  lane: ArticleViewLane,
  prefs: UserPreferences,
  query: {
    status?: ArticleStatus | undefined;
    minTier?: number | undefined;
    sort?: 'score' | 'date' | undefined;
  },
): { status: ArticleStatus; minTier: number; sort: ArticleListSort } {
  const status = query.status ?? (lane === 'bookmarks' || lane === 'hidden' ? 'all' : 'unread');
  const minTier = query.minTier ?? prefs.defaultTier;
  const sort: ArticleListSort =
    query.sort ?? (lane === 'for_you' ? prefs.sort : lane === 'maybe' ? 'uncertainty' : 'date');
  return { status, minTier, sort };
}

interface ListCursorExtra {
  asOf: string;
  datasetVersion: string;
  sort: ArticleListSort;
}

function isListKey(value: unknown): value is ArticleListKey {
  if (typeof value !== 'object' || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key['k1'] === 'number' &&
    Number.isFinite(key['k1']) &&
    typeof key['k2'] === 'string' &&
    /^-?\d{1,20}$/.test(key['k2']) &&
    typeof key['id'] === 'string' &&
    /^\d{1,19}$/.test(key['id'])
  );
}

function isListExtra(value: unknown): value is ListCursorExtra {
  if (typeof value !== 'object' || value === null) return false;
  const extra = value as Record<string, unknown>;
  return (
    typeof extra['asOf'] === 'string' &&
    !Number.isNaN(Date.parse(extra['asOf'])) &&
    typeof extra['datasetVersion'] === 'string' &&
    (extra['sort'] === 'score' || extra['sort'] === 'uncertainty' || extra['sort'] === 'date')
  );
}

const fenceOf = (fence: ArticleFence): ReaderFence => ({
  stateVersion: fence.stateVersion,
  contentRevision: fence.contentRevision,
  ...(fence.snapshotId === undefined ? {} : { snapshotId: fence.snapshotId }),
});

/** Response items for action results, in the given order (global-view projection, spec 08 §5.2). */
export async function actionItems(
  tx: TenantTx,
  ids: readonly string[],
): Promise<ArticleListItem[]> {
  const prefs = await readPrefs(tx);
  const contexts = await articleContexts(tx, ids);
  return loadArticleItems(tx, contexts, { loadRemoteImages: prefs.loadRemoteImages });
}

async function actionItem(tx: TenantTx, articleId: string): Promise<ArticleListItem> {
  const [item] = await actionItems(tx, [articleId]);
  if (item === undefined) throw new AppError('NOT_FOUND', 'Article not found');
  return item;
}

type ItemBody<E> = { item: ArticleListItem; mutationId: string } & E;

/** `{item, mutationId, ...extra}` with the action's undo receipt (spec 08 §5.3). */
async function itemOutcome<E extends object>(
  tx: TenantTx,
  ctx: MutationContext,
  articleId: string,
  result: ActionResult,
  extra: E,
  status = 200,
): Promise<MutationOutcome<ItemBody<E>>> {
  const item = await actionItem(tx, articleId);
  return {
    status,
    body: { item, mutationId: ctx.mutationId, ...extra },
    ...(result.undo === undefined ? {} : { undo: result.undo }),
  };
}

/**
 * Mark-read by a confirmed filter (spec 08 §5.3, and §4 `POST /subscriptions/:feedId/mark-read`):
 * under the user lock, materialize the view's unread representatives with arrival ≤ `olderThan`
 * (the list's `asOf`) once, compare its dataset version with the confirmed one (`STALE_STATE` when
 * it changed), reject more than 5,000 targets, and mark them read without per-item fences.
 */
export async function markReadByFilter(
  tx: TenantTx,
  ctx: MutationContext,
  input: {
    lane: MarkReadLane;
    scope: ArticleScope;
    minTier?: number | undefined;
    olderThan: string;
    datasetVersion: string;
  },
): Promise<MutationOutcome<{ count: number; mutationId: string }>> {
  const { prefs } = await lockReaderUser(tx);
  const view = await articleViewIds(
    tx,
    {
      scope: input.scope,
      lane: input.lane,
      status: 'unread',
      minTier: input.minTier ?? prefs.defaultTier,
      asOf: new Date(input.olderThan),
      scoreVersion: await currentScoreVersion(tx),
    },
    { maxIds: MAX_MARK_READ_FILTER_TARGETS },
  );
  if (view.datasetVersion !== input.datasetVersion) {
    throw new AppError('STALE_STATE', 'The list changed since it was confirmed', {
      details: { reason: 'dataset_changed', datasetVersion: view.datasetVersion },
    });
  }
  if (view.total > MAX_MARK_READ_FILTER_TARGETS) {
    throw new AppError('VALIDATION_FAILED', 'Too many articles to mark read at once', {
      details: { reason: 'too_many_targets', max: MAX_MARK_READ_FILTER_TARGETS, total: view.total },
    });
  }
  const result = await markArticlesRead(tx, {
    targets: view.ids.map((articleId) => ({ articleId, fence: null })),
    now: ctx.now,
    outbox: ctx.outbox,
  });
  return {
    status: 200,
    body: { count: result.count, mutationId: ctx.mutationId },
    ...(result.undo === undefined ? {} : { undo: result.undo }),
  };
}

export const articleRoutes: FastifyPluginAsyncZod = async (app) => {
  const { cursors, clock } = app.services;

  // ── Views (T6) ──────────────────────────────────────────────────────────────────────────────

  app.get(
    '',
    {
      schema: {
        tags: TAGS,
        summary: 'List articles of a lane',
        querystring: ArticleListQuerySchema,
        response: { 200: ArticleListResponseSchema },
      },
      config: USER,
    },
    async (request) => {
      const query = request.query;
      const userId = request.auth?.userId ?? '';
      const hash = queryHash({
        lane: query.lane,
        feedId: query.feedId,
        folder: query.folder,
        labelId: query.labelId,
        status: query.status,
        minTier: query.minTier,
        sort: query.sort,
      });
      const cursor =
        query.cursor === undefined
          ? null
          : cursors.decode<unknown, unknown>(query.cursor, { userId, query: hash });
      let after: ArticleListKey | null = null;
      let extra: ListCursorExtra | null = null;
      if (cursor !== null) {
        if (!isListKey(cursor.key) || !isListExtra(cursor.extra)) {
          throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
        }
        after = cursor.key;
        extra = cursor.extra;
      }
      return request.withTx(async (tx) => {
        const prefs = await readPrefs(tx);
        const defaults = viewDefaults(query.lane, prefs, query);
        if (extra !== null && extra.sort !== defaults.sort) {
          throw new AppError('STALE_CURSOR', 'The list order changed; reload from the first page');
        }
        const asOf = extra === null ? clock.now() : new Date(extra.asOf);
        const page = await listArticlePage(tx, {
          scope: { feedId: query.feedId, folder: query.folder, labelId: query.labelId },
          lane: query.lane,
          status: defaults.status,
          minTier: defaults.minTier,
          asOf,
          scoreVersion: await currentScoreVersion(tx),
          sort: defaults.sort,
          limit: query.limit,
          after,
        });
        if (extra !== null && extra.datasetVersion !== page.datasetVersion) {
          throw new AppError('STALE_CURSOR', 'The list changed; reload from the first page');
        }
        if (page.rankingPending) await requestCatchUp(tx, userId);
        const items = await loadArticleItems(tx, page.rows, {
          loadRemoteImages: prefs.loadRemoteImages,
        });
        const nextCursor =
          page.nextKey === null
            ? null
            : cursors.encode<ArticleListKey, ListCursorExtra>(
                {
                  key: page.nextKey,
                  query: hash,
                  extra: {
                    asOf: asOf.toISOString(),
                    datasetVersion: page.datasetVersion,
                    sort: defaults.sort,
                  },
                },
                { userId, ttlSeconds: ARTICLE_CURSOR_TTL_SECONDS },
              );
        return {
          items,
          nextCursor,
          asOf: asOf.toISOString(),
          datasetVersion: page.datasetVersion,
          rankingPending: page.rankingPending,
        };
      });
    },
  );

  app.get(
    '/counts',
    {
      schema: {
        tags: TAGS,
        summary: 'Lane counts of a view',
        querystring: ArticleCountsQuerySchema,
        response: { 200: ArticleCountsSchema },
      },
      config: USER,
    },
    async (request) => {
      const query = request.query;
      const userId = request.auth?.userId ?? '';
      return request.withTx(async (tx) => {
        const prefs = await readPrefs(tx);
        const asOf = query.asOf === undefined ? clock.now() : new Date(query.asOf);
        const counts = await countArticles(tx, {
          scope: { feedId: query.feedId, folder: query.folder, labelId: query.labelId },
          status: query.status ?? 'unread',
          minTier: query.minTier ?? prefs.defaultTier,
          asOf,
          scoreVersion: await currentScoreVersion(tx),
        });
        if (counts.rankingPending) await requestCatchUp(tx, userId);
        return { ...counts, asOf: asOf.toISOString() };
      });
    },
  );

  app.get(
    '/calibration',
    {
      schema: {
        tags: TAGS,
        summary: 'Articles for a calibration round',
        response: { 200: CalibrationResponseSchema },
      },
      config: USER,
    },
    async (request) =>
      request.withTx(async (tx) => {
        const prefs = await readPrefs(tx);
        const contexts = await calibrationArticles(tx, {
          now: clock.now(),
          scoreVersion: await currentScoreVersion(tx),
        });
        const items = await loadArticleItems(tx, contexts, {
          loadRemoteImages: prefs.loadRemoteImages,
        });
        return { items };
      }),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Article detail',
        params: ArticleIdParamsSchema,
        querystring: ArticleDetailQuerySchema,
        response: { 200: ArticleDetailSchema },
      },
      config: USER,
    },
    async (request) =>
      request.withTx(async (tx) => {
        const prefs = await readPrefs(tx);
        const detail = await getArticleDetail(tx, {
          articleId: request.params.id,
          sourceFeedId: request.query.sourceFeedId,
          savedView: request.query.view === 'saved',
          loadRemoteImages: prefs.loadRemoteImages,
        });
        if (detail === null) throw new AppError('NOT_FOUND', 'Article not found');
        return detail;
      }),
  );

  // ── Single-article actions (T7) ─────────────────────────────────────────────────────────────

  const itemResponse = { 200: ArticleItemResponseSchema };

  app.post(
    '/:id/read',
    {
      schema: {
        tags: TAGS,
        summary: 'Mark an article read',
        params: ArticleIdParamsSchema,
        body: ReadBodySchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await markArticleRead(tx, {
          articleId: id,
          fence: fenceOf(body),
          now: ctx.now,
          outbox: ctx.outbox,
          trigger: body.trigger,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/unread',
    {
      schema: {
        tags: TAGS,
        summary: 'Mark an article unread',
        params: ArticleIdParamsSchema,
        body: ArticleFenceSchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await markArticleUnread(tx, {
          articleId: id,
          fence: fenceOf(body),
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/unhide',
    {
      schema: {
        tags: TAGS,
        summary: 'Unhide an article',
        params: ArticleIdParamsSchema,
        body: ArticleFenceSchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await unhideArticle(tx, {
          articleId: id,
          fence: fenceOf(body),
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/open',
    {
      schema: {
        tags: TAGS,
        summary: 'Record opening the original article',
        params: ArticleIdParamsSchema,
        body: ArticleFenceSchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await openArticle(tx, {
          articleId: id,
          fence: fenceOf(body),
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/dwell',
    {
      schema: {
        tags: TAGS,
        summary: 'Record reading time',
        params: ArticleIdParamsSchema,
        body: DwellBodySchema,
        response: { 200: DwellResponseSchema },
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await recordDwell(tx, {
          articleId: id,
          fence: fenceOf(body),
          ms: body.ms,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, { prompt: result.prompt });
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/rating',
    {
      schema: {
        tags: TAGS,
        summary: 'Rate an article',
        params: ArticleIdParamsSchema,
        body: RatingBodySchema,
        response: { 200: RatingResponseSchema },
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await rateArticle(tx, {
          articleId: id,
          fence: fenceOf(body),
          rating: body.rating,
          reason: body.reason ?? null,
          hide: body.hide === true,
          analysisRequestId: body.analysisRequestId,
          selection: body.selection,
          now: ctx.now,
          outbox: ctx.outbox,
          suggest: (context) => suggestExample({ ...context, trigger: 'rating' }),
        });
        return itemOutcome(tx, ctx, id, result, { exampleSuggestion: result.exampleSuggestion });
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/prompt-answer',
    {
      schema: {
        tags: TAGS,
        summary: 'Answer the feedback prompt',
        params: ArticleIdParamsSchema,
        body: PromptAnswerBodySchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await answerPrompt(tx, {
          articleId: id,
          fence: fenceOf(body),
          liked: body.liked,
          analysisRequestId: body.analysisRequestId,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/bookmark',
    {
      schema: {
        tags: TAGS,
        summary: 'Bookmark an article',
        params: ArticleIdParamsSchema,
        body: BookmarkBodySchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await bookmarkArticle(tx, {
          articleId: id,
          fence: fenceOf(body),
          mediaPolicyFeedId: body.mediaPolicyFeedId,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '/:id/bookmark',
    {
      schema: {
        tags: TAGS,
        summary: 'Remove a bookmark',
        params: ArticleIdParamsSchema,
        querystring: ArticleFenceSchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const fence = fenceOf(request.query);
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await unbookmarkArticle(tx, {
          articleId: id,
          fence,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        const base = await itemOutcome(tx, ctx, id, result, {});
        const snapshotId = result.pinSnapshotId;
        if (snapshotId === null) return base;
        return {
          ...base,
          // The pin references the receipt, so it is written once the receipt exists.
          afterSave: (pinTx: TenantTx) =>
            pinUnbookmark(pinTx, { mutationId: ctx.mutationId, snapshotId, now: ctx.now }),
        };
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/bookmark/retry-capture',
    {
      schema: {
        tags: TAGS,
        summary: 'Retry capturing a saved article',
        params: ArticleIdParamsSchema,
        body: RetryCaptureBodySchema,
        response: { 202: ArticleItemResponseSchema },
      },
      config: {
        ...USER,
        rateLimits: [{ group: 'bookmark-retry', max: 20, windowSeconds: 3600, per: 'user' }],
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await retryBookmarkCapture(tx, {
          articleId: id,
          fence: fenceOf(body),
          captureGeneration: body.captureGeneration,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {}, 202);
      });
      return reply.code(202).send(outcome.body);
    },
  );

  app.post(
    '/:id/labels',
    {
      schema: {
        tags: TAGS,
        summary: 'Assign a label',
        params: ArticleIdParamsSchema,
        body: LabelBodySchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await labelArticle(tx, {
          articleId: id,
          fence: fenceOf(body),
          labelId: body.labelId,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '/:id/labels/:labelId',
    {
      schema: {
        tags: TAGS,
        summary: 'Remove a label',
        params: ArticleLabelParamsSchema,
        querystring: ArticleFenceSchema,
        response: itemResponse,
      },
      config: USER,
    },
    async (request, reply) => {
      const { id, labelId } = request.params;
      const fence = fenceOf(request.query);
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await unlabelArticle(tx, {
          articleId: id,
          fence,
          labelId,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return itemOutcome(tx, ctx, id, result, {});
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/mute-story',
    {
      schema: {
        tags: TAGS,
        summary: "Mute an article's story",
        params: ArticleIdParamsSchema,
        body: MuteStoryBodySchema,
        response: { 201: MuteStoryResponseSchema },
      },
      config: USER,
    },
    async (request, reply) => {
      const { id } = request.params;
      const { days } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const rule = await muteArticleStory(tx, { articleId: id, days });
        return { status: 201, body: { rule: ruleDto(rule) } };
      });
      return reply.code(201).send(outcome.body);
    },
  );

  // ── Bulk actions and undo (T7) ──────────────────────────────────────────────────────────────

  app.post(
    '/mark-read',
    {
      schema: {
        tags: TAGS,
        summary: 'Mark articles read',
        body: MarkReadBodySchema,
        response: { 200: MarkReadResponseSchema },
      },
      config: USER,
    },
    async (request, reply) => {
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        if ('filter' in body) {
          const { filter } = body;
          return markReadByFilter(tx, ctx, {
            lane: filter.lane,
            scope: { feedId: filter.feedId, folder: filter.folder, labelId: filter.labelId },
            minTier: filter.minTier,
            olderThan: filter.olderThan,
            datasetVersion: body.datasetVersion,
          });
        }
        const result = await markArticlesRead(tx, {
          targets: body.targets.map((target) => ({
            articleId: target.id,
            fence: { stateVersion: target.stateVersion, contentRevision: target.contentRevision },
          })),
          now: ctx.now,
          outbox: ctx.outbox,
        });
        return {
          status: 200,
          body: { count: result.count, mutationId: ctx.mutationId },
          ...(result.undo === undefined ? {} : { undo: result.undo }),
        };
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/rate-bulk',
    {
      schema: {
        tags: TAGS,
        summary: 'Rate several articles',
        body: RateBulkBodySchema,
        response: { 200: BulkItemsResponseSchema },
      },
      config: USER,
    },
    async (request, reply) => {
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await rateArticlesBulk(tx, {
          targets: body.targets.map((target) => ({
            articleId: target.id,
            fence: { stateVersion: target.stateVersion, contentRevision: target.contentRevision },
            analysisRequestId: target.analysisRequestId,
          })),
          rating: body.rating,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        const items = await actionItems(tx, result.articleIds);
        return {
          status: 200,
          body: { count: result.articleIds.length, mutationId: ctx.mutationId, items },
          ...(result.undo === undefined ? {} : { undo: result.undo }),
        };
      });
      return reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/undo',
    {
      schema: {
        tags: TAGS,
        summary: 'Undo a reader action',
        body: UndoBodySchema,
        response: { 200: BulkItemsResponseSchema },
      },
      config: USER,
    },
    async (request, reply) => {
      const { mutationId } = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        const result = await undoArticleMutation(tx, {
          mutationId,
          now: ctx.now,
          outbox: ctx.outbox,
        });
        const items = await actionItems(tx, result.articleIds);
        return { status: 200, body: { count: result.count, mutationId: ctx.mutationId, items } };
      });
      return reply.code(200).send(outcome.body);
    },
  );
};
