import type { SettingValue } from '@bantoozi/shared';

import { safeText, type Condition } from './types.js';

/** Minimum time between two emails about one open incident (spec 11 §6.1). */
export const ALERT_RESEND_MS = 6 * 60 * 60_000;
/** The `alerts.state` entry that remembers the latest `backup_ok`: its `firstAt` is that time, it is never active. */
export const BACKUP_MEMO_KEY = 'memo.backup_ok';
/** The emails one run sends are bounded: a digest lists at most this many conditions. */
const DIGEST_MAX = 20;

export type AlertState = SettingValue<'alerts.state'>;

/** What a run owes: alerts to (re)send, recoveries to announce, and incidents to close without mail. */
export interface NotificationPlan {
  alerts: Condition[];
  recoveries: string[];
  silent: string[];
}

/**
 * Decides the mail of a run from the stored incidents and the conditions firing now (spec 11
 * §6.1): a new incident or one unsent for 6 h is an alert, an incident whose condition stopped is a
 * recovery (or closes silently if its alert never went out). Incidents of rules in `skipped`
 * (evaluation failed) are untouched.
 */
export function planNotifications(
  state: AlertState,
  conditions: readonly Condition[],
  skipped: readonly string[],
  now: Date,
): NotificationPlan {
  const firing = new Set(conditions.map((condition) => condition.key));
  const alerts = conditions.filter((condition) => {
    const entry = state[condition.key];
    if (entry === undefined || !entry.active) return true;
    return (
      entry.lastSentAt === null || Date.parse(entry.lastSentAt) <= now.getTime() - ALERT_RESEND_MS
    );
  });
  const recoveries: string[] = [];
  const silent: string[] = [];
  for (const [key, entry] of Object.entries(state)) {
    if (key === BACKUP_MEMO_KEY || !entry.active || firing.has(key)) continue;
    if (skipped.some((id) => key === id || key.startsWith(`${id}.`) || key.startsWith(`${id}:`)))
      continue;
    (entry.lastSentAt === null ? silent : recoveries).push(key);
  }
  return { alerts, recoveries, silent };
}

/** The alert digest email (subject and text) of the conditions to send. */
export function alertEmail(alerts: readonly Condition[]): { subject: string; text: string } {
  const first = alerts[0];
  const more = alerts.length > 1 ? ` (+${alerts.length - 1} more)` : '';
  const lines = alerts
    .slice(0, DIGEST_MAX)
    .map((a) => `* ${safeText(a.title, 120)}\n  ${safeText(a.detail, 600)}`);
  if (alerts.length > DIGEST_MAX) lines.push(`... and ${alerts.length - DIGEST_MAX} more`);
  return {
    subject: `[Bantoozi] ALERT: ${safeText(first?.title ?? 'alert', 120)}${more}`,
    text: `Bantoozi operational alert.\n\n${lines.join('\n')}\n\nThe same alert is repeated every 6 hours while it lasts; a recovery notice follows when it clears.`,
  };
}

/** The recovery digest email of the incidents that cleared. */
export function recoveryEmail(keys: readonly string[]): { subject: string; text: string } {
  const lines = keys.slice(0, DIGEST_MAX).map((key) => `* ${safeText(key, 120)}`);
  if (keys.length > DIGEST_MAX) lines.push(`... and ${keys.length - DIGEST_MAX} more`);
  return {
    subject: `[Bantoozi] RECOVERED: ${keys.length} alert${keys.length === 1 ? '' : 's'} cleared`,
    text: `Bantoozi operational alerts have cleared.\n\n${lines.join('\n')}`,
  };
}

/** What happened to the mail of a run: `undefined` when none was due. */
export interface MailOutcome {
  alertsSent?: boolean;
  recoveriesSent?: boolean;
}

/**
 * Applies a run to the stored state (called under the row lock): a delivered alert sets
 * `lastSentAt` (a new incident also `firstAt`), an undelivered one stays pending with a failure
 * count, a delivered recovery re-arms the alert by dropping the incident.
 */
export function applyRun(
  current: AlertState,
  plan: NotificationPlan,
  conditions: readonly Condition[],
  outcome: MailOutcome,
  memoBackupOkAt: Date | undefined,
  now: Date,
): AlertState {
  const next: AlertState = { ...current };
  const at = now.toISOString();
  const failed = (entry: AlertState[string]) => ({ ...entry, failures: (entry.failures ?? 0) + 1 });
  const due = new Set(plan.alerts.map((alert) => alert.key));
  for (const { key } of conditions) {
    const existing = next[key];
    const open = existing?.active === true;
    const entry = open ? existing : { firstAt: at, lastSentAt: null, active: true };
    if (!due.has(key) && open) continue;
    if (outcome.alertsSent === undefined) continue;
    if (outcome.alertsSent) {
      const { failures: _failures, ...rest } = entry;
      next[key] = { ...rest, lastSentAt: at };
    } else {
      next[key] = failed(entry);
    }
  }
  for (const key of plan.silent) delete next[key];
  if (outcome.recoveriesSent !== undefined) {
    for (const key of plan.recoveries) {
      const entry = next[key];
      if (outcome.recoveriesSent) delete next[key];
      else if (entry !== undefined) next[key] = failed(entry);
    }
  }
  if (memoBackupOkAt !== undefined) {
    next[BACKUP_MEMO_KEY] = {
      firstAt: memoBackupOkAt.toISOString(),
      lastSentAt: null,
      active: false,
    };
  }
  return next;
}
