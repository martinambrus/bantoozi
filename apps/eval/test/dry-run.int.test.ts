import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runDryRun, type DryRunResult } from '../src/dryrun/run.js';
import { testDbEnv } from '@bantoozi/testing';

/**
 * M3a-T8 (spec 10 §3): `eval dry-run` end to end on a small synthetic corpus, in its own uniquely
 * named dry-run database (dropped afterwards) and against the in-process fakes: every experiment
 * runs, the gate and report are written with `dryRun`, and the card experiment E1 beats the
 * chronological baseline B0 on the hidden interest model.
 */

const name = `bantoozi_eval_dryrun_t${randomBytes(4).toString('hex')}`;
let outDir: string;
let cacheDir: string;
let result: DryRunResult;
let printed = '';

async function databaseExists(): Promise<boolean> {
  const client = new pg.Client({ connectionString: testDbEnv().adminUrl });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return found.rows.length > 0;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'bantoozi-dryrun-out-'));
  cacheDir = await mkdtemp(path.join(tmpdir(), 'bantoozi-dryrun-cache-'));
  result = await runDryRun({
    database: name,
    seed: 'dryrun-test',
    articlesPerLang: 48,
    feedsPerLang: 12,
    samplePerLang: 40,
    assignmentsPerRater: 40,
    facetsPerLang: 8,
    facetOverlap: 6,
    resamples: 50,
    outDir,
    dropAfter: true,
    env: { ...process.env, EVAL_CACHE_DIR: cacheDir, LOG_LEVEL: 'silent' },
    io: { out: (s) => (printed += s), err: () => undefined },
    now: () => new Date('2026-10-01T12:00:00Z'),
  });
}, 600_000);

afterAll(async () => {
  await Promise.all([
    rm(outDir, { recursive: true, force: true }),
    rm(cacheDir, { recursive: true, force: true }),
  ]);
});

describe('eval dry-run (M3a-T8)', () => {
  it('runs every experiment on the synthetic data (E5 skipped)', () => {
    expect(result.database).toBe(name);
    expect(result.version).toBe('golden-v1');
    const statuses = Object.fromEntries(
      Object.entries(result.runs).map(([id, run]) => [id, run.status]),
    );
    expect(statuses).toEqual({
      B0: 'complete',
      B1: 'complete',
      'B1-T': 'complete',
      E1: 'complete',
      E2: 'complete',
      E3: 'complete',
      E3b: 'complete',
      E4: 'complete',
      E5: 'skipped',
      E6: 'complete',
      E7: 'complete',
    });
    expect(result.raters).toHaveLength(4);
    for (const rater of result.raters) {
      expect(rater.assigned).toBe(40);
      expect(rater.likes).toBeGreaterThan(0);
      expect(rater.dislikes).toBeGreaterThan(0);
    }
  });

  it('E1 beats B0 on the hidden interest model', () => {
    const e1 = result.auc.E1 ?? null;
    const b0 = result.auc.B0 ?? null;
    expect(e1).not.toBeNull();
    expect(b0).not.toBeNull();
    expect(e1!).toBeGreaterThan(b0! + 0.15);
    expect(e1!).toBeGreaterThan(0.65);
  });

  it('writes the dry-run gate report and evaluation report, prints the decision table', async () => {
    expect(result.reportPath).toBe(path.join(outDir, 'DRYRUN-2026-10-01.md'));
    const report = await readFile(result.reportPath, 'utf8');
    expect(report.toLowerCase()).toContain('dry');
    expect(await readFile(result.evalReportPath, 'utf8')).toContain('synthetic data');
    // The small corpus does not meet the profile's label counts: an honest needs_more_data.
    expect(result.gate.status).toBe('needs_more_data');
    expect(result.g1Path).toBeNull();
    expect(printed).toContain('G1 NEEDS_MORE_DATA');
    expect(printed).toMatch(/E1\s+complete\s+0\.\d{3}/);
    expect(printed).toContain(`report: ${result.reportPath}`);
  });

  it('drops its database afterwards (dropAfter)', async () => {
    expect(await databaseExists()).toBe(false);
  });
});
