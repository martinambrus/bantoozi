import { z } from 'zod';

import { IdSchema, UuidSchema } from '../ids.js';
import { JsonObjectSchema } from '../json.js';
import { CardTextModeSchema, LanguageModeSchema } from '../settings.js';
import { IsoTimestampSchema } from './common.js';
import { StrengthSchema } from './explain.js';

/**
 * Selected-article analysis snapshots (spec 05 §1.1, spec 03 §2.2, spec 06 §8.2). The training API
 * captures `analysis_requests.input_snapshot` before it applies an attached first rating; the
 * worker's `analysis.process` answers exactly that frozen input and publishes `result_snapshot`.
 * Neither ever holds a rating, and the worker never substitutes live article, card, question or
 * translation inputs for the frozen ones. Both are versioned; a new version is a new schema.
 */

export const ANALYSIS_SNAPSHOT_VERSION = 1;
/** Held cards and labels one request may freeze (above any plan's card limit). */
export const ANALYSIS_MAX_CARDS = 2000;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a hex SHA-256');
const text = (max: number) => z.string().max(max);
const probability = z.number().finite().min(0).max(1);

/** A question set as the request pinned it: registry id, code version and definition hash. */
export const AnalysisSetRefSchema = z
  .object({ id: IdSchema, version: z.string().min(1).max(64), sha256: Sha256Schema })
  .strict();
export type AnalysisSetRef = z.infer<typeof AnalysisSetRefSchema>;

/**
 * The English translation a translated-variant state uses (spec 07 §3), with its provenance. Only
 * a usable row (a translated title, quality `ok` or `weak`) is ever frozen or used.
 */
export const AnalysisTranslationSchema = z
  .object({
    engine: z.enum(['libretranslate', 'ollama']),
    model: text(200).nullable(),
    sourceLang: z.string().regex(/^[a-z]{2}$/),
    sourceSha256: Sha256Schema,
    quality: z.enum(['ok', 'weak']),
    title: text(4000).min(1),
    excerpt: text(8000).nullable(),
    bodyLead: text(8000).nullable(),
  })
  .strict();
export type AnalysisTranslation = z.infer<typeof AnalysisTranslationSchema>;

/**
 * One held card or label as frozen at capture: its question built exactly under the card text
 * mode then in effect, `card_input_sha256` over it, and the holder's strength (none for a label).
 */
export const AnalysisCardSchema = z
  .object({
    cardId: IdSchema,
    kind: z.enum(['interest', 'label']),
    strength: StrengthSchema.nullable(),
    question: JsonObjectSchema,
    cardInputSha256: Sha256Schema,
  })
  .strict()
  .refine((card) => (card.kind === 'label') === (card.strength === null), {
    message: 'an interest card has a strength and a label has none',
    path: ['strength'],
  });
export type AnalysisCard = z.infer<typeof AnalysisCardSchema>;

/**
 * `analysis_requests.input_snapshot`, version 1: the pre-feedback article, card, question, state
 * and translation manifests and the feature context the result needs (spec 06 §8.1: source
 * timestamps, media, story group). `article` holds the model-state source fields of the frozen
 * revision with the canonical feed's shared metadata (spec 05 §3.1). With `languageMode:
 * 'translate'`, a null `translation` means the request translates the frozen source itself.
 */
export const AnalysisInputSnapshotSchema = z
  .object({
    v: z.literal(ANALYSIS_SNAPSHOT_VERSION),
    capturedAt: IsoTimestampSchema,
    article: z
      .object({
        id: IdSchema,
        revision: IdSchema,
        title: text(2000),
        author: text(1000).nullable(),
        categories: z.array(text(500)).max(64),
        excerpt: text(8000).nullable(),
        bodyLead: text(8000).nullable(),
        wordCount: z.number().int().min(0).nullable(),
        lang: text(16).nullable(),
        feed: z.object({ title: text(2000).nullable(), site: text(500).nullable() }).strict(),
        /** The request feed's arrival of this article (`feed_items.first_seen_at`). */
        firstSeenAt: IsoTimestampSchema,
        publishedAt: IsoTimestampSchema.nullable(),
        hasImage: z.boolean(),
        hasVideo: z.boolean().nullable(),
        bodyImageCount: z.number().int().min(0).nullable(),
        storyClusterId: IdSchema.nullable(),
        clusterSize: z.number().int().min(1),
      })
      .strict(),
    languageMode: LanguageModeSchema,
    translation: AnalysisTranslationSchema.nullable(),
    questionSets: z.object({ enrich: AnalysisSetRefSchema, match: AnalysisSetRefSchema }).strict(),
    cardTextMode: CardTextModeSchema,
    /** The engine policy the answers must come from: the pinned Jev model at capture. */
    model: z.object({ engine: z.literal('typesafe'), model: text(200).min(1) }).strict(),
    cards: z.array(AnalysisCardSchema).max(ANALYSIS_MAX_CARDS),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = new Set<string>();
    for (const [index, card] of snapshot.cards.entries()) {
      if (ids.has(card.cardId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cards', index, 'cardId'],
          message: 'duplicate card',
        });
      }
      ids.add(card.cardId);
    }
    if (snapshot.translation !== null) {
      if (snapshot.languageMode !== 'translate') {
        ctx.addIssue({
          code: 'custom',
          path: ['translation'],
          message: 'a translation is frozen only in translate mode',
        });
      } else if (snapshot.translation.sourceLang !== snapshot.article.lang) {
        ctx.addIssue({
          code: 'custom',
          path: ['translation', 'sourceLang'],
          message: 'the translation must translate the article language',
        });
      }
    }
  });
export type AnalysisInputSnapshot = z.infer<typeof AnalysisInputSnapshotSchema>;

const StateVariantSchema = z.enum(['native', 'translated']);

/**
 * `analysis_requests.result_snapshot`, version 1: the normalized answers of the frozen input and
 * their provenance, linked to `input_sha`. Features derive from it only together with the frozen
 * input (spec 06 §8.2); it is never written into newer `article_facets`/`card_answers`.
 */
export const AnalysisResultSnapshotSchema = z
  .object({
    v: z.literal(ANALYSIS_SNAPSHOT_VERSION),
    requestId: UuidSchema,
    inputSha: Sha256Schema,
    /** Processing time, recorded separately from the capture time (spec 06 §8.2). */
    processedAt: IsoTimestampSchema,
    article: z.object({ id: IdSchema, revision: IdSchema }).strict(),
    model: z.object({ engine: z.literal('typesafe'), model: text(200).min(1) }).strict(),
    /** The translation the states were built from (frozen or produced by this request); null = native. */
    translation: AnalysisTranslationSchema.nullable(),
    enrich: z
      .object({
        questionSetSha: Sha256Schema,
        stateSha256: Sha256Schema,
        stateVariant: StateVariantSchema,
        answers: JsonObjectSchema,
        /** `flattenFacets` of the answers and the level-2 answers below (spec 05 §3.4). */
        features: z.record(z.string().max(200), z.number().finite()),
      })
      .strict(),
    match: z
      .object({
        questionSetSha: Sha256Schema,
        stateSha256: Sha256Schema,
        stateVariant: StateVariantSchema,
        cards: z
          .array(
            z
              .object({
                cardId: IdSchema,
                cardInputSha256: Sha256Schema,
                p: probability,
                answer: JsonObjectSchema,
              })
              .strict(),
          )
          .max(ANALYSIS_MAX_CARDS),
        l2: z
          .array(z.object({ l1Id: z.string().min(1).max(64), answer: JsonObjectSchema }).strict())
          .max(64),
      })
      .strict(),
  })
  .strict();
export type AnalysisResultSnapshot = z.infer<typeof AnalysisResultSnapshotSchema>;
