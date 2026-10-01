import {
  assignmentStatusCounts,
  GATE_LOCK_EXPERIMENT,
  getDataset,
  listDatasets,
  listRuns,
  loadRunAnswers,
  loadSample,
  type DatasetRow,
  type Executor,
} from '@bantoozi/db';

import { EvalCommandError } from '../runtime.js';
import { sampleInfo, type SampleInfo } from './items.js';
import { buildReportModel, type ReportModel } from './model.js';
import { parseRunData, RunDataError, type RunData } from './run-data.js';

/**
 * Loading for `eval report` and `eval gate`: one frozen dataset version, its sample and its runs
 * with all answers (the gate's own lock rows are not experiment runs). The SQL lives in
 * `@bantoozi/db`; this module only orchestrates and validates.
 */
export interface LoadedDataset {
  dataset: DatasetRow & { snapshotSha: string; splitSha: string };
  sample: Map<string, SampleInfo>;
  runs: RunData[];
  /** Runs whose stored data could not be parsed (reported, never silently used). */
  unreadable: { id: string; experiment: string; reason: string }[];
}

/** The requested version, else the newest frozen one. */
export async function resolveDatasetVersion(db: Executor, requested?: string): Promise<DatasetRow> {
  if (requested !== undefined) {
    const dataset = await getDataset(db, requested);
    if (dataset === null) throw new EvalCommandError(`dataset version ${requested} does not exist`);
    return dataset;
  }
  const frozen = (await listDatasets(db)).filter((d) => d.frozenAt !== null);
  const newest = frozen[frozen.length - 1];
  if (newest === undefined) {
    throw new EvalCommandError('no frozen dataset version: run an experiment first (`eval run`)');
  }
  return newest;
}

export async function loadDataset(db: Executor, requested?: string): Promise<LoadedDataset> {
  const dataset = await resolveDatasetVersion(db, requested);
  if (dataset.frozenAt === null || dataset.snapshotSha === null || dataset.splitSha === null) {
    throw new EvalCommandError(
      `dataset version ${dataset.version} is not frozen yet (no model run)`,
    );
  }
  const sample = new Map(
    (await loadSample(db, dataset.version)).map((row) => [row.articleId, sampleInfo(row)]),
  );
  const runs: RunData[] = [];
  const unreadable: LoadedDataset['unreadable'] = [];
  for (const run of await listRuns(db, { datasetVersion: dataset.version })) {
    if (run.experiment === GATE_LOCK_EXPERIMENT) continue;
    try {
      runs.push(parseRunData(run, await loadRunAnswers(db, run.id)));
    } catch (error) {
      if (!(error instanceof RunDataError)) throw error;
      unreadable.push({ id: run.id, experiment: run.experiment, reason: error.message });
    }
  }
  return {
    dataset: { ...dataset, snapshotSha: dataset.snapshotSha, splitSha: dataset.splitSha },
    sample,
    runs,
    unreadable,
  };
}

export async function loadReportModel(db: Executor, loaded: LoadedDataset): Promise<ReportModel> {
  const model = buildReportModel({
    datasetVersion: loaded.dataset.version,
    runs: loaded.runs,
    sample: loaded.sample,
  });
  const raterIds = (model.reference?.config.raters ?? []).map((r) => r.raterId);
  model.assignmentCounts = await assignmentStatusCounts(db, raterIds);
  return model;
}
