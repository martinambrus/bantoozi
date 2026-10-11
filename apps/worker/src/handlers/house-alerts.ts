import { readStoredSetting, retryTransaction, updateSettingLocked } from '@bantoozi/db';
import { parseSetting } from '@bantoozi/shared';
import type { EmailMessage, Mailer } from '@bantoozi/shared/server';

import {
  BACKUP_MEMO_KEY,
  POOL_MEMO_KEY,
  alertEmail,
  applyRun,
  planNotifications,
  recoveryEmail,
  type MailOutcome,
} from '../alerts/notify.js';
import { ALERT_RULES } from '../alerts/rules.js';
import { safeText, type AlertMemo, type Condition } from '../alerts/types.js';
import { nowOf, type WorkerDeps } from './deps.js';
import { recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.alerts' as const;

/** Sends one message to each admin; delivered when at least one address accepted it. Never throws. */
async function deliver(
  deps: WorkerDeps,
  mailer: Mailer,
  admins: readonly string[],
  content: Pick<EmailMessage, 'subject' | 'text'>,
): Promise<boolean> {
  let accepted = 0;
  for (const to of admins) {
    try {
      await mailer.send({ to, ...content });
      accepted += 1;
    } catch (error) {
      deps.logger.warn(
        { job: JOB, error: safeText(error instanceof Error ? error.message : error, 200) },
        'alert email not delivered',
      );
    }
  }
  return accepted > 0;
}

/**
 * `house.alerts` (every 5 minutes, spec 11 §6, §6.1): evaluates every alert rule and mails
 * ADMIN_EMAILS one digest of the alerts due (a new incident, or one unsent for 6 h) and one of the
 * recoveries. Mail goes out before the state update, outside any transaction; `lastSentAt` is set
 * only after a send was accepted and an undelivered mail stays pending for the next run.
 */
export function createAlertsHandler(deps: WorkerDeps): QueueHandler<'house.alerts'> {
  return async () => {
    const now = nowOf(deps);
    const { mailer } = deps;
    if (mailer === undefined) throw new Error('house.alerts needs a mailer');
    const admins = deps.adminEmails ?? [];
    const state = parseSetting(
      'alerts.state',
      (await readStoredSetting(deps.db, 'alerts.state')) ?? {},
    );
    const memoEntry = state[BACKUP_MEMO_KEY];
    const poolEntry = state[POOL_MEMO_KEY];
    const memo: AlertMemo = {
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

    const plan = planNotifications(state, conditions, skipped, now);
    const outcome: MailOutcome = {};
    if (admins.length === 0) {
      if (plan.alerts.length + plan.recoveries.length > 0) {
        deps.logger.warn({ job: JOB }, 'ADMIN_EMAILS is empty: alerts cannot be sent');
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
          recoveryEmail(plan.recoveries),
        );
      }
    }

    const memoChanged = memo.backupOkAt !== undefined && memo.backupOkAt.getTime() !== remembered;
    const poolChanged =
      memo.poolStreak !== undefined &&
      (rememberedPool === undefined ||
        memo.poolStreak.at.getTime() !== rememberedPool.at.getTime() ||
        memo.poolStreak.count !== rememberedPool.count);
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
