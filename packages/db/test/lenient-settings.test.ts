import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';

import { parseSetting, readSetting } from '@bantoozi/shared';

import type { Executor } from '../src/client.js';
import { updateSettingLocked } from '../src/settings.js';

it('preserves future fields through a locked update while validating the known write', async () => {
  const current = {
    model: 'jev-1.2.3',
    since: '2026-10-01T00:00:00Z',
    llm: { fast: 'a', strong: 'b', future: 2 },
    future: 1,
  };
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (query: never) => {
      const statement = new PgDialect().sqlToQuery(query);
      statements.push(statement);
      return { rowCount: 1, rows: [{ value: current }] };
    },
  } as unknown as Executor;
  await updateSettingLocked(
    tx,
    'engine.model_pin',
    { model: 'jev-1.2.3', since: '2026-10-01T00:00:00Z' },
    (raw) => {
      const pin = readSetting('engine.model_pin', raw, {
        dailyBudgetUsd: 1,
        languageModes: {},
        signupMode: 'invite',
      })!;
      return parseSetting('engine.model_pin', { ...pin, llm: { ...pin.llm, fast: 'new' } });
    },
  );
  const written = JSON.parse(
    statements.find((s) => s.sql.includes('UPDATE settings'))!.params[0] as string,
  );
  expect(written).toEqual({ ...current, llm: { ...current.llm, fast: 'new' } });
});
