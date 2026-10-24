import { readStoredSetting, retryTransaction, updateSettingLocked } from '@bantoozi/db';
import { parseSetting } from '@bantoozi/shared';

import { alertRecipients, deliver } from '../alerts/mail.js';
import {
  BACKUP_MEMO_KEY,
  POOL_MEMO_KEY,
  alertEmail,
  applyRun,
  planWithQueueGrace,
  recoveryEmail,
  seenMemoKey,
  type MailOutcome,
  type NotificationPlan,
} from '../alerts/notify.js';
import { ALERT_RULES } from '../alerts/rules.js';
import {
  SEEN_KINDS,
  safeText,
  type AlertMemo,
  type Condition,
  type SeenKind,
} from '../alerts/types.js';
import { nowOf, type WorkerDeps } from './deps.js';
import { recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.alerts' as const;

/**
 * `house.alerts` (every 5 minutes, spec 11 §6, §6.1): evaluates every alert rule and mails
 * the active admins (ADMIN_EMAILS only as a fallback) one digest of the alerts due (a new incident, or one unsent for 6 h) and one of the
 * recoveries. Mail goes out before the state update, outside any transaction; `lastSentAt` is set
 * only after a send was accepted and an undelivered mail stays pending for the next run.
 */
export function createAlertsHandler(deps: WorkerDeps): QueueHandler<'house.alerts'> {
  return async () => {
    const now = nowOf(deps);
    const { mailer } = deps;
    if (mailer === undefined) throw new Error('house.alerts needs a mailer');
    const admins = await alertRecipients(deps);
    let state = parseSetting(
      'alerts.state',
      (await readStoredSetting(deps.db, 'alerts.state')) ?? {},
    );
    const memoEntry = state[BACKUP_MEMO_KEY];
    const poolEntry = state[POOL_MEMO_KEY];
    const rememberedSeen: Partial<Record<SeenKind, Date>> = {};
    for (const kind of SEEN_KINDS) {
      const entry = state[seenMemoKey(kind)];
      if (entry !== undefined) rememberedSeen[kind] = new Date(entry.firstAt);
    }
    const memo: AlertMemo = {
      seen: { ...rememberedSeen },
      ...(memoEntry === undefined ? {} : { backupOkAt: new Date(memoEntry.firstAt) }),
      ...(poolEntry === undefined
        ? {}
        : { poolStreak: { at: new Date(poolEntry.firstAt), count: poolEntry.streak ?? 0 } }),
    };
    const remembered = memo.backupOkAt?.getTime();
    const rememberedPool = memo.poolStreak;

    const conditions: Condition[] = [];
    const skipped: string[] = [];
    for (const rule of ALERT_RULES) {
      try {
        conditions.push(...(await rule.evaluate({ deps, now, memo })));
      } catch (error) {
        skipped.push(rule.id);
        deps.logger.error(
          {
            job: JOB,
            rule: rule.id,
            error: safeText(error instanceof Error ? error.message : error, 200),
          },
          'alert rule failed to evaluate',
        );
      }
    }

    let plan!: NotificationPlan;
    // The first absent observation and the recovery decision must commit together, or a restart
    // could lose the grace window and re-arm a still-open queue incident.
    await retryTransaction(deps.db, (tx) =>
      updateSettingLocked(tx, 'alerts.state', {}, (current) => {
        const decision = planWithQueueGrace(
          parseSetting('alerts.state', current ?? {}),
          conditions,
          skipped,
          now,
        );
        state = decision.state;
        plan = decision.plan;
        return state;
      }),
    );
    const outcome: MailOutcome = {};
    if (admins.length === 0) {
      if (plan.alerts.length + plan.recoveries.length > 0) {
        deps.logger.warn(
          { job: JOB },
          'no active admin and ADMIN_EMAILS is empty: alerts cannot be sent',
        );
      }
      plan.alerts = [];
      plan.recoveries = [];
    } else {
      if (plan.alerts.length > 0) {
        outcome.alertsSent = await deliver(deps, mailer, admins, alertEmail(plan.alerts));
      }
      if (plan.recoveries.length > 0) {
        outcome.recoveriesSent = await deliver(
          deps,
          mailer,
          admins,
          recoveryEmail(plan.recoveries, state),
        );
      }
    }

    const memoChanged = memo.backupOkAt !== undefined && memo.backupOkAt.getTime() !== remembered;
    const poolChanged =
      memo.poolStreak !== undefined &&
      (rememberedPool === undefined ||
        memo.poolStreak.at.getTime() !== rememberedPool.at.getTime() ||
        memo.poolStreak.count !== rememberedPool.count);
    const changedSeen: Partial<Record<SeenKind, Date>> = {};
    for (const kind of SEEN_KINDS) {
      const at = memo.seen?.[kind];
      if (at !== undefined && at.getTime() !== rememberedSeen[kind]?.getTime())
        changedSeen[kind] = at;
    }
    await retryTransaction(deps.db, (tx) =>
      updateSettingLocked(tx, 'alerts.state', {}, (current) =>
        parseSetting(
          'alerts.state',
          applyRun(
            parseSetting('alerts.state', current ?? {}),
            plan,
            admins.length === 0 ? [] : conditions,
            outcome,
            memoChanged ? memo.backupOkAt : undefined,
            now,
            poolChanged ? memo.poolStreak : undefined,
            changedSeen,
          ),
        ),
      ),
    );
    deps.logger.info(
      {
        job: JOB,
        firing: conditions.length,
        sent: plan.alerts.length,
        recovered: plan.recoveries.length,
        skippedRules: skipped.length,
      },
      'alerts evaluated',
    );
    await recordHouseProgress(deps, JOB, now, true);
  };
}
