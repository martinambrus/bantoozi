import { compareBigIntStrings } from '@bantoozi/shared';

import { resolveLabels, type ResolvedLabel } from './enrichment.js';
import { ratedItems, runScore, type RatedItem, type SampleInfo } from './items.js';
import type { ScoreFn } from './ranking.js';
import type { RunData } from './run-data.js';

/**
 * Everything a report renders from: the runs of one dataset version, the frozen sample, and the
 * ground truth of a reference run (ratings, cards and facet labels captured in its config). The
 * reference is the latest complete E1 run, else the latest complete run, else the latest run.
 */
export interface ReportModel {
  datasetVersion: string;
  runs: RunData[];
  reference: RunData | null;
  sample: Map<string, SampleInfo>;
  items: RatedItem[];
  labels: Map<string, Map<string, ResolvedLabel>>;
  langs: string[];
  /** Live assignment status counts per rater (skips are not part of run configs). */
  assignmentCounts: Map<string, { pending: number; rated: number; skipped: number }>;
}

/** One scorer shown in the tables: a run, or the composed configuration. */
export interface ScoreView {
  label: string;
  score: ScoreFn;
  /** Runs whose card answers give the policy view (null: no card answers, e.g. B0/B1). */
  runFor: ((item: RatedItem) => RunData | null) | null;
  /** Card scores are probabilities: calibration applies. */
  probabilistic: boolean;
}

const isComplete = (run: RunData) => run.results?.status === 'complete';

export function pickReference(runs: readonly RunData[]): RunData | null {
  const byNewest = [...runs].sort((a, b) => compareBigIntStrings(b.id, a.id));
  return (
    byNewest.find((r) => r.experiment === 'E1' && isComplete(r)) ??
    byNewest.find(isComplete) ??
    byNewest[0] ??
    null
  );
}

/** The latest complete run of each experiment (else its latest run, reported as incomplete). */
export function latestRuns(runs: readonly RunData[]): Map<string, RunData> {
  const result = new Map<string, RunData>();
  const sorted = [...runs].sort((a, b) => compareBigIntStrings(a.id, b.id));
  for (const run of sorted) {
    const current = result.get(run.experiment);
    if (current === undefined || isComplete(run) || !isComplete(current)) {
      result.set(run.experiment, run);
    }
  }
  return result;
}

export function buildReportModel(input: {
  datasetVersion: string;
  runs: readonly RunData[];
  sample: ReadonlyMap<string, SampleInfo>;
  reference?: RunData | null;
  assignmentCounts?: ReadonlyMap<string, { pending: number; rated: number; skipped: number }>;
}): ReportModel {
  const reference = input.reference === undefined ? pickReference(input.runs) : input.reference;
  const sample = new Map(input.sample);
  return {
    datasetVersion: input.datasetVersion,
    runs: [...input.runs].sort((a, b) => compareBigIntStrings(a.id, b.id)),
    reference,
    sample,
    items: reference === null ? [] : ratedItems(reference.config, sample),
    labels: resolveLabels(reference?.config.facetLabels ?? []),
    langs: [...new Set([...sample.values()].map((s) => s.lang))].sort(),
    assignmentCounts: new Map(input.assignmentCounts ?? []),
  };
}

const CARD_RUNS = new Set(['E1', 'E2', 'E3', 'E3b', 'E4', 'E5', 'E6']);

export function runView(run: RunData): ScoreView {
  const cardBased = CARD_RUNS.has(run.experiment);
  return {
    label: `${run.experiment} (#${run.id})`,
    score: (item) => runScore(run, item),
    runFor: cardBased ? () => run : null,
    probabilistic: cardBased,
  };
}

/** The composed per-language configuration: each item scored by its language's run. */
export function compositionView(
  label: string,
  composition: Readonly<Record<string, RunData | null>>,
  fallback: RunData | null,
): ScoreView {
  const runFor = (item: RatedItem): RunData | null =>
    Object.hasOwn(composition, item.lang) ? (composition[item.lang] ?? null) : fallback;
  return {
    label,
    score: (item) => {
      const run = runFor(item);
      return run === null ? null : runScore(run, item);
    },
    runFor,
    probabilistic: true,
  };
}
