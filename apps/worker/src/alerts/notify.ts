import type { SettingValue } from '@bantoozi/shared';

import { safeText, type Condition, type SeenKind } from './types.js';

/** Minimum time between two emails about one open incident (spec 11 §6.1). */
export const ALERT_RESEND_MS = 6 * 60 * 60_000;
/** The `alerts.state` entry that remembers the latest `backup_ok`: its `firstAt` is that time, it is never active. */
export const BACKUP_MEMO_KEY = 'memo.backup_ok';
/** The `alerts.state` entry of the pool streak: `firstAt` is the last counted run, `streak` the run count; never active. */
/** The `alerts.state` entry of the latest `backup_failed`, `restore_ok` or `restore_failed` seen: `firstAt` is that time; never active. */
export const seenMemoKey = (kind: SeenKind): string => `memo.seen.${kind}`;
export const POOL_MEMO_KEY = 'memo.pool_waiting';
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
  const waiting = (condition: Condition): number => {
    // Sort key: never-mailed conditions first (a new one by now, an open one by its firstAt), then
    // the longest-unsent first, so a truncated digest rotates through every condition.
    const entry = state[condition.key];
    if (entry === undefined || !entry.active) return Number.NEGATIVE_INFINITY;
    return entry.lastSentAt === null
      ? Date.parse(entry.firstAt) - 1e15
      : Date.parse(entry.lastSentAt);
  };
  const alerts = conditions
    .filter((condition) => {
      const entry = state[condition.key];
      if (entry === undefined || !entry.active) return true;
      return (
        entry.lastSentAt === null || Date.parse(entry.lastSentAt) <= now.getTime() - ALERT_RESEND_MS
      );
    })
    .sort((a, b) => waiting(a) - waiting(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    // One digest lists DIGEST_MAX conditions; the rest stay unsent and lead the next run's digest.
    .slice(0, DIGEST_MAX);
  const cleared: string[] = [];
  const silent: string[] = [];
  for (const [key, entry] of Object.entries(state)) {
    if (key === BACKUP_MEMO_KEY || key === POOL_MEMO_KEY || !entry.active || firing.has(key))
      continue;
    if (skipped.some((id) => key === id || key.startsWith(`${id}.`) || key.startsWith(`${id}:`)))
      continue;
    (entry.lastSentAt === null ? silent : cleared).push(key);
  }
  // A recovery mail lists at most DIGEST_MAX keys, so only those are planned (and later deleted):
  // the rest stay open and are mailed by the next run. Oldest incident first, then by key.
  const since = (key: string): number => Date.parse(state[key]?.firstAt ?? '') || 0;
  const recoveries = cleared
    .sort((a, b) => since(a) - since(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, DIGEST_MAX);
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
  memoPool?: { at: Date; count: number },
  memoSeen: Partial<Record<SeenKind, Date>> = {},
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
    // A new condition cut from the digest is opened unsent, so the next run mails it first.
    if (!due.has(key)) {
      next[key] = entry;
      continue;
    }
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
  for (const [kind, at] of Object.entries(memoSeen) as Array<[SeenKind, Date]>) {
    next[seenMemoKey(kind)] = { firstAt: at.toISOString(), lastSentAt: null, active: false };
  }
  if (memoPool !== undefined) {
    next[POOL_MEMO_KEY] = {
      firstAt: memoPool.at.toISOString(),
      lastSentAt: null,
      active: false,
      streak: memoPool.count,
    };
  }
  return next;
}
