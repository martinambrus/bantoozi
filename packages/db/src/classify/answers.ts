import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';
import { enginePrecedenceSql, precedenceOperator, type AnswerWriteOptions } from './facets.js';

/** One `card_answers` row: the current cached Call B answer of a card (spec 02 §3.1). */
export interface CardAnswerRow {
  articleId: string;
  cardId: string;
  p: number;
  engine: 'typesafe' | 'llm' | 'laya' | 'prefilter';
  model: string | null;
  questionSetSha: string;
  articleRevision: string;
  stateSha256: string;
  cardInputSha256: string;
  stateVariant: 'native' | 'translated';
  answeredAt: Date;
}

export type CardAnswerInput = Omit<CardAnswerRow, 'answeredAt'>;

/** The article's stored card answers (all, or only `cardIds`), whatever their fingerprints. */
export async function readCardAnswers(
  db: Executor,
  articleId: string,
  cardIds?: readonly string[],
): Promise<CardAnswerRow[]> {
  const filter =
    cardIds === undefined ? sql`` : sql`AND card_id = ANY(${sql.param([...cardIds])}::bigint[])`;
  const result = await db.execute<{
    article_id: string;
    card_id: string;
    p: number;
    engine: CardAnswerRow['engine'];
    model: string | null;
    question_set_sha: string;
    article_revision: string;
    state_sha256: string;
    card_input_sha256: string;
    state_variant: 'native' | 'translated';
    answered_at: RawTimestamp;
  }>(sql`
    SELECT article_id::text AS article_id, card_id::text AS card_id, p, engine, model,
           question_set_sha, article_revision::text AS article_revision, state_sha256,
           card_input_sha256, state_variant, answered_at
      FROM card_answers WHERE article_id = ${articleId}::bigint ${filter}
     ORDER BY card_id`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    cardId: row.card_id,
    p: row.p,
    engine: row.engine,
    model: row.model,
    questionSetSha: row.question_set_sha,
    articleRevision: row.article_revision,
    stateSha256: row.state_sha256,
    cardInputSha256: row.card_input_sha256,
    stateVariant: row.state_variant,
    answeredAt: toDate(row.answered_at),
  }));
}

/**
 * Upsert card answers with full provenance (spec 05 §5.5 step 6); the caller has locked the article
 * and checked the revision. `answered_at` is set on every insert and update. A stored answer is kept
 * when it belongs to a newer revision, or when it answers the identical input (revision, set,
 * state and built question) from a higher-precedence engine ({@link enginePrecedence}): a current
 * primary answer is never overwritten by an LLM or prefilter result for the same input, while a
 * different input is always replaced. In `fill` mode an equal-precedence answer of the same input is
 * kept ({@link AnswerWriteOptions}).
 * Returns the ids of the cards whose rows were written.
 */
export async function writeCardAnswers(
  tx: Transaction,
  rows: readonly CardAnswerInput[],
  options: AnswerWriteOptions,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const payload = JSON.stringify(
    rows.map((row) => ({
      article_id: row.articleId,
      card_id: row.cardId,
      p: row.p,
      engine: row.engine,
      model: row.model,
      question_set_sha: row.questionSetSha,
      article_revision: row.articleRevision,
      state_sha256: row.stateSha256,
      card_input_sha256: row.cardInputSha256,
      state_variant: row.stateVariant,
    })),
  );
  const result = await tx.execute<{ card_id: string }>(sql`
    INSERT INTO card_answers AS c
           (article_id, card_id, p, engine, model, question_set_sha, article_revision, state_sha256,
            card_input_sha256, state_variant, answered_at)
    SELECT r.article_id, r.card_id, r.p, r.engine, r.model, r.question_set_sha, r.article_revision,
           r.state_sha256, r.card_input_sha256, r.state_variant, now()
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(
             article_id bigint, card_id bigint, p real, engine text, model text,
             question_set_sha text, article_revision bigint, state_sha256 text,
             card_input_sha256 text, state_variant text)
    ON CONFLICT (article_id, card_id) DO UPDATE SET
      p = EXCLUDED.p, engine = EXCLUDED.engine, model = EXCLUDED.model,
      question_set_sha = EXCLUDED.question_set_sha, article_revision = EXCLUDED.article_revision,
      state_sha256 = EXCLUDED.state_sha256, card_input_sha256 = EXCLUDED.card_input_sha256,
      state_variant = EXCLUDED.state_variant, answered_at = now()
    WHERE c.article_revision < EXCLUDED.article_revision
       OR (c.article_revision = EXCLUDED.article_revision
           AND (c.question_set_sha <> EXCLUDED.question_set_sha
                OR c.state_sha256 <> EXCLUDED.state_sha256
                OR c.card_input_sha256 <> EXCLUDED.card_input_sha256
                OR ${enginePrecedenceSql(sql`c.engine`, sql`c.model`, options.primaryModel)}
                   ${precedenceOperator(options)}
                   ${enginePrecedenceSql(sql`EXCLUDED.engine`, sql`EXCLUDED.model`, options.primaryModel)}))
    RETURNING card_id::text AS card_id`);
  return result.rows.map((row) => row.card_id);
}

/** One `article_topics_l2` row: the current level-2 answer of one L1 branch (spec 05 §4). */
export interface L2AnswerRow {
  articleId: string;
  l1Id: string;
  articleRevision: string;
  questionSetSha: string;
  stateSha256: string;
  engine: string;
  model: string | null;
  stateVariant: 'native' | 'translated';
  answer: Record<string, unknown>;
  createdAt: Date;
}

export type L2AnswerInput = Omit<L2AnswerRow, 'createdAt'>;

/** The article's stored level-2 answers, whatever their fingerprints (callers compare). */
export async function readL2Answers(db: Executor, articleId: string): Promise<L2AnswerRow[]> {
  const result = await db.execute<{
    article_id: string;
    l1_id: string;
    article_revision: string;
    question_set_sha: string;
    state_sha256: string;
    engine: string;
    model: string | null;
    state_variant: 'native' | 'translated';
    answer: Record<string, unknown>;
    created_at: RawTimestamp;
  }>(sql`
    SELECT article_id::text AS article_id, l1_id, article_revision::text AS article_revision,
           question_set_sha, state_sha256, engine, model, state_variant, answer, created_at
      FROM article_topics_l2 WHERE article_id = ${articleId}::bigint ORDER BY l1_id`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    l1Id: row.l1_id,
    articleRevision: row.article_revision,
    questionSetSha: row.question_set_sha,
    stateSha256: row.state_sha256,
    engine: row.engine,
    model: row.model,
    stateVariant: row.state_variant,
    answer: row.answer,
    createdAt: toDate(row.created_at),
  }));
}

/** Upsert level-2 answers under the same precedence rules (and `fill` mode) as card answers. */
export async function writeL2Answers(
  tx: Transaction,
  rows: readonly L2AnswerInput[],
  options: AnswerWriteOptions,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const payload = JSON.stringify(
    rows.map((row) => ({
      article_id: row.articleId,
      l1_id: row.l1Id,
      article_revision: row.articleRevision,
      question_set_sha: row.questionSetSha,
      state_sha256: row.stateSha256,
      engine: row.engine,
      model: row.model,
      state_variant: row.stateVariant,
      answer: row.answer,
    })),
  );
  const result = await tx.execute<{ l1_id: string }>(sql`
    INSERT INTO article_topics_l2 AS t
           (article_id, l1_id, article_revision, question_set_sha, state_sha256, engine, model,
            state_variant, answer, created_at)
    SELECT r.article_id, r.l1_id, r.article_revision, r.question_set_sha, r.state_sha256, r.engine,
           r.model, r.state_variant, r.answer, now()
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(
             article_id bigint, l1_id text, article_revision bigint, question_set_sha text,
             state_sha256 text, engine text, model text, state_variant text, answer jsonb)
    ON CONFLICT (article_id, l1_id) DO UPDATE SET
      article_revision = EXCLUDED.article_revision, question_set_sha = EXCLUDED.question_set_sha,
      state_sha256 = EXCLUDED.state_sha256, engine = EXCLUDED.engine, model = EXCLUDED.model,
      state_variant = EXCLUDED.state_variant, answer = EXCLUDED.answer, created_at = now()
    WHERE t.article_revision < EXCLUDED.article_revision
       OR (t.article_revision = EXCLUDED.article_revision
           AND (t.question_set_sha <> EXCLUDED.question_set_sha
                OR t.state_sha256 <> EXCLUDED.state_sha256
                OR ${enginePrecedenceSql(sql`t.engine`, sql`t.model`, options.primaryModel)}
                   ${precedenceOperator(options)}
                   ${enginePrecedenceSql(sql`EXCLUDED.engine`, sql`EXCLUDED.model`, options.primaryModel)}))
    RETURNING l1_id`);
  return result.rows.map((row) => row.l1_id);
}
