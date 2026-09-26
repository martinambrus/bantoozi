import { parseSetting } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { readStoredSetting } from '../settings.js';

/** Question-set kinds (spec 02 §3.1). */
export type QuestionSetKind = 'enrich' | 'match' | 'cluster' | 'suggest';

/** One immutable `question_sets` row (spec 05 §2). */
export interface StoredQuestionSet {
  id: string;
  kind: QuestionSetKind;
  version: string;
  sha256: string;
  definition: unknown;
}

/**
 * The active set of each kind (`settings['question_sets.active']`, spec 05 §2), resolved to its
 * stored row. A kind missing from the setting is absent; an id naming a missing row or a row of
 * another kind is an operator error and throws, so no handler silently asks an unintended set.
 */
export async function loadActiveQuestionSets(
  db: Executor,
): Promise<Partial<Record<QuestionSetKind, StoredQuestionSet>>> {
  const active = parseSetting(
    'question_sets.active',
    (await readStoredSetting(db, 'question_sets.active')) ?? {},
  );
  const wanted = Object.entries(active).filter(
    (entry): entry is [QuestionSetKind, string] => entry[1] !== undefined,
  );
  if (wanted.length === 0) return {};
  const rows = await db.execute<{
    id: string;
    kind: QuestionSetKind;
    version: string;
    sha256: string;
    definition: unknown;
  }>(sql`
    SELECT id::text AS id, kind, version, sha256, definition FROM question_sets
     WHERE id = ANY(${sql.param(wanted.map(([, id]) => id))}::bigint[])`);
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const result: Partial<Record<QuestionSetKind, StoredQuestionSet>> = {};
  for (const [kind, id] of wanted) {
    const row = byId.get(id);
    if (row === undefined || row.kind !== kind) {
      throw new Error(`question_sets.active.${kind} names no ${kind} question set (id ${id})`);
    }
    result[kind] = row;
  }
  return result;
}

/** A stored question set by id (frozen request manifests name their set ids). */
export async function getQuestionSet(db: Executor, id: string): Promise<StoredQuestionSet | null> {
  const rows = await db.execute<{
    id: string;
    kind: QuestionSetKind;
    version: string;
    sha256: string;
    definition: unknown;
  }>(sql`
    SELECT id::text AS id, kind, version, sha256, definition FROM question_sets
     WHERE id = ${id}::bigint`);
  return rows.rows[0] ?? null;
}
