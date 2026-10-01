import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDatabase,
  createGateLock,
  findGateLocks,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
  type Database,
  type GateLockConfig,
} from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCli } from '../src/cli.js';
import { G1Schema } from '../src/report/g1-schema.js';
import { createEvalRuntime } from '../src/runtime.js';
import { seedGateDatabase, type SeededGateDb } from './gate-fixtures.js';

/**
 * M3a-T7 (spec 10 §5): `eval report` and `eval gate` on stored fixture runs — the test split stays
 * sealed until a selection is locked, the lock records the profile and the selection, and a rerun
 * cannot switch profile or retune under the same manifest.
 */

const NOW = new Date('2026-10-01T08:00:00Z');
let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let seeded: SeededGateDb;
let dir: string;

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'eval-gate',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 3 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  db = createDatabase(workerPool);
  seeded = await seedGateDatabase(owner, db);
  dir = await mkdtemp(path.join(os.tmpdir(), 'eval-gate-'));
}, 120_000);

afterAll(async () => {
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

async function evalCli(args: string[]): Promise<string> {
  const out: string[] = [];
  const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
  const program = buildCli({
    io,
    openRuntime: () =>
      createEvalRuntime({
        env: { DATABASE_URL_WORKER: testDb.urls.worker },
        io,
        now: () => NOW,
        poolMax: 2,
      }),
  }).exitOverride();
  for (const command of program.commands) {
    command.exitOverride().configureOutput({ writeOut: io.out, writeErr: io.err });
  }
  await program.parseAsync(['node', 'cli', ...args]);
  return out.join('');
}

describe('eval report and eval gate', () => {
  it('seals the test split in `eval report` until the gate locks a selection', async () => {
    const out = path.join(dir, 'before.md');
    const printed = await evalCli(['report', '--out', out, '--resamples', '20']);
    expect(printed).toContain('development only: test sealed');
    const markdown = await readFile(out, 'utf8');
    expect(markdown).toContain('## Ranking (development)');
    expect(markdown).not.toContain('## Ranking (test)');
    expect((markdown.match(/<svg /g) ?? []).length).toBe(2);
  });

  it('requires --profile', async () => {
    await expect(evalCli(['gate'])).rejects.toMatchObject({
      code: 'commander.missingMandatoryOptionValue',
    });
  });

  it('selects on development, locks, confirms on test and writes the report and g1.json', async () => {
    const g1Path = path.join(dir, 'g1.json');
    const reportPath = path.join(dir, 'G1.md');
    const printed = await evalCli([
      'gate',
      '--profile',
      'owner_pilot',
      '--g1',
      g1Path,
      '--report',
      reportPath,
      '--resamples',
      '20',
    ]);
    expect(printed).toContain('G1 PASS');
    expect(printed).toContain('profile            owner_pilot (1 participant(s))');
    const g1 = G1Schema.parse(JSON.parse(await readFile(g1Path, 'utf8')));
    expect(g1.gate).toMatchObject({ profile: 'owner_pilot', participants: 1, status: 'pass' });
    expect(g1.dataset).toEqual({
      version: seeded.fixture.dataset.version,
      snapshotSha: seeded.fixture.dataset.snapshotSha,
      splitSha: seeded.fixture.dataset.splitSha,
    });
    expect(g1.runs['E1']).toBe(seeded.runIds['E1']);
    expect(g1.dryRun).toBeUndefined();
    const locks = await findGateLocks(db, 'golden-v1');
    expect(locks).toHaveLength(1);
    expect(locks[0]?.config).toMatchObject({
      profile: 'owner_pilot',
      configSha: g1.selection.configSha,
    });
    expect(locks[0]?.results).toMatchObject({ status: 'pass', reportSha: g1.gate.reportSha });
    expect(g1.selection.lockedAt).toBe(locks[0]?.startedAt.toISOString());

    // A rerun reaches the same selection and reuses the lock.
    await evalCli([
      'gate',
      '--profile',
      'owner_pilot',
      '--g1',
      g1Path,
      '--report',
      reportPath,
      '--resamples',
      '20',
    ]);
    expect(await findGateLocks(db, 'golden-v1')).toHaveLength(1);

    // Once locked, `eval report` adds the test tables.
    const after = path.join(dir, 'after.md');
    await evalCli(['report', '--out', after, '--resamples', '20']);
    expect(await readFile(after, 'utf8')).toContain('## Ranking (test)');
  });

  it('refuses a different selection under the same manifest after the test reveal', async () => {
    await expect(
      evalCli([
        'gate',
        '--profile',
        'owner_pilot',
        '--daily-revisions',
        '50000',
        '--g1',
        path.join(dir, 'other.json'),
        '--report',
        path.join(dir, 'other.md'),
        '--resamples',
        '20',
      ]),
    ).rejects.toThrow(/differs from the one locked/);
  });

  it('refuses a profile switch on a locked manifest', async () => {
    const [lock] = await findGateLocks(db, 'golden-v1');
    const config = lock!.config as unknown as GateLockConfig;
    await owner.query('DELETE FROM eval.runs WHERE id = $1', [lock!.id]);
    await createGateLock(db, {
      gitSha: 'x',
      config: { ...config, profile: 'multi_person_beta' },
    });
    await expect(
      evalCli([
        'gate',
        '--profile',
        'owner_pilot',
        '--g1',
        path.join(dir, 'switch.json'),
        '--report',
        path.join(dir, 'switch.md'),
        '--resamples',
        '20',
      ]),
    ).rejects.toThrow(/locked as multi_person_beta/);
  });

  it("refuses a selection for another cohort once one cohort's lock revealed the test split", async () => {
    // Cohort A was locked (another `--raters` choice), so `eval report` already shows this
    // version's test split: a development selection for this cohort must not follow.
    const [lock] = await findGateLocks(db, 'golden-v1');
    const config = lock!.config as unknown as GateLockConfig;
    await owner.query('DELETE FROM eval.runs WHERE id = $1', [lock!.id]);
    await createGateLock(db, {
      gitSha: 'x',
      config: { ...config, profile: 'owner_pilot', cohortSha: 'cohort-a' },
    });
    const report = path.join(dir, 'cohort-a.md');
    await evalCli(['report', '--out', report, '--resamples', '20']);
    expect(await readFile(report, 'utf8')).toContain('## Ranking (test)');
    const g1Path = path.join(dir, 'cohort-b.json');
    await expect(
      evalCli([
        'gate',
        '--profile',
        'owner_pilot',
        '--g1',
        g1Path,
        '--report',
        path.join(dir, 'cohort-b.md'),
        '--resamples',
        '20',
      ]),
    ).rejects.toThrow(/locked for another cohort .* needs a new held-out dataset version/);
    await expect(readFile(g1Path, 'utf8')).rejects.toThrow();
    expect(await findGateLocks(db, 'golden-v1')).toHaveLength(1);
  });

  it('writes an honest incomplete report and no g1.json when readiness is not met', async () => {
    const g1Path = path.join(dir, 'beta.json');
    const reportPath = path.join(dir, 'beta.md');
    const printed = await evalCli([
      'gate',
      '--profile',
      'multi_person_beta',
      '--g1',
      g1Path,
      '--report',
      reportPath,
    ]);
    expect(printed).toContain('G1 NEEDS_MORE_DATA');
    expect(printed).toContain('g1.json: not written');
    const markdown = await readFile(reportPath, 'utf8');
    expect(markdown).toContain('needs ≥3 actual participants, found 1');
    expect(markdown).toContain('The test split was not revealed');
    await expect(readFile(g1Path, 'utf8')).rejects.toThrow();
  });
});
