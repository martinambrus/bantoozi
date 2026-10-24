import { HOUSE_PROGRESS_CURSORS } from '../src/jobs.js';
import {
  KeyringOverviewSchema,
  AdminEngineModelSchema,
  AdminSettingsValuesSchema,
  AdminSettingsPatchSchema,
} from '../src/dto/admin.js';
import { readRuntimeSetting, validateRuntimeSetting } from '../src/runtime-settings.js';
import { describe, expect, it } from 'vitest';

import {
  parseSetting,
  readSetting,
  settingDefault,
  SETTINGS,
  type SettingKey,
} from '../src/settings.js';

import { preserveUnknownFields, readerSchema } from '../src/setting-readers.js';
import { z } from 'zod';

const at = '2026-10-01T00:00:00Z';
const env = { dailyBudgetUsd: 2, languageModes: {}, signupMode: 'invite' as const };
const breaker = { state: 'closed', reopenCount: 0 };
const probe = { requested: 'jev-1.2.3', ok: true, at };
const fixtures: Partial<Record<SettingKey, unknown>> = {
  'engine.circuit': { typesafe: breaker, llm: breaker, resetRequested: {} },
  'engine.budget_alerts': { day: '2026-10-01' },
  'engine.laya': { enrich: ['en'] },
  'engine.model_pin': { model: 'jev-1.2.3', since: at, llm: { fast: 'a', strong: 'b' } },
  'engine.model_resolution': {
    alias: 'jev-latest',
    model: 'jev-1.2.3',
    resolvedAt: at,
    checkedAt: at,
    previous: { model: 'jev-1.2.2', until: at },
  },
  'engine.model_probe': { 'jev-1.2.3': probe },
  'engine.model_watch': {
    triggeredAt: at,
    lastCheck: { at, ok: true },
    notice: { from: 'jev-1.2.2', to: 'jev-1.2.3', at, major: false, attempts: 0 },
  },
  'engine.model_candidate': { model: 'jev-1.2.3', firstSeenAt: at, count: 1 },
  'engine.model_impact': { at, activeModels: 3 },
  'engine.rating_fingerprints': {
    ['a'.repeat(64)]: { family: 'b'.repeat(64), settings: {}, firstSeenAt: at },
  },
  'engine.ollama_models': { fast: 'a', strong: 'b' },
  'fetch.limits': { timeoutMs: 1000, maxBytes: 65536 },
  'auth.setup': { digest: 'a'.repeat(64), createdAt: at },
  'ranker.thresholds': { lanes: { forYou: 0.7 }, model: { lambdaGrid: [1, 3] } },
  'question_sets.active': { enrich: '1' },
  'ops.events': [{ kind: 'test', detail: '', at }],
  'house.progress': { 'house.purge-auth': { updatedAt: at, version: 1 } },
  'alerts.state': { test: { firstAt: at, lastSentAt: null, active: true } },
  'worker.heartbeat': {
    worker: {
      at,
      queues: ['feed.fetch'],
      evalIngestOnly: false,
      envCredentials: [],
      pool: { total: 1, idle: 1, waiting: 0 },
    },
  },
};

// Records have meaningful keys; add future fields only to schema objects, at every depth.
const records = new Set([
  'engine.model_probe',
  'engine.rating_fingerprints',
  'house.progress',
  'alerts.state',
  'worker.heartbeat',
]);
function extend(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(extend);
  if (value === null || typeof value !== 'object') return value;
  return {
    ...Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'settings' ? v : extend(v)]),
    ),
    future: { version: 2 },
  };
}

const settingFixtures = fixtures;
function futureSetting(key: SettingKey, value: unknown): unknown {
  return records.has(key)
    ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, extend(v)]))
    : extend(value);
}

function corruptKnown(value: unknown): unknown {
  if (Array.isArray(value)) return [corruptKnown(value[0]), ...value.slice(1)];
  if (value !== null && typeof value === 'object') {
    const [first, ...rest] = Object.entries(value);
    return first
      ? Object.fromEntries([[first[0], corruptKnown(first[1])], ...rest])
      : { invalid: true };
  }
  return { invalid: true };
}

describe('stored settings from a newer release', () => {
  for (const [name, value] of Object.entries(fixtures)) {
    const key = name as SettingKey;
    it(`${key}: strips future fields while writes remain strict`, () => {
      const canonical = parseSetting(key, value);
      const future = futureSetting(key, value);
      expect(readSetting(key, future, env)).toEqual(canonical);
      expect(() => parseSetting(key, future)).toThrow();
      expect(() => readSetting(key, corruptKnown(value), env)).toThrow();
      expect(preserveUnknownFields(SETTINGS[key].schema, future, canonical)).toEqual(future);
    });
  }
  it('still rejects invalid known fields', () => {
    expect(() =>
      readSetting('engine.model_pin', { model: 123, since: at, future: true }, env),
    ).toThrow();
    expect(() =>
      readSetting('ranker.thresholds', { model: { lambdaGrid: [3, 1] }, future: true }, env),
    ).toThrow();
    expect(() => readSetting('auth.setup', { createdAt: at, future: true }, env)).toThrow();
  });
});

it('derives readers through wrappers, arrays, tuples, records, lazy objects and discriminated unions without losing checks', () => {
  const leaf = z
    .object({ n: z.number().int().min(1) })
    .strict()
    .refine((v) => v.n !== 2, 'two is forbidden');
  const schema = z
    .object({
      optional: leaf.optional(),
      nullable: leaf.nullable(),
      defaulted: leaf.default({ n: 1 }),
      list: z.array(leaf).min(1).max(2),
      tuple: z.tuple([leaf]),
      record: z.record(z.string(), leaf),
      union: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), leaf }).strict(),
        z.object({ kind: z.literal('b'), n: z.number() }).strict(),
      ]),
      lazy: z.lazy(() => leaf),
    })
    .strict();
  const item = { n: 1, future: true };
  const future = {
    optional: item,
    nullable: item,
    list: [item],
    tuple: [item],
    record: { x: item },
    union: { kind: 'a', leaf: item, future: 1 },
    lazy: item,
    future: 1,
  };
  const read = readerSchema(schema);
  expect(read).toBe(readerSchema(schema));
  expect(read.parse(future)).toEqual({
    optional: { n: 1 },
    nullable: { n: 1 },
    defaulted: { n: 1 },
    list: [{ n: 1 }],
    tuple: [{ n: 1 }],
    record: { x: { n: 1 } },
    union: { kind: 'a', leaf: { n: 1 } },
    lazy: { n: 1 },
  });
  expect(() => schema.parse(future)).toThrow();
  expect(() => read.parse({ ...future, optional: { n: 2 } })).toThrow('two is forbidden');
  expect(() => read.parse({ ...future, list: [] })).toThrow();
  expect(() => read.parse({ ...future, nullable: { n: '1' } })).toThrow();
  expect(read.parse({ ...future, nullable: null }).nullable).toBeNull();
});

it('preserves future siblings while removing known fields and record entries deliberately', () => {
  const schema = z
    .object({
      child: z.object({ n: z.number(), optional: z.string().optional() }).strict(),
      entries: z.record(z.string(), z.object({ n: z.number() }).strict()),
    })
    .strict();
  const old = {
    child: { n: 1, optional: 'remove', future: 1 },
    entries: { keep: { n: 1, future: 2 }, remove: { n: 2, future: 3 } },
    future: 4,
  };
  const next = schema.parse({ child: { n: 2 }, entries: { keep: { n: 2 } } });
  expect(preserveUnknownFields(schema, old, next)).toEqual({
    child: { n: 2, future: 1 },
    entries: { keep: { n: 2, future: 2 } },
    future: 4,
  });
});

it('preserves array entry extras after append, removal and reordering', () => {
  const schema = z.array(z.object({ id: z.number() }).strict());
  expect(
    preserveUnknownFields(
      schema,
      [
        { id: 1, future: 'one' },
        { id: 2, future: 'two' },
      ],
      [{ id: 2 }, { id: 3 }],
    ),
  ).toEqual([{ id: 2, future: 'two' }, { id: 3 }]);
});

it('uses reader schemas for runtime settings and keeps proposed writes strict', () => {
  const ctx = { production: false, providerHostAllowlist: [], ollamaPricedModels: ['a', 'b'] };
  const limits = { timeoutMs: 1000, maxBytes: 65536, future: true };
  expect(readRuntimeSetting('fetch.limits', limits, ctx)).toEqual({
    ok: true,
    value: { timeoutMs: 1000, maxBytes: 65536 },
  });
  expect(validateRuntimeSetting('fetch.limits', limits, ctx).ok).toBe(false);
  expect(readRuntimeSetting('fetch.limits', { ...limits, maxBytes: 'bad' }, ctx).ok).toBe(false);
  expect(
    readRuntimeSetting('engine.ollama_models', { fast: 'a', strong: 'b', future: true }, ctx),
  ).toEqual({ ok: true, value: { fast: 'a', strong: 'b' } });
});

it('reads setting-shaped response DTOs without loosening request DTOs', () => {
  const values = Object.fromEntries(
    Object.keys(AdminSettingsValuesSchema.shape).map((name) => {
      const key = name as SettingKey;
      return [key, settingFixtures[key] ?? settingDefault(key, env) ?? null];
    }),
  );
  expect(
    AdminSettingsValuesSchema.safeParse({
      ...values,
      'ranker.thresholds': futureSetting('ranker.thresholds', fixtures['ranker.thresholds']),
      future: true,
    }).success,
  ).toBe(true);
  const model = {
    now: at,
    setting: { value: 'jev-1.2.3', source: 'stored' },
    resolution: futureSetting('engine.model_resolution', fixtures['engine.model_resolution']),
    pin: { model: 'jev-1.2.3', since: at, future: true },
    watch: { lastCheck: { at, ok: true, future: true } },
    probes: futureSetting('engine.model_probe', fixtures['engine.model_probe']),
    impact: { at, activeModels: 1, future: true },
  };
  expect(AdminEngineModelSchema.safeParse(model).success).toBe(true);
  expect(
    AdminSettingsPatchSchema.safeParse({ 'engine.laya': { enrich: ['en'], future: true } }).success,
  ).toBe(false);
});

it('keeps distinct extensions on duplicate events and does not copy them to a newly appended event', () => {
  const schema = z.array(z.object({ id: z.number() }).strict());
  expect(
    preserveUnknownFields(
      schema,
      [
        { id: 1, future: 'first' },
        { id: 1, future: 'second' },
      ],
      [{ id: 1 }, { id: 1 }, { id: 1 }],
    ),
  ).toEqual([{ id: 1, future: 'first' }, { id: 1, future: 'second' }, { id: 1 }]);
});

it('derives lenient readers for every typed housekeeping cursor while writes reject extensions', () => {
  const fixtures = {
    'house.rescore-degraded': { enrich: { key: at, articleId: '1', future: true }, future: true },
    'house.reenrich': { pending: [{ future: true }], future: true },
    'house.rematch': { pending: [{ future: true }], future: true },
    'house.purge-articles': { sweeps: { articles: '1' }, future: true },
    'house.purge-bodies': { sweeps: { bodies: '1' }, future: true },
    'house.retire-cards': { sweeps: { cards: '1' }, future: true },
    'house.reconcile': { sweeps: { rank: '1' }, future: true },
    'house.translate-cards': { after: '1', future: true },
    'house.purge-users': {
      failed: { ledger: 1, db: 0, blocked: 0, future: true },
      at,
      future: true,
    },
  };
  for (const [job, schema] of Object.entries(HOUSE_PROGRESS_CURSORS)) {
    const value = fixtures[job as keyof typeof fixtures];
    expect(readerSchema(schema).safeParse(value).success, job).toBe(true);
    expect(schema.safeParse(value).success, job).toBe(false);
  }
});

it('strips future fields from keyring response DTOs without removing required known fields', () => {
  expect(
    KeyringOverviewSchema.parse({
      api: { status: 'ok', activeKeyId: 'k1', future: true },
      workers: [{ workerId: 'w1', status: 'ok', future: true }],
      mismatch: false,
    }),
  ).toEqual({
    api: { status: 'ok', activeKeyId: 'k1' },
    workers: [{ workerId: 'w1', status: 'ok' }],
    mismatch: false,
  });
});

it('removes known fields of previous union branches while preserving future fields', () => {
  const schema = HOUSE_PROGRESS_CURSORS['house.purge-users'];
  const next = { failed: { ledger: 1, db: 0, blocked: 0 }, at };
  const written = preserveUnknownFields(
    schema,
    { disabled: 'ledger_unconfigured', future: 1 },
    next,
  );
  expect(written).toEqual({ ...next, future: 1 });
  expect(readerSchema(schema).parse(written)).toEqual(next);
});

it('ignores a future housekeeping job key while strict writers reject it and write-back preserves it', () => {
  const known = { updatedAt: at, version: 1 };
  const row = { 'house.purge-auth': known, 'house.future-job': { ...known, future: true } };
  const read = readSetting('house.progress', row, env);
  expect(read).toEqual({ 'house.purge-auth': known });
  expect(() => parseSetting('house.progress', row)).toThrow();
  expect(preserveUnknownFields(SETTINGS['house.progress'].schema, row, read)).toEqual(row);
});
