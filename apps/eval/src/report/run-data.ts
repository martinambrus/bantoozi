import type { Answer } from '@bantoozi/questions';
import { IdSchema } from '@bantoozi/shared';
import { z } from 'zod';

/**
 * What the report and the gate read from one `eval.runs` row and its `eval.run_answers` (spec 10
 * §2.1, §3; the run data conventions of the experiment runner). The config is the run's ground
 * truth boundary: ratings, cards and facet labels are read from it, never from the live tables, so a
 * later correction cannot change an earlier run. JSON from the database is validated here (zod at
 * the boundary); unknown extra fields are kept, so a newer runner does not break an older report.
 */

const id = IdSchema;
const STATE_VARIANTS = ['none', 'native', 'lt', 'glm'] as const;
export type StateVariant = (typeof STATE_VARIANTS)[number];
export type CardVariant = 'as_written' | 'english';

export const RunRaterSchema = z.looseObject({
  raterId: id,
  participantKey: z.string().min(1),
  contextName: z.string().nullish(),
  langs: z.array(z.string()),
});

export const RunRatingSchema = z.looseObject({
  raterId: id,
  articleId: id,
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z.string().nullish(),
  createdAt: z.string().nullish(),
});

export const RunCardSchema = z.looseObject({
  raterId: id,
  cardId: id,
  strength: z.enum(['must', 'love', 'like', 'never']),
  lang: z.string().nullish(),
  interest: z.string().nullish(),
});

export const RunFacetLabelSchema = z.looseObject({
  labeler: z.string().min(1),
  articleId: id,
  questionKey: z.string().min(1),
  value: z.string(),
});

export const RunConfigSchema = z.looseObject({
  experiment: z.string().min(1),
  variant: z
    .looseObject({
      state: z.enum(STATE_VARIANTS),
      cards: z.enum(['as_written', 'english']),
    })
    .nullish(),
  datasetVersion: z.string().min(1),
  snapshotSha: z.string().nullish(),
  splitSha: z.string().nullish(),
  configSha: z.string().nullish(),
  seed: z.union([z.string(), z.number()]).nullish(),
  engine: z
    .looseObject({
      provider: z.string().nullish(),
      model: z.string().nullish(),
      requiredEngine: z.string().nullish(),
      pricePerMTokUsd: z.number().nullish(),
    })
    .nullish(),
  langs: z.array(z.string()).default([]),
  raters: z.array(RunRaterSchema).default([]),
  cohort: z.looseObject({ articleIds: z.array(id), sha: z.string().min(1) }),
  ratings: z.array(RunRatingSchema).default([]),
  cards: z.array(RunCardSchema).default([]),
  facetLabels: z.array(RunFacetLabelSchema).default([]),
  maxUsd: z.number().nullish(),
  baseRunId: id.nullish(),
});
export type RunConfig = z.output<typeof RunConfigSchema>;
export type RunRater = z.output<typeof RunRaterSchema>;
export type RunRating = z.output<typeof RunRatingSchema>;
export type RunCard = z.output<typeof RunCardSchema>;
export type RunFacetLabel = z.output<typeof RunFacetLabelSchema>;

const countPair = z.looseObject({ expected: z.number().min(0), valid: z.number().min(0) });
const latency = z.looseObject({
  p50: z.number().nullish(),
  p95: z.number().nullish(),
  n: z.number(),
});

export const RunResultsSchema = z.looseObject({
  status: z.enum(['complete', 'partial', 'aborted', 'skipped', 'running']),
  reason: z.string().nullish(),
  coverage: z
    .looseObject({
      byLang: z.record(z.string(), countPair).default({}),
      byRater: z.record(z.string(), countPair).default({}),
    })
    .nullish(),
  cost: z
    .looseObject({
      estimatedUsd: z.number().nullish(),
      billedUsd: z.number().nullish(),
      cacheHits: z.number().nullish(),
      cacheMisses: z.number().nullish(),
      cacheSavingsUsd: z.number().nullish(),
      failedCallUsd: z.number().nullish(),
      tokens: z.looseObject({ input: z.number(), output: z.number() }).nullish(),
    })
    .nullish(),
  latencyMs: z.record(z.string(), latency).nullish(),
  cacheLookupMs: latency.nullish(),
  e6: z
    .looseObject({
      examplesAdded: z.record(z.string(), z.looseObject({ yes: z.number(), no: z.number() })),
      earlierArticleIds: z.array(id),
      laterArticleIds: z.array(id),
    })
    .nullish(),
  e7: z
    .looseObject({
      items: z.array(z.looseObject({ articleId: id, raterId: id, targetedCardId: id })),
    })
    .nullish(),
});
export type RunResults = z.output<typeof RunResultsSchema>;

const AnswerSchema: z.ZodType<Answer> = z.union([
  z.looseObject({ type: z.literal('noul'), p: z.number() }),
  z.looseObject({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.looseObject({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.array(z.number()),
    confidence: z.number(),
    levels: z.number().int(),
  }),
]) as unknown as z.ZodType<Answer>;

const okCard = z.looseObject({ ok: z.literal(true), p: z.number(), engine: z.string().nullish() });
const failed = z.looseObject({ ok: z.literal(false), reason: z.string().nullish() });
const okEnrich = z.looseObject({
  ok: z.literal(true),
  answer: AnswerSchema,
  engine: z.string().nullish(),
});
const scoreAnswer = z.looseObject({
  score: z.number().nullable(),
  source: z.string().nullish(),
  decidingCardId: id.nullish(),
});

/** A Call B answer of one card: usable `{p, engine}` or failed. */
export type CardResult = { ok: true; p: number; engine: string } | { ok: false };

/** The raw `eval.runs` row the loader hands over (see `@bantoozi/db` `RunRow`). */
export interface RawRun {
  id: string;
  experiment: string;
  datasetVersion: string;
  config: Record<string, unknown>;
  gitSha: string;
  startedAt: Date;
  finishedAt: Date | null;
  results: Record<string, unknown> | null;
}

export interface RawAnswer {
  articleId: string;
  cardId: string | null;
  questionKey: string;
  answer: Record<string, unknown>;
}

/** One parsed run with its answers indexed for the metrics. */
export interface RunData {
  id: string;
  experiment: string;
  datasetVersion: string;
  gitSha: string;
  startedAt: Date;
  finishedAt: Date | null;
  config: RunConfig;
  /** `null` while unfinished or when the stored results do not parse. */
  results: RunResults | null;
  /** `score.r<raterId>` → articleId → score (null = unknown). */
  scores: Map<string, Map<string, number | null>>;
  /** articleId → cardId → Call B result (`card` rows). */
  cards: Map<string, Map<string, CardResult>>;
  /** articleId → enrich key → Call A answer (null = failed). */
  enrich: Map<string, Map<string, Answer | null>>;
  /** Other keys (`e7.targeted`, `e7.generic`, …): key → articleId → cardId → result. */
  extra: Map<string, Map<string, Map<string, CardResult>>>;
  /** Answers that did not parse (counted, never silently dropped). */
  malformed: number;
}

export class RunDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunDataError';
  }
}

function nested<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let inner = map.get(key);
  if (inner === undefined) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

function cardResult(value: unknown): CardResult | null {
  const ok = okCard.safeParse(value);
  if (ok.success) {
    const p = ok.data.p;
    if (!(p >= 0 && p <= 1)) return { ok: false };
    return { ok: true, p, engine: ok.data.engine ?? 'typesafe' };
  }
  return failed.safeParse(value).success ? { ok: false } : null;
}

/** Parse a run row and its answers. A config that does not parse is an error (no ground truth). */
export function parseRunData(run: RawRun, answers: readonly RawAnswer[]): RunData {
  const config = RunConfigSchema.safeParse(run.config);
  if (!config.success) {
    throw new RunDataError(`run ${run.id}: config does not match the run conventions`);
  }
  const results = run.results === null ? null : RunResultsSchema.safeParse(run.results);
  const data: RunData = {
    id: run.id,
    experiment: run.experiment,
    datasetVersion: run.datasetVersion,
    gitSha: run.gitSha,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    config: config.data,
    results: results?.success === true ? results.data : null,
    scores: new Map(),
    cards: new Map(),
    enrich: new Map(),
    extra: new Map(),
    malformed: 0,
  };
  for (const row of answers) {
    const key = row.questionKey;
    if (key.startsWith('score.r')) {
      const parsed = scoreAnswer.safeParse(row.answer);
      const score = parsed.success ? parsed.data.score : null;
      if (!parsed.success) data.malformed += 1;
      const valid = score !== null && Number.isFinite(score) ? score : null;
      nested(data.scores, key.slice('score.r'.length)).set(row.articleId, valid);
    } else if (key === 'card' && row.cardId !== null) {
      const result = cardResult(row.answer);
      if (result === null) data.malformed += 1;
      nested(data.cards, row.articleId).set(row.cardId, result ?? { ok: false });
    } else if (key.startsWith('enrich.')) {
      const parsed = okEnrich.safeParse(row.answer);
      if (!parsed.success && !failed.safeParse(row.answer).success) data.malformed += 1;
      nested(data.enrich, row.articleId).set(
        key.slice('enrich.'.length),
        parsed.success ? parsed.data.answer : null,
      );
    } else if (row.cardId !== null) {
      const result = cardResult(row.answer);
      if (result === null) data.malformed += 1;
      nested(nested(data.extra, key), row.articleId).set(row.cardId, result ?? { ok: false });
    }
  }
  return data;
}
