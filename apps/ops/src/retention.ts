/**
 * Backup retention (spec 11 §4): 7 daily, 4 weekly (Sunday) and 6 monthly (the 1st) backups, by
 * the UTC date in the backup id, never deleting the last restore-tested backup. One backup may
 * satisfy several buckets. The functions here are pure so fake dates can drive them in tests.
 */

export const DAILY_KEEP = 7;
export const WEEKLY_KEEP = 4;
export const MONTHLY_KEEP = 6;
/** A backup that failed part-way (it carries a `backup-failed` marker) is removed after this. */
export const FAILED_BACKUP_GRACE_MS = 2 * 24 * 3_600_000;
/** Deletion-ledger copies live for the longest backup lifetime plus 7 days (spec 11 §5.1). */
export const LEDGER_KEEP_DAYS = 31 * 6 + 7;

const ID_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u;

/** `YYYYMMDDTHHMMSSZ` of an instant (UTC). */
export function backupIdOf(date: Date): string {
  return date.toISOString().replace(/[-:]|\.\d{3}/gu, '');
}

/** The instant a backup id names, or undefined when `id` is not a backup id. */
export function backupIdTime(id: string): Date | undefined {
  const m = ID_PATTERN.exec(id);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return backupIdOf(date) === id ? date : undefined;
}

const dayOf = (id: string): string => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;

export interface RetentionInput {
  /** Every valid backup id in the bucket (failed ones excluded). */
  ids: readonly string[];
  /** Ids carrying a `restore-tested.json` marker. */
  restoreTested: readonly string[];
  now: Date;
}

export interface RetentionPlan {
  keep: Map<string, string[]>;
  prune: string[];
}

/**
 * Which ids stay and why.
 * - daily: every backup of the 7 most recent UTC dates that have one (a pre-deploy backup and the
 *   cron backup of the same day both stay until the date leaves the window);
 * - weekly: the newest backup of each of the 4 most recent Sundays that have one;
 * - monthly: the newest backup of each of the 6 most recent 1st-of-month dates that have one;
 * - the newest restore-tested backup, whatever its age.
 * An id newer than `now` is never pruned (a clock override must not delete a future backup).
 */
export function planRetention(input: RetentionInput): RetentionPlan {
  const times = new Map<string, Date>();
  for (const id of input.ids) {
    const time = backupIdTime(id);
    if (time !== undefined) times.set(id, time);
  }
  const ids = [...times.keys()].sort();
  const current = ids.filter((id) => (times.get(id) as Date) <= input.now);
  const keep = new Map<string, string[]>(ids.map((id) => [id, []]));
  const mark = (id: string, reason: string): void => {
    const reasons = keep.get(id);
    if (reasons !== undefined && !reasons.includes(reason)) reasons.push(reason);
  };
  const newestOf = (day: string): string =>
    current.filter((id) => dayOf(id) === day).reduce((a, b) => (a > b ? a : b));
  const recentDays = (filter: (day: string) => boolean, count: number): string[] =>
    [...new Set(current.map(dayOf))].filter(filter).sort().reverse().slice(0, count);

  for (const day of recentDays(() => true, DAILY_KEEP)) {
    for (const id of current.filter((candidate) => dayOf(candidate) === day)) mark(id, 'daily');
  }
  for (const day of recentDays((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0, WEEKLY_KEEP)) {
    mark(newestOf(day), 'weekly');
  }
  for (const day of recentDays((d) => d.endsWith('-01'), MONTHLY_KEEP)) {
    mark(newestOf(day), 'monthly');
  }
  const tested = input.restoreTested.filter((id) => keep.has(id)).sort();
  const lastTested = tested[tested.length - 1];
  if (lastTested !== undefined) mark(lastTested, 'last-restore-tested');
  for (const id of ids) {
    if ((times.get(id) as Date) > input.now) mark(id, 'future');
  }
  const prune = ids.filter((id) => (keep.get(id) ?? []).length === 0);
  for (const id of prune) keep.delete(id);
  return { keep, prune };
}

/** Whether a deletion-ledger copy named for backup `id` has outlived its retention. */
export function ledgerExpired(id: string, now: Date): boolean {
  const time = backupIdTime(id);
  return time !== undefined && now.getTime() - time.getTime() > LEDGER_KEEP_DAYS * 86_400_000;
}

/** Whether a failed backup's leftovers may be deleted. */
export function failedExpired(id: string, now: Date): boolean {
  const time = backupIdTime(id);
  return time !== undefined && now.getTime() - time.getTime() > FAILED_BACKUP_GRACE_MS;
}
