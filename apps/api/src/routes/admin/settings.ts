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
  canonicalJson,
  enqueueLearn,
  enqueueReenrich,
  enqueueRematch,
  enqueueTranslateCards,
  mergeRankerConfig,
  readSetting,
  type AdminSettingKey,
  type AdminSettings,
  type AdminSettingsPatch,
  type AdminSettingsPatchResult,
  type AdminSettingsValues,
  type SettingEnvDefaults,
} from '@bantoozi/shared';
import { missingLanguagePairs } from '@bantoozi/translate';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import type { ApiConfig, ApiServices } from '../../context.js';
import { auditLog, freshWorkers, iso, layaConsumerPresent } from './shared.js';

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

function effectiveValues(
  rows: readonly StoredSettingRow[],
  env: SettingEnvDefaults,
): { values: AdminSettingsValues; version: number } {
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const values = Object.fromEntries(
    ADMIN_PATCHABLE_SETTING_KEYS.map((key) => [key, readSetting(key, stored.get(key), env)]),
  ) as AdminSettingsValues;
  const version = readSetting(VERSION_KEY, stored.get(VERSION_KEY), env) ?? 0;
  return { values, version };
}

async function loadSettings(db: Executor, env: SettingEnvDefaults): Promise<AdminSettings> {
  const rows = await readSettingRows(db, [...ADMIN_PATCHABLE_SETTING_KEYS, VERSION_KEY]);
  const { values, version } = effectiveValues(rows, env);
  return {
    values,
    stored: rows
      .filter((row) => (ADMIN_PATCHABLE_SETTING_KEYS as readonly string[]).includes(row.key))
      .map((row) => ({ key: row.key as AdminSettingKey, updatedAt: iso(row.updatedAt) })),
    rankerSettingsVersion: version,
  };
}

/** Deep equality; an absent override (`undefined`) equals `null`. */
const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);

function changedKeys(current: AdminSettingsValues, patch: AdminSettingsPatch): AdminSettingKey[] {
  return ADMIN_PATCHABLE_SETTING_KEYS.filter(
    (key) => patch[key] !== undefined && !same(current[key], patch[key]),
  );
}

/**
 * The `source→en` pairs LibreTranslate must list before a change is accepted (spec 08 §9): every
 * `translate` language of a changed `language_modes`, and, when the resulting `card_text_mode` is
 * `english` and either setting changed, every configured non-English content language (card texts
 * are translated into English, spec 07 §5).
 */
function requiredPairs(
  next: AdminSettingsValues,
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
  services: ApiServices,
  pairs: readonly [string, string][],
): Promise<void> {
  const client = services.libreTranslate;
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

function validateMerged(next: AdminSettingsValues): void {
  try {
    mergeRankerConfig(next['ranker.thresholds']);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The merged ranker configuration is invalid', {
      details: { key: 'ranker.thresholds' },
    });
  }
}

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const env = settingEnvDefaults(app.services.config);

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
    async (request) => request.withTx((tx) => loadSettings(tx, env)),
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
      // A retry is answered from its receipt before the settings are probed again; a concurrent
      // duplicate waits for this request to settle first.
      const outcome = await request.holdingKey(async () => {
        const saved = await request.savedOutcome<AdminSettingsPatchResult>();
        if (saved !== null) return saved;
        const patch = request.body;
        const { services } = app;

        // Slow outbound work first: the LibreTranslate probe runs before the transaction opens.
        const before = await request.withTx(async (tx) =>
          effectiveValues(await readSettingRows(tx, ADMIN_PATCHABLE_SETTING_KEYS), env),
        );
        const preview = { ...before.values, ...patch } as AdminSettingsValues;
        validateMerged(preview);
        const probedPairs = requiredPairs(preview, changedKeys(before.values, patch));
        if (probedPairs.length > 0) {
          try {
            await probeLibreTranslate(services, probedPairs);
          } catch (error) {
            // A duplicate on another instance may have committed meanwhile: its receipt wins.
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
          // The language-pair check reads both settings, so a patch of either locks both.
          const dependent = patchedKeys.some((key) => LANGUAGE_KEYS.includes(key))
            ? LANGUAGE_KEYS
            : [];
          await lockSettingRows(tx, [...patchedKeys, ...dependent, VERSION_KEY]);
          // Unpatched keys keep their stored values; read every key after the locks are held.
          const current = effectiveValues(
            await readSettingRows(tx, [...ADMIN_PATCHABLE_SETTING_KEYS, VERSION_KEY]),
            env,
          );
          const next = { ...current.values, ...patch } as AdminSettingsValues;
          validateMerged(next);
          const changed = changedKeys(current.values, patch);

          // Recheck the probe against the locked values: a concurrent change may need more pairs.
          const needed = requiredPairs(next, changed);
          if (needed.some((pair) => !probed.has(pairName(pair)))) {
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
            await writeSetting(tx, { key, value: next[key], updatedBy: adminId });
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

          const body = { ...(await loadSettings(tx, env)), changed };
          return { status: 200, body };
        });
      });
      auditLog(request, { action: 'settings.patch', changed: outcome.body.changed });
      await reply.code(200).send(outcome.body);
    },
  );
};
