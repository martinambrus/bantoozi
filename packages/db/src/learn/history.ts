import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

export const LEARNING_HISTORY_KEEP = 200;

export type LearningHistoryKind = 'model' | 'estimate';

export interface NewLearningHistoryRow {
  userId: string;
  kind: LearningHistoryKind;
  n: number;
  auc: number | null;
  baselineAuc?: number | null;
  activated?: boolean;
  turnedOn?: boolean;
  engineModel?: string | null;
  reason?: string | null;
  at?: Date;
}

export interface LearningHistoryRow {
  at: Date;
  kind: LearningHistoryKind;
  n: number;
  auc: number | null;
  baselineAuc: number | null;
  activated: boolean | null;
  turnedOn: boolean | null;
  engineModel: string | null;
  reason: string | null;
}

const finiteOrNull = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Append one learning milestone and keep the newest {@link LEARNING_HISTORY_KEEP} rows of that kind. */
export async function appendLearningHistory(
  tx: Transaction,
  row: NewLearningHistoryRow,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO user_learning_history
      (user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model, reason)
    VALUES (${row.userId}::uuid, COALESCE(${row.at ?? null}::timestamptz, now()), ${row.kind},
            ${row.n}, ${finiteOrNull(row.auc)}, ${finiteOrNull(row.baselineAuc)},
            ${row.activated ?? false}, ${row.turnedOn ?? false}, ${row.engineModel ?? null}, ${row.reason ?? null})`);
  await tx.execute(sql`
    DELETE FROM user_learning_history
     WHERE user_id = ${row.userId}::uuid AND kind = ${row.kind}
       AND id IN (SELECT id FROM user_learning_history
                   WHERE user_id = ${row.userId}::uuid AND kind = ${row.kind}
                   ORDER BY at DESC, id DESC OFFSET ${LEARNING_HISTORY_KEEP})`);
}

/** The user's learning history, oldest first; `truncated` marks kinds at the cap. */
export async function loadLearningHistory(
  db: Executor,
  userId: string,
): Promise<{ rows: LearningHistoryRow[]; truncated: { model: boolean; estimate: boolean } }> {
  const result = await db.execute<{
    at: RawTimestamp;
    kind: LearningHistoryKind;
    n: number;
    auc: number | null;
    baseline_auc: number | null;
    activated: boolean | null;
    turned_on: boolean | null;
    engine_model: string | null;
    reason: string | null;
  }>(sql`
    SELECT at, kind, n, auc, baseline_auc, activated, turned_on, engine_model, reason
      FROM user_learning_history
     WHERE user_id = ${userId}::uuid
     ORDER BY at ASC, id ASC`);
  const rows = result.rows.map((r) => ({
    at: toDate(r.at),
    kind: r.kind,
    n: Number(r.n),
    auc: r.auc === null ? null : Number(r.auc),
    baselineAuc: r.baseline_auc === null ? null : Number(r.baseline_auc),
    activated: r.activated,
    turnedOn: r.turned_on,
    engineModel: r.engine_model,
    reason: r.reason,
  }));
  const count = (kind: LearningHistoryKind) => rows.filter((r) => r.kind === kind).length;
  return {
    rows,
    truncated: {
      model: count('model') >= LEARNING_HISTORY_KEEP,
      estimate: count('estimate') >= LEARNING_HISTORY_KEEP,
    },
  };
}
