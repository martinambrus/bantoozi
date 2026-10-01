import {
  adoptLibraryCard,
  applyLibraryUpdate,
  listLibraryCards,
  listLibraryUpdates,
  listTopics,
  type LibraryCursorKey,
} from '@bantoozi/db';
import {
  AdoptLibraryCardBodySchema,
  AppError,
  ApplyLibraryUpdateBodySchema,
  CardIdParamsSchema,
  CardMutationResponseSchema,
  LibraryPageSchema,
  LibraryQuerySchema,
  LibraryUpdateListSchema,
  LibraryUpdateParamsSchema,
  TopicListSchema,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { queryHash } from '../services/cursor.js';
import { cardMutationResponse, libraryCardDto, requireAuth } from './cards.js';

/**
 * The card library, its opt-in updates and the topic taxonomy (spec 08 §7, spec 05 §8). Adoption and
 * update application run the card lifecycle of `@bantoozi/db` inside `request.mutate`. A replayed
 * update application is answered from its `Idempotency-Key` receipt: repeating the lifecycle call
 * would find the old holding gone and answer `404` (PLAN §7 M2 → M4 handoff).
 */

/** Library cursors outlive a browsing session but not a seed run by much. */
const LIBRARY_CURSOR_TTL_SECONDS = 3600;

function isCursorKey(value: unknown): value is LibraryCursorKey {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Number.isInteger(value[0]) &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string' &&
    /^[1-9]\d{0,18}$/.test(value[2])
  );
}

const tags = ['library'];

export const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/library',
    {
      schema: {
        tags,
        summary: 'Browse the public card library (localized, grouped by level-1 topic)',
        querystring: LibraryQuerySchema,
        response: { 200: LibraryPageSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { cursor, limit, topic, q } = request.query;
      const query = queryHash({ route: 'library', topic, q, limit, locale: auth.locale });
      let after: LibraryCursorKey | null = null;
      if (cursor !== undefined) {
        const decoded = app.services.cursors.decode<unknown, never>(cursor, {
          userId: auth.userId,
          query,
        });
        if (!isCursorKey(decoded.key)) throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
        after = decoded.key;
      }
      const { rows, keys } = await request.withTx((tx) =>
        listLibraryCards(tx, { topic, q, locale: auth.locale, after, limit }),
      );
      const items = rows.slice(0, limit).map((row) => libraryCardDto(row, auth.locale));
      const last = keys[limit - 1];
      const nextCursor =
        rows.length > limit && last !== undefined
          ? app.services.cursors.encode(
              { key: last, query },
              { userId: auth.userId, ttlSeconds: LIBRARY_CURSOR_TTL_SECONDS },
            )
          : null;
      return { items, nextCursor };
    },
  );

  app.post(
    '/library/:id/adopt',
    {
      schema: {
        tags,
        summary: 'Hold a library card (a superseded version is 409 superseded)',
        params: CardIdParamsSchema,
        body: AdoptLibraryCardBodySchema,
        response: { 200: CardMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { locale } = requireAuth(request);
      const { id } = request.params;
      const { strength, scopeFeedId } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const mutation = await adoptLibraryCard(tx, {
          cardId: id,
          strength,
          ...(scopeFeedId === undefined ? {} : { scopeFeedId }),
        });
        return { status: 200, body: cardMutationResponse(mutation, locale, null) };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.get(
    '/library/updates',
    {
      schema: {
        tags,
        summary: 'Newer library versions of the user’s holdings (never applied automatically)',
        response: { 200: LibraryUpdateListSchema },
      },
    },
    async (request) => request.withTx((tx) => listLibraryUpdates(tx)),
  );

  app.post(
    '/library/:id/updates/:newId/apply',
    {
      schema: {
        tags,
        summary: 'Explicitly switch an unchanged library holding to its newer version',
        params: LibraryUpdateParamsSchema,
        body: ApplyLibraryUpdateBodySchema,
        response: { 200: CardMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { locale } = requireAuth(request);
      const { id, newId } = request.params;
      const { expectedCurrentCardId } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const mutation = await applyLibraryUpdate(tx, {
          cardId: id,
          newCardId: newId,
          expectedCurrentCardId,
        });
        return { status: 200, body: cardMutationResponse(mutation, locale, null) };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.get(
    '/topics',
    {
      schema: {
        tags: ['topics'],
        summary: 'The topic taxonomy',
        response: { 200: TopicListSchema },
      },
    },
    async (request) => {
      const topics = await request.withTx((tx) => listTopics(tx));
      return topics.map((topic) => ({
        id: topic.id,
        parent: topic.parent,
        level: topic.level,
        names: { en: topic.nameEn, sk: topic.nameSk },
        description: topic.description,
      }));
    },
  );
};
