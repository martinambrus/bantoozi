import { z } from 'zod';

import { CARD_LIMITS } from '../cards.js';
import { IdSchema } from '../ids.js';
import { IsoTimestampSchema, pageSchema, PageQuerySchema } from './common.js';
import { StrengthSchema } from './explain.js';

/**
 * Card, label, library, suggestion, publication-request and topic DTOs (spec 08 §7). Request schemas
 * bound every string by the spec 05 §5.1 limits (zod counts UTF-16 units, never fewer than the code
 * points the card repository counts, so the repository's own validation stays the final word on
 * trimming and minimum lengths). Cards are immutable: every response that may move a holding to
 * another card carries `idChange`, so a client can replace a cached id.
 */

const title = z.string().min(1).max(CARD_LIMITS.titleMax);
const interest = z.string().min(1).max(CARD_LIMITS.interestMax);
const notFor = z.string().max(CARD_LIMITS.notForMax);
const example = z.string().min(1).max(CARD_LIMITS.exampleMax);

export const CardStrengthSchema = StrengthSchema;
export const ExampleSideSchema = z.enum(['yes', 'no']);

/** Label colours are `#rrggbb` values, never arbitrary CSS (spec 08 §7). */
export const LabelColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');

/** `:id` of card and label routes. */
export const CardIdParamsSchema = z.object({ id: IdSchema }).strict();

/** A holding moved to another immutable card (spec 08 §7 `idChange`). */
export const IdChangeSchema = z.object({ from: IdSchema, to: IdSchema }).strict();
export type IdChange = z.infer<typeof IdChangeSchema>;

/**
 * The non-blocking card-text translation status of a create or edit (spec 07 §5, D-32); `null` when
 * no new card text was submitted, the request was answered from its receipt, or the status of the
 * original request is unknown.
 */
export const CardTextStatusSchema = z.enum([
  'translated',
  'english',
  'undetermined',
  'unconfirmed',
  'unsupported',
  'weak',
  'failed',
]);

// ── Cards ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `Card` (spec 08 §7). `title` is the holder's override, else the card's title localized to the
 * user's locale; `interest` of a library card is localized for display only (its stored text is
 * what is matched). `titleOverride` and `librarySlug` let the editor show what the user set.
 */
export const CardSchema = z
  .object({
    id: IdSchema,
    kind: z.literal('interest'),
    title: z.string(),
    titleOverride: z.string().nullable(),
    interest: z.string(),
    notFor: z.string().nullable(),
    strength: CardStrengthSchema,
    scopeFeedId: IdSchema.nullable(),
    origin: z.enum(['library', 'user', 'fork']),
    isPrivateFork: z.boolean(),
    examplesYes: z.array(z.string()),
    examplesNo: z.array(z.string()),
    topicIds: z.array(z.string()),
    lang: z.string(),
    librarySlug: z.string().nullable(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type CardDto = z.infer<typeof CardSchema>;

export const CardListSchema = z.array(CardSchema);

/** `POST /cards`. */
export const CreateCardBodySchema = z
  .object({
    title: title.optional(),
    interest,
    notFor: notFor.nullable().optional(),
    strength: CardStrengthSchema,
    scopeFeedId: IdSchema.nullable().optional(),
  })
  .strict();

/**
 * `PATCH /cards/:id`: `title` sets (or with `null` clears) the holder's override; `interest`/
 * `notFor` re-point to another card; `scopeFeedId: null` means all feeds. An empty body is
 * `VALIDATION_FAILED`.
 */
export const UpdateCardBodySchema = z
  .object({
    title: title.nullable().optional(),
    interest: interest.optional(),
    notFor: notFor.nullable().optional(),
    strength: CardStrengthSchema.optional(),
    scopeFeedId: IdSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'empty patch');

/** `POST /cards/:id/examples` and `POST /labels/:id/examples`. */
export const AddExampleBodySchema = z
  .object({ articleId: IdSchema, side: ExampleSideSchema })
  .strict();

/** `POST /cards/:id/examples/remove` and `POST /labels/:id/examples/remove`. */
export const RemoveExampleBodySchema = z
  .object({ side: ExampleSideSchema, text: example })
  .strict();

/** `POST /cards/from-article`. */
export const CardFromArticleBodySchema = z
  .object({
    articleId: IdSchema,
    interest,
    notFor: notFor.nullable().optional(),
    title: title.optional(),
    strength: CardStrengthSchema,
  })
  .strict();

/** The answer of every card mutation that leaves the user holding a card. */
export const CardMutationResponseSchema = z
  .object({
    card: CardSchema,
    idChange: IdChangeSchema.nullable(),
    translation: CardTextStatusSchema.nullable(),
  })
  .strict();
export type CardMutationResponse = z.infer<typeof CardMutationResponseSchema>;

// ── Labels ────────────────────────────────────────────────────────────────────────────────────────

/** `Label` (spec 08 §7); `id` is the label card id, `count` the articles the user labelled. */
export const LabelSchema = z
  .object({
    id: IdSchema,
    name: z.string(),
    color: z.string(),
    definition: z.string(),
    notFor: z.string().nullable(),
    examplesYes: z.array(z.string()),
    examplesNo: z.array(z.string()),
    count: z.number().int().min(0),
  })
  .strict();
export type LabelDto = z.infer<typeof LabelSchema>;

export const LabelListSchema = z.array(LabelSchema);

/** `POST /labels`; an omitted colour stores `#64748b` (D-42). */
export const CreateLabelBodySchema = z
  .object({
    name: title,
    definition: interest,
    notFor: notFor.nullable().optional(),
    color: LabelColorSchema.optional(),
  })
  .strict();

/** `PATCH /labels/:id`; an empty body is `VALIDATION_FAILED`. */
export const UpdateLabelBodySchema = z
  .object({
    name: title.optional(),
    definition: interest.optional(),
    notFor: notFor.nullable().optional(),
    color: LabelColorSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'empty patch');

export const LabelMutationResponseSchema = z
  .object({
    label: LabelSchema,
    idChange: IdChangeSchema.nullable(),
    translation: CardTextStatusSchema.nullable(),
  })
  .strict();
export type LabelMutationResponse = z.infer<typeof LabelMutationResponseSchema>;

// ── Library ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A public library card (spec 08 §7 `GET /library`, suggestions), localized to the user's locale
 * from its `i18n` for display. `l1TopicId` is the level-1 topic it is grouped under (that of its
 * first topic); `version` its library version; `held` whether the user already holds it.
 */
export const LibraryCardSchema = z
  .object({
    id: IdSchema,
    slug: z.string().nullable(),
    title: z.string(),
    interest: z.string(),
    notFor: z.string().nullable(),
    examplesYes: z.array(z.string()),
    examplesNo: z.array(z.string()),
    topicIds: z.array(z.string()),
    l1TopicId: z.string().nullable(),
    lang: z.string(),
    version: z.number().int().min(1).nullable(),
    held: z.boolean(),
  })
  .strict();
export type LibraryCardDto = z.infer<typeof LibraryCardSchema>;

/** `GET /library?topic=&q=`: paginated (spec 08 §1), ordered by level-1 topic, then card id. */
export const LibraryQuerySchema = PageQuerySchema.extend({
  topic: z.string().min(1).max(100).optional(),
  q: z.string().min(1).max(200).optional(),
}).strict();

export const LibraryPageSchema = pageSchema(LibraryCardSchema);

/** `POST /library/:id/adopt`. */
export const AdoptLibraryCardBodySchema = z
  .object({ strength: CardStrengthSchema, scopeFeedId: IdSchema.nullable().optional() })
  .strict();

const listChange = z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).strict();

/** Semantic differences between two library versions (spec 05 §8). */
export const LibraryCardDiffSchema = z
  .object({
    title: z.object({ from: z.string(), to: z.string() }).strict().nullable(),
    interest: z.object({ from: z.string(), to: z.string() }).strict().nullable(),
    notFor: z
      .object({ from: z.string().nullable(), to: z.string().nullable() })
      .strict()
      .nullable(),
    examplesYes: listChange,
    examplesNo: listChange,
  })
  .strict();

/** One offer of `GET /library/updates` (spec 08 §7). */
export const LibraryUpdateOfferSchema = z
  .object({
    currentCardId: IdSchema,
    baseCardId: IdSchema,
    newCardId: IdSchema,
    librarySlug: z.string(),
    fromVersion: z.number().int().min(1),
    toVersion: z.number().int().min(1),
    diff: LibraryCardDiffSchema,
    hasPrivateCustomization: z.boolean(),
  })
  .strict();
export const LibraryUpdateListSchema = z.array(LibraryUpdateOfferSchema);

/** `POST /library/:id/updates/:newId/apply`. */
export const LibraryUpdateParamsSchema = z.object({ id: IdSchema, newId: IdSchema }).strict();
export const ApplyLibraryUpdateBodySchema = z.object({ expectedCurrentCardId: IdSchema }).strict();

// ── Suggestions ───────────────────────────────────────────────────────────────────────────────────

/** `GET /cards/suggestions`: `[{card, score}]`, best first. */
export const CardSuggestionSchema = z
  .object({ card: LibraryCardSchema, score: z.number().min(0).max(1) })
  .strict();
export const CardSuggestionListSchema = z.array(CardSuggestionSchema);
export const SuggestionParamsSchema = z.object({ cardId: IdSchema }).strict();

// ── Publication requests (spec 08 §7, §9.2) ───────────────────────────────────────────────────────

export const PublicationStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'promoted',
]);

/**
 * A publication request addressed to its original creator, with the exact card text and the exact
 * proposed public metadata, digest and version the creator answers.
 */
export const PublicationRequestSchema = z
  .object({
    id: IdSchema,
    cardId: IdSchema,
    kind: z.enum(['interest', 'label']),
    status: PublicationStatusSchema,
    /** The request version a response names as `expectedVersion`. */
    version: IdSchema,
    card: z
      .object({
        title: z.string(),
        interest: z.string(),
        notFor: z.string().nullable(),
        examplesYes: z.array(z.string()),
        examplesNo: z.array(z.string()),
        textHash: z.string(),
      })
      .strict(),
    proposed: z
      .object({
        slug: z.string().nullable(),
        title: z.string().nullable(),
        topicIds: z.array(z.string()),
        /** Proposed translations, e.g. `{sk: {title, interest}}`. */
        i18n: z.record(z.string(), z.record(z.string(), z.string())),
      })
      .strict(),
    publicationSha: z.string(),
    requestedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema.nullable(),
    respondedAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type PublicationRequestDto = z.infer<typeof PublicationRequestSchema>;
export const PublicationRequestListSchema = z.array(PublicationRequestSchema);

/** `POST /cards/publication-requests/:id/respond`: a creator-only CAS on the request version. */
export const RespondPublicationBodySchema = z
  .object({ decision: z.enum(['approve', 'decline']), expectedVersion: IdSchema })
  .strict();
export const PublicationResponseSchema = z.object({ request: PublicationRequestSchema }).strict();

// ── Topics ────────────────────────────────────────────────────────────────────────────────────────

/** `GET /topics`: the taxonomy (spec 05 §3.2) in display order. */
export const TopicSchema = z
  .object({
    id: z.string(),
    parent: z.string().nullable(),
    level: z.union([z.literal(1), z.literal(2)]),
    names: z.object({ en: z.string(), sk: z.string() }).strict(),
    description: z.string(),
  })
  .strict();
export const TopicListSchema = z.array(TopicSchema);
