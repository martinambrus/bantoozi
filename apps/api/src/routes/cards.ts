import {
  addCardExample,
  createCardFromArticle,
  createUserCard,
  deleteUserCard,
  dismissCardSuggestion,
  getUserCard,
  listCardSuggestions,
  listPublicationRequests,
  listUserCards,
  readCardTextMode,
  readMutation,
  recordCardTranslationAttempts,
  removeCardExample,
  respondToPublicationRequest,
  updateUserCard,
  type CardMutation,
  type CardTranslationPair,
  type HeldCard,
  type LibraryCardRow,
  type PublicationRequestRow,
} from '@bantoozi/db';
import {
  AddExampleBodySchema,
  AppError,
  CardFromArticleBodySchema,
  CardIdParamsSchema,
  CardListSchema,
  CardMutationResponseSchema,
  CardSuggestionListSchema,
  CreateCardBodySchema,
  newUuid,
  PublicationRequestListSchema,
  PublicationResponseSchema,
  RemoveExampleBodySchema,
  RespondPublicationBodySchema,
  SuggestionParamsSchema,
  UpdateCardBodySchema,
  type CardDto,
  type CardMutationResponse,
  type LibraryCardDto,
  type PublicationRequestDto,
} from '@bantoozi/shared';
import { detectLanguage, normCardText } from '@bantoozi/shared/server';
import {
  CARD_TEXT_MIN_DETECT_LENGTH,
  createSupportedSourcesCache,
  translateCardText,
  type CardTextStatus,
  type LibreTranslateClient,
} from '@bantoozi/translate';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { idempotencyKey } from '../plugins/tenant.js';
import type { AuthContext, RateLimitRule } from '../types.js';

/**
 * Interest cards, card suggestions and publication requests (spec 08 §7). Every change runs one
 * card lifecycle function of `@bantoozi/db` (spec 05 §5.1) inside `request.mutate`, which already
 * takes the documented locks, rechecks ownership/scope/quotas, runs `refresh_feed_cards` and records
 * the backfill/rank/learn intents in the same transaction. The card text of a create or edit is
 * language-detected (and, under `card_text_mode = 'english'`, translated by tier 1) **before** the
 * transaction opens (spec 07 §5, spec 08 §1 "Tenancy").
 */

/** `POST /cards`, `PATCH /cards/*`, `POST /cards/*\/examples*`, `POST /labels*`: 60/hour per user. */
export const CARD_WRITE_LIMIT: RateLimitRule = {
  group: 'card_write',
  max: 60,
  windowSeconds: 3600,
  per: 'user',
};
const CARD_WRITE = { rateLimits: [CARD_WRITE_LIMIT] } as const;

export function requireAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) throw new AppError('UNAUTHENTICATED', 'Sign in required');
  return request.auth;
}

// ── Localization and DTOs ─────────────────────────────────────────────────────────────────────────

/** The localized display text of a library card (`i18n[locale].title`/`.interest`), if any. */
export function localizedText(
  i18n: Record<string, unknown>,
  locale: string,
): { title?: string; interest?: string } {
  const entry = i18n[locale];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return {};
  const fields = entry as Record<string, unknown>;
  const pick = (key: string) => {
    const value = fields[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const title = pick('title');
  const interest = pick('interest');
  return {
    ...(title === undefined ? {} : { title }),
    ...(interest === undefined ? {} : { interest }),
  };
}

/**
 * `Card` (spec 08 §7): the holder's name, else the card title localized to `locale`. The interest
 * text stays as stored, because it is the text an edit starts from.
 */
export function cardDto(card: HeldCard, locale: string): CardDto {
  return {
    id: card.id,
    kind: 'interest',
    title: card.titleOverride ?? localizedText(card.i18n, locale).title ?? card.cardTitle,
    titleOverride: card.titleOverride,
    interest: card.interest,
    notFor: card.notFor,
    strength: card.strength,
    scopeFeedId: card.scopeFeedId,
    origin: card.origin,
    isPrivateFork: card.isPrivateFork,
    examplesYes: card.examplesYes,
    examplesNo: card.examplesNo,
    topicIds: card.topicIds,
    lang: card.lang,
    librarySlug: card.librarySlug,
    createdAt: card.createdAt.toISOString(),
  };
}

/** A library card localized for browsing: title and interest from `i18n[locale]` when present. */
export function libraryCardDto(card: LibraryCardRow, locale: string): LibraryCardDto {
  const local = localizedText(card.i18n, locale);
  return {
    id: card.id,
    slug: card.slug,
    title: local.title ?? card.title,
    interest: local.interest ?? card.interest,
    notFor: card.notFor,
    examplesYes: card.examplesYes,
    examplesNo: card.examplesNo,
    topicIds: card.topicIds,
    l1TopicId: card.l1TopicId,
    lang: card.lang,
    version: card.version,
    held: card.held,
  };
}

export function cardMutationResponse(
  mutation: CardMutation,
  locale: string,
  translation: CardTextStatus | null,
): CardMutationResponse {
  return {
    card: cardDto(mutation.card, locale),
    idChange: mutation.idChange,
    translation,
  };
}

function publicationRequestDto(row: PublicationRequestRow): PublicationRequestDto {
  return {
    id: row.id,
    cardId: row.cardId,
    kind: row.kind,
    status: row.status,
    version: row.version,
    card: row.card,
    proposed: row.proposed,
    publicationSha: row.publicationSha,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}

// ── Card text: language and English translation (spec 07 §5) ──────────────────────────────────────

/** What a create/edit passes to the card repository for its new text. */
export interface CardTextPlan {
  /** The detected language, stored in a newly inserted card row. */
  lang?: string;
  /** The validated English pair under `card_text_mode = 'english'`. */
  translation?: CardTranslationPair | null;
  /** The non-blocking status returned to the client. */
  status: CardTextStatus | null;
}

/** One `/languages` cache per translator client (spec 07 §2). */
const supportedSources = new WeakMap<
  LibreTranslateClient,
  () => Promise<ReadonlySet<string> | undefined>
>();

function sourcesOf(client: LibreTranslateClient) {
  let cached = supportedSources.get(client);
  if (cached === undefined) {
    cached = createSupportedSourcesCache(client);
    supportedSources.set(client, cached);
  }
  return cached();
}

/**
 * Detect the language of a new card text and, under `card_text_mode = 'english'`, translate it with
 * tier 1 (spec 07 §5), before any transaction holds a connection. Every HTTP attempt is recorded
 * through `record_card_translation` in its own short transaction, so failures stay accounted even
 * when the mutation that follows fails. A request whose `Idempotency-Key` already has a receipt is
 * answered from it by `mutate`, so it sends nothing. Translation never blocks the edit: a failed,
 * weak or unsupported translation keeps the original text with a status.
 */
export async function prepareCardText(
  app: FastifyInstance,
  request: FastifyRequest,
  text: { interest: string; notFor?: string | null | undefined },
): Promise<CardTextPlan> {
  const auth = requireAuth(request);
  if (text.interest.trim() === '') return { status: null }; // the repository rejects it
  const key = idempotencyKey(request);
  const { mode, replay } = await request.withTx(async (tx) => ({
    mode: await readCardTextMode(tx),
    replay: (await readMutation(tx, key)) !== null,
  }));
  if (replay) return { status: null };
  const notFor = text.notFor === undefined || text.notFor === null ? null : text.notFor;
  const client = app.services.libreTranslate;
  if (mode !== 'english' || client === null) {
    const { lang } = detectLanguage(`${text.interest} ${notFor ?? ''}`, {
      hint: auth.locale,
      minLength: CARD_TEXT_MIN_DETECT_LENGTH,
    });
    if (mode !== 'english') return { lang, status: null };
    const status: CardTextStatus =
      lang === 'en' ? 'english' : lang === 'und' ? 'undetermined' : 'failed';
    return { lang, translation: null, status };
  }
  const sources = await sourcesOf(client);
  let result;
  try {
    result = await translateCardText(client, {
      interest: text.interest,
      notFor,
      locale: auth.locale,
      supportedSources: sources ?? new Set<string>(),
    });
  } catch (error) {
    request.log.warn({ err: error }, 'card text translation failed');
    const { lang } = detectLanguage(`${text.interest} ${notFor ?? ''}`, {
      hint: auth.locale,
      minLength: CARD_TEXT_MIN_DETECT_LENGTH,
    });
    return { lang, translation: null, status: 'failed' };
  }
  if (result.attempts.length > 0) {
    const logicalRequestId = newUuid();
    await request.withTx((tx) =>
      recordCardTranslationAttempts(
        tx,
        logicalRequestId,
        result.attempts.map((a) => ({
          attempt: a.attempt,
          status: a.status,
          latencyMs: a.latencyMs,
          error: a.error,
        })),
      ),
    );
  }
  // Without a readable `/languages`, "unsupported" only means the model list is unknown.
  const status: CardTextStatus =
    sources === undefined && result.status === 'unsupported' ? 'failed' : result.status;
  const translation =
    result.status === 'translated' && result.interestEn !== null
      ? { interestEn: result.interestEn, notForEn: result.notForEn }
      : null;
  return { lang: result.lang, translation, status };
}

/** The repository fields of a {@link CardTextPlan}. */
export function textFields(plan: CardTextPlan): {
  lang?: string;
  translation?: CardTranslationPair | null;
} {
  return {
    ...(plan.lang === undefined ? {} : { lang: plan.lang }),
    ...(plan.translation === undefined ? {} : { translation: plan.translation }),
  };
}

const sameText = (a: string | null, b: string | null) =>
  normCardText(a ?? '') === normCardText(b ?? '');

// ── Routes ────────────────────────────────────────────────────────────────────────────────────────

const tags = ['cards'];
const NoContent = z.null();

export const cardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/cards',
    { schema: { tags, summary: 'The user’s interest cards', response: { 200: CardListSchema } } },
    async (request) => {
      const { locale } = requireAuth(request);
      const cards = await request.withTx((tx) => listUserCards(tx));
      return cards.map((card) => cardDto(card, locale));
    },
  );

  app.post(
    '/cards',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Create or reuse an interest card',
        body: CreateCardBodySchema,
        response: { 201: CardMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { locale } = requireAuth(request);
      const body = request.body;
      // Holds the key across translation, so a concurrent duplicate translates nothing.
      const outcome = await request.holdingKey(async () => {
        const text = await prepareCardText(app, request, body);
        return request.mutate(async (tx) => {
          const mutation = await createUserCard(tx, {
            interest: body.interest,
            strength: body.strength,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.notFor === undefined ? {} : { notFor: body.notFor }),
            ...(body.scopeFeedId === undefined ? {} : { scopeFeedId: body.scopeFeedId }),
            ...textFields(text),
          });
          return { status: 201, body: cardMutationResponse(mutation, locale, text.status) };
        });
      });
      await reply.code(201).send(outcome.body);
    },
  );

  app.post(
    '/cards/from-article',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Create a card with an article title as its first example',
        body: CardFromArticleBodySchema,
        response: { 201: CardMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { locale } = requireAuth(request);
      const body = request.body;
      // Holds the key across translation, so a concurrent duplicate translates nothing.
      const outcome = await request.holdingKey(async () => {
        const text = await prepareCardText(app, request, body);
        return request.mutate(async (tx) => {
          const mutation = await createCardFromArticle(tx, {
            articleId: body.articleId,
            interest: body.interest,
            strength: body.strength,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.notFor === undefined ? {} : { notFor: body.notFor }),
            ...textFields(text),
          });
          return { status: 201, body: cardMutationResponse(mutation, locale, text.status) };
        });
      });
      await reply.code(201).send(outcome.body);
    },
  );

  app.patch(
    '/cards/:id',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Rename, re-scope, re-weight or edit a card (an edit may return a new id)',
        params: CardIdParamsSchema,
        body: UpdateCardBodySchema,
        response: { 200: CardMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { locale } = requireAuth(request);
      const { id } = request.params;
      const body = request.body;
      // Holds the key across translation, so a concurrent duplicate translates nothing.
      const outcome = await request.holdingKey(async () => {
        let text: CardTextPlan = { status: null };
        if (body.interest !== undefined || body.notFor !== undefined) {
          // Translate only a text that really changes; the repository rechecks under its locks.
          const current = await request.withTx((tx) => getUserCard(tx, id));
          if (current !== null) {
            const next = {
              interest: body.interest ?? current.interest,
              notFor: body.notFor === undefined ? current.notFor : body.notFor,
            };
            if (
              !sameText(next.interest, current.interest) ||
              !sameText(next.notFor, current.notFor)
            ) {
              text = await prepareCardText(app, request, next);
            }
          }
        }
        return request.mutate(async (tx) => {
          const mutation = await updateUserCard(tx, {
            cardId: id,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.interest === undefined ? {} : { interest: body.interest }),
            ...(body.notFor === undefined ? {} : { notFor: body.notFor }),
            ...(body.strength === undefined ? {} : { strength: body.strength }),
            ...(body.scopeFeedId === undefined ? {} : { scopeFeedId: body.scopeFeedId }),
            ...textFields(text),
          });
          return { status: 200, body: cardMutationResponse(mutation, locale, text.status) };
        });
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '/cards/:id',
    {
      schema: {
        tags,
        summary: 'Stop holding a card',
        params: CardIdParamsSchema,
        response: { 204: NoContent },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      await request.mutate(async (tx) => {
        await deleteUserCard(tx, { cardId: id });
        return { status: 204, body: null };
      });
      await reply.code(204).send(null);
    },
  );

  app.post(
    '/cards/:id/examples',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Add an article title as an example (a private fork, new id)',
        params: CardIdParamsSchema,
        body: AddExampleBodySchema,
        response: { 200: CardMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { locale } = requireAuth(request);
      const { id } = request.params;
      const outcome = await request.mutate(async (tx) => {
        const mutation = await addCardExample(tx, { cardId: id, ...request.body });
        return { status: 200, body: cardMutationResponse(mutation, locale, null) };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/cards/:id/examples/remove',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Remove an example (new id)',
        params: CardIdParamsSchema,
        body: RemoveExampleBodySchema,
        response: { 200: CardMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { locale } = requireAuth(request);
      const { id } = request.params;
      const outcome = await request.mutate(async (tx) => {
        const mutation = await removeCardExample(tx, { cardId: id, ...request.body });
        return { status: 200, body: cardMutationResponse(mutation, locale, null) };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  // ── Suggestions ─────────────────────────────────────────────────────────────────────────────────

  app.get(
    '/cards/suggestions',
    {
      schema: {
        tags,
        summary: 'Suggested library cards',
        response: { 200: CardSuggestionListSchema },
      },
    },
    async (request) => {
      const { locale } = requireAuth(request);
      const rows = await request.withTx((tx) => listCardSuggestions(tx));
      return rows.map((row) => ({ card: libraryCardDto(row.card, locale), score: row.score }));
    },
  );

  app.post(
    '/cards/suggestions/:cardId/dismiss',
    {
      schema: {
        tags,
        summary: 'Dismiss a card suggestion',
        params: SuggestionParamsSchema,
        response: { 204: NoContent },
      },
    },
    async (request, reply) => {
      const { cardId } = request.params;
      await request.mutate(async (tx) => {
        if (!(await dismissCardSuggestion(tx, cardId))) {
          throw new AppError('NOT_FOUND', 'suggestion not found', {
            details: { resource: 'suggestion' },
          });
        }
        return { status: 204, body: null };
      });
      await reply.code(204).send(null);
    },
  );

  // ── Publication requests ────────────────────────────────────────────────────────────────────────

  app.get(
    '/cards/publication-requests',
    {
      schema: {
        tags,
        summary: 'Publication requests addressed to the user as a card’s original creator',
        response: { 200: PublicationRequestListSchema },
      },
    },
    async (request) => {
      const rows = await request.withTx((tx) => listPublicationRequests(tx));
      return rows.map(publicationRequestDto);
    },
  );

  app.post(
    '/cards/publication-requests/:id/respond',
    {
      schema: {
        tags,
        summary: 'Approve or decline the exact publication payload (creator only)',
        params: CardIdParamsSchema,
        body: RespondPublicationBodySchema,
        response: { 200: PublicationResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { decision, expectedVersion } = request.body;
      const outcome = await request.mutate(async (tx) => {
        const row = await respondToPublicationRequest(tx, {
          requestId: id,
          expectedVersion,
          approve: decision === 'approve',
        });
        return { status: 200, body: { request: publicationRequestDto(row) } };
      });
      await reply.code(200).send(outcome.body);
    },
  );
};
