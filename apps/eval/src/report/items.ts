import { canonicalSha256 } from '@bantoozi/shared/server';
import { z } from 'zod';

import type { RunConfig, RunData } from './run-data.js';

/**
 * The unit every metric is computed on (spec 10 §4): one rating of one article by one reading
 * context (an `eval.raters` row), joined with the frozen sample row (language, split, story group,
 * first-seen time). Contexts of the same human share a participant key; participants, not contexts,
 * count as independent people (spec 10 §2.2).
 */
export type Split = 'dev' | 'test';

export interface SampleInfo {
  articleId: string;
  lang: string;
  split: Split;
  storyGroupId: string;
  /** Epoch ms. */
  firstSeenAt: number;
  title: string | null;
}

export interface RatedItem {
  /** `<raterId>:<articleId>`. */
  key: string;
  raterId: string;
  /** The reading context: one `eval.raters` row. */
  contextId: string;
  participantKey: string;
  articleId: string;
  lang: string;
  split: Split;
  groupId: string;
  firstSeenAt: number;
  liked: boolean;
  title: string | null;
}

const SnapshotSchema = z.looseObject({
  storyGroupId: z.string().min(1),
  firstSeenAt: z.string().min(1),
  input: z.looseObject({ title: z.string().nullish() }).nullish(),
});

/** The sample row fields the report reads (from `eval.sample`, see `@bantoozi/db` `SampleRow`). */
export function sampleInfo(row: {
  articleId: string;
  lang: string;
  split: string;
  snapshot: Record<string, unknown>;
}): SampleInfo {
  const snapshot = SnapshotSchema.parse(row.snapshot);
  if (row.split !== 'dev' && row.split !== 'test') {
    throw new RangeError(`article ${row.articleId} has split ${row.split}`);
  }
  const firstSeenAt = Date.parse(snapshot.firstSeenAt);
  return {
    articleId: row.articleId,
    lang: row.lang,
    split: row.split,
    storyGroupId: snapshot.storyGroupId,
    firstSeenAt: Number.isFinite(firstSeenAt) ? firstSeenAt : 0,
    title: snapshot.input?.title ?? null,
  };
}

/**
 * The rated cohort of a run: its captured ratings of cohort articles that are in the frozen sample,
 * with the context's participant. Ratings of articles outside the cohort or the sample are left out
 * (they belong to another version).
 */
export function ratedItems(
  config: RunConfig,
  sample: ReadonlyMap<string, SampleInfo>,
): RatedItem[] {
  const cohort = new Set(config.cohort.articleIds);
  const raters = new Map(config.raters.map((rater) => [rater.raterId, rater]));
  const items: RatedItem[] = [];
  for (const rating of config.ratings) {
    if (!cohort.has(rating.articleId)) continue;
    const info = sample.get(rating.articleId);
    const rater = raters.get(rating.raterId);
    if (info === undefined || rater === undefined) continue;
    items.push({
      key: `${rating.raterId}:${rating.articleId}`,
      raterId: rating.raterId,
      contextId: rating.raterId,
      participantKey: rater.participantKey,
      articleId: rating.articleId,
      lang: info.lang,
      split: info.split,
      groupId: info.storyGroupId,
      firstSeenAt: info.firstSeenAt,
      liked: rating.rating === 1,
      title: info.title,
    });
  }
  return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The items of one split: selection only ever sees `dev` (spec 10 §5). */
export function onSplit<T extends { split: Split }>(items: readonly T[], split: Split): T[] {
  return items.filter((item) => item.split === split);
}

/** Hash of a run's ground truth (raters and ratings), to prove runs compare the same labels. */
export function groundTruthSha(config: RunConfig): string {
  return canonicalSha256({
    raters: [...config.raters]
      .map((r) => [r.raterId, r.participantKey, [...r.langs].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ratings: [...config.ratings]
      .map((r) => [r.raterId, r.articleId, r.rating])
      .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)),
  });
}

/** The zero-training score of an item in a run (`score.r<raterId>`); null when unknown/missing. */
export function runScore(
  run: RunData,
  item: Pick<RatedItem, 'raterId' | 'articleId'>,
): number | null {
  return run.scores.get(item.raterId)?.get(item.articleId) ?? null;
}

/** Valid-scoring coverage of a run on the items, per language and per context. */
export interface Coverage {
  byLang: Map<string, { expected: number; valid: number }>;
  byRater: Map<string, { expected: number; valid: number }>;
}

export function scoringCoverage(run: RunData, items: readonly RatedItem[]): Coverage {
  const byLang = new Map<string, { expected: number; valid: number }>();
  const byRater = new Map<string, { expected: number; valid: number }>();
  const bump = (
    map: Map<string, { expected: number; valid: number }>,
    key: string,
    ok: boolean,
  ) => {
    const entry = map.get(key) ?? { expected: 0, valid: 0 };
    entry.expected += 1;
    if (ok) entry.valid += 1;
    map.set(key, entry);
  };
  for (const item of items) {
    const ok = runScore(run, item) !== null;
    bump(byLang, item.lang, ok);
    bump(byRater, item.raterId, ok);
  }
  return { byLang, byRater };
}
