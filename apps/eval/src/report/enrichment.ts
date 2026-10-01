import type { Answer } from '@bantoozi/questions';

import {
  accuracy,
  cohenKappa,
  macroF1,
  meanAbsoluteError,
  precisionRecallAtCutoff,
  rocAuc,
  spearman,
  topKAccuracy,
  type CutoffResult,
  type FlagSample,
} from '../metrics/index.js';

/**
 * Enrichment accuracy (spec 10 §2.3, §4): Call A answers against human facet labels. Label values
 * are the rating app's strings: an option id for `content_type`/`topic_l1`, `0`–`4` for `depth`,
 * yes/no for the three flags, and an uncertain/not-applicable value that is always excluded.
 * Adjudication is predeclared (spec 10 §2.3, D-105): an `adjudicated` labeller's value wins;
 * otherwise a single label, or the agreed value of several; an unresolved disagreement is left
 * out and counted. The label that agrees with a model is never chosen.
 */
export const FACET_KEYS = [
  'content_type',
  'topic_l1',
  'depth',
  'clickbait',
  'promotional',
  'time_sensitive',
] as const;
export type FacetKey = (typeof FACET_KEYS)[number];
export const FLAG_KEYS = ['clickbait', 'promotional', 'time_sensitive'] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export const ADJUDICATOR = 'adjudicated';
const EXCLUDED = new Set(['uncertain', 'not_applicable', 'n/a', 'na', 'unknown', '?', '']);
const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

export interface FacetLabel {
  labeler: string;
  articleId: string;
  questionKey: string;
  value: string;
}

export type ResolvedLabel = { value: string } | { excluded: 'uncertain' | 'unresolved' };

/** The adjudicated label of each (article, key). */
export function resolveLabels(
  labels: readonly FacetLabel[],
): Map<string, Map<string, ResolvedLabel>> {
  const grouped = new Map<string, FacetLabel[]>();
  for (const label of labels) {
    const key = `${label.articleId}\u0000${label.questionKey}`;
    grouped.set(key, [...(grouped.get(key) ?? []), label]);
  }
  const resolved = new Map<string, Map<string, ResolvedLabel>>();
  for (const group of grouped.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const adjudicated = group.find((label) => label.labeler === ADJUDICATOR);
    const values = new Set(group.map((label) => label.value.trim().toLowerCase()));
    let result: ResolvedLabel;
    const chosen =
      adjudicated?.value.trim().toLowerCase() ?? (values.size === 1 ? [...values][0] : undefined);
    if (chosen === undefined) result = { excluded: 'unresolved' };
    else if (EXCLUDED.has(chosen)) result = { excluded: 'uncertain' };
    else result = { value: chosen };
    const inner = resolved.get(first.articleId) ?? new Map<string, ResolvedLabel>();
    inner.set(first.questionKey, result);
    resolved.set(first.articleId, inner);
  }
  return resolved;
}

export function yesNo(value: string): boolean | null {
  if (YES.has(value)) return true;
  if (NO.has(value)) return false;
  return null;
}

export function depthLevel(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
}

/** The normalized depth facet (`score / (levels − 1)`, spec 05 §3.4) a demotion compares. */
export function depthFacet(answer: Answer | null | undefined): number | null {
  if (answer?.type !== 'score' || answer.levels < 2) return null;
  return answer.score / (answer.levels - 1);
}

export function noulP(answer: Answer | null | undefined): number | null {
  return answer?.type === 'noul' && answer.p >= 0 && answer.p <= 1 ? answer.p : null;
}

/** The demotion flags of spec 06 §5 with their facet, direction and positive label. */
export const DEMOTION_FLAGS = [
  { flag: 'clickbait', key: 'clickbait', direction: 'gte' },
  { flag: 'promotional', key: 'promotional', direction: 'gte' },
  { flag: 'staleTimeSensitive', key: 'time_sensitive', direction: 'gte' },
  { flag: 'shallowDepth', key: 'depth', direction: 'lte' },
] as const;
export type DemotionFlag = (typeof DEMOTION_FLAGS)[number]['flag'];

/**
 * One sample per labelled article for a demotion flag: the Call A facet and whether the label is
 * the flagged class (*yes*, or a labelled depth ≤ 1). Excluded or unparsable labels and failed
 * answers are left out.
 */
export function demotionSamples(
  flag: DemotionFlag,
  articleIds: readonly string[],
  labels: ReadonlyMap<string, ReadonlyMap<string, ResolvedLabel>>,
  answerOf: (articleId: string, key: string) => Answer | null | undefined,
): FlagSample[] {
  const spec = DEMOTION_FLAGS.find((d) => d.flag === flag);
  if (spec === undefined) throw new RangeError(`unknown flag ${flag}`);
  const samples: FlagSample[] = [];
  for (const articleId of [...new Set(articleIds)]) {
    const label = labels.get(articleId)?.get(spec.key);
    if (label === undefined || !('value' in label)) continue;
    const answer = answerOf(articleId, spec.key);
    if (spec.key === 'depth') {
      const level = depthLevel(label.value);
      const value = depthFacet(answer);
      if (level !== null && value !== null) samples.push({ value, positive: level <= 1 });
    } else {
      const yes = yesNo(label.value);
      const value = noulP(answer);
      if (yes !== null && value !== null) samples.push({ value, positive: yes });
    }
  }
  return samples;
}

export interface EnrichmentMetrics {
  articles: number;
  contentType: { n: number; accuracy: number | null; macroF1: number | null };
  topic: { n: number; top1: number | null; top2: number | null };
  depth: { n: number; mae: number | null; spearman: number | null };
  flags: Record<FlagKey, { n: number; auc: number | null }>;
  excluded: { uncertain: number; unresolved: number; failedAnswers: number };
}

/** Enrichment accuracy of one language's labelled articles against one run's Call A answers. */
export function enrichmentMetrics(
  articleIds: readonly string[],
  labels: ReadonlyMap<string, ReadonlyMap<string, ResolvedLabel>>,
  answerOf: (articleId: string, key: string) => Answer | null | undefined,
): EnrichmentMetrics {
  const ct: { truth: string; predicted: string }[] = [];
  const topic: { truth: string; probabilities: Record<string, number> }[] = [];
  const depth: { truth: number; predicted: number }[] = [];
  const flags = Object.fromEntries(
    FLAG_KEYS.map((k) => [k, [] as { score: number; positive: boolean }[]]),
  ) as Record<FlagKey, { score: number; positive: boolean }[]>;
  const excluded = { uncertain: 0, unresolved: 0, failedAnswers: 0 };
  const ids = [...new Set(articleIds)].filter((id) => labels.has(id));
  for (const articleId of ids) {
    for (const key of FACET_KEYS) {
      const label = labels.get(articleId)?.get(key);
      if (label === undefined) continue;
      if (!('value' in label)) {
        excluded[label.excluded] += 1;
        continue;
      }
      const answer = answerOf(articleId, key);
      if (answer === null || answer === undefined) {
        excluded.failedAnswers += 1;
        continue;
      }
      if (key === 'content_type' && answer.type === 'choice') {
        ct.push({ truth: label.value, predicted: answer.choice });
      } else if (key === 'topic_l1' && answer.type === 'choice') {
        topic.push({ truth: label.value, probabilities: answer.probabilities });
      } else if (key === 'depth' && answer.type === 'score') {
        const level = depthLevel(label.value);
        if (level !== null) depth.push({ truth: level, predicted: answer.score });
      } else if ((FLAG_KEYS as readonly string[]).includes(key) && answer.type === 'noul') {
        const yes = yesNo(label.value);
        if (yes !== null) flags[key as FlagKey].push({ score: answer.p, positive: yes });
      }
    }
  }
  return {
    articles: ids.length,
    contentType: { n: ct.length, accuracy: accuracy(ct), macroF1: macroF1(ct).value },
    topic: { n: topic.length, top1: topKAccuracy(topic, 1), top2: topKAccuracy(topic, 2) },
    depth: {
      n: depth.length,
      mae: meanAbsoluteError(depth),
      spearman: spearman(
        depth.map((d) => d.truth),
        depth.map((d) => d.predicted),
      ),
    },
    flags: Object.fromEntries(
      FLAG_KEYS.map((k) => [k, { n: flags[k].length, auc: rocAuc(flags[k]) }]),
    ) as Record<FlagKey, { n: number; auc: number | null }>,
    excluded,
  };
}

/** Human agreement between the two labellers with the largest overlap, per facet (spec 10 §2.3). */
export function humanAgreement(labels: readonly FacetLabel[]): {
  labelers: [string, string];
  byKey: Record<FacetKey, { n: number; kappa: number | null }>;
} | null {
  const humans = [...new Set(labels.map((l) => l.labeler))].filter((l) => l !== ADJUDICATOR).sort();
  let best: { pair: [string, string]; overlap: number } | null = null;
  for (let i = 0; i < humans.length; i += 1) {
    for (let j = i + 1; j < humans.length; j += 1) {
      const a = humans[i] as string;
      const b = humans[j] as string;
      const left = new Set(
        labels.filter((l) => l.labeler === a).map((l) => `${l.articleId}:${l.questionKey}`),
      );
      const overlap = labels.filter(
        (l) => l.labeler === b && left.has(`${l.articleId}:${l.questionKey}`),
      ).length;
      if (best === null || overlap > best.overlap) best = { pair: [a, b], overlap };
    }
  }
  if (best === null || best.overlap === 0) return null;
  const [a, b] = best.pair;
  const valueOf = (labeler: string) =>
    new Map(
      labels
        .filter((l) => l.labeler === labeler)
        .map((l) => [`${l.articleId}:${l.questionKey}`, l.value.trim().toLowerCase()]),
    );
  const va = valueOf(a);
  const vb = valueOf(b);
  const byKey = {} as Record<FacetKey, { n: number; kappa: number | null }>;
  for (const key of FACET_KEYS) {
    const pairs: { a: string; b: string }[] = [];
    for (const [k, x] of va) {
      if (!k.endsWith(`:${key}`)) continue;
      const y = vb.get(k);
      if (y === undefined || EXCLUDED.has(x) || EXCLUDED.has(y)) continue;
      if (key === 'depth' && (depthLevel(x) === null || depthLevel(y) === null)) continue;
      pairs.push({ a: x, b: y });
    }
    byKey[key] = {
      n: pairs.length,
      kappa:
        key === 'depth'
          ? cohenKappa(pairs, { weights: 'quadratic', categories: ['0', '1', '2', '3', '4'] })
          : cohenKappa(pairs),
    };
  }
  return { labelers: [a, b], byKey };
}

export { type CutoffResult, precisionRecallAtCutoff };
