import {
  createLibraryCard,
  createPublicationRequest,
  getAdminLibraryCard,
  listAdminLibrary,
  listPromotionCandidates,
  listAdminPublicationRequests,
  patchLibraryCard,
  promotePublicationRequest,
  type AdminLibraryCardRow,
  type AdminPublicationRequestRow,
  type TenantTx,
} from '@bantoozi/db';
import {
  AdminIdParamsSchema,
  AdminLibraryCreateSchema,
  AdminLibraryPageSchema,
  AdminLibraryPatchSchema,
  AdminLibraryQuerySchema,
  AdminLibraryResultSchema,
  AppError,
  LibraryCandidatesQuerySchema,
  LibraryCandidatesSchema,
  LibraryI18nSchema,
  PromoteBodySchema,
  PromoteResultSchema,
  PromotionRequestBodySchema,
  PromotionRequestResultSchema,
  type AdminLibraryCard,
  type LibraryI18n,
} from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import {
  auditLog,
  decodeAdminCursor,
  iso,
  isoOrNull,
  nextAdminCursor,
  toPromotionRequest,
} from './shared.js';

/**
 * Library administration and consent-gated promotion (spec 08 §9, §9.2; spec 05 §8, §8.1).
 * Popularity is never consent: a request needs a shared interest card with at least three holders
 * and is addressed to the card's original creator; promotion needs that creator's exact-version
 * approval or verified 30-day inactivity, rechecked under locks by `admin_promote_card`. Library
 * semantic updates create new immutable versions that holders adopt explicitly.
 */

/** "sorted by holders descending, at most 100" (spec 08 §9). */
const MAX_CANDIDATES = 100;

function toLibraryI18n(stored: Record<string, unknown>): LibraryI18n {
  const parsed = LibraryI18nSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  const sk = stored['sk'];
  if (sk === null || typeof sk !== 'object') return {};
  const record = sk as Record<string, unknown>;
  const title = record['title'];
  const interest = record['interest'];
  return {
    sk: {
      ...(typeof title === 'string' && title.length <= 60 ? { title } : {}),
      ...(typeof interest === 'string' && interest.length <= 300 ? { interest } : {}),
    },
  };
}

function toLibraryCard(row: AdminLibraryCardRow): AdminLibraryCard {
  return {
    cardId: row.cardId,
    slug: row.slug,
    version: row.version,
    title: row.title,
    interest: row.interest,
    notFor: row.notFor,
    examplesYes: row.examplesYes,
    examplesNo: row.examplesNo,
    topicIds: row.topicIds,
    i18n: toLibraryI18n(row.i18n),
    holders: row.holders,
    retiredAt: isoOrNull(row.retiredAt),
    createdAt: iso(row.createdAt),
    publication:
      row.publication === null
        ? null
        : {
            requestId: row.publication.requestId,
            authorizationKind: row.publication.authorizationKind,
            promotedAt: iso(row.publication.promotedAt),
          },
  };
}

/** A URL-safe slug for a proposed listing: the title's ASCII words plus the card id. */
function proposedSlug(title: string, cardId: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base.length === 0 ? `card-${cardId}` : `${base}-${cardId}`;
}

function i18nOf(i18n: LibraryI18n | undefined): Record<string, unknown> {
  return i18n?.sk === undefined ? {} : { sk: { ...i18n.sk } };
}

async function requestById(tx: TenantTx, requestId: string): Promise<AdminPublicationRequestRow> {
  const [row] = await listAdminPublicationRequests(tx, { requestId });
  if (row === undefined) throw new AppError('NOT_FOUND', 'Publication request not found');
  return row;
}

export const libraryAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const now = () => app.services.clock.now();

  app.get(
    '/library/candidates',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Promotion candidates (shared cards with enough holders)',
        querystring: LibraryCandidatesQuerySchema,
        response: { 200: LibraryCandidatesSchema },
      },
    },
    async (request) =>
      request.withTx(async (tx) => {
        const candidates = await listPromotionCandidates(tx, {
          minHolders: request.query.minHolders,
          limit: MAX_CANDIDATES,
        });
        const requests = await listAdminPublicationRequests(tx, {
          cardIds: candidates.map((card) => card.cardId),
          open: true,
        });
        const at = now();
        return {
          items: candidates.map((card) => {
            const open = requests.find((row) => row.cardId === card.cardId);
            const request = open === undefined ? null : toPromotionRequest(open, at);
            return {
              ...card,
              createdAt: iso(card.createdAt),
              request,
              promotionEligibility:
                request?.promotionEligibility ??
                (card.vetoed
                  ? { status: 'held' as const, basis: null, reason: 'declined' as const }
                  : !card.creatorKnown
                    ? { status: 'held' as const, basis: null, reason: 'unknown_creator' as const }
                    : { status: 'held' as const, basis: null, reason: 'no_request' as const }),
            };
          }),
        };
      }),
  );

  app.post(
    '/library/promotion-requests',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: "Ask a card's original creator to approve publication",
        body: PromotionRequestBodySchema,
        response: { 201: PromotionRequestResultSchema },
      },
    },
    async (request, reply) => {
      const { cardId, title, titleSk, topicIds, slug } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const payload = {
          slug: slug ?? proposedSlug(title, cardId),
          title,
          topic_ids: [...new Set(topicIds)],
          ...(titleSk === undefined ? {} : { i18n: { sk: { title: titleSk } } }),
        };
        const requestId = await createPublicationRequest(tx, { cardId, payload });
        return {
          status: 201,
          body: { request: toPromotionRequest(await requestById(tx, requestId), now()) },
        };
      });
      auditLog(request, { action: 'library.request_publication', target: cardId });
      await reply.code(201).send(outcome.body);
    },
  );

  app.post(
    '/library/promote',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Promote a consented shared card to the public library',
        body: PromoteBodySchema,
        response: { 200: PromoteResultSchema },
      },
    },
    async (request, reply) => {
      const { requestId, expectedVersion } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const before = await requestById(tx, requestId);
        // Idempotent: the same request already promoted at this version reports its recorded basis.
        if (
          before.status === 'promoted' &&
          before.version === expectedVersion &&
          before.authorizationKind !== null
        ) {
          return {
            status: 200,
            body: {
              request: toPromotionRequest(before, now()),
              cardId: before.cardId,
              authorizationKind: before.authorizationKind,
            },
          };
        }
        const result = await promotePublicationRequest(tx, { requestId, expectedVersion });
        return {
          status: 200,
          body: {
            request: toPromotionRequest(await requestById(tx, requestId), now()),
            cardId: result.cardId,
            authorizationKind: result.authorizationKind,
          },
        };
      });
      auditLog(request, {
        action: 'library.promote',
        target: requestId,
        changed: [outcome.body.authorizationKind],
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.get(
    '/library',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Public library cards and versions',
        querystring: AdminLibraryQuerySchema,
        response: { 200: AdminLibraryPageSchema },
      },
    },
    async (request) => {
      const { q, limit } = request.query;
      const route = 'admin.library';
      const afterId = decodeAdminCursor<string>(request, route, request.query);
      const rows = await request.withTx((tx) =>
        listAdminLibrary(tx, {
          ...(q === undefined ? {} : { q }),
          ...(afterId === undefined ? {} : { afterId }),
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      return {
        items: page.map(toLibraryCard),
        nextCursor: nextAdminCursor(
          request,
          route,
          request.query,
          rows.length > limit,
          page.at(-1)?.cardId,
        ),
      };
    },
  );

  app.post(
    '/library',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Create a library card (version 1 of a new slug)',
        body: AdminLibraryCreateSchema,
        response: { 201: AdminLibraryResultSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const outcome = await request.mutate(async (tx) => {
        const cardId = await createLibraryCard(tx, {
          slug: body.slug,
          title: body.title,
          interest: body.interest,
          notFor: body.notFor ?? null,
          examplesYes: body.examplesYes ?? [],
          examplesNo: body.examplesNo ?? [],
          topicIds: [...new Set(body.topicIds)],
          i18n: i18nOf(body.i18n),
        });
        const card = (await getAdminLibraryCard(tx, cardId))!;
        return { status: 201, body: { card: toLibraryCard(card), idChange: null } };
      });
      auditLog(request, { action: 'library.create', target: body.slug });
      await reply.code(201).send(outcome.body);
    },
  );

  app.patch(
    '/library/:id',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Edit library metadata or publish a new semantic version',
        params: AdminIdParamsSchema,
        body: AdminLibraryPatchSchema,
        response: { 200: AdminLibraryResultSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await request.mutate(async (tx) => {
        const result = await patchLibraryCard(tx, id, {
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.topicIds === undefined ? {} : { topicIds: [...new Set(body.topicIds)] }),
          ...(body.i18n === undefined ? {} : { i18n: i18nOf(body.i18n) }),
          ...(body.retired === undefined ? {} : { retired: body.retired }),
          ...(body.interest === undefined ? {} : { interest: body.interest }),
          ...(body.notFor === undefined ? {} : { notFor: body.notFor }),
          ...(body.examplesYes === undefined ? {} : { examplesYes: body.examplesYes }),
          ...(body.examplesNo === undefined ? {} : { examplesNo: body.examplesNo }),
        });
        if (result === null) throw new AppError('NOT_FOUND', 'Library card not found');
        const card = (await getAdminLibraryCard(tx, result.cardId))!;
        return {
          status: 200,
          body: {
            card: toLibraryCard(card),
            idChange: result.versioned ? { from: id, to: result.cardId } : null,
          },
        };
      });
      auditLog(request, { action: 'library.patch', target: id, changed: Object.keys(body) });
      await reply.code(200).send(outcome.body);
    },
  );
};
