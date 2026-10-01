import { sql } from 'drizzle-orm';
import pg from 'pg';

import type { Executor } from '../client.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Experiment runs (spec 10 §3, spec 02 §7). A run reads one frozen dataset version; its `config`
 * (immutable once inserted) records the dataset/split/config hashes, the engine and the exact
 * ratings, cards and facet labels it used, so later corrections never change its ground truth. Its
 * answers are keyed by run, article, card and question (NULL card ids are equal), so a resumed run
 * upserts instead of duplicating.
 *
 * Answer key conventions (written by the runner, read by the report):
 * - `enrich.<key>` (card NULL): one Call A answer of `enrich-v1`;
 * - `card` (card set): the card's Call B answer;
 * - `score.r<raterId>` (card NULL): the zero-training score of the article for that rater;
 * - other experiment-specific keys (E6/E7 variants) documented by their experiment.
 */

export interface RunRow {
  id: string;
  experiment: string;
  datasetVersion: string;
  config: Record<string, unknown>;
  gitSha: string;
  startedAt: Date;
  finishedAt: Date | null;
  results: Record<string, unknown> | null;
}

export interface RunAnswerInput {
  articleId: string;
  cardId: string | null;
  questionKey: string;
  answer: Record<string, unknown>;
}

export interface RunAnswerRow extends RunAnswerInput {
  runId: string;
}

type RunDbRow = {
  id: string;
  experiment: string;
  dataset_version: string;
  config: Record<string, unknown>;
  git_sha: string;
  started_at: RawTimestamp;
  finished_at: RawTimestamp | null;
  results: Record<string, unknown> | null;
};

const RUN_COLUMNS = sql`id::text AS id, experiment, dataset_version, config, git_sha, started_at,
  finished_at, results`;

const toRun = (row: RunDbRow): RunRow => ({
  id: row.id,
  experiment: row.experiment,
  datasetVersion: row.dataset_version,
  config: row.config,
  gitSha: row.git_sha,
  startedAt: toDate(row.started_at),
  finishedAt: toDateOrNull(row.finished_at),
  results: row.results,
});

export async function createRun(
  db: Executor,
  input: {
    experiment: string;
    datasetVersion: string;
    config: Record<string, unknown>;
    gitSha: string;
  },
): Promise<RunRow> {
  const result = await db.execute<RunDbRow>(sql`
    INSERT INTO eval.runs (experiment, dataset_version, config, git_sha)
    VALUES (${input.experiment}, ${input.datasetVersion}, ${JSON.stringify(input.config)}::jsonb,
            ${input.gitSha})
    RETURNING ${RUN_COLUMNS}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('run insert returned no row');
  return toRun(row);
}

export async function getRun(db: Executor, runId: string): Promise<RunRow | null> {
  const result = await db.execute<RunDbRow>(
    sql`SELECT ${RUN_COLUMNS} FROM eval.runs WHERE id = ${runId}::bigint`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toRun(row);
}

export async function listRuns(
  db: Executor,
  filter: { datasetVersion?: string; experiment?: string } = {},
): Promise<RunRow[]> {
  const version =
    filter.datasetVersion === undefined
      ? sql``
      : sql` AND dataset_version = ${filter.datasetVersion}`;
  const experiment =
    filter.experiment === undefined ? sql`` : sql` AND experiment = ${filter.experiment}`;
  const result = await db.execute<RunDbRow>(
    sql`SELECT ${RUN_COLUMNS} FROM eval.runs WHERE true${version}${experiment} ORDER BY id`,
  );
  return result.rows.map(toRun);
}

/** Upsert answers (a resumed or retried run replaces, never duplicates). */
export async function upsertRunAnswers(
  db: Executor,
  runId: string,
  answers: readonly RunAnswerInput[],
): Promise<void> {
  for (let i = 0; i < answers.length; i += 500) {
    const chunk = answers.slice(i, i + 500);
    await db.execute(sql`
      INSERT INTO eval.run_answers (run_id, article_id, card_id, question_key, answer)
      SELECT ${runId}::bigint, r.article_id, r.card_id, r.question_key, r.answer
        FROM jsonb_to_recordset(${JSON.stringify(
          chunk.map((a) => ({
            article_id: a.articleId,
            card_id: a.cardId,
            question_key: a.questionKey,
            answer: a.answer,
          })),
        )}::jsonb) AS r(article_id bigint, card_id bigint, question_key text, answer jsonb)
      ON CONFLICT (run_id, article_id, card_id, question_key)
      DO UPDATE SET answer = EXCLUDED.answer`);
  }
}

/** A run's answers, optionally narrowed to question keys (exact) or a key prefix. */
export async function loadRunAnswers(
  db: Executor,
  runId: string,
  filter: { questionKeys?: readonly string[]; keyPrefix?: string } = {},
): Promise<RunAnswerRow[]> {
  const keys =
    filter.questionKeys === undefined
      ? sql``
      : sql` AND question_key = ANY(${sql.param([...filter.questionKeys])}::text[])`;
  const prefix =
    filter.keyPrefix === undefined
      ? sql``
      : sql` AND starts_with(question_key, ${filter.keyPrefix})`;
  const result = await db.execute<{
    run_id: string;
    article_id: string;
    card_id: string | null;
    question_key: string;
    answer: Record<string, unknown>;
  }>(sql`
    SELECT run_id::text AS run_id, article_id::text AS article_id, card_id::text AS card_id,
           question_key, answer
      FROM eval.run_answers WHERE run_id = ${runId}::bigint${keys}${prefix}
     ORDER BY article_id, card_id NULLS FIRST, question_key`);
  return result.rows.map((row) => ({
    runId: row.run_id,
    articleId: row.article_id,
    cardId: row.card_id,
    questionKey: row.question_key,
    answer: row.answer,
  }));
}

/** Record a run's completion (status, coverage, costs …); the config stays as it was. */
export async function finishRun(
  db: Executor,
  runId: string,
  results: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    UPDATE eval.runs SET finished_at = now(), results = ${JSON.stringify(results)}::jsonb
     WHERE id = ${runId}::bigint`);
}

/** Record progress of a run still in flight (resume bookkeeping), without finishing it. */
export async function updateRunResults(
  db: Executor,
  runId: string,
  results: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    UPDATE eval.runs SET results = ${JSON.stringify(results)}::jsonb WHERE id = ${runId}::bigint`);
}

/** The id of a run built on `runId` (E6/E7 record their base in `config.baseRunId`), if any. */
export async function findDerivedRunId(db: Executor, runId: string): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM eval.runs
     WHERE config->>'baseRunId' = ${runId}
     ORDER BY id LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/** A session advisory lock on one run, held by a dedicated connection until released. */
export interface RunLock {
  release(): Promise<void>;
}

/**
 * Claim a run for one `eval run` invocation (its creation or a `--resume`): a session advisory lock
 * on its own connection, so two invocations never execute the same run at once, and a crashed one
 * frees the run when its connection drops (no stale claim to clear). Null when another invocation
 * holds it. The connection is separate from the runtime pool, so holding it never starves the run.
 * A run built on it (E6/E7 on an E1 run) holds the `shared` mode for its whole invocation, so the
 * base cannot be resumed (and gain answers) while its answers are read; derived runs share it.
 */
export async function tryLockRun(
  connectionString: string,
  runId: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<RunLock | null> {
  const client = new pg.Client({ connectionString, application_name: 'bantoozi-eval-run-lock' });
  // A dropped connection releases the lock server-side; the error must not crash the process.
  client.on('error', () => undefined);
  await client.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      mode === 'shared'
        ? "SELECT pg_try_advisory_lock_shared(hashtext('eval.run'), hashtext($1::bigint::text)) AS locked"
        : "SELECT pg_try_advisory_lock(hashtext('eval.run'), hashtext($1::bigint::text)) AS locked",
      [runId],
    );
    locked = result.rows[0]?.locked === true;
  } finally {
    if (!locked) await client.end().catch(() => undefined);
  }
  if (!locked) return null;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await client.end().catch(() => undefined);
    },
  };
}
