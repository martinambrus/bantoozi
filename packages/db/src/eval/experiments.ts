import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

/**
 * Experiment runner reads (M3a-T6, spec 10 §3): the rater data a run snapshots into its immutable
 * `eval.runs.config` before its first model call (raters, their cards with the exact card text,
 * assignments, ratings and facet labels of one dataset version), the base runs E6/E7 and replays
 * build on, and the billed spend of a run's own engine calls. The rating app (M3a-T3/T4) writes
 * these tables concurrently; a run reads them once and never again, so later corrections never
 * change its ground truth (spec 10 §2.1).
 */

export interface EvalRaterRecord {
  raterId: string;
  name: string;
  /** The actual participant (spec 10 §2.2): one human may own several reading contexts. */
  participantKey: string;
  contextName: string | null;
  langs: string[];
}

/** A rater's card with its exact text at read time (`interest_cards.body`). */
export interface EvalRaterCardRecord {
  raterId: string;
  cardId: string;
  strength: 'must' | 'love' | 'like' | 'never';
  kind: 'interest' | 'label';
  title: string;
  /** `interest_cards.lang`: the language `interest` is written in. */
  lang: string;
  visibility: 'public' | 'shared' | 'private';
  ownerUserId: string | null;
  body: Record<string, unknown>;
}

export interface EvalAssignmentRecord {
  raterId: string;
  articleId: string;
  position: number;
  status: 'pending' | 'rated' | 'skipped';
}

export interface EvalRatingRecord {
  raterId: string;
  articleId: string;
  rating: 1 | -1;
  reason: string | null;
  createdAt: Date;
}

export interface EvalFacetLabelRecord {
  labeler: string;
  articleId: string;
  questionKey: string;
  value: string;
}

const raterFilter = (raterIds: readonly string[] | undefined, column = sql`r.id`) =>
  raterIds === undefined ? sql`` : sql` AND ${column} = ANY(${sql.param([...raterIds])}::bigint[])`;

/** Raters (all, or the given ids), ordered by id. */
export async function loadEvalRaters(
  db: Executor,
  raterIds?: readonly string[],
): Promise<EvalRaterRecord[]> {
  const result = await db.execute<{
    id: string;
    name: string;
    participant_key: string;
    context_name: string | null;
    langs: string[];
  }>(sql`
    SELECT r.id::text AS id, r.name, r.participant_key::text AS participant_key, r.context_name,
           r.langs
      FROM eval.raters r WHERE true${raterFilter(raterIds)}
     ORDER BY r.id`);
  return result.rows.map((row) => ({
    raterId: row.id,
    name: row.name,
    participantKey: row.participant_key,
    contextName: row.context_name,
    langs: [...row.langs],
  }));
}

/** The cards of the given raters with their exact stored text, ordered by rater and card id. */
export async function loadEvalRaterCards(
  db: Executor,
  raterIds: readonly string[],
): Promise<EvalRaterCardRecord[]> {
  if (raterIds.length === 0) return [];
  const result = await db.execute<{
    rater_id: string;
    card_id: string;
    strength: EvalRaterCardRecord['strength'];
    kind: EvalRaterCardRecord['kind'];
    title: string;
    lang: string;
    visibility: EvalRaterCardRecord['visibility'];
    owner_user_id: string | null;
    body: Record<string, unknown>;
  }>(sql`
    SELECT rc.rater_id::text AS rater_id, rc.card_id::text AS card_id, rc.strength, c.kind,
           c.title, c.lang, c.visibility, c.owner_user_id::text AS owner_user_id, c.body
      FROM eval.rater_cards rc JOIN interest_cards c ON c.id = rc.card_id
     WHERE rc.rater_id = ANY(${sql.param([...raterIds])}::bigint[])
     ORDER BY rc.rater_id, rc.card_id`);
  return result.rows.map((row) => ({
    raterId: row.rater_id,
    cardId: row.card_id,
    strength: row.strength,
    kind: row.kind,
    title: row.title,
    lang: row.lang,
    visibility: row.visibility,
    ownerUserId: row.owner_user_id,
    body: row.body,
  }));
}

/** Assignments of the given raters whose article belongs to the dataset version. */
export async function loadEvalAssignments(
  db: Executor,
  version: string,
  raterIds: readonly string[],
): Promise<EvalAssignmentRecord[]> {
  if (raterIds.length === 0) return [];
  const result = await db.execute<{
    rater_id: string;
    article_id: string;
    position: number;
    status: EvalAssignmentRecord['status'];
  }>(sql`
    SELECT a.rater_id::text AS rater_id, a.article_id::text AS article_id, a.position, a.status
      FROM eval.assignments a
      JOIN eval.sample s ON s.article_id = a.article_id AND s.dataset_version = ${version}
     WHERE a.rater_id = ANY(${sql.param([...raterIds])}::bigint[])
     ORDER BY a.rater_id, a.position`);
  return result.rows.map((row) => ({
    raterId: row.rater_id,
    articleId: row.article_id,
    position: row.position,
    status: row.status,
  }));
}

/**
 * Ratings of the given raters on articles of the dataset version, in rating order (then rater and
 * article id). A skipped assignment has no rating row and never becomes a dislike.
 */
export async function loadEvalRatings(
  db: Executor,
  version: string,
  raterIds: readonly string[],
): Promise<EvalRatingRecord[]> {
  if (raterIds.length === 0) return [];
  const result = await db.execute<{
    rater_id: string;
    article_id: string;
    rating: number;
    reason: string | null;
    created_at: RawTimestamp;
  }>(sql`
    SELECT r.rater_id::text AS rater_id, r.article_id::text AS article_id, r.rating, r.reason,
           r.created_at
      FROM eval.ratings r
      JOIN eval.sample s ON s.article_id = r.article_id AND s.dataset_version = ${version}
     WHERE r.rater_id = ANY(${sql.param([...raterIds])}::bigint[])
     ORDER BY r.created_at, r.rater_id, r.article_id`);
  return result.rows.map((row) => ({
    raterId: row.rater_id,
    articleId: row.article_id,
    rating: row.rating === 1 ? 1 : -1,
    reason: row.reason,
    createdAt: toDate(row.created_at),
  }));
}

/** Facet labels of articles in the dataset version (every labeller), ordered by article and key. */
export async function loadEvalFacetLabels(
  db: Executor,
  version: string,
): Promise<EvalFacetLabelRecord[]> {
  const result = await db.execute<{
    labeler: string;
    article_id: string;
    question_key: string;
    value: string;
  }>(sql`
    SELECT f.labeler, f.article_id::text AS article_id, f.question_key, f.value
      FROM eval.facet_labels f
      JOIN eval.sample s ON s.article_id = f.article_id AND s.dataset_version = ${version}
     ORDER BY f.article_id, f.question_key, f.labeler`);
  return result.rows.map((row) => ({
    labeler: row.labeler,
    articleId: row.article_id,
    questionKey: row.question_key,
    value: row.value,
  }));
}

/**
 * The newest finished run of an experiment on a dataset version whose `results.status` is one of
 * `statuses` (E6/E7 build on the E1 run; spec 10 §3), or null.
 */
export async function latestFinishedRunId(
  db: Executor,
  filter: { datasetVersion: string; experiment: string; statuses: readonly string[] },
): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM eval.runs
     WHERE dataset_version = ${filter.datasetVersion} AND experiment = ${filter.experiment}
       AND finished_at IS NOT NULL
       AND results->>'status' = ANY(${sql.param([...filter.statuses])}::text[])
     ORDER BY id DESC LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/** The recorded spend of a run's own logical requests (engine and external calls). */
export interface RunCallSpend {
  /** Every attempt's recorded cost, failed ones included. */
  billedUsd: number;
  /** The cost recorded on attempts that did not succeed (spec 10 §3 "failed-call charges"). */
  failedCallUsd: number;
  /** Attempts whose billing is still uncertain (charged at their reserve until reconciled). */
  uncertainCalls: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/**
 * Sum `engine_calls` of the given logical request ids (UUIDs the runner assigned to its own engine
 * and translation requests), so concurrent eval invocations never mix their costs.
 */
export async function runCallSpend(
  db: Executor,
  logicalRequestIds: readonly string[],
): Promise<RunCallSpend> {
  const empty: RunCallSpend = {
    billedUsd: 0,
    failedCallUsd: 0,
    uncertainCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
  };
  if (logicalRequestIds.length === 0) return empty;
  const result = await db.execute<{
    billed: string | null;
    failed: string | null;
    uncertain: string;
    input_tokens: string | null;
    output_tokens: string | null;
    calls: string;
  }>(sql`
    SELECT sum(cost_usd)::text AS billed,
           sum(cost_usd) FILTER (WHERE status <> 'ok')::text AS failed,
           count(*) FILTER (WHERE billing = 'uncertain')::text AS uncertain,
           sum(input_tokens)::text AS input_tokens, sum(output_tokens)::text AS output_tokens,
           count(*)::text AS calls
      FROM engine_calls
     WHERE logical_request_id = ANY(${sql.param([...logicalRequestIds])}::uuid[])`);
  const row = result.rows[0];
  if (row === undefined) return empty;
  return {
    billedUsd: Number(row.billed ?? 0),
    failedCallUsd: Number(row.failed ?? 0),
    uncertainCalls: Number(row.uncertain),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    calls: Number(row.calls),
  };
}
