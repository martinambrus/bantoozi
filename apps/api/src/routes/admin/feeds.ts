import {
  getAdminFeed,
  listAdminFeeds,
  resetAdminFeed,
  updateFeedFetchOptions,
  type AdminFeedRow,
} from '@bantoozi/db';
import {
  AdminFeedPageSchema,
  AdminFeedPatchSchema,
  AdminFeedResultSchema,
  AdminFeedsQuerySchema,
  AdminIdParamsSchema,
  AppError,
  type AdminFeed,
  type AdminFetchOptions,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { auditLog, decodeAdminCursor, iso, isoOrNull, nextAdminCursor } from './shared.js';

/**
 * Feed health (spec 08 §9): list by status/search, edit `fetch_options` through spec 03's
 * allowlist (a User-Agent override and `translate_strong` only: no SSRF switch, no auth headers)
 * and clear quarantine/dead.
 */

/** Stored `fetch_options` keys ⇄ DTO fields; anything else is never read or written. */
function toFetchOptions(stored: Record<string, unknown>): AdminFetchOptions {
  const userAgent = stored['user_agent'];
  const translateStrong = stored['translate_strong'];
  return {
    ...(typeof userAgent === 'string' && /^[\x20-\x7e]{1,200}$/.test(userAgent)
      ? { userAgent }
      : {}),
    ...(typeof translateStrong === 'boolean' ? { translateStrong } : {}),
  };
}

function fromFetchOptions(options: AdminFetchOptions): Record<string, unknown> {
  return {
    ...(options.userAgent === undefined ? {} : { user_agent: options.userAgent }),
    ...(options.translateStrong === undefined ? {} : { translate_strong: options.translateStrong }),
  };
}

function toFeed(row: AdminFeedRow): AdminFeed {
  return {
    id: row.id,
    url: row.url,
    siteUrl: row.siteUrl,
    title: row.title,
    status: row.status,
    subscriberCount: row.subscriberCount,
    consecutiveErrors: row.consecutiveErrors,
    quarantineCount: row.quarantineCount,
    quarantinedUntil: isoOrNull(row.quarantinedUntil),
    lastSuccessAt: isoOrNull(row.lastSuccessAt),
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: isoOrNull(row.lastErrorAt),
    nextFetchAt: iso(row.nextFetchAt),
    minIntervalS: row.minIntervalS,
    mergedIntoId: row.mergedIntoId,
    fetchOptions: toFetchOptions(row.fetchOptions),
  };
}

const notFound = () => new AppError('NOT_FOUND', 'Feed not found');

export const feedRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/feeds',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Feed health',
        querystring: AdminFeedsQuerySchema,
        response: { 200: AdminFeedPageSchema },
      },
    },
    async (request) => {
      const { status, q, limit } = request.query;
      const route = 'admin.feeds';
      const afterId = decodeAdminCursor<string>(request, route, request.query);
      const rows = await request.withTx((tx) =>
        listAdminFeeds(tx, {
          ...(status === undefined ? {} : { status }),
          ...(q === undefined ? {} : { q }),
          ...(afterId === undefined ? {} : { afterId }),
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      return {
        items: page.map(toFeed),
        nextCursor: nextAdminCursor(
          request,
          route,
          request.query,
          rows.length > limit,
          page.at(-1)?.id,
        ),
      };
    },
  );

  app.patch(
    '/feeds/:id',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: "Edit a feed's fetch options",
        params: AdminIdParamsSchema,
        body: AdminFeedPatchSchema,
        response: { 200: AdminFeedResultSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const outcome = await request.mutate(async (tx) => {
        if ((await getAdminFeed(tx, id, { lock: true })) === null) throw notFound();
        await updateFeedFetchOptions(tx, id, fromFetchOptions(request.body.fetchOptions));
        return { status: 200, body: { feed: toFeed((await getAdminFeed(tx, id))!) } };
      });
      auditLog(request, {
        action: 'feeds.patch',
        target: id,
        changed: Object.keys(request.body.fetchOptions),
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/feeds/:id/reset',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: "Clear a feed's quarantine or dead state",
        params: AdminIdParamsSchema,
        response: { 200: AdminFeedResultSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const outcome = await request.mutate(async (tx) => {
        const feed = await getAdminFeed(tx, id, { lock: true });
        if (feed === null) throw notFound();
        if (feed.mergedIntoId !== null) {
          throw new AppError('CONFLICT', 'A merged feed identity cannot be revived', {
            details: { reason: 'merged' },
          });
        }
        await resetAdminFeed(tx, id);
        return { status: 200, body: { feed: toFeed((await getAdminFeed(tx, id))!) } };
      });
      auditLog(request, { action: 'feeds.reset', target: id });
      await reply.code(200).send(outcome.body);
    },
  );
};
