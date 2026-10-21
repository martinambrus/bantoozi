import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { QUEUE_NAMES } from '@bantoozi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeTemplateHash,
  queueRegistryKey,
  roleUrl,
  templateDatabaseName,
  testDatabaseName,
  testDbEnv,
  worktreeHash,
} from '../src/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bantoozi-migrations-'));
  await mkdir(path.join(dir, 'meta'));
  await writeFile(path.join(dir, '0000_init.sql'), 'CREATE TABLE a (id int);');
  await writeFile(path.join(dir, '0001_rls.sql'), 'ALTER TABLE a ENABLE ROW LEVEL SECURITY;');
  await writeFile(path.join(dir, 'meta', '_journal.json'), '{"entries":[0,1]}');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const hashOf = (pgBossVersion = '10.4.2') =>
  computeTemplateHash({ migrationsDir: dir, pgBossVersion });

describe('template hash (spec 02 §1.1)', () => {
  it('is 12 hex digits and deterministic', async () => {
    const h = await hashOf();
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashOf()).toBe(h);
    expect(templateDatabaseName(h)).toBe(`bantoozi_template_${h}`);
  });

  it('changes when the journal content changes', async () => {
    const before = await hashOf();
    await writeFile(path.join(dir, 'meta', '_journal.json'), '{"entries":[0,1,2]}');
    expect(await hashOf()).not.toBe(before);
  });

  it('changes when a migration file changes although its journal filename does not', async () => {
    const before = await hashOf();
    await writeFile(path.join(dir, '0001_rls.sql'), 'ALTER TABLE a FORCE ROW LEVEL SECURITY;');
    expect(await hashOf()).not.toBe(before);
  });

  it('changes with the pinned pg-boss version and with added migrations', async () => {
    const before = await hashOf();
    expect(await hashOf('10.4.3')).not.toBe(before);
    await writeFile(path.join(dir, '0002_more.sql'), 'SELECT 1;');
    expect(await hashOf()).not.toBe(before);
  });

  it('ignores non-SQL files such as drizzle snapshots', async () => {
    const before = await hashOf();
    await writeFile(path.join(dir, 'meta', '0001_snapshot.json'), '{}');
    expect(await hashOf()).toBe(before);
  });

  it('changes with the extra input, and an empty extra leaves the hash as it was', async () => {
    const before = await hashOf();
    const withExtra = (extra: string) =>
      computeTemplateHash({ migrationsDir: dir, pgBossVersion: '10.4.2', extra });
    expect(await withExtra('')).toBe(before);
    const a = await withExtra('queues:a');
    expect(a).not.toBe(before);
    expect(await withExtra('queues:b')).not.toBe(a);
    expect(await withExtra('queues:a')).toBe(a);
  });

  it('works before any migration exists', async () => {
    expect(
      await computeTemplateHash({
        migrationsDir: path.join(dir, 'missing'),
        pgBossVersion: '10.4.2',
      }),
    ).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('queue registry key (the migrate job creates the pg-boss queues from the registry)', () => {
  it('names every queue with its create options, in a stable order', () => {
    const key = queueRegistryKey();
    for (const name of QUEUE_NAMES) expect(key).toContain(`"${name}"`);
    expect(key).toContain('house.model-watch');
    expect(queueRegistryKey()).toBe(key);
  });

  it('moves with the registry: a queue added without a migration, or other options, is another key', () => {
    const registry = {
      'a.queue': { options: { policy: 'standard', retryLimit: 0 } },
      'b.queue': { options: { policy: 'singleton', retryLimit: 1 } },
    };
    const key = queueRegistryKey(registry);
    expect(
      queueRegistryKey({ 'b.queue': registry['b.queue'], 'a.queue': registry['a.queue'] }),
    ).toBe(key);
    expect(
      queueRegistryKey({ ...registry, 'c.queue': { options: { policy: 'standard' } } }),
    ).not.toBe(key);
    expect(
      queueRegistryKey({
        ...registry,
        'a.queue': { options: { policy: 'standard', retryLimit: 2 } },
      }),
    ).not.toBe(key);
  });
});

describe('test database names', () => {
  it('separates worktrees, packages and runs, within the 63-byte identifier limit', () => {
    const a = testDatabaseName({ worktreeRoot: '/work/bantoozi', pkg: 'db', runId: 'r1' });
    const b = testDatabaseName({ worktreeRoot: '/work/bantoozi-m2', pkg: 'db', runId: 'r1' });
    expect(a).toMatch(/^bantoozi_test_[0-9a-f]{8}_db_r1$/);
    expect(a).not.toBe(b);
    expect(worktreeHash('/work/bantoozi')).not.toBe(worktreeHash('/work/bantoozi-m2'));
    const long = testDatabaseName({
      worktreeRoot: '/w',
      pkg: '@bantoozi/Some Very-Long.Package.Name.Exceeding',
      runId: 'RUN-ID-WITH-CAPS-AND-MORE-CHARS',
    });
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9_]+$/);
  });

  it('builds role URLs on the admin host/port', () => {
    const env = testDbEnv({ PG_TEST_PORT: '6543' });
    expect(env.adminUrl).toBe('postgres://postgres:postgres@localhost:6543/postgres');
    expect(roleUrl(env, 'bantoozi_app', 'bantoozi_test_x')).toBe(
      'postgres://bantoozi_app:bantoozi_app@localhost:6543/bantoozi_test_x',
    );
    expect(() => templateDatabaseName('xyz')).toThrow();
  });
});
