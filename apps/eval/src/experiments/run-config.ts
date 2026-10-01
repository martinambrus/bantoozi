import type {
  EvalAssignmentRecord,
  EvalFacetLabelRecord,
  EvalRaterCardRecord,
  EvalRaterRecord,
  EvalRatingRecord,
} from '@bantoozi/db';
import type { CardBody } from '@bantoozi/questions';
import type { CardTextMode } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';
import { z } from 'zod';

/**
 * `eval.runs.config` (spec 10 §2.1, §3): written once when a run starts and immutable afterwards (a
 * database trigger refuses updates). It is the reproducibility boundary of the run: the dataset and
 * split hashes, the engine and question manifests, and the exact raters, cards (with the card text
 * actually sent, translations included), assignments, ratings and facet labels the run used, so a
 * later rating correction or card edit never changes an earlier run's ground truth. Resumes and
 * replays rebuild their inputs from this object, never from the live rater tables.
 *
 * Ids are decimal strings; timestamps ISO strings. `configSha` is the canonical SHA-256 of every
 * other field.
 */

const id = z.string().regex(/^[1-9]\d{0,18}$/);
const strength = z.enum(['must', 'love', 'like', 'never']);

export const RunCardSchema = z.object({
  raterId: id,
  cardId: id,
  strength,
  kind: z.enum(['interest', 'label']),
  title: z.string(),
  interest: z.string(),
  notFor: z.string().nullable(),
  /** The English pair the run used in `english` mode (spec 07 §5); null when not translated. */
  interestEn: z.string().nullable(),
  notForEn: z.string().nullable(),
  /** `interest_cards.lang`, or the detected language of a card-text translation. */
  lang: z.string(),
  examplesYes: z.array(z.string()),
  examplesNo: z.array(z.string()),
  visibility: z.enum(['public', 'shared', 'private']),
  ownerUserId: z.string().nullable(),
  /** The card-text translation status (`translateCardText`), for `english` runs. */
  textStatus: z.string().nullable(),
});
export type RunCard = z.infer<typeof RunCardSchema>;

export const RunRaterSchema = z.object({
  raterId: id,
  participantKey: z.string(),
  contextName: z.string().nullable(),
  langs: z.array(z.string()),
});
export type RunRater = z.infer<typeof RunRaterSchema>;

export const RunRatingSchema = z.object({
  raterId: id,
  articleId: id,
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type RunRating = z.infer<typeof RunRatingSchema>;

export const RunFacetLabelSchema = z.object({
  labeler: z.string(),
  articleId: id,
  questionKey: z.string(),
  value: z.string(),
});
export type RunFacetLabel = z.infer<typeof RunFacetLabelSchema>;

export const RunEngineSchema = z.object({
  provider: z.enum(['typesafe', 'llm', 'laya']),
  model: z.string(),
  requiredEngine: z.enum(['typesafe', 'llm', 'laya']),
  pricePerMTokUsd: z.number().nullable(),
  /** The LLM output cap (`num_predict`), part of an LLM replay's decoding settings. */
  maxOutputTokens: z.number().int().positive().nullable(),
});
export type RunEngine = z.infer<typeof RunEngineSchema>;

const setRef = z.object({ version: z.string(), sha: z.string() });

export const RunConfigSchema = z.object({
  experiment: z.string(),
  variant: z.object({
    state: z.enum(['none', 'native', 'lt', 'glm']),
    cards: z.enum(['as_written', 'english']),
  }),
  datasetVersion: z.string(),
  snapshotSha: z.string().nullable(),
  splitSha: z.string().nullable(),
  configSha: z.string(),
  seed: z.string(),
  engine: RunEngineSchema.nullable(),
  questionSets: z.object({ enrich: setRef, match: setRef }).nullable(),
  translation: z.object({
    articles: z.enum(['libretranslate', 'ollama']).nullable(),
    cards: z.literal('libretranslate').nullable(),
    model: z.string().optional(),
  }),
  langs: z.array(z.string()),
  developmentOnly: z.boolean(),
  raters: z.array(RunRaterSchema),
  cohort: z.object({ articleIds: z.array(id), sha: z.string() }),
  /** Each rater's assigned articles of the version (the BM25 corpus, spec 06 §9). */
  assignments: z.record(z.string(), z.array(id)),
  ratings: z.array(RunRatingSchema),
  cards: z.array(RunCardSchema),
  facetLabels: z.array(RunFacetLabelSchema),
  maxUsd: z.number().nonnegative(),
  baseRunId: id.optional(),
  /** A replay (spec 10 §6): the compared run and the proposed change. */
  replay: z
    .object({
      of: id,
      engine: z.enum(['typesafe', 'llm']),
      model: z.string(),
      questionSet: z.string(),
      thresholds: z.record(z.string(), z.unknown()).nullable(),
      /** The effective ranker config of the compared (baseline) side and where it came from. */
      baseRanker: z.record(z.string(), z.unknown()).optional(),
      baseRankerSource: z.enum(['base_run', 'settings']).optional(),
      /** The effective ranker config of the replay side (baseline + `--thresholds`). */
      replayRanker: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /**
   * The stored `ranker.thresholds` partial (spec 06 §11) when the run started: the deployed policy
   * a later replay compares against. Absent in runs written before it was recorded.
   */
  rankerThresholds: z.record(z.string(), z.unknown()).optional(),
  runtime: z.record(z.string(), z.unknown()),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

/** Read back a stored run config (resume, replay, E6/E7 base runs). */
export function parseRunConfig(value: unknown): RunConfig {
  return RunConfigSchema.parse(value);
}

/** `configSha`: the canonical hash of every other field. */
export function computeConfigSha(config: Omit<RunConfig, 'configSha'>): string {
  return canonicalSha256(config);
}

export function withConfigSha(config: Omit<RunConfig, 'configSha'>): RunConfig {
  return { ...config, configSha: computeConfigSha(config) };
}

const stringList = z.array(z.string()).catch([]);
const BodySchema = z.object({
  interest: z.string(),
  not_for: z.string().nullish(),
  interest_en: z.string().nullish(),
  not_for_en: z.string().nullish(),
  examples_yes: stringList.optional(),
  examples_no: stringList.optional(),
});

/** A card snapshot from its stored row (spec 05 §5.1 body); unreadable bodies throw. */
export function runCardOf(record: EvalRaterCardRecord): RunCard {
  const body = BodySchema.parse(record.body);
  return {
    raterId: record.raterId,
    cardId: record.cardId,
    strength: record.strength,
    kind: record.kind,
    title: record.title,
    interest: body.interest,
    notFor: body.not_for ?? null,
    interestEn: body.interest_en ?? null,
    notForEn: body.not_for_en ?? null,
    lang: record.lang,
    examplesYes: [...(body.examples_yes ?? [])],
    examplesNo: [...(body.examples_no ?? [])],
    visibility: record.visibility,
    ownerUserId: record.ownerUserId,
    textStatus: null,
  };
}

/**
 * The body a card question is built from. In `as_written` mode the English pair is left out, so a
 * run's question never depends on a translation it did not make; `english` mode uses the run's own
 * translation (`effectiveCardText` falls back to the original when it is incomplete).
 */
export function cardBodyOf(card: RunCard, mode: CardTextMode): CardBody {
  return {
    interest: card.interest,
    not_for: card.notFor,
    interest_en: mode === 'english' ? card.interestEn : null,
    not_for_en: mode === 'english' ? card.notForEn : null,
    examples_yes: card.examplesYes,
    examples_no: card.examplesNo,
  };
}

export function runRaterOf(record: EvalRaterRecord): RunRater {
  return {
    raterId: record.raterId,
    participantKey: record.participantKey,
    contextName: record.contextName,
    langs: [...record.langs],
  };
}

export function runRatingOf(record: EvalRatingRecord): RunRating {
  return {
    raterId: record.raterId,
    articleId: record.articleId,
    rating: record.rating,
    reason: record.reason,
    createdAt: record.createdAt.toISOString(),
  };
}

export function runFacetLabelOf(record: EvalFacetLabelRecord): RunFacetLabel {
  return { ...record };
}

/** Assigned article ids per rater, in assignment order. */
export function assignmentsByRater(
  records: readonly EvalAssignmentRecord[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const record of records) (out[record.raterId] ??= []).push(record.articleId);
  return out;
}

/** Numeric order of decimal id strings. */
export function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
