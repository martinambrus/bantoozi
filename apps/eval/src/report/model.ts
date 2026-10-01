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

/**
 * Whether `run` covers a strict subset of `other`'s scope (languages and raters): a diagnostic
 * rerun with `--langs` or `--raters` that must not replace a full-scope run of the experiment.
 */
function narrowerThan(run: RunData, other: RunData): boolean {
  const langs = new Set(other.config.langs);
  const raters = new Set(other.config.raters.map((r) => r.raterId));
  const within =
    run.config.langs.every((l) => langs.has(l)) &&
    run.config.raters.every((r) => raters.has(r.raterId));
  return within && (run.config.langs.length < langs.size || run.config.raters.length < raters.size);
}

/** Complete runs not narrower than another complete run of the same experiment. */
function fullScope(runs: readonly RunData[]): RunData[] {
  const complete = runs.filter(isComplete);
  return complete.filter(
    (run) =>
      !complete.some((other) => other.experiment === run.experiment && narrowerThan(run, other)),
  );
}

export function pickReference(runs: readonly RunData[]): RunData | null {
  const byNewest = [...runs].sort((a, b) => compareBigIntStrings(b.id, a.id));
  const full = new Set(fullScope(runs));
  return (
    byNewest.find((r) => r.experiment === 'E1' && full.has(r)) ??
    byNewest.find(isComplete) ??
    byNewest[0] ??
    null
  );
}

/**
 * The latest complete run of each experiment (else its latest run, reported as incomplete). A
 * complete run narrower than another complete run of its experiment is passed over, so a later
 * `--langs`/`--raters` rerun does not replace the full-scope run (`--run` still selects it).
 */
export function latestRuns(runs: readonly RunData[]): Map<string, RunData> {
  const result = new Map<string, RunData>();
  const full = new Set(fullScope(runs));
  const sorted = [...runs].sort((a, b) => compareBigIntStrings(a.id, b.id));
  for (const run of sorted) {
    const current = result.get(run.experiment);
    if (current === undefined || full.has(run) || !isComplete(current)) {
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
