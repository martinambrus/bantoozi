import { z } from 'zod';

import { IdSchema, RevisionSchema, UuidSchema, UuidStringSchema } from '../ids.js';
import { IMAGE_POLICIES } from '../policies/images.js';
import { INFERENCE_MODES } from '../policies/inference.js';
import { MAX_FOLDER_NAME_LENGTH } from '../preferences.js';
import { IsoTimestampSchema } from './common.js';

/** Subscription, feed preference, OPML and analysis request DTOs (spec 08 §4). */

/** Longest accepted subscribe input, in characters (spec 03 §4.1 caps feed URLs at 8 KiB). */
export const MAX_SUBSCRIBE_URL_LENGTH = 8192;
/** Longest title override (display text only). */
export const MAX_TITLE_OVERRIDE_LENGTH = 300;
/** Most article revisions one `/analyze` request may select (spec 08 §11). */
export const MAX_ANALYZE_ARTICLES = 20;

export const ImagePolicySchema = z.enum(IMAGE_POLICIES);
export const InferenceModeSchema = z.enum(INFERENCE_MODES);

const FolderSchema = z.string().trim().min(1).max(MAX_FOLDER_NAME_LENGTH);
const TitleOverrideSchema = z.string().trim().min(1).max(MAX_TITLE_OVERRIDE_LENGTH);

/** `FeedInfo` (spec 08 §4): the shared feed row as a reader sees it. */
export const FeedInfoSchema = z
  .object({
    id: IdSchema,
    url: z.string(),
    siteUrl: z.string().nullable(),
    title: z.string().nullable(),
    iconUrl: z.string().nullable(),
    status: z.enum(['active', 'quarantined', 'dead', 'paused']),
    lastSuccessAt: IsoTimestampSchema.nullable(),
    lastErrorCode: z.string().nullable(),
    lastErrorAt: IsoTimestampSchema.nullable(),
  })
  .strict();
export type FeedInfo = z.infer<typeof FeedInfoSchema>;

/** Unread counts of one subscription's feed view (spec 08 §4, §5.1 semantics). */
export const SubscriptionUnreadSchema = z
  .object({
    forYou: z.number().int().min(0),
    maybe: z.number().int().min(0),
    everything: z.number().int().min(0),
    new: z.number().int().min(0),
  })
  .strict();
export type SubscriptionUnread = z.infer<typeof SubscriptionUnreadSchema>;

/** One element of `GET /subscriptions` and the `subscription` of every subscription mutation. */
export const SubscriptionSchema = z
  .object({
    feed: FeedInfoSchema,
    titleOverride: z.string().nullable(),
    folder: z.string().nullable(),
    allowDuplicates: z.boolean(),
    hidden: z.boolean(),
    inferenceMode: InferenceModeSchema,
    /** Decimal string; the CAS token of `POST /subscriptions/:feedId/inference`. */
    inferenceVersion: RevisionSchema,
    inferenceActivatedAt: IsoTimestampSchema.nullable(),
    imagePolicy: ImagePolicySchema,
    effectiveImagesAllowed: z.boolean(),
    unread: SubscriptionUnreadSchema,
  })
  .strict();
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SubscriptionListSchema = z.array(SubscriptionSchema);
export const SubscriptionEnvelopeSchema = z.object({ subscription: SubscriptionSchema }).strict();
export type SubscriptionEnvelope = z.infer<typeof SubscriptionEnvelopeSchema>;

export const FeedIdParamsSchema = z.object({ feedId: IdSchema }).strict();

/** `POST /subscriptions`: a site or feed URL (a scheme-less input is tried as https, then http). */
export const SubscribeBodySchema = z
  .object({
    url: z.string().trim().min(1).max(MAX_SUBSCRIBE_URL_LENGTH),
    folder: FolderSchema.nullable().optional(),
  })
  .strict();
export type SubscribeBody = z.infer<typeof SubscribeBodySchema>;

/** A discovered feed the user can choose (spec 03 §10). */
export const FeedCandidateSchema = z
  .object({
    url: z.string(),
    title: z.string().nullable(),
    type: z.string().max(32),
  })
  .strict();

export const SubscribeChooseSchema = z
  .object({ status: z.literal('choose'), candidates: z.array(FeedCandidateSchema).max(20) })
  .strict();
/** `200` of `POST /subscriptions`: an existing subscription, or several candidates to choose. */
export const SubscribeOkSchema = z.union([SubscriptionEnvelopeSchema, SubscribeChooseSchema]);
export type SubscribeOk = z.infer<typeof SubscribeOkSchema>;

/** `PATCH /subscriptions/:feedId`: metadata and image policy only; `null` clears a nullable text. */
export const SubscriptionPatchSchema = z
  .object({
    titleOverride: TitleOverrideSchema.nullable(),
    folder: FolderSchema.nullable(),
    allowDuplicates: z.boolean(),
    hidden: z.boolean(),
    imagePolicy: ImagePolicySchema,
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'empty patch');
export type SubscriptionPatch = z.infer<typeof SubscriptionPatchSchema>;

/** `POST /subscriptions/:feedId/inference`: CAS on `inferenceVersion` (spec 08 §4.1). */
export const InferenceChangeSchema = z
  .object({ mode: InferenceModeSchema, expectedVersion: RevisionSchema })
  .strict();
export type InferenceChange = z.infer<typeof InferenceChangeSchema>;

/** `POST /subscriptions/:feedId/analyze`: exact article revisions (spec 08 §4.1). */
export const AnalyzeBodySchema = z
  .object({
    articles: z
      .array(z.object({ id: IdSchema, contentRevision: IdSchema }).strict())
      .min(1)
      .max(MAX_ANALYZE_ARTICLES)
      .refine(
        (articles) => new Set(articles.map((a) => a.id)).size === articles.length,
        'duplicate article',
      ),
    expectedInferenceVersion: RevisionSchema,
    startTraining: z.boolean().optional(),
  })
  .strict();
export type AnalyzeBody = z.infer<typeof AnalyzeBodySchema>;

export const ANALYSIS_REQUEST_STATUSES = [
  'pending',
  'running',
  'complete',
  'failed',
  'cancelled',
] as const;
export type AnalysisRequestStatus = (typeof ANALYSIS_REQUEST_STATUSES)[number];
export const AnalysisRequestStatusSchema = z.enum(ANALYSIS_REQUEST_STATUSES);

export const AnalyzeResponseSchema = z
  .object({
    requests: z.array(
      z
        .object({ id: UuidStringSchema, articleId: IdSchema, status: AnalysisRequestStatusSchema })
        .strict(),
    ),
  })
  .strict();
export type AnalyzeResponse = z.infer<typeof AnalyzeResponseSchema>;

export const AnalysisRequestParamsSchema = z.object({ id: UuidSchema }).strict();

/** `GET /analysis-requests/:id` (own request only). */
export const AnalysisRequestSchema = z
  .object({
    id: UuidStringSchema,
    feedId: IdSchema,
    articleId: IdSchema,
    contentRevision: IdSchema,
    status: AnalysisRequestStatusSchema,
    createdAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.nullable(),
    errorCode: z.string().optional(),
  })
  .strict();
export type AnalysisRequestDto = z.infer<typeof AnalysisRequestSchema>;

/** One remembered per-feed image preference (spec 08 §4.2). */
export const FeedPreferenceSchema = z
  .object({
    feedId: IdSchema,
    imagePolicy: ImagePolicySchema,
    effectiveImagesAllowed: z.boolean(),
  })
  .strict();
export type FeedPreference = z.infer<typeof FeedPreferenceSchema>;
export const FeedPreferenceListSchema = z.array(FeedPreferenceSchema);
export const FeedPreferenceBodySchema = z.object({ imagePolicy: ImagePolicySchema }).strict();

/** Why an OPML outline was not imported (spec 03 §11), including the plan's remaining quota. */
export const OPML_INVALID_REASONS = [
  'invalid_url',
  'unsupported_scheme',
  'credentials',
  'credential_param',
  'blocked_address',
  'too_long',
  'missing_url',
  'quota_exceeded',
] as const;
export type OpmlImportInvalidReason = (typeof OPML_INVALID_REASONS)[number];

/** `POST /subscriptions/import-opml` report (spec 03 §11). */
export const OpmlImportReportSchema = z
  .object({
    added: z.number().int().min(0),
    existing: z.number().int().min(0),
    invalid: z.array(
      z
        .object({
          index: z.number().int().min(0),
          url: z.string(),
          reason: z.enum(OPML_INVALID_REASONS),
        })
        .strict(),
    ),
  })
  .strict();
export type OpmlImportReport = z.infer<typeof OpmlImportReportSchema>;

/** `POST /subscriptions/folders/rename`. */
export const FolderRenameSchema = z
  .object({ from: FolderSchema, to: FolderSchema })
  .strict()
  .refine((body) => body.from !== body.to, { message: 'from and to are equal', path: ['to'] });
export type FolderRename = z.infer<typeof FolderRenameSchema>;
export const FolderRenameResultSchema = z.object({ count: z.number().int().min(0) }).strict();
