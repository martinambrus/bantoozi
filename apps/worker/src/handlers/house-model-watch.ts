import {
  readStoredSetting,
  retryTransaction,
  updateSettingLocked,
  type Database,
} from '@bantoozi/db';
import {
  MODEL_NOTICE_MAX_ATTEMPTS,
  isConcreteJevModel,
  isModelAlias,
  type EngineModelProbe,
  type EngineModelWatch,
} from '@bantoozi/shared';
import type { Mailer } from '@bantoozi/shared/server';

import { alertRecipients, deliver } from '../alerts/mail.js';
import { ensureFingerprintRegistered } from '../learn/fingerprints.js';
import { recordModelProbe, type ModelProber } from '../model-probe.js';
import {
  readResolutionState,
  recordModelResolution,
  recordStartResolution,
  resolutionInForce,
} from '../model-resolution.js';
import {
  MODEL_CANDIDATE_KEY,
  MODEL_WATCH_KEY,
  isOlderSameMajorRelease,
  observeModelCandidate,
  retryModelCandidate,
  upgradeMail,
  watchStateOf,
  writePendingNotice,
} from '../model-watch.js';
import type { HandlerLogger, WorkerDeps } from './deps.js';
import { MODEL_PROBE_DEADLINE_MS } from './model-probe.js';
import { recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.model-watch' as const;

type Notice = NonNullable<EngineModelWatch['notice']>;

export interface ModelWatchDeps {
  db: Database;
  prober: ModelProber;
  logger: HandlerLogger;
  /** The effective configured model, read live. */
  configuredModel(): Promise<string>;
  settingsEnv: WorkerDeps['settingsEnv'];
  mailer?: Mailer | undefined;
  adminEmails?: readonly string[] | undefined;
  now?: () => Date;
}

const sameNotice = (a: Notice | undefined, b: Notice): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * `house.model-watch` (every 6 hours, on start, after a retired-model failure, or by hand): probes
 * the alias `jev-latest` and adopts a different concrete answer after two agreeing probes ≥10 min
 * apart. The outgoing rating fingerprint is registered first, then `engine.model_resolution` and
 * the pending notice are written in one transaction and the admins are mailed. A dormant stored
 * resolution (see `resolutionInForce`) is replaced silently by the answer, with no fingerprint,
 * notice or mail. Workers restart through
 * the stale-worker machinery; this job never touches `engine.model_pin`. A failed probe or mail is
 * recorded, never thrown.
 */
export function createModelWatchHandler(deps: ModelWatchDeps): QueueHandler<typeof JOB> {
  const { db, prober, logger } = deps;
  const now = (): Date => deps.now?.() ?? new Date();

  const updateState = (
    change: (state: EngineModelWatch) => EngineModelWatch,
    clearCandidate = false,
    retryCandidate = false,
  ): Promise<void> =>
    retryTransaction(db, async (tx) => {
      await updateSettingLocked<EngineModelWatch>(tx, MODEL_WATCH_KEY, {}, (current) =>
        change(watchStateOf(current)),
      );
      if (retryCandidate) await retryModelCandidate(tx, now());
      if (clearCandidate) {
        await updateSettingLocked(tx, MODEL_CANDIDATE_KEY, null, () => null);
      }
    });

  const checkedWithoutCandidate = (): Promise<void> =>
    updateState((state) => ({ ...state, lastCheck: { at: now().toISOString(), ok: true } }), true);

  /** One round of sending the pending notice, if any. */
  const deliverPending = async (): Promise<void> => {
    const notice = watchStateOf(await readStoredSetting(db, MODEL_WATCH_KEY)).notice;
    if (notice === undefined) return;
    const clear = (state: EngineModelWatch): EngineModelWatch => {
      if (!sameNotice(state.notice, notice)) return state;
      const { notice: _gone, ...rest } = state;
      return rest;
    };
    const { mailer } = deps;
    const admins =
      mailer === undefined
        ? []
        : await alertRecipients(
            {
              db,
              logger,
              ...(deps.adminEmails === undefined ? {} : { adminEmails: deps.adminEmails }),
            },
            JOB,
          );
    if (mailer === undefined || admins.length === 0) {
      logger.warn(
        { job: JOB, from: notice.from, to: notice.to },
        'Jev upgrade mail has no recipient',
      );
      await updateState(clear);
      return;
    }
    if (await deliver({ logger }, mailer, admins, upgradeMail(notice), JOB)) {
      await updateState(clear);
      return;
    }
    const attempts = notice.attempts + 1;
    if (attempts >= MODEL_NOTICE_MAX_ATTEMPTS) {
      logger.error(
        { job: JOB, from: notice.from, to: notice.to, attempts },
        'Jev upgrade mail given up',
      );
      await updateState(clear);
      return;
    }
    await updateState((state) =>
      sameNotice(state.notice, notice) ? { ...state, notice: { ...notice, attempts } } : state,
    );
  };

  const probeModel = async (alias: string): Promise<EngineModelProbe> => {
    try {
      return await prober.probe(alias, { signal: AbortSignal.timeout(MODEL_PROBE_DEADLINE_MS) });
    } catch (error) {
      logger.warn(
        { job: JOB, model: alias, err: error instanceof Error ? error.message : 'unknown' },
        'model probe rejected',
      );
      return { requested: alias, ok: false, at: now().toISOString(), error: 'internal_error' };
    }
  };

  return async () => {
    await deliverPending();
    const alias = await deps.configuredModel();
    if (!isModelAlias(alias)) {
      await updateState((state) => state, true);
      await recordHouseProgress({ db }, JOB, now(), true);
      return;
    }

    const probe = await probeModel(alias);
    await recordModelProbe(db, probe, logger);
    const answered = probe.answered;
    if (!probe.ok || answered === undefined || !isConcreteJevModel(answered)) {
      const error = (probe.error ?? 'not_concrete').slice(0, 200);
      await updateState(
        (state) => ({ ...state, lastCheck: { at: now().toISOString(), ok: false, error } }),
        false,
        true,
      );
      logger.warn({ job: JOB, model: alias, error }, 'jev-latest probe failed; keeping the model');
      await recordHouseProgress({ db }, JOB, now(), true);
      return;
    }

    if ((await deps.configuredModel()) !== alias) {
      await updateState((state) => state, true);
      await recordHouseProgress({ db }, JOB, now(), true);
      return;
    }
    const { row: stored, pin } = await readResolutionState(db);
    if (stored !== null && stored.alias === alias && !resolutionInForce(stored, pin, now())) {
      const at = now();
      await recordStartResolution(db, { alias, model: answered, now: at, dormant: stored });
      await checkedWithoutCandidate();
      await recordHouseProgress({ db }, JOB, now(), true);
      return;
    }
    if (stored !== null && stored.alias === alias && stored.model !== answered) {
      if (isOlderSameMajorRelease(answered, stored.model)) {
        const currentProbe = await probeModel(stored.model);
        await recordModelProbe(db, currentProbe, logger);
        if (currentProbe.ok || currentProbe.error !== 'model_unavailable') {
          logger.warn({ job: JOB, current: stored.model, answered }, 'older Jev release ignored');
          await checkedWithoutCandidate();
          await recordHouseProgress({ db }, JOB, now(), true);
          return;
        }
      }
      if (!(await observeModelCandidate(db, answered, now()))) {
        logger.info({ job: JOB, model: answered }, 'Jev release awaits confirmation');
        await recordHouseProgress({ db }, JOB, now(), true);
        return;
      }
      await ensureFingerprintRegistered(
        db,
        { settingsEnv: deps.settingsEnv, primaryModel: stored.model },
        now(),
      );
    }
    const at = now();
    const result = await recordModelResolution(
      db,
      { alias, model: answered, now: at, expectedModel: stored?.model ?? null },
      (tx, change) => writePendingNotice(tx, change, at),
    );
    await checkedWithoutCandidate();
    if (result.changed && result.previous !== undefined) {
      logger.info({ job: JOB, from: result.previous, to: answered }, 'Jev release adopted');
      await deliverPending();
    }
    await recordHouseProgress({ db }, JOB, now(), true);
  };
}
