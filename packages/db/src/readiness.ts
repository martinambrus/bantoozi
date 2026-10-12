import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import type { Executor } from './client.js';

/** Bundled migrations: the `when` stamps Drizzle records as `created_at` (spec 01 §4 readiness). */
export interface MigrationJournal {
  count: number;
  latestTag: string;
  latestWhen: number;
  /** Every bundled `when` stamp (distinct), in journal order. */
  whens: number[];
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
  return {
    count: entries.length,
    latestTag: latest.tag,
    latestWhen: latest.when,
    whens: entries.map((e) => e.when),
  };
}

export interface MigrationStatus {
  ready: boolean;
  expectedLatest: number;
  appliedLatest: number | null;
  /** Applied migrations newer than the newest bundled one (the database is ahead of this release). */
  newerApplied: number;
}

/**
 * `/readyz`: the database has applied every migration this release bundles. A database AHEAD of the
 * release (extra, newer rows) is ready: the spec 11 §3.6 expand/contract rollback runs the previous
 * application images over the expanded schema. One BEHIND (a bundled migration missing, including a
 * missing middle one) is not.
 */
export async function migrationStatus(
  db: Executor,
  journal: MigrationJournal,
): Promise<MigrationStatus> {
  const bundled = sql.join(
    journal.whens.map((w) => sql`${String(w)}::bigint`),
    sql`, `,
  );
  const result = await db.execute<{
    latest: string | null;
    bundled_applied: string;
    newer: string;
    has_latest: boolean;
  }>(
    sql`SELECT max(created_at)::text AS latest,
               count(DISTINCT created_at) FILTER (WHERE created_at IN (${bundled}))::text AS bundled_applied,
               count(*) FILTER (WHERE created_at > ${String(journal.latestWhen)}::bigint)::text AS newer,
               coalesce(bool_or(created_at = ${String(journal.latestWhen)}::bigint), false) AS has_latest
        FROM drizzle.__drizzle_migrations`,
  );
  const row = result.rows[0];
  const raw = row?.latest ?? null;
  const appliedLatest = raw === null ? null : Number(raw);
  const distinctBundled = new Set(journal.whens).size;
  const ready = row?.has_latest === true && Number(row.bundled_applied) === distinctBundled;
  return {
    ready,
    expectedLatest: journal.latestWhen,
    appliedLatest,
    newerApplied: Number(row?.newer ?? 0),
  };
}
