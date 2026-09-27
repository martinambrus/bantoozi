import { sql, type SQL } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

/**
 * Whether a stored answer is the approved primary result (spec 05 §5.5 step 2, §10): Jev at the
 * pinned `TYPESAFE_MODEL`. An answer of an older Jev model is no longer primary: it neither
 * satisfies a cache lookup nor outranks a current fallback answer. Laya is not interchangeable with
 * Jev (spec 05 §10): until M9 adds its per-kind precedence policy (spec 04 §9) it ranks lowest.
 */
export function isPrimaryAnswer(
  answer: { engine: string; model: string | null },
  primaryModel: string,
): boolean {
  return answer.engine === 'typesafe' && answer.model === primaryModel;
}

/**
 * Precedence for identical inputs: the current primary answer (2) outranks the LLM fallback (1),
 * which outranks prefilter markers, Laya and answers of a superseded primary model (0).
 */
export function enginePrecedence(
  answer: { engine: string; model: string | null },
  primaryModel: string,
): number {
  if (isPrimaryAnswer(answer, primaryModel)) return 2;
  return answer.engine === 'llm' ? 1 : 0;
}

/** One `article_facets` row: Call A answers of one enrich set (spec 02 §3.1). */
export interface FacetRow {
  articleId: string;
  questionSetId: string;
  articleRevision: string;
  stateSha256: string;
  engine: string;
  model: string | null;
  stateVariant: 'native' | 'translated';
  answers: Record<string, unknown>;
  features: Record<string, number>;
  updatedAt: Date;
}

/**
 * The stored facets of `(articleId, questionSetId)`, whatever their revision (callers compare).
 * `lock` takes the row `FOR UPDATE`, so its answers cannot change until the transaction ends.
 */
export async function readFacets(
  db: Executor,
  articleId: string,
  questionSetId: string,
  options: { lock?: boolean } = {},
): Promise<FacetRow | null> {
  const result = await db.execute<{
    article_id: string;
    question_set_id: string;
    article_revision: string;
    state_sha256: string;
    engine: string;
    model: string | null;
    state_variant: 'native' | 'translated';
    answers: Record<string, unknown>;
    features: Record<string, number>;
    updated_at: RawTimestamp;
  }>(sql`
    SELECT article_id::text AS article_id, question_set_id::text AS question_set_id,
           article_revision::text AS article_revision, state_sha256, engine, model, state_variant,
           answers, features, updated_at
      FROM article_facets
     WHERE article_id = ${articleId}::bigint AND question_set_id = ${questionSetId}::bigint
     ${options.lock === true ? sql`FOR UPDATE` : sql``}`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        articleId: row.article_id,
        questionSetId: row.question_set_id,
        articleRevision: row.article_revision,
        stateSha256: row.state_sha256,
        engine: row.engine,
        model: row.model,
        stateVariant: row.state_variant,
        answers: row.answers,
        features: row.features,
        updatedAt: toDate(row.updated_at),
      };
}

export type FacetInput = Omit<FacetRow, 'updatedAt'>;

/** How a cache write treats a stored answer of the identical input (facets, card and L2 answers). */
export interface AnswerWriteOptions {
  primaryModel: string;
  /**
   * `replace` (default, the live article workers): an answer of equal or higher precedence replaces
   * the stored one. `fill` (a selected request's frozen result, spec 03 §2.2): only entries still
   * missing, incompatible or of strictly lower precedence are written, so a newer compatible answer
   * of the same precedence is never overwritten.
   */
  mode?: 'replace' | 'fill';
}

/** The precedence comparison `stored <op> incoming` of a write in `options.mode`. */
export function precedenceOperator(options: AnswerWriteOptions): SQL {
  return sql.raw(options.mode === 'fill' ? '<' : '<=');
}

/**
 * Write Call A answers (spec 05 §5.5 step 6, §10). The caller has locked the article and checked
 * that `articleRevision` is current. A stored row is replaced unless it belongs to a newer
 * revision, or it answers the same input (revision and state) from a higher-precedence engine
 * ({@link enginePrecedence}): an LLM fallback never overwrites a current primary answer for the
 * same input, while an old primary answer for a different input or of a superseded model never
 * blocks a new current fallback. In `fill` mode an equal-precedence answer of the same input is kept
 * ({@link AnswerWriteOptions}). Returns whether the row was written.
 */
export async function writeFacets(
  tx: Transaction,
  row: FacetInput,
  options: AnswerWriteOptions,
): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO article_facets AS f
           (article_id, question_set_id, article_revision, state_sha256, engine, model,
            state_variant, answers, features, created_at, updated_at)
    VALUES (${row.articleId}::bigint, ${row.questionSetId}::bigint, ${row.articleRevision}::bigint,
            ${row.stateSha256}, ${row.engine}, ${row.model}, ${row.stateVariant},
            ${JSON.stringify(row.answers)}::jsonb, ${JSON.stringify(row.features)}::jsonb, now(),
            now())
    ON CONFLICT (article_id, question_set_id) DO UPDATE SET
      article_revision = EXCLUDED.article_revision, state_sha256 = EXCLUDED.state_sha256,
      engine = EXCLUDED.engine, model = EXCLUDED.model, state_variant = EXCLUDED.state_variant,
      answers = EXCLUDED.answers, features = EXCLUDED.features, updated_at = now()
    WHERE f.article_revision < EXCLUDED.article_revision
       OR (f.article_revision = EXCLUDED.article_revision
           AND (f.state_sha256 <> EXCLUDED.state_sha256
                OR ${enginePrecedenceSql(sql`f.engine`, sql`f.model`, options.primaryModel)}
                   ${precedenceOperator(options)} ${enginePrecedence(row, options.primaryModel)}))`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Replace the flattened features of the current facets (spec 05 §3.4: recomputed when L2 answers
 * arrive), only while the row still holds exactly the answers they were built from: the same
 * revision, state, engine, model and answers. Callers read that row with `lock` in the same
 * transaction, so a concurrent replacement of the answers waits instead of being overwritten.
 */
export async function updateFacetFeatures(
  tx: Transaction,
  input: Pick<
    FacetRow,
    | 'articleId'
    | 'questionSetId'
    | 'articleRevision'
    | 'stateSha256'
    | 'engine'
    | 'model'
    | 'answers'
  > & { features: Record<string, number> },
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE article_facets SET features = ${JSON.stringify(input.features)}::jsonb, updated_at = now()
     WHERE article_id = ${input.articleId}::bigint
       AND question_set_id = ${input.questionSetId}::bigint
       AND article_revision = ${input.articleRevision}::bigint
       AND state_sha256 = ${input.stateSha256}
       AND engine = ${input.engine}
       AND model IS NOT DISTINCT FROM ${input.model}::text
       AND answers = ${JSON.stringify(input.answers)}::jsonb
       AND features IS DISTINCT FROM ${JSON.stringify(input.features)}::jsonb`);
  return (result.rowCount ?? 0) > 0;
}

/** SQL form of {@link enginePrecedence} over engine and model columns. */
export function enginePrecedenceSql(engine: SQL, model: SQL, primaryModel: string): SQL {
  return sql`(CASE WHEN ${engine} = 'typesafe' AND ${model} IS NOT DISTINCT FROM ${primaryModel}::text
                   THEN 2 WHEN ${engine} = 'llm' THEN 1 ELSE 0 END)`;
}
