import { createHash } from 'node:crypto';

import {
  canHoldFeedPreference,
  checkAnalysisSelection,
  createAnalysisRequest,
  deleteSubscription,
  getAnalysisRequest,
  getSubscription,
  listFeedPreferences,
  listOpmlRows,
  listSubscriptions,
  lockFeeds,
  lockSubscription,
  readOwnUser,
  recordRankIntents,
  refreshFeedMaterializations,
  renameSubscriptionFolder,
  reusableAnalysisRequests,
  setInferenceMode,
  countSubscriptionUnread,
  updateOwnUser,
  updateSubscriptionMetadata,
  upsertFeedPreference,
} from '@bantoozi/db';
import { decodeBody, exportOpml, parseOpml } from '@bantoozi/feeds';
import {
  AnalysisRequestParamsSchema,
  AnalysisRequestSchema,
  AnalyzeBodySchema,
  AnalyzeResponseSchema,
  AppError,
  FeedIdParamsSchema,
  FeedPreferenceBodySchema,
  FeedPreferenceListSchema,
  FeedPreferenceSchema,
  FolderRenameResultSchema,
  FolderRenameSchema,
  InferenceChangeSchema,
  OpmlImportReportSchema,
  SubscribeBodySchema,
  SubscribeOkSchema,
  SubscriptionEnvelopeSchema,
  SubscriptionListSchema,
  SubscriptionPatchSchema,
  analysisRequestTransition,
  compareBigIntStrings,
  effectiveImagesAllowed,
  enqueueLearn,
  planInferenceModeChange,
  readUserPreferences,
  type AnalyzeResponse,
  type OpmlImportReport,
  type SubscriptionEnvelope,
} from '@bantoozi/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { captureSelectionSnapshot, loadSnapshotConfig } from '../services/analysis.js';
import { importOpml } from '../services/opml.js';
import { currentScoreVersion } from '../services/score-version.js';
import {
  discover,
  loadSubscriptionDto,
  ownPreferences,
  subscribe,
  subscriptionDto,
} from '../services/subscriptions.js';

/** Route limits of spec 08 §11, per user. */
const SUBSCRIBE_LIMIT = { group: 'subscribe', max: 30, windowSeconds: 3600, per: 'user' } as const;
const IMPORT_LIMIT = { group: 'opml-import', max: 5, windowSeconds: 86_400, per: 'user' } as const;
const ANALYZE_LIMIT = { group: 'analyze', max: 20, windowSeconds: 3600, per: 'user' } as const;

const notFound = () => new AppError('NOT_FOUND', 'Subscription not found');

/** Aborts when the client goes away before the response is complete (cancels slow discovery). */
function clientGone(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/**
 * Bind a multipart upload's idempotency receipt to the uploaded bytes: the receipt digest covers
 * the validated body (spec 08 §1.1), and a multipart request has none, so the file's SHA-256
 * stands in for it.
 */
function bindUploadDigest(request: FastifyRequest, bytes: Buffer): void {
  (request as { body: unknown }).body = {
    file: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** The supplied keys only (`exactOptionalPropertyTypes`: missing means unchanged). */
function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** M4-T4: subscriptions, feed preferences, OPML, folders and analysis requests (spec 08 §4). */
/** Answer a subscribe from a saved receipt (`201` created, otherwise `200`). */
function replaySubscribe(
  reply: FastifyReply,
  saved: { status: number; body: SubscriptionEnvelope },
): FastifyReply {
  return reply.code(saved.status === 201 ? 201 : 200).send(saved.body);
}

export const subscriptionRoutes: FastifyPluginAsyncZod = async (app) => {
  const { clock } = app.services;

  app.get(
    '/subscriptions',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Your subscriptions with unread counts',
        response: { 200: SubscriptionListSchema },
      },
    },
    async (request) =>
      request.withTx(async (tx) => {
        const preferences = await ownPreferences(tx);
        const rows = await listSubscriptions(tx);
        const unread = await countSubscriptionUnread(tx, {
          asOf: clock.now(),
          minTier: preferences.defaultTier,
          scoreVersion: await currentScoreVersion(tx),
        });
        return rows.map((row) => subscriptionDto(row, preferences, unread.get(row.feed.id)));
      }),
  );

  app.post(
    '/subscriptions',
    {
      config: { rateLimits: [SUBSCRIBE_LIMIT] },
      schema: {
        tags: ['subscriptions'],
        summary: 'Subscribe to a site or feed URL (discovery; inference starts off)',
        body: SubscribeBodySchema,
        response: { 200: SubscribeOkSchema, 201: SubscriptionEnvelopeSchema },
      },
    },
    async (request, reply) =>
      request.holdingKey(async () => {
        // A retry of a committed subscribe is answered from its receipt, without new discovery; a
        // concurrent duplicate waits for this request to settle first.
        const saved = await request.savedOutcome<SubscriptionEnvelope>();
        if (saved !== null) return replaySubscribe(reply, saved);
        // Slow outbound work first: no transaction is open during discovery (spec 08 §1). A
        // concurrent duplicate may have committed meanwhile: its receipt wins over a discovery
        // failure or a candidate choice of this request.
        let discovered: Awaited<ReturnType<typeof discover>>;
        try {
          discovered = await discover(
            request.body.url,
            app.services.discoverDeps,
            clientGone(reply),
          );
        } catch (error) {
          const committed = await request.savedOutcome<SubscriptionEnvelope>();
          if (committed !== null) return replaySubscribe(reply, committed);
          throw error;
        }
        const [candidate, ...others] = discovered.candidates;
        if (candidate === undefined || others.length > 0) {
          const committed = await request.savedOutcome<SubscriptionEnvelope>();
          if (committed !== null) return replaySubscribe(reply, committed);
          return reply.code(200).send({
            status: 'choose' as const,
            candidates: discovered.candidates.map((c) => ({
              url: c.url,
              title: c.title,
              type: c.type,
            })),
          });
        }
        const title =
          discovered.validated?.candidate.canonicalUrl === candidate.canonicalUrl
            ? (discovered.validated.parsed.feed.title ?? candidate.title)
            : candidate.title;
        const outcome = await request.mutate(async (tx, { outbox, now }) => {
          const result = await subscribe(tx, outbox, {
            candidate,
            title,
            folder: request.body.folder ?? null,
            asOf: now,
          });
          return {
            status: result.created ? 201 : 200,
            body: { subscription: result.subscription },
          };
        });
        return reply.code(outcome.status === 201 ? 201 : 200).send(outcome.body);
      }),
  );

  app.patch(
    '/subscriptions/:feedId',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Update subscription metadata and its remembered image policy',
        params: FeedIdParamsSchema,
        body: SubscriptionPatchSchema,
        response: { 200: SubscriptionEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const { feedId } = request.params;
      const { imagePolicy, ...metadata } = request.body;
      const outcome = await request.mutate(async (tx, { outbox, now }) => {
        const user = await readOwnUser(tx, { lock: true });
        const current = await getSubscription(tx, feedId);
        if (current === null) throw notFound();
        const columns = Object.keys(metadata).length > 0;
        if (columns) {
          await lockFeeds(tx, [feedId]);
          await updateSubscriptionMetadata(tx, feedId, definedOnly(metadata));
          await refreshFeedMaterializations(tx, [feedId]);
        }
        if (imagePolicy !== undefined) await upsertFeedPreference(tx, feedId, imagePolicy);
        // A changed duplicate policy changes folding and ranking (spec 06 §7).
        if (
          metadata.allowDuplicates !== undefined &&
          metadata.allowDuplicates !== current.allowDuplicates
        ) {
          await recordRankIntents(tx, outbox, [user.id], {
            reason: 'subscription:duplicates',
            full: true,
          });
        }
        return {
          status: 200,
          body: { subscription: await loadSubscriptionDto(tx, feedId, now) },
        };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/subscriptions/:feedId/inference',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Change the feed’s inference mode (CAS on inferenceVersion)',
        params: FeedIdParamsSchema,
        body: InferenceChangeSchema,
        response: { 200: SubscriptionEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const { feedId } = request.params;
      const outcome = await request.mutate(async (tx, { outbox, now }) => {
        const user = await readOwnUser(tx, { lock: true });
        await lockFeeds(tx, [feedId]);
        const current = await lockSubscription(tx, feedId);
        if (current === null) throw notFound();
        const plan = planInferenceModeChange(
          current,
          request.body.mode,
          request.body.expectedVersion,
          now,
        );
        if (plan.kind === 'change') {
          // Entering active stamps the transaction time; only new arrivals from then on are
          // admitted automatically (spec 08 §4.1). Leaving a mode fences its stale demand.
          await setInferenceMode(tx, feedId, plan.state);
          await refreshFeedMaterializations(tx, [feedId]);
          await recordRankIntents(tx, outbox, [user.id], { reason: 'inference_mode', full: true });
        }
        return {
          status: 200,
          body: { subscription: await loadSubscriptionDto(tx, feedId, now) },
        };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/subscriptions/:feedId/analyze',
    {
      config: { rateLimits: [ANALYZE_LIMIT] },
      schema: {
        tags: ['subscriptions'],
        summary: 'Request analysis of exactly these article revisions',
        params: FeedIdParamsSchema,
        body: AnalyzeBodySchema,
        response: { 202: AnalyzeResponseSchema },
      },
    },
    async (request, reply) => {
      const { feedId } = request.params;
      const { articles, expectedInferenceVersion, startTraining } = request.body;
      const outcome = await request.mutate(async (tx, { outbox, now }) => {
        const user = await readOwnUser(tx, { lock: true });
        await lockFeeds(tx, [feedId]);
        const current = await lockSubscription(tx, feedId);
        if (current === null) throw notFound();
        if (compareBigIntStrings(current.version, expectedInferenceVersion) !== 0) {
          throw new AppError('STALE_STATE', 'Subscription inference version changed', {
            details: { currentVersion: current.version },
          });
        }
        const transition = analysisRequestTransition(current.mode, startTraining === true);
        if (!transition.allowed) {
          throw new AppError(
            'CONFLICT',
            'Inference is off for this feed; start training explicitly to analyze articles',
          );
        }
        // Validate the complete selection before anything is inserted (spec 08 §4.1).
        const problems = await checkAnalysisSelection(tx, feedId, articles);
        const notCarried = [...problems].filter(([, problem]) => problem === 'not_carried');
        if (notCarried.length > 0) throw new AppError('NOT_FOUND', 'Article not found');
        if (problems.size > 0) {
          throw new AppError('STALE_STATE', 'An article changed since it was displayed', {
            details: { articleIds: [...problems.keys()] },
          });
        }
        const config = await loadSnapshotConfig(tx, app.services.config);
        let version = current.version;
        if (transition.enterTraining) {
          // The explicit combined action: CAS off → training with the selection (spec 08 §4.1).
          const plan = planInferenceModeChange(current, 'training', current.version, now);
          if (plan.kind === 'change') {
            await setInferenceMode(tx, feedId, plan.state);
            await refreshFeedMaterializations(tx, [feedId]);
            version = plan.state.version;
          }
        }
        const reusable = await reusableAnalysisRequests(tx, {
          feedId,
          inferenceVersion: version,
          articles,
        });
        const requests: AnalyzeResponse['requests'] = [];
        let created = 0;
        for (const article of articles) {
          const existing = reusable.get(article.id);
          if (existing !== undefined) {
            requests.push({ id: existing.id, articleId: article.id, status: existing.status });
            continue;
          }
          const inputSnapshot = await captureSelectionSnapshot(tx, {
            feedId,
            articleId: article.id,
            config,
            capturedAt: now,
          });
          // Writes the request and its `analysis.process` intent in this transaction.
          const request = await createAnalysisRequest(tx, {
            feedId,
            articleId: article.id,
            articleRevision: article.contentRevision,
            inferenceVersion: version,
            inputSnapshot,
          });
          requests.push({ id: request.id, articleId: article.id, status: 'pending' });
          created += 1;
        }
        if (created > 0 || transition.enterTraining) {
          await recordRankIntents(tx, outbox, [user.id], { reason: 'selection', full: true });
        }
        return { status: 202, body: { requests } };
      });
      await reply.code(202).send(outcome.body);
    },
  );

  app.get(
    '/analysis-requests/:id',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'One of your analysis requests',
        params: AnalysisRequestParamsSchema,
        response: { 200: AnalysisRequestSchema },
      },
    },
    async (request) =>
      request.withTx(async (tx) => {
        const found = await getAnalysisRequest(tx, request.params.id);
        if (found === null) throw new AppError('NOT_FOUND', 'Analysis request not found');
        return {
          id: found.id,
          feedId: found.feedId,
          articleId: found.articleId,
          contentRevision: found.contentRevision,
          status: found.status,
          createdAt: found.createdAt.toISOString(),
          completedAt: found.completedAt?.toISOString() ?? null,
          ...(found.errorCode === null ? {} : { errorCode: found.errorCode }),
        };
      }),
  );

  app.get(
    '/feed-preferences',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Your remembered per-feed image preferences',
        response: { 200: FeedPreferenceListSchema },
      },
    },
    async (request) =>
      request.withTx(async (tx) => {
        const preferences = await ownPreferences(tx);
        return (await listFeedPreferences(tx)).map((row) => ({
          feedId: row.feedId,
          imagePolicy: row.imagePolicy,
          effectiveImagesAllowed: effectiveImagesAllowed(
            row.imagePolicy,
            preferences.loadRemoteImages,
          ),
        }));
      }),
  );

  app.put(
    '/feed-preferences/:feedId',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Remember an image policy for a feed (never changes inference)',
        params: FeedIdParamsSchema,
        body: FeedPreferenceBodySchema,
        response: { 200: FeedPreferenceSchema },
      },
    },
    async (request, reply) => {
      const { feedId } = request.params;
      const { imagePolicy } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const user = await readOwnUser(tx, { lock: true });
        if (!(await canHoldFeedPreference(tx, feedId))) {
          throw new AppError('NOT_FOUND', 'Feed not found');
        }
        await upsertFeedPreference(tx, feedId, imagePolicy);
        const preferences = readUserPreferences(user.preferences);
        return {
          status: 200,
          body: {
            feedId,
            imagePolicy,
            effectiveImagesAllowed: effectiveImagesAllowed(
              imagePolicy,
              preferences.loadRemoteImages,
            ),
          },
        };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '/subscriptions/:feedId',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Unsubscribe (completed analysis requests stay for learning)',
        params: FeedIdParamsSchema,
        response: { 204: z.null().describe('Unsubscribed') },
      },
    },
    async (request, reply) => {
      const { feedId } = request.params;
      await request.mutate(async (tx, { outbox }) => {
        const user = await readOwnUser(tx, { lock: true });
        await lockFeeds(tx, [feedId]);
        const removed = await deleteSubscription(tx, feedId);
        if (!removed.deleted) throw notFound();
        await refreshFeedMaterializations(tx, [feedId]);
        await recordRankIntents(tx, outbox, [user.id], { reason: 'unsubscribe', full: true });
        // Interest cards scoped to this feed went with it: an interest-card change (spec 06 §8.4).
        if (removed.scopedCards > 0) await enqueueLearn(outbox, { userId: user.id });
        return { status: 204, body: null };
      });
      await reply.code(204).send(null);
    },
  );

  app.post(
    '/subscriptions/import-opml',
    {
      config: { rateLimits: [IMPORT_LIMIT] },
      schema: {
        tags: ['subscriptions'],
        summary: 'Import subscriptions from an OPML file (multipart field `file`, ≤ 1 MiB)',
        consumes: ['multipart/form-data'],
        response: { 200: OpmlImportReportSchema },
      },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw new AppError('VALIDATION_FAILED', 'Expected a multipart upload with a file field');
      }
      const file = await request.file();
      if (file === undefined || file.fieldname !== 'file') {
        throw new AppError('VALIDATION_FAILED', 'Expected a multipart upload with a file field');
      }
      const bytes = await file.toBuffer();
      bindUploadDigest(request, bytes);
      // A retry of a committed import replays its report without parsing the file again.
      const saved = await request.savedOutcome<OpmlImportReport>();
      if (saved !== null) return reply.code(200).send(saved.body);
      // Validate the whole document before any transaction (spec 03 §11): no network access.
      const decoded = decodeBody(bytes, file.mimetype);
      if (!decoded.ok) {
        throw new AppError('VALIDATION_FAILED', 'The OPML file cannot be decoded', {
          details: { code: 'OPML_INVALID' },
        });
      }
      const parsed = parseOpml(decoded.text, {
        allowPrivate: app.services.config.fetchAllowPrivate,
      });
      if (!parsed.ok) {
        throw new AppError('VALIDATION_FAILED', parsed.message, { details: { code: parsed.code } });
      }
      const outcome = await request.mutate(async (tx, { outbox }) => ({
        status: 200,
        body: await importOpml(tx, outbox, parsed),
      }));
      await reply.code(200).send(outcome.body);
    },
  );

  app.get(
    '/subscriptions/export-opml',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Download your subscriptions as OPML 2.0',
        produces: ['text/x-opml'],
        response: { 200: z.string().describe('OPML 2.0 document') },
      },
    },
    async (request, reply) => {
      const rows = await request.withTx(listOpmlRows);
      const document = exportOpml(rows, { dateCreated: clock.now() });
      return reply
        .header('content-type', 'text/x-opml; charset=utf-8')
        .header('content-disposition', 'attachment; filename="bantoozi-subscriptions.opml"')
        .send(document);
    },
  );

  app.post(
    '/subscriptions/folders/rename',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Rename a folder across your subscriptions and folder order',
        body: FolderRenameSchema,
        response: { 200: FolderRenameResultSchema },
      },
    },
    async (request, reply) => {
      const { from, to } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const user = await readOwnUser(tx, { lock: true });
        const feedIds = await renameSubscriptionFolder(tx, { from, to });
        await refreshFeedMaterializations(tx, feedIds);
        const preferences = readUserPreferences(user.preferences);
        if (preferences.folderOrder.includes(from)) {
          const order: string[] = [];
          for (const name of preferences.folderOrder) {
            const renamed = name === from ? to : name;
            if (!order.includes(renamed)) order.push(renamed);
          }
          await updateOwnUser(tx, { preferences: { ...preferences, folderOrder: order } });
        }
        return { status: 200, body: { count: feedIds.length } };
      });
      await reply.code(200).send(outcome.body);
    },
  );
};
