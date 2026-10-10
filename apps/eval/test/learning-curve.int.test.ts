import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDatabase,
  createDataset,
  createRun,
  finishRun,
  freezeDataset,
  insertSampleRows,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
  upsertRunAnswers,
  type Database,
} from '@bantoozi/db';
import { canonicalSha256 } from '@bantoozi/shared/server';
import {
  createArticle,
  createCard,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCli } from '../src/cli.js';
import { createEvalRuntime } from '../src/runtime.js';
import { buildCurveFixture, type CurveFixture } from './learning-curve-fixtures.js';

/**
 * M7-T7a: `eval learning-curve` reads a frozen dataset and the stored answers of the g1 run only: it
 * writes the decision report and prints the table, makes no network request and changes no table.
 */

const NOW = new Date('2026-10-10T09:00:00Z');
const VERSION = 'golden-v3';
let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let dir: string;
let g1Path: string;
let runId = '';
let dataset = { version: VERSION, snapshotSha: '', splitSha: '' };

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'eval-curve',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 3 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  db = createDatabase(workerPool);
  dir = await mkdtemp(path.join(os.tmpdir(), 'eval-curve-'));

  const options = { devArticles: 60, testArticles: 30 };
  const draft = buildCurveFixture(options);
  const articleIds: string[] = [];
  for (let i = 0; i < draft.sampleRows.length; i += 1) {
    articleIds.push((await createArticle(owner, { title: `Curve article ${i}` })).id);
  }
  const cardIds: Record<string, string> = {};
  for (const raterId of draft.raterIds) cardIds[raterId] = (await createCard(owner)).id;
  const placed = buildCurveFixture({ ...options, articleIds, cardIds });
  const frozen = await db.transaction(async (tx) => {
    await createDataset(tx, { version: VERSION, seed: 'curve', params: {} });
    await insertSampleRows(
      tx,
      VERSION,
      placed.sampleRows.map((row) => ({
        articleId: row.articleId,
        lang: row.lang,
        snapshot: row.snapshot,
        snapshotSha: canonicalSha256(row.snapshot),
        split: row.split,
      })),
    );
    return freezeDataset(tx, VERSION);
  });
  dataset = {
    version: VERSION,
    snapshotSha: frozen.snapshotSha ?? '',
    splitSha: frozen.splitSha ?? '',
  };
  const stored: CurveFixture = buildCurveFixture({ ...options, articleIds, cardIds, dataset });
  const run = await createRun(db, {
    experiment: 'E1',
    datasetVersion: VERSION,
    config: stored.run.config,
    gitSha: stored.run.gitSha,
  });
  await upsertRunAnswers(db, run.id, stored.answers);
  await finishRun(db, run.id, { status: 'complete' });
  runId = run.id;
  g1Path = path.join(dir, 'g1.json');
  await writeG1({ runs: { E1: runId } });
}, 120_000);

afterAll(async () => {
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

async function writeG1(overrides: Record<string, unknown>): Promise<void> {
  const sha = 'e'.repeat(64);
  await writeFile(
    g1Path,
    JSON.stringify({
      language_modes: { en: 'native' },
      card_text_mode: 'as_written',
      ranker_thresholds: {},
      recommended_daily_budget_usd: 2,
      translate_tier2_daily_cap: 300,
      laya_track_recommended: false,
      runs: { E1: runId },
      notes: '',
      dataset,
      selection: { developmentRunIds: [], lockedAt: '2026-10-08T10:00:00Z', configSha: sha },
      gate: { profile: 'owner_pilot', participants: 1, status: 'pass', reportSha: sha },
      ...overrides,
    }),
  );
}

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

async function rowCounts(): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  const tables = await owner.query<{ name: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
      WHERE schemaname IN ('eval', 'public') ORDER BY 1`,
  );
  for (const { name } of tables.rows) {
    const result = await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${name}`);
    counts[name] = result.rows[0]?.n ?? '?';
  }
  return counts;
}

describe('eval learning-curve', () => {
  it('prints the table and writes the decision report without fetching or writing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network in learning-curve');
    });
    const before = await rowCounts();
    let out: string;
    try {
      out = await evalCli(['learning-curve', '--g1', g1Path, '--out', dir, '--sizes', '10,30,50']);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowCounts()).toEqual(before);
    expect(out).toContain('model AUC');
    expect(out).toContain('cards AUC');
    const file = `LEARNING-CURVE-${VERSION}-2026-10-10-decision.md`;
    expect(await readdir(dir)).toContain(file);
    const report = await readFile(path.join(dir, file), 'utf8');
    expect(report).toContain(VERSION);
    expect(report).toContain(`run ${runId}`);
    expect(report).toContain('model AUC');
  });

  it('refuses a g1 file whose card text mode has no run, and a dataset hash mismatch', async () => {
    await writeG1({ card_text_mode: 'english' });
    await expect(evalCli(['learning-curve', '--g1', g1Path, '--out', dir])).rejects.toThrow(/E2/);
    await writeG1({ dataset: { ...dataset, splitSha: 'f'.repeat(64) } });
    await expect(evalCli(['learning-curve', '--g1', g1Path, '--out', dir])).rejects.toThrow(/hash/);
    await writeG1({});
  });
});
