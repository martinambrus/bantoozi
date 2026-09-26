import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import type { Executor } from './client.js';

/** Bundled migrations: the `when` stamps Drizzle records as `created_at` (spec 01 §4 readiness). */
export interface MigrationJournal {
  count: number;
  latestTag: string;
  latestWhen: number;
}

interface JournalEntry {
  tag: string;
  when: number;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry['tag'] === 'string' && Number.isSafeInteger(entry['when']);
}

export function readMigrationJournal(migrationsFolder: string): MigrationJournal {
  const journal: unknown = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  );
  const entries = (journal as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isJournalEntry)) {
    throw new Error('invalid migration journal');
  }
  const latest = entries.reduce((a, b) => (b.when > a.when ? b : a));
  return { count: entries.length, latestTag: latest.tag, latestWhen: latest.when };
}

export interface MigrationStatus {
  ready: boolean;
  expectedLatest: number;
  appliedLatest: number | null;
}

/** `/readyz`: the newest applied migration equals the newest bundled one. */
export async function migrationStatus(
  db: Executor,
  journal: MigrationJournal,
): Promise<MigrationStatus> {
  const result = await db.execute<{ latest: string | null }>(
    sql`SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`,
  );
  const raw = result.rows[0]?.latest ?? null;
  const appliedLatest = raw === null ? null : Number(raw);
  return {
    ready: appliedLatest === journal.latestWhen,
    expectedLatest: journal.latestWhen,
    appliedLatest,
  };
}
