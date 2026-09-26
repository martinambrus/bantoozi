import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AppError } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  MIGRATIONS_FOLDER,
  PACKAGE_NAME,
  mapDbError,
  readMigrationJournal,
  sqlState,
} from '../src/index.js';

describe('@bantoozi/db', () => {
  it('exposes its public entry point', () => {
    expect(PACKAGE_NAME).toBe('@bantoozi/db');
  });
});

describe('mapDbError', () => {
  const pgError = (code: string) =>
    Object.assign(new Error('raw text naming private values'), { code });

  it.each([
    ['BZ404', 'NOT_FOUND', 404],
    ['BZ409', 'CONFLICT', 409],
    ['22023', 'VALIDATION_FAILED', 400],
    ['42501', 'FORBIDDEN', 403],
    ['23505', 'CONFLICT', 409],
    ['23514', 'CONFLICT', 409],
    ['40001', 'CONFLICT', 409],
  ])('maps SQLSTATE %s to %s', (state, code, status) => {
    const mapped = mapDbError(pgError(state));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.code).toBe(code);
    expect(mapped?.httpStatus).toBe(status);
    // Database text can name private values; it never reaches the application error message.
    expect(mapped?.message).not.toContain('private');
  });

  it('finds the SQLSTATE of a wrapped driver error (Drizzle query errors)', () => {
    const wrapped = new Error('Failed query', { cause: pgError('BZ404') });
    expect(sqlState(wrapped)).toBe('BZ404');
    expect(mapDbError(wrapped)?.code).toBe('NOT_FOUND');
  });

  it('leaves unknown errors alone', () => {
    expect(mapDbError(pgError('XX000'))).toBeUndefined();
    expect(mapDbError(new Error('no code'))).toBeUndefined();
    expect(mapDbError('not an error')).toBeUndefined();
  });
});

describe('readMigrationJournal', () => {
  it('reads the bundled journal', () => {
    const journal = readMigrationJournal(MIGRATIONS_FOLDER);
    expect(journal.count).toBeGreaterThanOrEqual(6);
    expect(journal.latestTag).toMatch(/^\d{4}_[a-z_]+$/);
  });

  it('picks the newest entry and rejects malformed journals', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'journal-'));
    mkdirSync(path.join(dir, 'meta'));
    const write = (content: unknown) =>
      writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(content));
    write({
      entries: [
        { tag: '0001_b', when: 20 },
        { tag: '0000_a', when: 10 },
      ],
    });
    expect(readMigrationJournal(dir)).toEqual({ count: 2, latestTag: '0001_b', latestWhen: 20 });
    write({ entries: [] });
    expect(() => readMigrationJournal(dir)).toThrow('invalid migration journal');
    write({ entries: [{ tag: 1, when: 'x' }] });
    expect(() => readMigrationJournal(dir)).toThrow('invalid migration journal');
  });
});
