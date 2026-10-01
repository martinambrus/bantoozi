import { z } from 'zod';

import { distinctIds, IdSchema, RevisionSchema, UuidSchema, UuidStringSchema } from '../ids.js';
import { DEFAULT_PAGE_LIMIT, IsoTimestampSchema, MAX_PAGE_LIMIT } from './common.js';
import { ExplainSchema, LaneSchema } from './explain.js';
import { RuleSchema } from './rules.js';

/**
 * Article list, detail and action DTOs (spec 08 §5). Ids, revisions and state versions are decimal
 * strings; timestamps are ISO strings; unscored items have explicitly `null` probability and tier
 * (clients must not coerce them to zero).
 */

/** The reader views of `GET /articles` (spec 08 §5.1). */
export const ArticleViewLaneSchema = z.enum([
  'for_you',
  'maybe',
  'everything',
  'new',
  'all',
  'bookmarks',
  'hidden',
]);
export type ArticleViewLane = z.infer<typeof ArticleViewLaneSchema>;

/** Lanes a mark-read filter may name: the ordinary reader lanes (spec 08 §5.3). */
export const MarkReadLaneSchema = z.enum(['for_you', 'maybe', 'everything', 'new', 'all']);
export type MarkReadLane = z.infer<typeof MarkReadLaneSchema>;

export const ArticleStatusSchema = z.enum(['unread', 'all']);
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;

export const ArticleSortSchema = z.enum(['score', 'date']);
export type ArticleSort = z.infer<typeof ArticleSortSchema>;

/** Dislike reasons (spec 02 `user_article.reason`); allowed only with rating -1. */
export const RatingReasonSchema = z.enum([
  'off_topic',
  'clickbait',
  'seen',
  'shallow',
  'promo',
  'other',
]);
export type RatingReason = z.infer<typeof RatingReasonSchema>;

const MinTierSchema = z.coerce.number().int().min(1).max(5);
const FolderSchema = z.string().trim().min(1).max(100);

/** The feed/folder/label scope shared by the list, the counts and mark-read (spec 08 §5.1). */
const scopeFields = {
  feedId: IdSchema.optional(),
  folder: FolderSchema.optional(),
  labelId: IdSchema.optional(),
};

export const ArticleListQuerySchema = z
  .object({
    lane: ArticleViewLaneSchema.default('for_you'),
    ...scopeFields,
    status: ArticleStatusSchema.optional(),
    minTier: MinTierSchema.optional(),
    sort: ArticleSortSchema.optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  })
  .strict();
export type ArticleListQuery = z.infer<typeof ArticleListQuerySchema>;

export const ArticleCountsQuerySchema = z
  .object({
    ...scopeFields,
    status: ArticleStatusSchema.optional(),
    minTier: MinTierSchema.optional(),
    asOf: IsoTimestampSchema.optional(),
  })
  .strict();
export type ArticleCountsQuery = z.infer<typeof ArticleCountsQuerySchema>;

/** Structured "why this" for list rows (spec 08 §5.1); the client localizes it. */
export const TopReasonSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('card'),
      cardId: IdSchema,
      title: z.string().max(200),
      p: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rule'),
      code: z.string().min(1).max(200),
      ruleId: IdSchema.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('model'), feature: z.string().max(200), label: z.string().max(200) })
    .strict(),
  z.object({ kind: z.literal('keyword') }).strict(),
]);
export type TopReason = z.infer<typeof TopReasonSchema>;

export const BookmarkCaptureSchema = z
  .object({
    status: z.enum(['pending', 'saved', 'partial', 'failed']),
    generation: RevisionSchema,
    snapshotId: IdSchema.nullable(),
    capturedAt: IsoTimestampSchema.nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();
export type BookmarkCapture = z.infer<typeof BookmarkCaptureSchema>;

export const BookmarkSnapshotSchema = z
  .object({
    id: IdSchema,
    sourceUrl: z.string().nullable(),
    title: z.string(),
    author: z.string().nullable(),
    publishedAt: IsoTimestampSchema.nullable(),
    capturedAt: IsoTimestampSchema,
    contentRevision: RevisionSchema,
    completeness: z.enum(['complete', 'partial']),
    text: z.string(),
    html: z.string().nullable(),
    mediaPolicyFeedId: IdSchema.nullable(),
    effectiveImagesAllowed: z.boolean(),
  })
  .strict();
export type BookmarkSnapshot = z.infer<typeof BookmarkSnapshotSchema>;

export const ArticleAnalysisSchema = z
  .object({
    mode: z.enum(['off', 'training', 'active']),
    status: z.enum(['not_requested', 'pending', 'running', 'complete', 'failed', 'cancelled']),
    requestId: UuidStringSchema.nullable(),
  })
  .strict();
export type ArticleAnalysis = z.infer<typeof ArticleAnalysisSchema>;

export const ArticleClusterSchema = z
  .object({
    id: IdSchema,
    size: z.number().int().min(1),
    otherFeeds: z.array(z.string()),
  })
  .strict();
export type ArticleCluster = z.infer<typeof ArticleClusterSchema>;

export const ArticleListItemSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    /** Linkless feeds are valid. */
    url: z.string().nullable(),
    feed: z.object({ id: IdSchema, title: z.string(), iconUrl: z.string().nullable() }).nullable(),
    author: z.string().nullable(),
    publishedAt: IsoTimestampSchema.nullable(),
    /** The arrival the view sorts by: the latest carrier arrival in its scope (spec 08 §5.1). */
    firstSeenAt: IsoTimestampSchema,
    /** At most 300 characters. */
    excerpt: z.string().max(300).nullable(),
    imageUrl: z.string().nullable(),
    lang: z.string().nullable(),
    lane: LaneSchema,
    tier: z.number().int().min(1).max(5).nullable(),
    pLike: z.number().min(0).max(1).nullable(),
    topReason: TopReasonSchema.nullable(),
    labelIds: z.array(IdSchema),
    labelSuggestions: z.array(IdSchema),
    rating: z.union([z.literal(1), z.literal(-1)]).nullable(),
    reason: RatingReasonSchema.nullable(),
    readAt: IsoTimestampSchema.nullable(),
    bookmarkedAt: IsoTimestampSchema.nullable(),
    archivedAt: IsoTimestampSchema.nullable(),
    /** `user_article.state_version`; `'0'` when the reader has no row yet. */
    stateVersion: RevisionSchema,
    contentRevision: RevisionSchema,
    translationAvailable: z.boolean(),
    analysis: ArticleAnalysisSchema,
    mediaPolicyFeedId: IdSchema.nullable(),
    effectiveImagesAllowed: z.boolean(),
    bookmarkCapture: BookmarkCaptureSchema.nullable(),
    cluster: ArticleClusterSchema.nullable(),
  })
  .strict();
export type ArticleListItem = z.infer<typeof ArticleListItemSchema>;

export const ArticleListResponseSchema = z
  .object({
    items: z.array(ArticleListItemSchema),
    nextCursor: z.string().nullable(),
    asOf: IsoTimestampSchema,
    datasetVersion: z.string(),
    rankingPending: z.boolean(),
  })
  .strict();
export type ArticleListResponse = z.infer<typeof ArticleListResponseSchema>;

export const ArticleCountsSchema = z
  .object({
    forYou: z.number().int().min(0),
    maybe: z.number().int().min(0),
    everything: z.number().int().min(0),
    new: z.number().int().min(0),
    bookmarks: z.number().int().min(0),
    hidden: z.number().int().min(0),
    scored: z.number().int().min(0),
    total: z.number().int().min(0),
    asOf: IsoTimestampSchema,
    datasetVersion: z.string(),
    rankingPending: z.boolean(),
  })
  .strict();
export type ArticleCounts = z.infer<typeof ArticleCountsSchema>;

/** Unread lane counts of one subscription (spec 08 §4 `GET /subscriptions` `unread`). */
export interface LaneUnreadCounts {
  forYou: number;
  maybe: number;
  everything: number;
  new: number;
}

export const CalibrationResponseSchema = z
  .object({ items: z.array(ArticleListItemSchema) })
  .strict();

export const ArticleIdParamsSchema = z.object({ id: IdSchema }).strict();
export const ArticleLabelParamsSchema = z.object({ id: IdSchema, labelId: IdSchema }).strict();

export const ArticleDetailQuerySchema = z
  .object({ sourceFeedId: IdSchema.optional(), view: z.literal('saved').optional() })
  .strict();

export const ArticleTranslationSchema = z
  .object({
    title: z.string().nullable(),
    excerpt: z.string().nullable(),
    engine: z.string(),
    quality: z.string(),
  })
  .strict();

export const ArticleDetailSchema = ArticleListItemSchema.extend({
  excerptHtml: z.string().nullable(),
  bodyLead: z.string().nullable(),
  explain: ExplainSchema.nullable(),
  translation: ArticleTranslationSchema.nullable(),
  clusterMembers: z.array(
    z
      .object({
        id: IdSchema,
        title: z.string(),
        feedTitle: z.string().nullable(),
        url: z.string().nullable(),
      })
      .strict(),
  ),
  bookmarkSnapshot: BookmarkSnapshotSchema.nullable(),
}).strict();
export type ArticleDetail = z.infer<typeof ArticleDetailSchema>;

// ── Actions (spec 08 §5.3) ──────────────────────────────────────────────────────────────────────

/**
 * The displayed item's fence: its reader `stateVersion` (`'0'` for no row) and `contentRevision`.
 * Saved-snapshot actions add the bookmark's `snapshotId` and are fenced against its revision.
 */
const fence = {
  stateVersion: RevisionSchema,
  contentRevision: RevisionSchema,
  snapshotId: IdSchema.optional(),
};

export const ArticleFenceSchema = z.object(fence).strict();
export type ArticleFence = z.infer<typeof ArticleFenceSchema>;

/**
 * `POST /articles/:id/read`. `trigger: 'expand'` marks the list's mark-read-on-expand side effect,
 * which never counts as an individual explicit read signal (spec 06 §8.2); it can only weaken the
 * recorded origin, never claim consent.
 */
export const ReadBodySchema = z
  .object({ ...fence, trigger: z.literal('expand').optional() })
  .strict();

export const DwellBodySchema = z
  .object({ ...fence, ms: z.number().int().min(0).max(1_800_000) })
  .strict();

export const RatingBodySchema = z
  .object({
    ...fence,
    rating: z.union([z.literal(1), z.literal(-1), z.null()]),
    reason: RatingReasonSchema.optional(),
    hide: z.boolean().optional(),
    analysisRequestId: UuidSchema.optional(),
    /** The item came from the calibration round; recorded with its source lane (spec 06 §10). */
    selection: z.literal('calibration').optional(),
  })
  .strict()
  .refine((body) => body.reason === undefined || body.rating === -1, {
    message: 'reason is allowed only with rating -1',
    path: ['reason'],
  });
export type RatingBody = z.infer<typeof RatingBodySchema>;

export const PromptAnswerBodySchema = z
  .object({ ...fence, liked: z.boolean(), analysisRequestId: UuidSchema.optional() })
  .strict();

export const BookmarkBodySchema = z
  .object({ ...fence, mediaPolicyFeedId: IdSchema.optional() })
  .strict();

export const RetryCaptureBodySchema = z
  .object({ ...fence, captureGeneration: RevisionSchema })
  .strict();

export const LabelBodySchema = z.object({ ...fence, labelId: IdSchema }).strict();

export const MuteStoryBodySchema = z
  .object({ days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(30)]) })
  .strict();

/** Explicit targets of a bulk action: both versions of every displayed item. */
export const BulkTargetSchema = z
  .object({ id: IdSchema, stateVersion: RevisionSchema, contentRevision: RevisionSchema })
  .strict();

export const MAX_MARK_READ_TARGETS = 500;
export const MAX_MARK_READ_FILTER_TARGETS = 5000;
export const MAX_RATE_BULK_TARGETS = 200;

/** Each article at most once: one locked snapshot, one result version per article for undo. */
const uniqueTargets = <T extends { id: string }>(targets: readonly T[]) =>
  distinctIds(targets.map((target) => target.id));

export const MarkReadFilterSchema = z
  .object({
    lane: MarkReadLaneSchema,
    ...scopeFields,
    minTier: z.number().int().min(1).max(5).optional(),
    /** Inclusive arrival cutoff: the list's `asOf` when the reader confirmed. */
    olderThan: IsoTimestampSchema,
  })
  .strict();
export type MarkReadFilter = z.infer<typeof MarkReadFilterSchema>;

export const MarkReadBodySchema = z.union([
  z
    .object({
      targets: z
        .array(BulkTargetSchema)
        .min(1)
        .max(MAX_MARK_READ_TARGETS)
        .refine(uniqueTargets, 'duplicate article'),
    })
    .strict(),
  z.object({ filter: MarkReadFilterSchema, datasetVersion: z.string().min(1).max(128) }).strict(),
]);
export type MarkReadBody = z.infer<typeof MarkReadBodySchema>;

/** `POST /subscriptions/:feedId/mark-read` (spec 08 §4): the filter with the feed fixed by the path. */
export const FeedMarkReadBodySchema = z
  .object({ olderThan: IsoTimestampSchema, datasetVersion: z.string().min(1).max(128) })
  .strict();

export const RateBulkTargetSchema = BulkTargetSchema.extend({
  analysisRequestId: UuidSchema.optional(),
}).strict();

export const RateBulkBodySchema = z
  .object({
    targets: z
      .array(RateBulkTargetSchema)
      .min(1)
      .max(MAX_RATE_BULK_TARGETS)
      .refine(uniqueTargets, 'duplicate article'),
    rating: z.union([z.literal(1), z.literal(-1), z.null()]),
  })
  .strict();

export const UndoBodySchema = z.object({ mutationId: UuidSchema }).strict();

export const ExampleSuggestionSchema = z
  .object({ cardId: IdSchema, side: z.enum(['yes', 'no']) })
  .strict();

export const ArticleItemResponseSchema = z
  .object({ item: ArticleListItemSchema, mutationId: UuidStringSchema })
  .strict();
export type ArticleItemResponse = z.infer<typeof ArticleItemResponseSchema>;

export const RatingResponseSchema = ArticleItemResponseSchema.extend({
  exampleSuggestion: ExampleSuggestionSchema.nullable(),
}).strict();

export const DwellResponseSchema = ArticleItemResponseSchema.extend({
  prompt: z.boolean(),
}).strict();

export const MarkReadResponseSchema = z
  .object({ count: z.number().int().min(0), mutationId: UuidStringSchema })
  .strict();

export const BulkItemsResponseSchema = z
  .object({
    count: z.number().int().min(0),
    mutationId: UuidStringSchema,
    items: z.array(ArticleListItemSchema),
  })
  .strict();

/** `/articles/:id/mute-story` → `201 {rule}`: the `mute_story` rule, shaped as `POST /rules` returns it. */
export const MuteStoryResponseSchema = z.object({ rule: RuleSchema }).strict();
