import { JEV_FAKE_MODEL } from '@bantoozi/engine';
import type { Database } from '@bantoozi/db';
import type { EngineModelProbe } from '@bantoozi/shared';
import { createLogger, type EmailMessage, type Mailer } from '@bantoozi/shared/server';
import { createUser, type FakeTypeSafeServer } from '@bantoozi/testing';
import type pg from 'pg';
import { vi } from 'vitest';

import { createWorkerCredentialResolver } from '../../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../../src/engine-router.js';
import { createModelWatchHandler } from '../../src/handlers/house-model-watch.js';
import { createModelProber, type ModelProber } from '../../src/model-probe.js';
import { enqueueModelWatchNow } from '../../src/model-watch.js';

import type { ClassifyHarness } from './classify.js';
import { recorder, type Recorder } from './m8b-t5-world.js';

/**
 * Shared fixtures of the `house.model-watch` tests (model-watch*.int.test.ts): a fixed clock, a
 * recording mailer, scripted and real probers over the fake TypeSafe server, admin fixtures and
 * readers of the rows the job writes. The tests build the handler through {@link loadWatchHandler}
 * with these loosely typed deps and queue a check through {@link enqueueWatchNow}.
 */

export const ALIAS = 'jev-latest';
export const V113 = 'jev-1.13.0';
export const V114 = 'jev-1.14.0';
export const V115 = 'jev-1.15.0';
export const V2 = 'jev-2.0.0';
export const ARROW = '→';

export const API_KEY = 'model-watch-env-key-0001';

/** The fake clock of a run: the handler must take every timestamp from its injected `now`. */
export const NOW = new Date('2026-10-21T12:00:00.000Z');
export const LATER = new Date('2026-10-21T18:00:00.000Z');
export const STORED_AT = '2026-10-10T08:00:00.000Z';

export const iso = (at: Date): string => at.toISOString();

// ── The handler contract ──────────────────────────────────────────────────────────────────────────

export interface WatchProber {
  probe(requested: string, options?: { signal?: AbortSignal }): Promise<EngineModelProbe>;
}

export interface WatchDeps {
  db: Database;
  prober: WatchProber;
  logger: Recorder['logger'];
  configuredModel(): Promise<string>;
  settingsEnv: ClassifyHarness['settingsEnv'];
  mailer?: Mailer;
  adminEmails?: readonly string[];
  now?: () => Date;
}

export type WatchHandler = (
  payload: Record<string, never>,
  context: { queue: 'house.model-watch'; jobId: string },
) => Promise<void>;

/** `createModelWatchHandler` over the loosely typed fixture deps. */
export async function loadWatchHandler(deps: WatchDeps): Promise<WatchHandler> {
  return createModelWatchHandler(deps as unknown as Parameters<typeof createModelWatchHandler>[0]);
}

/** `enqueueModelWatchNow`. */
export async function enqueueWatchNow(db: Database): Promise<void> {
  await enqueueModelWatchNow(db);
}

export const watchContext = (jobId = 'model-watch-test') =>
  ({ queue: 'house.model-watch', jobId }) as const;

// ── Mail ──────────────────────────────────────────────────────────────────────────────────────────

/** The recipient addresses of a recorded message (`to` may list several). */
export const addressesOf = (message: EmailMessage): string[] =>
  message.to
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter((address) => address !== '');

/**
 * An in-memory {@link Mailer}: records the accepted messages; throws for every address in
 * `rejecting`, or for all of them while `failing`.
 */
export class WatchMailer implements Mailer {
  readonly transport = 'log' as const;
  /** Accepted messages only. */
  readonly sent: EmailMessage[] = [];
  /** Every `send` call, accepted or not. */
  attempts = 0;
  failing = false;
  readonly rejecting = new Set<string>();

  send(message: EmailMessage): Promise<void> {
    this.attempts += 1;
    const refused =
      this.failing || addressesOf(message).some((address) => this.rejecting.has(address));
    if (refused) return Promise.reject(new Error('smtp unavailable'));
    this.sent.push({ ...message });
    return Promise.resolve();
  }

  lastEmail(): EmailMessage | undefined {
    return this.sent.at(-1);
  }

  close(): void {
    return undefined;
  }

  /** Accepted messages that reached `address`. */
  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => addressesOf(message).includes(address.toLowerCase()));
  }
}

/** The mail oracle (U+2192 arrows): subject and sentence of a same-major / other-major upgrade. */
export const sameMajorMail = (from: string, to: string) => ({
  subject: `[Bantoozi] Jev updated: ${from} ${ARROW} ${to}`,
  sentence: `Jev ${from} ${ARROW} ${to}: ratings and personal models kept`,
});
export const majorMail = (from: string, to: string) => ({
  subject: `[Bantoozi] Jev major update: ${from} ${ARROW} ${to}`,
  sentence: `Jev ${from} ${ARROW} ${to}: major change: personal models restart from new ratings`,
});

// ── Probers ───────────────────────────────────────────────────────────────────────────────────────

export const okProbe = (model: string, at: Date = NOW): EngineModelProbe => ({
  requested: ALIAS,
  answered: model,
  ok: true,
  at: iso(at),
});

export const failedProbe = (
  error: string,
  extra: { answered?: string; at?: Date } = {},
): EngineModelProbe => ({
  requested: ALIAS,
  ok: false,
  at: iso(extra.at ?? NOW),
  error,
  ...(extra.answered === undefined ? {} : { answered: extra.answered }),
});

export interface ScriptedProber extends WatchProber {
  probe: ReturnType<typeof vi.fn<WatchProber['probe']>>;
  /** The result of the next probes; the last one repeats. */
  results: EngineModelProbe[];
}

/** A prober that answers the scripted results in order (the last repeats) and counts its calls. */
export function scriptedProber(...results: EngineModelProbe[]): ScriptedProber {
  const state = { index: 0, results };
  const probe = vi.fn<WatchProber['probe']>(async () => {
    const result = state.results[Math.min(state.index, state.results.length - 1)]!;
    state.index += 1;
    return result;
  });
  return {
    probe,
    get results() {
      return state.results;
    },
    set results(next: EngineModelProbe[]) {
      state.results = next;
    },
  };
}

const quiet = createLogger({
  name: 'model-watch-test',
  level: 'debug',
  destination: { write: () => undefined },
});

function routerConfig(baseUrl: string): WorkerEngineConfig {
  return {
    nodeEnv: 'test',
    typesafeBaseUrl: baseUrl,
    typesafeModel: JEV_FAKE_MODEL,
    typesafePricePerMtokUsd: 0.042,
    engineConcurrency: 2,
    dailyBudgetUsd: 2,
    ollamaBaseUrl: 'http://127.0.0.1:9',
    ollamaModelFast: 'glm-5.3-flash',
    ollamaModelStrong: 'glm-5.3',
    ollamaMaxConcurrency: 1,
    llmFallbackEnabled: false,
  };
}

/** The real prober over the real ledger and the env key, against the fake TypeSafe server. */
export function realProber(h: ClassifyHarness, fake: FakeTypeSafeServer, now: Date): ModelProber {
  const credentials = createWorkerCredentialResolver({
    db: h.db,
    masterKeyId: undefined,
    masterKeys: undefined,
    envKeys: { typesafe: API_KEY },
    logger: quiet,
    metadataTtlMs: 0,
  });
  const ledger = createWorkerEngineRouter({
    db: h.db,
    config: routerConfig(fake.url),
    credentials,
    logger: quiet,
  });
  return createModelProber({
    ledger,
    credentials,
    config: {
      nodeEnv: 'test',
      typesafeBaseUrl: fake.url,
      typesafePricePerMtokUsd: 0.042,
    },
    logger: quiet,
    now: () => now,
    random: () => 0,
  });
}

/** The fake server's table when `latest` is the newest release: the alias and every release answer. */
export const fakeTable = (latest: string, ...others: string[]): Record<string, string> =>
  Object.fromEntries([
    [ALIAS, latest],
    ...[latest, V113, V114, V115, V2, ...others].map((id) => [id, id]),
  ]);

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────

export interface RawSetting {
  text: string;
  stamp: string;
}

/** A settings row as bytes and write time: what "untouched" compares. */
export async function rawSetting(owner: pg.Pool, key: string): Promise<RawSetting | null> {
  const result = await owner.query<{ text: string; stamp: string }>(
    `SELECT value::text AS text, updated_at::text AS stamp FROM settings WHERE key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

export async function settingValue<T = Record<string, unknown>>(
  owner: pg.Pool,
  key: string,
): Promise<T | undefined> {
  const result = await owner.query<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [
    key,
  ]);
  return result.rows[0]?.value;
}

export interface WatchRow {
  triggeredAt?: string;
  lastCheck?: { at: string; ok: boolean; error?: string };
  notice?: { from: string; to: string; at: string; major: boolean; attempts: number };
}

export const watchRow = async (owner: pg.Pool): Promise<WatchRow> =>
  (await settingValue<WatchRow>(owner, 'engine.model_watch')) ?? {};

export interface ProgressEntry {
  updatedAt: string;
  completedAt?: string;
}

export const progressOf = async (
  owner: pg.Pool,
  job = 'house.model-watch',
): Promise<ProgressEntry | undefined> =>
  (await settingValue<Record<string, ProgressEntry>>(owner, 'house.progress'))?.[job];

export const probeOf = async (
  owner: pg.Pool,
  requested = ALIAS,
): Promise<EngineModelProbe | undefined> =>
  (await settingValue<Record<string, EngineModelProbe>>(owner, 'engine.model_probe'))?.[requested];

export interface ImpactRow {
  at: string;
  activeModels: number;
}

export const impactOf = async (owner: pg.Pool): Promise<ImpactRow | undefined> =>
  settingValue<ImpactRow>(owner, 'engine.model_impact');

/** One `user_models` row for `userId`; at most one version per user may be active. */
export async function seedModel(
  owner: pg.Pool,
  userId: string,
  options: { version?: number; active?: boolean } = {},
): Promise<void> {
  await owner.query(
    `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights, intercept, scaler, calibration, metrics, active)
     VALUES ($1, $2, 'spec', 40, 20, 20, '{}'::jsonb, 0, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3)`,
    [userId, options.version ?? 1, options.active ?? true],
  );
}

/** Pending `house.model-watch` intents of the outbox. */
export async function watchIntents(
  owner: pg.Pool,
): Promise<{ queue: string; payload: unknown; dedupeKey: string | null }[]> {
  const result = await owner.query<{ queue: string; payload: unknown; dedupe_key: string | null }>(
    `SELECT queue, payload, dedupe_key FROM job_outbox
      WHERE queue = 'house.model-watch' AND delivered_at IS NULL ORDER BY id`,
  );
  return result.rows.map((r) => ({ queue: r.queue, payload: r.payload, dedupeKey: r.dedupe_key }));
}

// ── Admins ────────────────────────────────────────────────────────────────────────────────────────

export async function clearAdmins(owner: pg.Pool): Promise<void> {
  await owner.query(`DELETE FROM users WHERE role = 'admin'`);
}

export async function addAdmin(owner: pg.Pool, email: string): Promise<string> {
  return (await createUser(owner, { role: 'admin', email })).id;
}

// ── A whole run ───────────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  prober: WatchProber;
  /** The effective `engine.typesafe_model`; default the alias. */
  configured?: string;
  /** Overrides `configured`: reads the effective setting at run time. */
  configuredModel?: () => Promise<string>;
  mailer?: WatchMailer | null;
  adminEmails?: readonly string[];
  now?: Date;
  rec?: Recorder;
}

/** Builds the handler over the harness database and runs it once. */
export async function runWatch(h: ClassifyHarness, options: RunOptions): Promise<Recorder> {
  const rec = options.rec ?? recorder();
  const at = options.now ?? NOW;
  const deps: WatchDeps = {
    db: h.db,
    prober: options.prober,
    logger: rec.logger,
    configuredModel: options.configuredModel ?? (async () => options.configured ?? ALIAS),
    settingsEnv: h.settingsEnv,
    ...(options.mailer === null ? {} : { mailer: options.mailer ?? new WatchMailer() }),
    ...(options.adminEmails === undefined ? {} : { adminEmails: options.adminEmails }),
    now: () => at,
  };
  const handler = await loadWatchHandler(deps);
  await handler({}, watchContext());
  return rec;
}
