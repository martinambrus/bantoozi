import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/** One `topics` row as the seed writes it (spec 02 §3.1, spec 05 §3.2). */
export interface TopicSeedRow {
  id: string;
  parentId: string | null;
  level: 1 | 2;
  nameEn: string;
  nameSk: string;
  description: string;
  sort: number;
}

export interface TopicSeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/** Why a taxonomy cannot be seeded (empty when it can): every level-2 topic needs a level-1 parent. */
export function topicSeedProblems(rows: readonly TopicSeedRow[]): string[] {
  const problems: string[] = [];
  const levelOne = new Set(rows.filter((row) => row.level === 1).map((row) => row.id));
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) problems.push(`duplicate topic ${row.id}`);
    ids.add(row.id);
    if (row.level === 1 && row.parentId !== null) problems.push(`${row.id}: level 1 has a parent`);
    if (row.level === 2 && (row.parentId === null || !levelOne.has(row.parentId))) {
      problems.push(`${row.id}: parent ${String(row.parentId)} is not a level-1 topic`);
    }
  }
  return problems;
}

/**
 * Upsert the taxonomy (spec 05 §3.2) in one statement, so parents and children land together (the
 * `topics_parent_check` trigger checks every level-2 parent at the end of the statement). Existing
 * rows get the current names, description, level, parent and sort; unchanged rows are not touched.
 * Topics missing from `rows` are kept: features and cards keep referring to them by id.
 */
export async function seedTopics(
  tx: Transaction,
  rows: readonly TopicSeedRow[],
): Promise<TopicSeedResult> {
  const problems = topicSeedProblems(rows);
  if (problems.length > 0) throw new Error(`invalid taxonomy: ${problems.join('; ')}`);
  if (rows.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  const result = await tx.execute<{ inserted: boolean }>(sql`
    INSERT INTO topics AS t (id, parent_id, level, name_en, name_sk, description, sort)
    SELECT r.id, r.parent_id, r.level, r.name_en, r.name_sk, r.description, r.sort
      FROM jsonb_to_recordset(${JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          parent_id: row.parentId,
          level: row.level,
          name_en: row.nameEn,
          name_sk: row.nameSk,
          description: row.description,
          sort: row.sort,
        })),
      )}::jsonb) AS r(id text, parent_id text, level smallint, name_en text, name_sk text,
                      description text, sort int)
    ON CONFLICT (id) DO UPDATE SET
      parent_id = EXCLUDED.parent_id, level = EXCLUDED.level, name_en = EXCLUDED.name_en,
      name_sk = EXCLUDED.name_sk, description = EXCLUDED.description, sort = EXCLUDED.sort
    WHERE (t.parent_id, t.level, t.name_en, t.name_sk, t.description, t.sort)
          IS DISTINCT FROM (EXCLUDED.parent_id, EXCLUDED.level, EXCLUDED.name_en,
                            EXCLUDED.name_sk, EXCLUDED.description, EXCLUDED.sort)
    RETURNING (xmax = 0) AS inserted`);
  const inserted = result.rows.filter((row) => row.inserted).length;
  const updated = result.rows.length - inserted;
  return { inserted, updated, unchanged: rows.length - inserted - updated };
}
