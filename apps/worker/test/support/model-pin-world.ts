import { createDatabase, type Database } from '@bantoozi/db';
import type { EngineModelPin } from '@bantoozi/shared';
import type pg from 'pg';

import { runSeed } from '../../src/seed.js';
import type { recordModelPin } from '../../src/model-pin.js';

/** The pin a worker derives from its config: `llm` exists only while the fallback is on. */
export interface WorkerPin {
  model: string;
  llm?: { fast: string; strong: string };
}

export const LAYA = { checkpointSha: 'a'.repeat(64), calibrationVersion: 'cal-1' } as const;

/**
 * `runSeed` with the worker's pin. Assumption (the brief leaves the seam open): the pin comes in
 * through the settings environment as `modelPin`. Change it here only if the implementation picks
 * another seam.
 */
export function seedWithPin(db: Database, pin: WorkerPin) {
  const env = {
    dailyBudgetUsd: 5,
    languageModes: { en: 'native', sk: 'native', cs: 'native' },
    signupMode: 'invite',
    modelPin: pin,
  } as const;
  return runSeed(db, env as never);
}

/** `recordModelPin`, imported lazily so a missing module fails each test, not the file. */
export async function callRecordModelPin(
  db: Database,
  pin: WorkerPin,
  now: Date,
  options: Parameters<typeof recordModelPin>[3] = {},
): ReturnType<typeof recordModelPin> {
  const mod = (await import('../../src/model-pin.js')) as {
    recordModelPin: typeof recordModelPin;
  };
  return mod.recordModelPin(db, pin, now, options);
}

export const dbOf = (pool: pg.Pool) => createDatabase(pool);

export async function pinRow(owner: pg.Pool): Promise<EngineModelPin | undefined> {
  const result = await owner.query<{ value: EngineModelPin }>(
    `SELECT value FROM settings WHERE key = 'engine.model_pin'`,
  );
  return result.rows[0]?.value;
}

export async function pinIntents(owner: pg.Pool): Promise<{ queue: string; payload: unknown }[]> {
  const result = await owner.query<{ queue: string; payload: unknown }>(
    `SELECT queue, payload FROM job_outbox WHERE queue IN ('house.reenrich', 'house.rematch')
      ORDER BY queue, id`,
  );
  return result.rows;
}

export async function resetPin(owner: pg.Pool, value?: unknown): Promise<void> {
  await owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
  await owner.query('DELETE FROM job_outbox');
  if (value !== undefined) {
    await owner.query(`INSERT INTO settings (key, value) VALUES ('engine.model_pin', $1::jsonb)`, [
      JSON.stringify(value),
    ]);
  }
}
