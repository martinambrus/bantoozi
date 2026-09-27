import { parseSetting, type QuestionSetsActive } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { insertSettingIfMissing, readStoredSetting } from '../settings.js';

/** `question_sets.kind` (spec 02 §3.1). */
type QuestionSetKind = 'enrich' | 'match' | 'cluster' | 'suggest';

/** A question set as the code defines it (spec 05 §2): the seed stores it immutably. */
export interface QuestionSetSeed {
  kind: QuestionSetKind;
  version: string;
  sha256: string;
  definition: unknown;
}

export interface QuestionSetSeedResult {
  /** Stored id (decimal string) of every set, by version. */
  ids: Record<string, string>;
  /** Versions this run inserted. */
  inserted: string[];
  /** Kinds this run made active because `question_sets.active` had none. */
  activated: QuestionSetKind[];
}

/** A stored set whose version or hash disagrees with the code: wording changed without a new version. */
export class QuestionSetConflictError extends Error {
  override readonly name = 'QuestionSetConflictError';
}

const KINDS: readonly QuestionSetKind[] = ['enrich', 'match', 'cluster', 'suggest'];

function checkSeed(set: QuestionSetSeed): void {
  if (!KINDS.includes(set.kind)) throw new TypeError(`unknown question set kind ${set.kind}`);
  const computed = canonicalSha256(set.definition);
  if (computed !== set.sha256) {
    throw new TypeError(`question set ${set.version}: sha256 does not match its definition`);
  }
}

async function storedByVersion(
  db: Executor,
  version: string,
): Promise<{ id: string; kind: string; sha256: string; definition: unknown } | undefined> {
  const result = await db.execute<{
    id: string;
    kind: string;
    sha256: string;
    definition: unknown;
  }>(
    sql`SELECT id::text AS id, kind, sha256, definition FROM question_sets WHERE version = ${version}`,
  );
  return result.rows[0];
}

/**
 * Upsert every code question set into `question_sets` (spec 05 §2). Rows are immutable: a stored
 * `version` with another `sha256` (or kind) fails the seed, because changed wording needs a new
 * version. Then `settings['question_sets.active'][kind]` is set to `activeByKind[kind]` (a version)
 * **only when that kind is absent**; ids are decimal strings. Switching an active kind is an admin
 * change, never a seed side effect.
 */
export async function seedQuestionSets(
  tx: Transaction,
  sets: readonly QuestionSetSeed[],
  activeByKind: Partial<Record<QuestionSetKind, string>>,
): Promise<QuestionSetSeedResult> {
  const ids: Record<string, string> = {};
  const inserted: string[] = [];
  for (const set of sets) {
    checkSeed(set);
    const insert = await tx.execute<{ id: string }>(sql`
      INSERT INTO question_sets (kind, version, sha256, definition)
      VALUES (${set.kind}, ${set.version}, ${set.sha256}, ${JSON.stringify(set.definition)}::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id`);
    const insertedId = insert.rows[0]?.id;
    if (insertedId !== undefined) {
      ids[set.version] = insertedId;
      inserted.push(set.version);
      continue;
    }
    const stored = await storedByVersion(tx, set.version);
    if (stored === undefined) {
      throw new QuestionSetConflictError(
        `question set ${set.version}: its sha256 is already stored under another version`,
      );
    }
    if (stored.sha256 !== set.sha256 || stored.kind !== set.kind) {
      throw new QuestionSetConflictError(
        `question set ${set.version} is stored with a different ${stored.kind !== set.kind ? 'kind' : 'sha256'}; changed wording needs a new version`,
      );
    }
    ids[set.version] = stored.id;
  }

  // Read-modify-write under the settings row lock, so a concurrent admin switch is never lost.
  await insertSettingIfMissing(tx, 'question_sets.active', {});
  const locked = await tx.execute<{ value: unknown }>(
    sql`SELECT value FROM settings WHERE key = 'question_sets.active' FOR UPDATE`,
  );
  const active = parseSetting('question_sets.active', locked.rows[0]?.value ?? {});
  const next: QuestionSetsActive = { ...active };
  const activated: QuestionSetKind[] = [];
  for (const kind of KINDS) {
    const version = activeByKind[kind];
    if (version === undefined || active[kind] !== undefined) continue;
    const id = ids[version];
    if (id === undefined) throw new TypeError(`active ${kind} set ${version} is not being seeded`);
    if (sets.find((set) => set.version === version)?.kind !== kind) {
      throw new TypeError(`set ${version} is not a ${kind} set`);
    }
    next[kind] = id;
    activated.push(kind);
  }
  if (activated.length > 0) {
    await tx.execute(sql`
      UPDATE settings
         SET value = ${JSON.stringify(parseSetting('question_sets.active', next))}::jsonb,
             updated_at = now()
       WHERE key = 'question_sets.active'`);
  }
  return { ids, inserted, activated };
}

/**
 * Whether the stored question sets match the code (the worker's startup check, spec 05 §2): every
 * code set is stored under its version with the same kind and sha256 (and the stored definition
 * still hashes to it), and every active set is one the code knows. Returns the problems (empty
 * when consistent); a missing set means the seed has not run.
 */
export async function checkQuestionSets(
  db: Executor,
  sets: readonly Pick<QuestionSetSeed, 'kind' | 'version' | 'sha256'>[],
): Promise<string[]> {
  const problems: string[] = [];
  const rows = await db.execute<{
    id: string;
    kind: string;
    version: string;
    sha256: string;
    definition: unknown;
  }>(sql`SELECT id::text AS id, kind, version, sha256, definition FROM question_sets ORDER BY id`);
  const byVersion = new Map(rows.rows.map((row) => [row.version, row]));
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  for (const set of sets) {
    const stored = byVersion.get(set.version);
    if (stored === undefined) {
      problems.push(`question set ${set.version} is not seeded (run pnpm db:seed)`);
    } else if (stored.kind !== set.kind || stored.sha256 !== set.sha256) {
      problems.push(`question set ${set.version} differs from the code (sha256 ${stored.sha256})`);
    } else if (canonicalSha256(stored.definition) !== stored.sha256) {
      problems.push(`question set ${set.version}: the stored definition does not match its sha256`);
    }
  }
  const known = new Set(sets.map((set) => `${set.version}:${set.sha256}`));
  const active = parseSetting(
    'question_sets.active',
    (await readStoredSetting(db, 'question_sets.active')) ?? {},
  );
  for (const kind of KINDS) {
    const id = active[kind];
    if (id === undefined) continue;
    const stored = byId.get(id);
    if (stored === undefined || stored.kind !== kind) {
      problems.push(`question_sets.active.${kind} names no ${kind} set (id ${id})`);
    } else if (!known.has(`${stored.version}:${stored.sha256}`)) {
      problems.push(`active ${kind} set ${stored.version} is unknown to this code`);
    }
  }
  return problems;
}
