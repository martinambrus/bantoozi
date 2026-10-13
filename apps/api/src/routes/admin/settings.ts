import {
  activeUserIds,
  lockSettingRows,
  questionSetKinds,
  readSettingRows,
  recordRankIntents,
  writeSetting,
  type Executor,
  type StoredSettingRow,
} from '@bantoozi/db';
import {
  ADMIN_PATCHABLE_SETTING_KEYS,
  AdminSettingsPatchResultSchema,
  AdminSettingsPatchSchema,
  AdminSettingsSchema,
  AppError,
  RUNTIME_SETTING_KEYS,
  canonicalJson,
  enqueueLearn,
  enqueueReenrich,
  enqueueRematch,
  enqueueTranslateCards,
  mergeRankerConfig,
  readSetting,
  validateRuntimeSetting,
  type AdminSettingKey,
  type AdminSettings,
  type AdminSettingsPatch,
  type AdminSettingsPatchResult,
  type AdminSettingsValues,
  type RuntimeSettingKey,
  type RuntimeSettingsContext,
  type SettingEnvDefaults,
} from '@bantoozi/shared';
import {
  OLLAMA_PRICES,
  createLibreTranslateClient,
  missingLanguagePairs,
  type LibreTranslateClient,
} from '@bantoozi/translate';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import type { ApiConfig } from '../../context.js';
import {
  auditLog,
  freshWorkerRuntimeDefaults,
  freshWorkers,
  iso,
  layaConsumerPresent,
} from './shared.js';

/**
 * `GET/PATCH /admin/settings` (spec 08 §9): the allow-listed admin keys, each validated by its
 * registry schema (spec 02 §2), the merged configuration validated as a whole, the rows locked for
 * the write and every side effect committed through the outbox in the same transaction.
 */

const VERSION_KEY = 'ranker.settings_version';
/** Users whose ranking a thresholds change refreshes (spec 08 §9). */
const RANK_ACTIVE_DAYS = 7;
/** Bound of the LibreTranslate `/languages` probe (spec 08 §9, spec 11 §2). */
const PROBE_TIMEOUT_MS = 5_000;

export function settingEnvDefaults(config: ApiConfig): SettingEnvDefaults {
  return {
    dailyBudgetUsd: config.dailyBudgetUsd,
    languageModes: config.languageModes,
    signupMode: config.signupMode,
  };
}

const isRuntimeKey = (key: string): key is RuntimeSettingKey =>
  (RUNTIME_SETTING_KEYS as readonly string[]).includes(key);
type BaseKey = Exclude<AdminSettingKey, RuntimeSettingKey>;
const BASE_KEYS = ADMIN_PATCHABLE_SETTING_KEYS.filter((key): key is BaseKey => !isRuntimeKey(key));
const STORED_KEYS = [...ADMIN_PATCHABLE_SETTING_KEYS, VERSION_KEY];

/** Changing these re-enriches and re-matches the corpus, so the admin must confirm (M8b-T2). */
const MODEL_AFFECTING: readonly RuntimeSettingKey[] = [
  'engine.typesafe_model',
  'engine.llm_fallback_enabled',
  'engine.ollama_models',
];

function runtimeContext(config: ApiConfig): RuntimeSettingsContext {
  return {
    production: config.nodeEnv === 'production',
    providerHostAllowlist: config.providerHostAllowlist,
    ollamaPricedModels: Object.keys(OLLAMA_PRICES),
  };
}

/** The environment defaults the API process knows itself; the rest comes from worker heartbeats. */
function apiRuntimeDefaults(config: ApiConfig): Map<string, unknown> {
  return new Map<string, unknown>([
    ['engine.typesafe_model', config.typesafeModel],
    ['api.rate_limits_enabled', config.rateLimitsEnabled],
    ['translate.libretranslate_url', config.libretranslateUrl],
    ['fetch.limits', { timeoutMs: config.fetchTimeoutMs, maxBytes: config.fetchMaxBytes }],
  ]);
}

interface RuntimeState {
  values: Record<RuntimeSettingKey, unknown>;
  sources: Record<RuntimeSettingKey, 'env' | 'stored' | 'last_good'>;
  defaults: Record<RuntimeSettingKey, unknown>;
  /** Keys with a valid, non-null stored override. */
  overridden: Set<RuntimeSettingKey>;
}

/**
 * The effective live runtime values: the valid stored row, else (for a row that no longer validates)
 * the last good value this process saw, else the environment default (`null` when nobody knows it).
 */
function runtimeState(
  rows: readonly StoredSettingRow[],
  workerDefaults: ReadonlyMap<string, unknown>,
  config: ApiConfig,
  ctx: RuntimeSettingsContext,
  lastGood: Map<string, unknown>,
): RuntimeState {
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const api = apiRuntimeDefaults(config);
  const state: RuntimeState = {
    values: {},
    sources: {},
    defaults: {},
    overridden: new Set(),
  } as never;
  for (const key of RUNTIME_SETTING_KEYS) {
    const fallback = api.get(key) ?? workerDefaults.get(key) ?? null;
    state.defaults[key] = fallback;
    const row = stored.get(key);
    const checked =
      row === undefined || row === null ? null : validateRuntimeSetting(key, row, ctx);
    if (checked?.ok === true && checked.value !== null) {
      state.values[key] = checked.value;
      state.sources[key] = 'stored';
      state.overridden.add(key);
      lastGood.set(key, checked.value);
    } else if (checked !== null && !checked.ok && lastGood.has(key)) {
      state.values[key] = lastGood.get(key);
      state.sources[key] = 'last_good';
    } else {
      state.values[key] = fallback;
      state.sources[key] = 'env';
    }
  }
  return state;
}

function effectiveValues(
  rows: readonly StoredSettingRow[],
  env: SettingEnvDefaults,
): { values: Omit<AdminSettingsValues, RuntimeSettingKey>; version: number } {
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const values = Object.fromEntries(
    BASE_KEYS.map((key) => [key, readSetting(key, stored.get(key), env)]),
  ) as Omit<AdminSettingsValues, RuntimeSettingKey>;
  const version = readSetting(VERSION_KEY, stored.get(VERSION_KEY), env) ?? 0;
  return { values, version };
}

interface SettingsDeps {
  env: SettingEnvDefaults;
  config: ApiConfig;
  ctx: RuntimeSettingsContext;
  lastGood: Map<string, unknown>;
  now: () => Date;
}

async function readRuntime(
  tx: Executor,
  rows: readonly StoredSettingRow[],
  deps: SettingsDeps,
  now: Date,
): Promise<RuntimeState> {
  const workerDefaults = await freshWorkerRuntimeDefaults(tx, now);
  return runtimeState(rows, workerDefaults, deps.config, deps.ctx, deps.lastGood);
}

async function loadSettings(db: Executor, deps: SettingsDeps, now: Date): Promise<AdminSettings> {
  const rows = await readSettingRows(db, STORED_KEYS);
  const { values, version } = effectiveValues(rows, deps.env);
  const runtime = await readRuntime(db, rows, deps, now);
  return {
    values: { ...values, ...runtime.values } as AdminSettingsValues,
    stored: rows
      .filter(
        (row) =>
          (ADMIN_PATCHABLE_SETTING_KEYS as readonly string[]).includes(row.key) &&
          (!isRuntimeKey(row.key) || (row.value !== null && row.value !== undefined)),
      )
      .map((row) => ({ key: row.key as AdminSettingKey, updatedAt: iso(row.updatedAt) })),
    rankerSettingsVersion: version,
    sources: runtime.sources,
    defaults: runtime.defaults,
  };
}

/** Deep equality; an absent override (`undefined`) equals `null`. */
const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);

function changedKeys(
  current: Omit<AdminSettingsValues, RuntimeSettingKey>,
  patch: AdminSettingsPatch,
): BaseKey[] {
  return BASE_KEYS.filter((key) => patch[key] !== undefined && !same(current[key], patch[key]));
}

interface RuntimePlan {
  /** Each patched runtime key's new stored value (`null` = reset to the environment value). */
  stored: Map<RuntimeSettingKey, unknown>;
  /** The keys written: a different effective value, or a reset of a stored override. */
  changed: RuntimeSettingKey[];
  /** The effective value of every runtime key once the patch is applied. */
  next: Record<RuntimeSettingKey, unknown>;
  needsAcknowledge: boolean;
}

/** Validates the patched runtime keys (production rules included) and works out what changes. */
function planRuntime(
  patch: AdminSettingsPatch,
  state: RuntimeState,
  ctx: RuntimeSettingsContext,
): RuntimePlan {
  const stored = new Map<RuntimeSettingKey, unknown>();
  const next = { ...state.values };
  const changed: RuntimeSettingKey[] = [];
  const effective: RuntimeSettingKey[] = [];
  for (const key of RUNTIME_SETTING_KEYS) {
    const raw = patch[key];
    if (raw === undefined) continue;
    const checked = validateRuntimeSetting(key, raw, ctx);
    if (!checked.ok) {
      throw new AppError('VALIDATION_FAILED', 'Invalid setting value', {
        details: { key, message: checked.message },
      });
    }
    stored.set(key, checked.value);
    const value = checked.value ?? state.defaults[key];
    next[key] = value;
    const bool = key === 'engine.llm_fallback_enabled';
    const differs = bool
      ? Boolean(value) !== Boolean(state.values[key])
      : !same(value, state.values[key]);
    if (differs) effective.push(key);
    if (differs || (checked.value === null && state.overridden.has(key))) changed.push(key);
  }
  const fallbackOn = Boolean(next['engine.llm_fallback_enabled']);
  const needsAcknowledge = effective.some(
    (key) => MODEL_AFFECTING.includes(key) && (key !== 'engine.ollama_models' || fallbackOn),
  );
  return { stored, changed, next, needsAcknowledge };
}

function requireAcknowledge(plan: RuntimePlan, acknowledged: boolean | undefined): void {
  if (plan.needsAcknowledge && acknowledged !== true) {
    throw new AppError(
      'CONFLICT',
      'This change re-enriches and re-matches the corpus; confirm it',
      {
        details: { reason: 'confirmation_required', effects: ['reenrich', 'rematch'] },
      },
    );
  }
}

/**
 * The `source→en` pairs LibreTranslate must list before a change is accepted (spec 08 §9): every
 * `translate` language of a changed `language_modes`, and, when the resulting `card_text_mode` is
 * `english` and either setting changed, every configured non-English content language (card texts
 * are translated into English, spec 07 §5).
 */
function requiredPairs(
  next: Pick<AdminSettingsValues, 'language_modes' | 'card_text_mode'>,
  changed: readonly AdminSettingKey[],
): [string, string][] {
  const sources = new Set<string>();
  if (changed.includes('language_modes')) {
    for (const [lang, mode] of Object.entries(next.language_modes)) {
      if (mode === 'translate' && lang !== 'en') sources.add(lang);
    }
  }
  const cardModeAffected = changed.includes('card_text_mode') || changed.includes('language_modes');
  if (cardModeAffected && next.card_text_mode === 'english') {
    for (const lang of Object.keys(next.language_modes)) if (lang !== 'en') sources.add(lang);
  }
  return [...sources].sort().map((lang): [string, string] => [lang, 'en']);
}

const LANGUAGE_KEYS: readonly AdminSettingKey[] = ['card_text_mode', 'language_modes'];

const pairName = ([source, target]: readonly [string, string]) => `${source}-${target}`;

/** The bounded `GET {LIBRETRANSLATE_URL}/languages` probe; refuses unless every pair is listed. */
async function probeLibreTranslate(
  client: LibreTranslateClient | null,
  pairs: readonly [string, string][],
): Promise<void> {
  const unavailable = (details: Record<string, unknown>) =>
    new AppError('ENGINE_UNAVAILABLE', 'LibreTranslate cannot translate the required languages', {
      details: { engine: 'libretranslate', ...details },
    });
  if (client === null) throw unavailable({ reason: 'not_configured' });
  const result = await client.languages({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!result.ok) throw unavailable({ reason: result.reason });
  const missing = missingLanguagePairs(result.languages, pairs);
  if (missing.length > 0) {
    throw unavailable({ reason: 'missing_languages', missing: missing.map(pairName) });
  }
}

function validateMerged(next: Pick<AdminSettingsValues, 'ranker.thresholds'>): void {
  try {
    mergeRankerConfig(next['ranker.thresholds']);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The merged ranker configuration is invalid', {
      details: { key: 'ranker.thresholds' },
    });
  }
}

/** The LibreTranslate client for the effective URL: the injected one unless a live override differs. */
function probeClient(
  app: Parameters<FastifyPluginAsyncZod>[0],
  effectiveUrl: unknown,
): LibreTranslateClient | null {
  if (typeof effectiveUrl === 'string' && effectiveUrl !== app.services.config.libretranslateUrl) {
    return createLibreTranslateClient({ baseUrl: effectiveUrl, maxAttempts: 1 });
  }
  return app.services.libreTranslate;
}

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps: SettingsDeps = {
    env: settingEnvDefaults(app.services.config),
    config: app.services.config,
    ctx: runtimeContext(app.services.config),
    lastGood: new Map(),
    now: () => app.services.clock.now(),
  };
  const LT_KEY = 'translate.libretranslate_url';

  app.get(
    '/settings',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Allow-listed admin settings',
        response: { 200: AdminSettingsSchema },
      },
    },
    async (request) => request.withTx((tx) => loadSettings(tx, deps, deps.now())),
  );

  app.patch(
    '/settings',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Update allow-listed admin settings',
        body: AdminSettingsPatchSchema,
        response: { 200: AdminSettingsPatchResultSchema },
      },
    },
    async (request, reply) => {
      const outcome = await request.holdingKey(async () => {
        const saved = await request.savedOutcome<AdminSettingsPatchResult>();
        if (saved !== null) return saved;
        const { acknowledge, ...patch } = request.body;

        const { before, beforeRuntime } = await request.withTx(async (tx) => {
          const rows = await readSettingRows(tx, STORED_KEYS);
          return {
            before: effectiveValues(rows, deps.env),
            beforeRuntime: await readRuntime(tx, rows, deps, deps.now()),
          };
        });
        const plan = planRuntime(patch, beforeRuntime, deps.ctx);
        requireAcknowledge(plan, acknowledge);
        const preview = { ...before.values, ...patch, ...plan.next } as AdminSettingsValues;
        validateMerged(preview);
        const ltChanged = plan.changed.includes(LT_KEY);
        const probedPairs = requiredPairs(
          preview,
          ltChanged ? ['language_modes', 'card_text_mode'] : changedKeys(before.values, patch),
        );
        const probeUrl = ltChanged ? plan.next[LT_KEY] : undefined;
        if (probedPairs.length > 0) {
          try {
            await probeLibreTranslate(probeClient(app, plan.next[LT_KEY]), probedPairs);
          } catch (error) {
            const committed = await request.savedOutcome<AdminSettingsPatchResult>();
            if (committed !== null) return committed;
            throw error;
          }
        }
        const probed = new Set(probedPairs.map(pairName));

        return request.mutate(async (tx, { outbox, now }) => {
          const adminId = request.auth!.userId;
          const patchedKeys = ADMIN_PATCHABLE_SETTING_KEYS.filter(
            (key) => patch[key] !== undefined,
          );
          const dependent = patchedKeys.some((key) => LANGUAGE_KEYS.includes(key))
            ? LANGUAGE_KEYS
            : [];
          await lockSettingRows(tx, [...patchedKeys, ...dependent, VERSION_KEY]);
          const rows = await readSettingRows(tx, STORED_KEYS);
          const current = effectiveValues(rows, deps.env);
          const currentRuntime = await readRuntime(tx, rows, deps, now);
          const runtimePlan = planRuntime(patch, currentRuntime, deps.ctx);
          requireAcknowledge(runtimePlan, acknowledge);
          const next = { ...current.values, ...patch, ...runtimePlan.next } as AdminSettingsValues;
          validateMerged(next);
          const baseChanged = changedKeys(current.values, patch);
          const changed = ADMIN_PATCHABLE_SETTING_KEYS.filter(
            (key) =>
              (baseChanged as readonly string[]).includes(key) ||
              (runtimePlan.changed as readonly string[]).includes(key),
          );

          const ltNow = runtimePlan.changed.includes(LT_KEY);
          const needed = requiredPairs(
            next,
            ltNow ? ['language_modes', 'card_text_mode'] : baseChanged,
          );
          if (
            needed.some((pair) => !probed.has(pairName(pair))) ||
            (needed.length > 0 && ltNow !== ltChanged) ||
            (ltNow && !same(runtimePlan.next[LT_KEY], probeUrl))
          ) {
            throw new AppError('CONFLICT', 'Settings changed concurrently; retry', {
              details: { reason: 'settings_changed' },
            });
          }
          if (changed.includes('engine.laya') && (next['engine.laya'].enrich ?? []).length > 0) {
            if (!layaConsumerPresent(await freshWorkers(tx, now))) {
              throw new AppError('CONFLICT', 'No live worker consumes the Laya queues', {
                details: { reason: 'laya_worker_missing' },
              });
            }
          }
          if (changed.includes('question_sets.active')) {
            const active = next['question_sets.active'];
            const entries = Object.entries(active).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            );
            const kinds = await questionSetKinds(
              tx,
              entries.map(([, id]) => id),
            );
            for (const [kind, id] of entries) {
              if (kinds.get(id) !== kind) {
                throw new AppError('VALIDATION_FAILED', 'Unknown question set for this kind', {
                  details: { key: 'question_sets.active', kind },
                });
              }
            }
          }

          for (const key of changed) {
            const value = isRuntimeKey(key) ? runtimePlan.stored.get(key) : next[key];
            await writeSetting(tx, { key, value, updatedBy: adminId });
          }

          // Side effects (spec 08 §9), all through the outbox in this transaction.
          let rematch = false;
          const reenrichLangs = new Set<string>();
          let reenrichAll = false;
          if (changed.includes('ranker.thresholds')) {
            await writeSetting(tx, {
              key: VERSION_KEY,
              value: current.version + 1,
              updatedBy: adminId,
            });
            const users = await activeUserIds(tx, RANK_ACTIVE_DAYS);
            await recordRankIntents(tx, outbox, users, { reason: 'settings', full: true });
            const prev = current.values['ranker.thresholds'];
            const upd = next['ranker.thresholds'];
            if (!same(prev.strengthWeights, upd.strengthWeights) || !same(prev.model, upd.model)) {
              // The API cannot read other tenants' user_models under RLS, so learning is requested
              // for every recently active user; the handler trains only when its model context or
              // eligible samples changed (spec 06 §8.4).
              for (const userId of users) await enqueueLearn(outbox, { userId });
            }
          }
          if (changed.includes('question_sets.active')) {
            const prev = current.values['question_sets.active'];
            const upd = next['question_sets.active'];
            if (prev.enrich !== upd.enrich) reenrichAll = true;
            if (prev.match !== upd.match) rematch = true;
          }
          if (changed.includes('card_text_mode')) {
            rematch = true;
            if (next.card_text_mode === 'english') await enqueueTranslateCards(outbox, {});
          }
          if (changed.includes('engine.prefilter_enabled')) rematch = true;
          if (changed.includes('engine.prefilter_min_cards') && next['engine.prefilter_enabled']) {
            rematch = true;
          }
          if (changed.includes('language_modes')) {
            const prev = current.values.language_modes;
            const upd = next.language_modes;
            for (const lang of new Set([...Object.keys(prev), ...Object.keys(upd)])) {
              if (prev[lang] !== upd[lang]) reenrichLangs.add(lang);
            }
          }
          if (changed.includes('engine.laya')) {
            const prev = new Set(current.values['engine.laya'].enrich ?? []);
            const upd = new Set(next['engine.laya'].enrich ?? []);
            for (const lang of prev) if (!upd.has(lang)) reenrichLangs.add(lang);
            for (const lang of upd) if (!prev.has(lang)) reenrichLangs.add(lang);
          }
          if (reenrichAll) await enqueueReenrich(outbox, {});
          for (const lang of [...reenrichLangs].sort()) await enqueueReenrich(outbox, { lang });
          if (rematch) await enqueueRematch(outbox, {});

          const body = { ...(await loadSettings(tx, deps, now)), changed };
          return { status: 200, body };
        });
      });
      auditLog(request, { action: 'settings.patch', changed: outcome.body.changed });
      await reply.code(200).send(outcome.body);
    },
  );
};
