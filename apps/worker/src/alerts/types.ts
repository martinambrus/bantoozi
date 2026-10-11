import type { WorkerDeps } from '../handlers/deps.js';

/** One firing alert condition of a `house.alerts` run (spec 11 §6.1). `key` starts with its rule's `id`. */
export interface Condition {
  key: string;
  title: string;
  detail: string;
}

/** What `house.alerts` remembers between runs besides incident state (spec 11 §6.1 "Backups"). */
export interface AlertMemo {
  /** The latest `backup_ok` ever seen: `ops.events` keeps only 50 events. */
  backupOkAt?: Date;
  /** Consecutive `house.alerts` samples whose worker pool had waiting clients, and the last sample's time. */
  poolStreak?: { at: Date; count: number };
}

/** The inputs of a rule evaluation: the worker dependencies, the run's clock and the mutable memo. */
export interface RuleContext {
  deps: WorkerDeps;
  now: Date;
  memo: AlertMemo;
}

/** An alert rule: `evaluate` returns the conditions firing now; an error leaves the rule's incidents untouched. */
export interface AlertRule {
  id: string;
  evaluate(context: RuleContext): Promise<Condition[]>;
}

/** Strips control characters and bounds a value taken from stored data before it enters an email (spec 11 §6.1). */
export function safeText(value: unknown, max = 120): string {
  return Array.from(String(value), (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : char;
  })
    .join('')
    .slice(0, max);
}
