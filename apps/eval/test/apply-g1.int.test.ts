import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDatabase,
  createGateLock,
  findGateLocks,
  G1_SETTING_KEYS,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  recordGateOutcome,
  runMigrations,
  type Database,
  type GateLockConfig,
} from '@bantoozi/db';
import {
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
  type UserFixture,
} from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCli } from '../src/cli.js';
import { g1ConfigSha, G1Schema, type G1File } from '../src/report/g1-schema.js';
import { createEvalRuntime } from '../src/runtime.js';
import { seedGateDatabase, type SeededGateDb } from './gate-fixtures.js';

/**
 * M3a-T7 (spec 10 §1): `eval apply-g1` writes exactly the settings of the mapping table, bumps
 * `ranker.settings_version` only for changed thresholds, records the settings flow's side-effect
 * intents in the outbox, and refuses failed, edited, incomplete or dry-run artifacts.
 */

const NOW = new Date('2026-10-01T08:00:00Z');
const DAY = 24 * 3_600_000;
let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let seeded: SeededGateDb;
let dir: string;
let g1Path: string;
let reportPath: string;
let g1: G1File;
let active: UserFixture;
let inactive: UserFixture;
let deleted: UserFixture;

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

async function settingsSnapshot(): Promise<Map<string, string>> {
  const result = await owner.query<{ key: string; value: string }>(
    'SELECT key, value::text AS value FROM settings ORDER BY key',
  );
  return new Map(result.rows.map((r) => [r.key, r.value]));
}

async function outbox(): Promise<
  { id: string; queue: string; payload: Record<string, unknown> }[]
> {
  const result = await owner.query<{ id: string; queue: string; payload: Record<string, unknown> }>(
    'SELECT id::text AS id, queue, payload FROM job_outbox ORDER BY id',
  );
  return result.rows;
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

async function writeVariant(name: string, patch: (g: G1File) => unknown): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(patch(structuredClone(g1))), 'utf8');
  return file;
}

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'eval-apply-g1',
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'eval-apply-'));
  g1Path = path.join(dir, 'g1.json');
  reportPath = path.join(dir, 'G1.md');
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
  g1 = G1Schema.parse(JSON.parse(await readFile(g1Path, 'utf8')));
  expect(g1.gate.status).toBe('pass');

  active = await createUser(owner, { lastActiveAt: new Date(NOW.getTime() - DAY) });
  inactive = await createUser(owner, { lastActiveAt: new Date(NOW.getTime() - 30 * DAY) });
  deleted = await createUser(owner, {
    lastActiveAt: new Date(NOW.getTime() - DAY),
    deletedAt: new Date(NOW.getTime() - DAY),
  });
  // Stored values chosen so that thresholds, budget and the SK mode change, while the card mode
  // and the tier-2 cap (a missing row at its default) do not.
  const sk = g1.language_modes['sk'] === 'translate' ? 'native' : 'translate';
  await setSetting('language_modes', { en: 'native', sk, cs: 'translate' });
  await setSetting('card_text_mode', g1.card_text_mode);
  await setSetting('engine.daily_budget_usd', g1.recommended_daily_budget_usd + 1);
  await setSetting('ranker.settings_version', 4);
  await owner.query(
    `DELETE FROM settings WHERE key IN ('ranker.thresholds', 'translate.tier2_daily_cap')`,
  );
  expect(g1.translate_tier2_daily_cap).toBe(300);
}, 180_000);

afterAll(async () => {
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe('eval apply-g1 refusals', () => {
  it.each([
    [
      'a gate other than pass',
      (g: G1File) => ({ ...g, gate: { ...g.gate, status: 'fail' } }),
      /gate status is fail/,
    ],
    [
      'edited thresholds',
      (g: G1File) => ({
        ...g,
        ranker_thresholds: { ...g.ranker_thresholds, lanes: { forYou: 0.9, maybe: 0.2 } },
      }),
      /config hash mismatch/,
    ],
    [
      'a dry-run artifact',
      (g: G1File) => ({ ...g, dryRun: true }),
      /dry-run artifact cannot be applied/,
    ],
    [
      'a missing run',
      (g: G1File) => {
        const runs = { ...g.runs, E1: '999999' };
        return {
          ...g,
          runs,
          selection: {
            ...g.selection,
            configSha: g1ConfigSha({ ...g, runs, profile: g.gate.profile }),
          },
        };
      },
      /run 999999 does not exist/,
    ],
    [
      'a dataset hash mismatch',
      (g: G1File) => {
        const dataset = { ...g.dataset, splitSha: 'e'.repeat(64) };
        return {
          ...g,
          dataset,
          selection: {
            ...g.selection,
            configSha: g1ConfigSha({ ...g, dataset, profile: g.gate.profile }),
          },
        };
      },
      /dataset golden-v1 hash mismatch/,
    ],
    [
      'a re-hashed selection the gate never locked',
      (g: G1File) => {
        const value = { ...g, recommended_daily_budget_usd: 50 };
        return {
          ...value,
          selection: {
            ...g.selection,
            configSha: g1ConfigSha({ ...value, profile: g.gate.profile }),
          },
        };
      },
      /no gate lock records this selection/,
    ],
    [
      'an edited participant count',
      (g: G1File) => ({ ...g, gate: { ...g.gate, participants: 3 } }),
      /participant count mismatch: g1\.json claims 3, the gate lock records 1/,
    ],
    ['an invalid file', () => ({ language_modes: {} }), /invalid g1\.json/],
  ])('refuses %s and writes nothing', async (_name, patch, message) => {
    const before = await settingsSnapshot();
    const outboxBefore = (await outbox()).length;
    const file = await writeVariant(`${_name.replace(/\W+/g, '-')}.json`, patch);
    await expect(evalCli(['apply-g1', file])).rejects.toThrow(message);
    expect(await settingsSnapshot()).toEqual(before);
    expect(await outbox()).toHaveLength(outboxBefore);
  });

  it('refuses an incomplete run', async () => {
    const id = seeded.runIds['B1']!;
    await owner.query(
      `UPDATE eval.runs SET results = jsonb_set(results, '{status}', '"partial"') WHERE id = $1`,
      [id],
    );
    try {
      await expect(evalCli(['apply-g1', g1Path])).rejects.toThrow(
        new RegExp(`run ${id} is incomplete`),
      );
    } finally {
      await owner.query(
        `UPDATE eval.runs SET results = jsonb_set(results, '{status}', '"complete"') WHERE id = $1`,
        [id],
      );
    }
  });

  it('refuses an artifact with dryRun stripped when the gate lock records a dry run', async () => {
    // The lock is a dry-run lock (as in a restored or renamed dry-run database); the file is the
    // same artifact without its `dryRun` mark, so its config hash still matches.
    // A lock's config is immutable: replace the row with the same results and the mark changed.
    const set = async (value: boolean) => {
      const lock = (await findGateLocks(db, g1.dataset.version)).find(
        (l) => (l.config as { configSha?: unknown }).configSha === g1.selection.configSha,
      )!;
      await owner.query('DELETE FROM eval.runs WHERE id = $1', [lock.id]);
      const created = await createGateLock(db, {
        gitSha: lock.gitSha,
        config: { ...(lock.config as unknown as GateLockConfig), dryRun: value },
      });
      await recordGateOutcome(
        db,
        created.id,
        lock.results as { status: 'pass'; reportSha: string } & Record<string, unknown>,
      );
    };
    const before = await settingsSnapshot();
    expect(g1.dryRun).toBeUndefined();
    await set(true);
    try {
      await expect(evalCli(['apply-g1', g1Path])).rejects.toThrow(
        /gate lock records a dry run[\s\S]*dry-run mismatch: g1\.json says not a dry run, the gate lock says dry run/,
      );
    } finally {
      await set(false);
    }
    expect(await settingsSnapshot()).toEqual(before);
  });

  it('hashes the dry-run mark: adding it breaks the hash, re-hashing it contradicts the lock', async () => {
    const marked = await writeVariant('marked.json', (g) => ({ ...g, dryRun: true }));
    await expect(evalCli(['apply-g1', marked])).rejects.toThrow(/config hash mismatch/);
    const rehashed = await writeVariant('rehashed.json', (g) => {
      const value = { ...g, dryRun: true };
      return {
        ...value,
        selection: {
          ...g.selection,
          configSha: g1ConfigSha({ ...value, profile: g.gate.profile }),
        },
      };
    });
    await expect(evalCli(['apply-g1', rehashed])).rejects.toThrow(
      /no gate lock records this selection/,
    );
    // Without the mark the artifact hashes as before (real artifacts are unaffected).
    expect(g1ConfigSha({ ...g1, profile: g1.gate.profile })).toBe(g1.selection.configSha);
  });

  it('refuses a report that does not match its hash', async () => {
    const other = path.join(dir, 'other.md');
    await writeFile(other, 'not the report', 'utf8');
    await expect(evalCli(['apply-g1', g1Path, '--report', other])).rejects.toThrow(
      /report hash mismatch/,
    );
  });
});

describe('eval apply-g1', () => {
  it('writes exactly the settings of the spec 10 §1 mapping table and enqueues their side effects', async () => {
    const before = await settingsSnapshot();
    const outboxBefore = await outbox();
    const printed = await evalCli(['apply-g1', g1Path, '--report', reportPath]);
    expect(printed).toContain('applied G1 (owner_pilot, 1 participant(s): one-person evidence');
    const after = await settingsSnapshot();
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((key) => before.get(key) !== after.get(key))
      .sort();
    expect(changed).toEqual(
      [
        'engine.daily_budget_usd',
        'language_modes',
        'ranker.settings_version',
        'ranker.thresholds',
      ].sort(),
    );
    expect(changed.every((key) => (G1_SETTING_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(JSON.parse(after.get('ranker.thresholds')!)).toEqual(g1.ranker_thresholds);
    expect(JSON.parse(after.get('ranker.settings_version')!)).toBe(5);
    expect(JSON.parse(after.get('engine.daily_budget_usd')!)).toBe(g1.recommended_daily_budget_usd);
    // Measured languages are applied; an unmeasured one keeps its stored mode.
    expect(JSON.parse(after.get('language_modes')!)).toEqual({
      ...g1.language_modes,
      cs: 'translate',
    });
    expect(after.has('translate.tier2_daily_cap')).toBe(false);

    const added = (await outbox()).filter((row) => !outboxBefore.some((b) => b.id === row.id));
    expect(added.map((r) => [r.queue, r.payload]).sort()).toEqual(
      [
        ['house.reenrich', { lang: 'sk' }],
        ['user.rank', { userId: active.id, reason: 'apply-g1', full: true }],
      ].sort(),
    );
    expect(
      added.some((r) => r.payload['userId'] === inactive.id || r.payload['userId'] === deleted.id),
    ).toBe(false);
  });

  it('changes nothing and bumps no version when applied again', async () => {
    const before = await settingsSnapshot();
    const outboxBefore = (await outbox()).length;
    const printed = await evalCli(['apply-g1', g1Path]);
    expect(printed).toContain('changed: nothing');
    expect(printed).toContain('ranker.settings_version: 5');
    expect(await settingsSnapshot()).toEqual(before);
    expect(await outbox()).toHaveLength(outboxBefore);
  });

  it('changes the card mode with a rematch and card translations', async () => {
    await setSetting('card_text_mode', g1.card_text_mode === 'english' ? 'as_written' : 'english');
    const outboxBefore = await outbox();
    await evalCli(['apply-g1', g1Path]);
    const added = (await outbox()).filter((row) => !outboxBefore.some((b) => b.id === row.id));
    const queues = added.map((r) => r.queue).sort();
    expect(queues).toEqual(
      g1.card_text_mode === 'english'
        ? ['house.rematch', 'house.translate-cards']
        : ['house.rematch'],
    );
  });
});
