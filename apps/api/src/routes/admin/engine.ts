import {
  adminActivateCredential,
  adminCredentialMetadata,
  adminOverviewCounts,
  latestMetricsSnapshots,
  adminRevokeCredential,
  adminStageCredential,
  adminValidateCredential,
  readSettingRows,
  updateSettingLocked,
  adminUsageDaily,
  usageTopUsers,
  type TenantTx,
} from '@bantoozi/db';
import {
  AdminEngineModelSchema,
  AdminOverviewSchema,
  EngineModelWatchSchema,
  ModelProbeBodySchema,
  MetricsSnapshotSchema,
  AdminUsageQuerySchema,
  AdminUsageSchema,
  AppError,
  CandidateActionBodySchema,
  CredentialListSchema,
  CredentialResultSchema,
  EngineCircuitSchema,
  EngineModelImpactSchema,
  JEV_LATEST_ALIAS,
  PROVIDERS,
  ProviderParamsSchema,
  QueuedSchema,
  ResetBreakerBodySchema,
  ResetBreakerResultSchema,
  RevokeCredentialQuerySchema,
  StageCredentialBodySchema,
  TRANSLATE_SKIP_REASONS,
  TranslationsReprocessBodySchema,
  enqueueModelProbe,
  enqueueModelWatch,
  enqueueRetranslateSkipped,
  readSetting,
  settingDefault,
  validateRuntimeSetting,
  type AdminMetrics,
  type AdminOverview,
  type BreakerState,
  type CredentialStatus,
  type EngineCircuit,
  type KeyringOverview,
  type Provider,
} from '@bantoozi/shared';
import {
  CredentialCryptoError,
  ProviderKeyring,
  encryptProviderSecret,
} from '@bantoozi/shared/server/credential-crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import type { RateLimitRule } from '../../types.js';
import { MODEL_STATE_KEYS, readModelState } from '../../services/model-state.js';
import { runtimeContext, settingEnvDefaults } from './settings.js';
import { auditLog, credentialStatus, freshWorkerKeyrings, freshWorkers } from './shared.js';

/**
 * Engine administration (spec 08 §9, §9.1): overview and usage, the breaker reset request, the
 * tier-2 translation reprocess and the provider credential state machine. Credential routes are
 * admin-only, CSRF-protected, CAS-guarded and idempotent; the API key is write-only and encrypted
 * before the transaction, and only metadata leaves the database.
 */

/** "Provider credential stage/validate/activate/delete: 20 / hour per admin" (spec 08 §11). */
const CREDENTIAL_LIMITS: readonly RateLimitRule[] = [
  { group: 'admin-credentials', max: 20, windowSeconds: 3600, per: 'user' },
];
/** Each model probe costs at most $0.002; one bucket covers the probe and the Check now button. */
const MODEL_PROBE_LIMITS: readonly RateLimitRule[] = [
  { group: 'admin-model-probe', max: 30, windowSeconds: 3600, per: 'user' },
];
const MODEL_KEYS = [...MODEL_STATE_KEYS, 'engine.model_watch', 'engine.model_impact'];
const TOP_USERS = 20;

function breaker(state: BreakerState, resetRequestedAt: string | undefined) {
  return {
    state: state.state,
    openUntil: state.openUntil ?? null,
    resetRequestedAt: resetRequestedAt ?? null,
  };
}

async function loadCredentials(tx: TenantTx, now: Date): Promise<CredentialStatus[]> {
  const rows = await adminCredentialMetadata(tx);
  const workers = await freshWorkers(tx, now);
  return PROVIDERS.map((provider) =>
    credentialStatus(
      provider,
      rows.find((row) => row.provider === provider),
      workers,
    ),
  );
}

async function loadCredential(tx: TenantTx, provider: Provider, now: Date) {
  const all = await loadCredentials(tx, now);
  return all.find((status) => status.provider === provider)!;
}

/** The newest stored `metrics.daily` snapshot that parses, with the regret rate; `null` when none does. */
async function latestMetrics(tx: TenantTx): Promise<AdminMetrics | null> {
  for (const [day, value] of await latestMetricsSnapshots(tx, 10)) {
    const parsed = MetricsSnapshotSchema.safeParse(value);
    if (!parsed.success) continue;
    const { lanes, regret } = parsed.data;
    return {
      day,
      lanes,
      regret: {
        ...regret,
        rate: regret.denominator === 0 ? null : regret.numerator / regret.denominator,
      },
    };
  }
  return null;
}

export const engineRoutes: FastifyPluginAsyncZod = async (app) => {
  const env = settingEnvDefaults(app.services.config);
  const circuitDefault = settingDefault('engine.circuit', env)!;

  app.get(
    '/overview',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Platform overview',
        response: { 200: AdminOverviewSchema },
      },
    },
    async (request): Promise<AdminOverview> =>
      request.withTx(async (tx) => {
        const counts = await adminOverviewCounts(tx);
        const rows = await readSettingRows(tx, [
          'engine.circuit',
          'engine.daily_budget_usd',
          'engine.llm_daily_cap',
          'translate.tier2_daily_cap',
        ]);
        const stored = new Map(rows.map((row) => [row.key, row.value]));
        const metrics = await latestMetrics(tx);
        const circuitParsed = EngineCircuitSchema.safeParse(stored.get('engine.circuit'));
        const circuit: EngineCircuit = circuitParsed.success ? circuitParsed.data : circuitDefault;
        return {
          users: { total: counts.usersTotal, active7d: counts.usersActive7d },
          feeds: counts.feeds,
          articlesToday: counts.articlesToday,
          queues: counts.queues,
          engine: {
            breakers: {
              typesafe: breaker(circuit.typesafe, circuit.resetRequested.typesafe),
              llm: breaker(circuit.llm, circuit.resetRequested.llm),
            },
            spendTodayUsd: counts.spendTodayUsd,
            dailyBudgetUsd:
              readSetting('engine.daily_budget_usd', stored.get('engine.daily_budget_usd'), env) ??
              env.dailyBudgetUsd,
            llmCallsToday: counts.llmCallsToday,
            llmDailyCap:
              readSetting('engine.llm_daily_cap', stored.get('engine.llm_daily_cap'), env) ?? 0,
          },
          metrics,
          translations: {
            last24h: counts.translations24h,
            tier2CallsToday: counts.tier2CallsToday,
            tier2DailyCap:
              readSetting(
                'translate.tier2_daily_cap',
                stored.get('translate.tier2_daily_cap'),
                env,
              ) ?? 0,
          },
        };
      }),
  );

  app.get(
    '/usage',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Spend per day and top users by attributed cost',
        querystring: AdminUsageQuerySchema,
        response: { 200: AdminUsageSchema },
      },
    },
    async (request) =>
      request.withTx(async (tx) => {
        const { days } = request.query;
        return {
          days,
          daily: await adminUsageDaily(tx, days),
          topUsers: await usageTopUsers(tx, days, TOP_USERS),
        };
      }),
  );

  app.post(
    '/engine/reset-breaker',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Request a breaker reset',
        body: ResetBreakerBodySchema,
        response: { 200: ResetBreakerResultSchema },
      },
    },
    async (request, reply) => {
      const { engine } = request.body;
      const outcome = await request.mutate(async (tx, { now }) => {
        const at = now.toISOString();
        await updateSettingLocked(tx, 'engine.circuit', circuitDefault, (current) => {
          const parsed = EngineCircuitSchema.safeParse(current);
          if (!parsed.success) {
            throw new AppError('CONFLICT', 'The stored breaker state is invalid', {
              details: { reason: 'circuit_invalid' },
            });
          }
          return EngineCircuitSchema.parse({
            ...parsed.data,
            resetRequested: { ...parsed.data.resetRequested, [engine]: at },
          });
        });
        return { status: 200, body: { engine, resetRequestedAt: at } };
      });
      auditLog(request, { action: 'engine.reset_breaker', target: engine });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/translations/reprocess',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Retry skipped tier-2 translations',
        body: TranslationsReprocessBodySchema,
        response: { 202: QueuedSchema },
      },
    },
    async (request, reply) => {
      const reasons = request.body.reasons;
      const outcome = await request.mutate(async (_tx, { outbox }) => {
        const all: typeof TRANSLATE_SKIP_REASONS = TRANSLATE_SKIP_REASONS;
        await enqueueRetranslateSkipped(outbox, {
          reasons: all.filter((reason) => (reasons ?? all).includes(reason)),
        });
        return { status: 202, body: { queued: true as const } };
      });
      auditLog(request, { action: 'translations.reprocess' });
      await reply.code(202).send(outcome.body);
    },
  );

  // ── The TypeSafe model (visible-learning §4.1) ───────────────────────────────────────────────

  app.get(
    '/engine/model',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'TypeSafe model status',
        response: { 200: AdminEngineModelSchema },
      },
    },
    async (request) => {
      const [snapshot, rows] = await Promise.all([
        app.services.runtime.get(),
        request.withTx((tx) => readSettingRows(tx, MODEL_KEYS)),
      ]);
      const state = readModelState(rows);
      const byKey = new Map(rows.map((row) => [row.key, row.value]));
      const lastCheck =
        EngineModelWatchSchema.pick({ lastCheck: true }).safeParse({
          lastCheck: (byKey.get('engine.model_watch') as { lastCheck?: unknown } | null)?.lastCheck,
        }).data?.lastCheck ?? null;
      const source = snapshot.sources['engine.typesafe_model'];
      return {
        now: app.services.clock.now().toISOString(),
        setting: {
          value: snapshot.values.typesafeModel,
          source: source === 'stored' || source === 'last_good' ? source : ('env' as const),
        },
        resolution: state.resolution,
        pin:
          state.pin === null
            ? null
            : {
                model: state.pin.model,
                ...(state.pin.alias === undefined ? {} : { alias: state.pin.alias }),
                since: state.pin.since,
              },
        watch: { lastCheck },
        probes: state.probes,
        impact: EngineModelImpactSchema.safeParse(byKey.get('engine.model_impact')).data ?? null,
      };
    },
  );

  app.post(
    '/engine/model-probe',
    {
      config: { auth: 'admin', rateLimits: MODEL_PROBE_LIMITS },
      schema: {
        tags: ['admin'],
        summary: 'Ask Jev whether it serves a model',
        body: ModelProbeBodySchema,
        response: { 202: QueuedSchema },
      },
    },
    async (request, reply) => {
      const { model } = request.body;
      const checked = validateRuntimeSetting(
        'engine.typesafe_model',
        model,
        runtimeContext(app.services.config),
      );
      if (!checked.ok) {
        throw new AppError('VALIDATION_FAILED', 'Invalid setting value', {
          details: { key: 'engine.typesafe_model', message: checked.message },
        });
      }
      const outcome = await request.mutate(async (_tx, { outbox }) => {
        await enqueueModelProbe(outbox, { model });
        return { status: 202, body: { queued: true as const } };
      });
      auditLog(request, { action: 'engine.model_probe', target: model });
      await reply.code(202).send(outcome.body);
    },
  );

  app.post(
    '/engine/model-check',
    {
      config: { auth: 'admin', rateLimits: MODEL_PROBE_LIMITS },
      schema: {
        tags: ['admin'],
        summary: 'Check where jev-latest points now',
        response: { 202: QueuedSchema },
      },
    },
    async (request, reply) => {
      const outcome = await request.mutate(async (_tx, { outbox }) => {
        if ((await app.services.runtime.get()).values.typesafeModel !== JEV_LATEST_ALIAS) {
          throw new AppError('CONFLICT', 'The model setting is not following jev-latest', {
            details: { reason: 'not_following_alias' },
          });
        }
        await enqueueModelWatch(outbox);
        return { status: 202, body: { queued: true as const } };
      });
      auditLog(request, { action: 'engine.model_check' });
      await reply.code(202).send(outcome.body);
    },
  );

  // ── Provider credentials (spec 08 §9.1) ──────────────────────────────────────────────────────

  app.get(
    '/engine/credentials',
    {
      config: { auth: 'admin' },
      schema: {
        tags: ['admin'],
        summary: 'Provider credential metadata',
        response: { 200: CredentialListSchema },
      },
    },
    async (request) =>
      request.withTx(async (tx) => {
        const now = app.services.clock.now();
        const items = await loadCredentials(tx, now);
        const workers = await freshWorkerKeyrings(tx, now);
        const { config } = app.services;
        const parsed = ProviderKeyring.parse(config.providerMasterKeyId, config.providerMasterKeys);
        const api: KeyringOverview['api'] = parsed.ok
          ? { status: 'ok', activeKeyId: parsed.keyring.activeKeyId }
          : { status: parsed.reason };
        const mismatch =
          api.status === 'ok' &&
          workers.some((w) => w.status === 'ok' && w.activeKeyId !== api.activeKeyId);
        return { items, keyring: { api, workers, mismatch } };
      }),
  );

  app.put(
    '/engine/credentials/:provider',
    {
      config: { auth: 'admin', rateLimits: CREDENTIAL_LIMITS },
      schema: {
        tags: ['admin'],
        summary: 'Stage a provider API key (write-only)',
        params: ProviderParamsSchema,
        body: StageCredentialBodySchema,
        response: { 200: CredentialResultSchema },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const { apiKey, expectedRevision } = request.body;
      // A retry of a committed stage replays its receipt without needing the keyring again.
      const saved = await request.savedOutcome<{ credential: CredentialStatus }>();
      if (saved !== null) {
        auditLog(request, { action: 'credentials.stage', target: provider });
        return reply.code(200).send(saved.body);
      }
      const { config } = app.services;
      const keyring = ProviderKeyring.parse(config.providerMasterKeyId, config.providerMasterKeys);
      if (!keyring.ok) {
        throw new AppError('ENGINE_UNAVAILABLE', 'Credential storage is not configured', {
          details: { reason: 'keyring_unavailable' },
        });
      }
      let envelope: unknown;
      try {
        envelope = encryptProviderSecret({
          keyring: keyring.keyring,
          provider,
          secretVersion: (BigInt(expectedRevision) + 1n).toString(),
          secret: apiKey,
        });
      } catch (error) {
        if (error instanceof CredentialCryptoError && error.code === 'INVALID_SECRET') {
          // The message names the rule, never the submitted value.
          throw new AppError('VALIDATION_FAILED', error.message, {
            details: { field: 'apiKey' },
          });
        }
        throw new AppError('ENGINE_UNAVAILABLE', 'Credential storage is not configured', {
          details: { reason: 'keyring_unavailable' },
        });
      }
      const outcome = await request.mutate(async (tx, { now }) => {
        await adminStageCredential(tx, { provider, expectedRevision, envelope });
        return { status: 200, body: { credential: await loadCredential(tx, provider, now) } };
      });
      auditLog(request, { action: 'credentials.stage', target: provider });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/engine/credentials/:provider/validate',
    {
      config: { auth: 'admin', rateLimits: CREDENTIAL_LIMITS },
      schema: {
        tags: ['admin'],
        summary: 'Request validation of the staged candidate',
        params: ProviderParamsSchema,
        body: CandidateActionBodySchema,
        response: { 202: CredentialResultSchema },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const outcome = await request.mutate(async (tx, { now }) => {
        await adminValidateCredential(tx, { provider, ...request.body });
        return { status: 202, body: { credential: await loadCredential(tx, provider, now) } };
      });
      auditLog(request, { action: 'credentials.validate', target: provider });
      await reply.code(202).send(outcome.body);
    },
  );

  app.post(
    '/engine/credentials/:provider/activate',
    {
      config: { auth: 'admin', rateLimits: CREDENTIAL_LIMITS },
      schema: {
        tags: ['admin'],
        summary: 'Activate the validated candidate',
        params: ProviderParamsSchema,
        body: CandidateActionBodySchema,
        response: { 200: CredentialResultSchema },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const outcome = await request.mutate(async (tx, { now }) => {
        await adminActivateCredential(tx, { provider, ...request.body });
        return { status: 200, body: { credential: await loadCredential(tx, provider, now) } };
      });
      auditLog(request, { action: 'credentials.activate', target: provider });
      await reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '/engine/credentials/:provider',
    {
      config: { auth: 'admin', rateLimits: CREDENTIAL_LIMITS },
      schema: {
        tags: ['admin'],
        summary: 'Disable the provider locally (tombstone)',
        params: ProviderParamsSchema,
        querystring: RevokeCredentialQuerySchema,
        response: { 200: CredentialResultSchema },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const { expectedRevision } = request.query;
      const outcome = await request.mutate(async (tx, { now }) => {
        await adminRevokeCredential(tx, { provider, expectedRevision });
        return { status: 200, body: { credential: await loadCredential(tx, provider, now) } };
      });
      auditLog(request, { action: 'credentials.revoke', target: provider });
      await reply.code(200).send(outcome.body);
    },
  );
};
