import { ownsSubscription } from '@bantoozi/db';
import {
  AppError,
  FeedMarkReadBodySchema,
  IdSchema,
  MarkReadResponseSchema,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { markReadByFilter } from './articles.js';

const FeedParamsSchema = z.object({ feedId: IdSchema }).strict();

/**
 * `POST /subscriptions/:feedId/mark-read` (spec 08 §4): the `/articles/mark-read` filter operation
 * with `lane: 'all'` and `filter.feedId` fixed by the path — same scope, cap, receipt and undo
 * contract. A feed the caller does not subscribe to is `404`.
 */
export const feedMarkReadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/subscriptions/:feedId/mark-read',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Mark a feed read up to a confirmed cutoff',
        params: FeedParamsSchema,
        body: FeedMarkReadBodySchema,
        response: { 200: MarkReadResponseSchema },
      },
      config: { auth: 'user' },
    },
    async (request, reply) => {
      const { feedId } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx, ctx) => {
        if (!(await ownsSubscription(tx, feedId))) {
          throw new AppError('NOT_FOUND', 'Subscription not found');
        }
        return markReadByFilter(tx, ctx, {
          lane: 'all',
          scope: { feedId },
          olderThan: body.olderThan,
          datasetVersion: body.datasetVersion,
        });
      });
      return reply.code(200).send(outcome.body);
    },
  );
};
