import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Drizzle's migration journal, relative to the migrations folder. */
export const JOURNAL_PATH = path.join('meta', '_journal.json');

export interface TemplateHashInput {
  /** Folder with the SQL migrations and `meta/_journal.json` (packages/db/drizzle). */
  migrationsDir: string;
  /** The pinned pg-boss version: its schema is part of the migrate job (spec 02 §1.2). */
  pgBossVersion: string;
}

/**
 * `h` of `bantoozi_template_<h>` (spec 02 §1.1): the first 12 hex digits of
 * `sha256(sorted migration paths + their bytes + journal bytes + pinned pg-boss version)`.
 * A changed migration yields a new template even when the journal filename is unchanged.
 */
export async function computeTemplateHash(input: TemplateHashInput): Promise<string> {
  const hash = createHash('sha256');
  const migrations = (await listSqlFiles(input.migrationsDir)).sort();
  for (const relative of migrations) {
    hash.update(`path:${relative.split(path.sep).join('/')}\0`);
    hash.update(await readFile(path.join(input.migrationsDir, relative)));
    hash.update('\0');
  }
  hash.update('journal:');
  hash.update(await readOptional(path.join(input.migrationsDir, JOURNAL_PATH)));
  hash.update(`\0pg-boss:${input.pgBossVersion}`);
  return hash.digest('hex').slice(0, 12);
}

async function listSqlFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listSqlFiles(dir, relative)));
    else if (entry.isFile() && entry.name.endsWith('.sql')) files.push(relative);
  }
  return files;
}

async function readOptional(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}
