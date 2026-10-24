import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createUser, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '../src/migrate/migrate.js';

let previous: TestDatabase;
let owner: pg.Pool;
let folder: string;
beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'bantoozi-vl37-'));
  await mkdir(path.join(folder, 'meta'));
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[];
  };
  const entries = journal.entries.filter((entry) => entry.idx <= 36);
  for (const entry of entries)
    await cp(
      path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  previous = await setupTestDatabase({
    pkg: 'vl37',
    migrationsDir: folder,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (databaseUrl) => {
      await runMigrations({ databaseUrl, migrationsFolder: folder });
    },
  });
  owner = new pg.Pool({ connectionString: previous.urls.owner });
});
afterAll(async () => {
  await owner?.end();
  await previous?.drop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

it('upgrades seeded 0036 runs, preserves existing history, caps each kind and is idempotent', async () => {
  const user = await createUser(owner);
  const other = await createUser(owner);
  const tied = await createUser(owner);
  const replacement = await createUser(owner);
  const firstActivation = await createUser(owner);
  const excluded = await createUser(owner);
  const seed = async (userId: string, versions: number) =>
    owner.query(
      `
    INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg,
      weights, intercept, scaler, calibration, metrics, active, trained_at)
    SELECT $1, g, 'v1', g, g, 0, '{"features":[],"weights":[]}', 0, '{}', '{}',
      CASE WHEN g = 1 THEN '{"status":"activated","cvAuc":0.75,"baselineAuc":0.65,"engineModel":"jev-old"}'::jsonb
           WHEN g = 2 THEN '{"status":"rejected","reason":"low_auc","cvAuc":0.51}'::jsonb ELSE '{}'::jsonb END,
      false, '2026-01-01'::timestamptz + g * interval '1 minute'
    FROM generate_series(1, $2::int) g`,
      [userId, versions],
    );
  await seed(user.id, 205);
  await seed(other.id, 3);
  await seed(tied.id, 4);
  await owner.query(
    `UPDATE user_models SET metrics = '{"status":"rejected","reason":"low_auc"}' WHERE user_id = $1 AND version = 4`,
    [tied.id],
  );
  await seed(replacement.id, 2);
  await seed(firstActivation.id, 3);
  await seed(excluded.id, 4);
  await owner.query(
    `UPDATE user_models SET weights = CASE WHEN version = 1 THEN '{}'::jsonb ELSE weights END,
      metrics = CASE WHEN version = 1 THEN '{"status":"rejected","reason":"insufficient_explicit"}'::jsonb
        WHEN version = 2 THEN '{"status":"superseded","reason":"inputs_changed"}'::jsonb
        WHEN version = 3 THEN '{"status":"activated"}'::jsonb
        ELSE '{"status":"rejected","reason":"low_auc"}'::jsonb END WHERE user_id = $1`,
    [excluded.id],
  );
  await owner.query(
    `UPDATE user_models SET metrics = CASE WHEN version < 3 THEN '{"status":"rejected"}'::jsonb ELSE '{"status":"activated"}'::jsonb END WHERE user_id = $1`,
    [firstActivation.id],
  );
  await owner.query(
    `UPDATE user_models SET metrics = '{"status":"activated"}' WHERE user_id = $1`,
    [replacement.id],
  );
  await owner.query(
    `UPDATE user_models SET trained_at = '2026-01-02', n_labels = 3 WHERE user_id = $1 AND version >= 3`,
    [tied.id],
  );
  await owner.query(
    `INSERT INTO user_estimate_models
    (user_id, version, spec, trained_at, n, n_pos, n_neg, intercept, weights, platt, metrics)
    SELECT $1, g, 'v1', '2026-03-01'::timestamptz + g * interval '1 minute', g, g, 0, 0, '{}', '{}', '{}'
    FROM generate_series(1, 205) g`,
    [user.id],
  );
  await owner.query(
    `INSERT INTO user_estimate_models
    (user_id, version, spec, trained_at, n, n_pos, n_neg, intercept, weights, platt, metrics)
    VALUES ($1, 7, 'v1', '2026-02-01', 20, 10, 10, 0, '{}', '{}', '{"auc":0.7}')`,
    [other.id],
  );
  // Existing PRG rows use their append time, which can differ from trained_at.
  await owner.query(
    `INSERT INTO user_learning_history
    (user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model)
    VALUES ($1, '2026-01-01 00:01:00.050Z', 'model', 1, 0.75, 0.65, true, true, 'jev-old')`,
    [other.id],
  );
  await runMigrations({ databaseUrl: previous.urls.owner });
  const read = () =>
    owner.query(`SELECT id, user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model, reason
    FROM user_learning_history ORDER BY user_id, kind, at, id`);
  const first = (await read()).rows;
  expect.soft(first.filter((r) => r.user_id === excluded.id).map((r) => r.n)).toEqual([3, 4]);
  expect.soft(first.find((r) => r.user_id === excluded.id && r.n === 3)?.turned_on).toBe(true);
  expect
    .soft(first.every((r) => typeof r.activated === 'boolean' && typeof r.turned_on === 'boolean'))
    .toBe(true);
  expect
    .soft(first.filter((r) => r.kind === 'estimate').every((r) => r.activated === false))
    .toBe(true);
  const models = first.filter((r) => r.user_id === user.id && r.kind === 'model');
  const estimates = first.filter((r) => r.user_id === user.id && r.kind === 'estimate');
  expect(estimates).toHaveLength(200);
  expect(estimates[0].n).toBe(6);
  expect(estimates[0].turned_on).toBe(false);
  expect(first.filter((r) => r.user_id === replacement.id).map((r) => r.turned_on)).toEqual([
    true,
    false,
  ]);
  expect(first.filter((r) => r.user_id === firstActivation.id).map((r) => r.turned_on)).toEqual([
    false,
    false,
    true,
  ]);
  expect(models).toHaveLength(200);
  expect(models[0].n).toBe(6);
  expect(first.filter((r) => r.user_id === tied.id)).toHaveLength(4);
  expect(first.filter((r) => r.user_id === tied.id && r.n === 3).map((r) => r.reason)).toEqual(
    expect.arrayContaining([null, 'low_auc']),
  );
  const rows = first.filter((r) => r.user_id === other.id);
  expect(rows).toHaveLength(4);
  expect(rows.find((r) => r.kind === 'model' && r.n === 1)).toMatchObject({
    activated: true,
    turned_on: true,
    engine_model: 'jev-old',
  });
  expect(rows.find((r) => r.kind === 'model' && r.n === 2)).toMatchObject({
    auc: 0.51,
    baseline_auc: null,
    activated: false,
    turned_on: false,
    reason: 'low_auc',
  });
  expect(rows.find((r) => r.kind === 'model' && r.n === 3)).toMatchObject({
    auc: null,
    baseline_auc: null,
    activated: false,
    turned_on: false,
    engine_model: null,
    reason: null,
  });
  expect(rows.find((r) => r.kind === 'estimate')).toMatchObject({
    n: 20,
    auc: 0.7,
    baseline_auc: null,
    activated: false,
    turned_on: false,
    engine_model: null,
    reason: null,
  });
  const migration = await readFile(
    path.join(MIGRATIONS_FOLDER, '0037_learning_history_backfill.sql'),
    'utf8',
  );
  // Repeat the data section as well as the normal journal-protected migrate job.
  await owner.query(migration.slice(migration.indexOf('-- Backfill')));
  await runMigrations({ databaseUrl: previous.urls.owner });
  expect((await read()).rows).toEqual(first);
});
