import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const folder = fileURLToPath(new URL('../drizzle', import.meta.url));

describe('the migration journal (D-265)', () => {
  const { entries } = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };

  it('has strictly increasing timestamps, so an existing database applies every new migration', () => {
    // Drizzle applies only migrations whose `when` is later than the newest applied one: a
    // drizzle-kit stamp of the real time (earlier than this repo's synthetic values) is skipped on
    // every existing database, silently. Give a new entry the previous `when` plus one.
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.when, entries[i]!.tag).toBeGreaterThan(entries[i - 1]!.when);
    }
  });

  it('numbers the entries in order and has a SQL file for each', () => {
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag.startsWith(String(i).padStart(4, '0'))).toBe(true);
      expect(existsSync(`${folder}/${entry.tag}.sql`), entry.tag).toBe(true);
    });
  });
});
