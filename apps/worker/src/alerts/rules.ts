import {
  degradedShareLastHour,
  dueJobBacklog,
  feedErrorShare24h,
  latestMetricsSnapshots,
  latestTypesafeFailure,
  oldestPendingOutboxAgeSeconds,
  readStoredSetting,
  terminalFailureCounts,
  typesafeModelMismatches,
} from '@bantoozi/db';
import {
  HOUSE_CRON_SCHEDULES,
  HOUSE_PROGRESS_CURSORS,
  HostHealthDetailSchema,
  readSetting,
  utcDay,
  type SettingKey,
} from '@bantoozi/shared';
import {
  safeText,
  type AlertRule,
  type Condition,
  type RuleContext,
  type SeenKind,
} from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Alert thresholds (spec 11 §6.1, spec 10 §7). */
export const ALERT_THRESHOLDS = {
  breakerOpenMs: 30 * MINUTE,
  /** Must exceed the longest probe gap of a flapping breaker (30 min), or the incident clears and re-fires between probes. */
  mismatchWindowMs: 45 * MINUTE,
  backlogDue: 5_000,
  backlogOldestSeconds: 30 * 60,
  outboxSeconds: 5 * 60,
  heartbeatStaleMs: 30 * MINUTE,
  houseOverduePeriods: 2,
  degradedMinArticles: 20,
  feedsMinSubscribed: 5,
  diskUsedPct: 80,
  diskFreeBytes: 10e9,
  hostHealthStaleMs: HOUR,
  backupMissingMs: 26 * HOUR,
  metricsMinRated: 30,
  metricsDays: 3,
  /** Rising terminal failures: at least this many in the last hour, and this many times the hourly mean of the 24 h before. */
  failuresMin: 20,
  failuresFactor: 3,
  /** Consecutive `house.alerts` samples with waiting pool clients. */
  poolStreak: 3,
  /** Restarts of one container within the hour that raise the alert. */
  restartsMin: 3,
  restartsWindowMs: HOUR,
} as const;

const read = async <K extends SettingKey>(context: RuleContext, key: K) =>
  readSetting(key, await readStoredSetting(context.deps.db, key), context.deps.settingsEnv);

/** A lookup that only enriches an alert's detail must never keep the alert itself from firing. */
async function bestEffort<T>(lookup: () => Promise<T>): Promise<T | undefined> {
  try {
    return await lookup();
  } catch {
    return undefined;
  }
}

const duration = (ms: number): string => {
  if (ms < 2 * HOUR) return `${Math.round(ms / MINUTE)} minutes`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} hours`;
  return `${Math.round(ms / (24 * HOUR))} days`;
};

/**
 * `engine.circuit.typesafe` failing (`open` or `half_open`) for more than 30 minutes, measured from the
 * start of the failing streak (`failingSince`, else `openedAt`), or `auth` (spec 11 §6.1 "Engine breaker open").
 */
const breakerRule: AlertRule = {
  id: 'engine.breaker',
  async evaluate(context) {
    const circuit = await read(context, 'engine.circuit');
    const breaker = circuit?.typesafe;
    if (breaker === undefined) return [];
    if (breaker.state === 'auth') {
      return [
        {
          key: 'engine.breaker',
          title: 'Engine credentials rejected',
          detail: 'The decision engine breaker is in state auth: the provider key was rejected.',
        },
      ];
    }
    if (breaker.state !== 'open' && breaker.state !== 'half_open') return [];
    const start = breaker.failingSince ?? breaker.openedAt;
    if (start === undefined) return [];
    const startMs = Date.parse(start);
    const failingMs = context.now.getTime() - startMs;
    if (Number.isNaN(startMs) || failingMs <= ALERT_THRESHOLDS.breakerOpenMs) return [];
    const failure = await bestEffort(() =>
      latestTypesafeFailure(context.deps.db, context.now, new Date(startMs - 10 * MINUTE)),
    );
    const configured =
      (await bestEffort(() => read(context, 'engine.typesafe_model'))) ??
      context.deps.classification?.primaryModel;
    const pinned = (await bestEffort(() => read(context, 'engine.model_pin')))?.model;
    const parts = [
      `The decision engine has been failing for ${duration(failingMs)} (since ${start}; breaker ${breaker.state}, ${breaker.reopenCount} re-opens).`,
    ];
    if (failure !== undefined && failure !== null) {
      parts.push(
        `Last TypeSafe failure: ${failure.status}${failure.detail === null ? '' : ` ${failure.detail}`}${failure.model === null ? '' : ` on ${failure.model}`} at ${failure.at.toISOString()}.`,
      );
    }
    if (configured !== undefined) parts.push(`Configured model: ${configured}.`);
    if (pinned !== undefined) parts.push(`Pinned model: ${pinned}.`);
    return [
      {
        key: 'engine.breaker',
        title: 'Classification engine failing',
        detail: safeText(parts.join(' '), 600),
      },
    ];
  },
};

/** TypeSafe answered with another model than requested within the last 45 minutes (the 2026-10-17 outage). */
const mismatchRule: AlertRule = {
  id: 'engine.model_mismatch',
  async evaluate(context) {
    const groups = await typesafeModelMismatches(
      context.deps.db,
      context.now,
      ALERT_THRESHOLDS.mismatchWindowMs,
    );
    if (groups.length === 0) return [];
    const pairs = groups
      .slice(0, 3)
      .map(
        (g) =>
          `requested ${g.requested ?? 'unknown'}, answered ${g.answered} (${g.calls} calls, latest ${g.latestAt.toISOString()})`,
      );
    return [
      {
        key: 'engine.model_mismatch',
        title: 'Jev answered with another model',
        detail: safeText(`Jev named another model than requested: ${pairs.join('; ')}.`, 600),
      },
    ];
  },
};

/** Today's `engine.budget_alerts` p80/p100 crossing (spec 04 §6). */
const budgetRule: AlertRule = {
  id: 'engine.budget',
  async evaluate(context) {
    const alerts = await read(context, 'engine.budget_alerts');
    if (alerts === undefined || alerts.day !== utcDay(context.now)) return [];
    if (alerts.p100At !== undefined) {
      return [
        {
          key: 'engine.budget',
          title: 'Daily engine budget exhausted',
          detail: `The daily budget reached 100 % at ${safeText(alerts.p100At)}.`,
        },
      ];
    }
    if (alerts.p80At !== undefined) {
      return [
        {
          key: 'engine.budget',
          title: 'Daily engine budget at 80 %',
          detail: `The daily budget reached 80 % at ${safeText(alerts.p80At)}.`,
        },
      ];
    }
    return [];
  },
};

/** Due jobs per queue, the oldest due job and the pending outbox (spec 11 §6.1 "Pipeline backlog"). */
const backlogRule: AlertRule = {
  id: 'backlog',
  async evaluate({ deps, now }) {
    const out: Condition[] = [];
    for (const queue of await dueJobBacklog(deps.db, now)) {
      const name = safeText(queue.queue, 64);
      if (queue.due > ALERT_THRESHOLDS.backlogDue) {
        out.push({
          key: `backlog.depth:${name}`,
          title: `Backlog in ${name}`,
          detail: `${queue.due} due jobs wait in ${name}.`,
        });
      }
      if (queue.oldestDueSeconds > ALERT_THRESHOLDS.backlogOldestSeconds) {
        out.push({
          key: `backlog.age:${name}`,
          title: `Stuck jobs in ${name}`,
          detail: `The oldest due job in ${name} has waited ${Math.round(queue.oldestDueSeconds / 60)} minutes.`,
        });
      }
    }
    const outbox = await oldestPendingOutboxAgeSeconds(deps.db, now);
    if (outbox !== null && outbox > ALERT_THRESHOLDS.outboxSeconds) {
      out.push({
        key: 'backlog.outbox',
        title: 'Outbox backlog',
        detail: `The oldest pending outbox intent is ${Math.round(outbox / 60)} minutes old.`,
      });
    }
    return out;
  },
};

/** Worker heartbeat, overdue housekeeping jobs and LibreTranslate (spec 11 §6.1 "Service health"). */
const serviceRule: AlertRule = {
  id: 'service',
  async evaluate(context) {
    const { deps, now } = context;
    const out: Condition[] = [];
    const heartbeats = (await read(context, 'worker.heartbeat')) ?? {};
    const newest = Math.max(0, ...Object.values(heartbeats).map((entry) => Date.parse(entry.at)));
    if (now.getTime() - newest >= ALERT_THRESHOLDS.heartbeatStaleMs) {
      out.push({
        key: 'service.heartbeat',
        title: 'No worker heartbeat',
        detail:
          newest === 0
            ? 'No worker has reported a heartbeat.'
            : `The newest worker heartbeat is from ${new Date(newest).toISOString()}.`,
      });
    }
    const progress = (await read(context, 'house.progress')) ?? {};
    for (const [job, schedule] of Object.entries(HOUSE_CRON_SCHEDULES)) {
      const updatedAt = progress[job]?.updatedAt;
      const grace = ALERT_THRESHOLDS.houseOverduePeriods * schedule.everyMs;
      if (updatedAt === undefined) {
        // Never recorded: overdue once a worker consuming the job has been up longer than the grace
        // (the earliest `startedAt` among the heartbeats, so a fresh deploy is not alarmed).
        const started = Object.values(heartbeats)
          .filter((entry) => entry.startedAt !== undefined && entry.queues.includes(job))
          .map((entry) => Date.parse(entry.startedAt!));
        if (started.length > 0 && now.getTime() - Math.min(...started) > grace) {
          out.push({
            key: `service.house:${job}`,
            title: `${job} is overdue`,
            detail: `${job} has never recorded a run although a worker has been up for more than ${ALERT_THRESHOLDS.houseOverduePeriods} periods.`,
          });
        }
        continue;
      }
      const age = now.getTime() - Date.parse(updatedAt);
      if (age > grace) {
        out.push({
          key: `service.house:${job}`,
          title: `${job} is overdue`,
          detail: `${job} last ran at ${safeText(updatedAt)}, more than ${ALERT_THRESHOLDS.houseOverduePeriods} periods ago.`,
        });
      }
    }
    if (deps.libreTranslateProbe !== undefined) {
      const modes = (await read(context, 'language_modes')) ?? {};
      const needed =
        Object.values(modes).includes('translate') ||
        (await read(context, 'card_text_mode')) === 'english';
      if (needed && !(await deps.libreTranslateProbe().catch(() => false))) {
        out.push({
          key: 'service.libretranslate',
          title: 'LibreTranslate unreachable',
          detail: 'LibreTranslate does not answer while translation is in use.',
        });
      }
    }
    return out;
  },
};

/**
 * `house.purge-users` last ran with users erased 7 days ago waiting and no deletion ledger or HMAC
 * key configured (its `disabled` cursor, spec 11 §5.1) or with a failed run (its `failed` cursor,
 * raising `erasure.failed`): erasure is not happening. Production
 * refuses to start without the ledger, so this guards every other environment.
 */
const erasureRule: AlertRule = {
  id: 'erasure',
  async evaluate(context) {
    const progress = (await read(context, 'house.progress')) ?? {};
    const cursor = HOUSE_PROGRESS_CURSORS['house.purge-users'].safeParse(
      progress['house.purge-users']?.cursor,
    );
    if (!cursor.success) return [];
    if ('failed' in cursor.data) {
      const { ledger, db, blocked } = cursor.data.failed;
      return [
        {
          key: 'erasure.failed',
          title: 'Account erasure is failing',
          detail: `The last house.purge-users run could not erase every due account (ledger append failures ${ledger}, deletion failures ${db}, blocked by a card reference ${blocked}).`,
        },
      ];
    }
    return [
      {
        key: 'erasure.disabled',
        title: 'Account erasure is disabled',
        detail:
          'Accounts erased more than 7 days ago are not being deleted: the deletion ledger or its HMAC key is not configured.',
      },
    ];
  },
};

/** More than 20 % of the last hour's new articles degraded (spec 11 §6.1). */
const degradedRule: AlertRule = {
  id: 'degraded',
  async evaluate({ deps, now }) {
    const { total, degraded } = await degradedShareLastHour(deps.db, now);
    if (total < ALERT_THRESHOLDS.degradedMinArticles || degraded * 5 <= total) return [];
    return [
      {
        key: 'degraded',
        title: 'Many degraded articles',
        detail: `${degraded} of ${total} articles first seen in the last hour are degraded.`,
      },
    ];
  },
};

/** More than 10 % of subscribed feeds errored in 24 h (spec 11 §6.1). */
const feedsRule: AlertRule = {
  id: 'feeds',
  async evaluate({ deps, now }) {
    const { total, errored } = await feedErrorShare24h(deps.db, now);
    if (total < ALERT_THRESHOLDS.feedsMinSubscribed || errored * 10 <= total) return [];
    return [
      {
        key: 'feeds',
        title: 'Many feeds failing',
        detail: `${errored} of ${total} subscribed feeds had an error in the last 24 hours.`,
      },
    ];
  },
};

type OpsEvents = NonNullable<Awaited<ReturnType<typeof readOpsEvents>>>;
async function readOpsEvents(context: RuleContext) {
  return (await read(context, 'ops.events')) ?? [];
}
const latest = (events: OpsEvents, kind: string): number | undefined => {
  const times = events.filter((event) => event.kind === kind).map((event) => Date.parse(event.at));
  return times.length === 0 ? undefined : Math.max(...times);
};

/** The latest time of `kind` in the retained events or in the memo; the memo keeps the newer one (R5). */
function remember(context: RuleContext, events: OpsEvents, kind: SeenKind): number | undefined {
  const seen = latest(events, kind);
  const seenBefore = context.memo.seen?.[kind]?.getTime();
  const newest = Math.max(seen ?? -Infinity, seenBefore ?? -Infinity);
  if (newest === -Infinity) return undefined;
  if (seenBefore === undefined || newest > seenBefore) {
    context.memo.seen = { ...context.memo.seen, [kind]: new Date(newest) };
  }
  return newest;
}

/** The latest `host_health` report: filesystem capacity and its freshness (spec 11 §6.1 "Disk"). */
const diskRule: AlertRule = {
  id: 'disk',
  async evaluate(context) {
    const events = await readOpsEvents(context);
    const reports = events.filter((event) => event.kind === 'host_health');
    const newest = reports.reduce<(typeof reports)[number] | undefined>(
      (best, event) =>
        best === undefined || Date.parse(event.at) > Date.parse(best.at) ? event : best,
      undefined,
    );
    if (
      newest === undefined ||
      context.now.getTime() - Date.parse(newest.at) > ALERT_THRESHOLDS.hostHealthStaleMs
    ) {
      return [
        {
          key: 'disk.stale',
          title: 'No host health report',
          detail:
            newest === undefined
              ? 'No host_health event was received.'
              : `The latest host_health event is from ${safeText(newest.at)}.`,
        },
      ];
    }
    let detail: ReturnType<typeof HostHealthDetailSchema.parse>;
    try {
      detail = HostHealthDetailSchema.parse(JSON.parse(newest.detail));
    } catch {
      return [];
    }
    const problems: string[] = [];
    for (const fs of detail.filesystems ?? []) {
      const reasons: string[] = [];
      if (fs.usedPct > ALERT_THRESHOLDS.diskUsedPct) reasons.push(`${fs.usedPct} % used`);
      if (fs.freeBytes < ALERT_THRESHOLDS.diskFreeBytes)
        reasons.push(`${Math.round(fs.freeBytes / 1e9)} GB free`);
      if ((fs.inodesUsedPct ?? 0) >= 100) reasons.push('no inodes left');
      if (reasons.length > 0) problems.push(`${safeText(fs.mount, 100)}: ${reasons.join(', ')}`);
    }
    if (problems.length === 0) return [];
    return [{ key: 'disk', title: 'Disk capacity', detail: problems.join('\n') }];
  },
};

/** Backup and restore failures and a missing `backup_ok` (spec 11 §6.1 "Backups"). */
const backupsRule: AlertRule = {
  id: 'backup',
  async evaluate(context) {
    const events = await readOpsEvents(context);
    const { now, memo } = context;
    const seenOk = latest(events, 'backup_ok');
    if (
      seenOk !== undefined &&
      (memo.backupOkAt === undefined || seenOk > memo.backupOkAt.getTime())
    ) {
      memo.backupOkAt = new Date(seenOk);
    }
    const lastOk = memo.backupOkAt?.getTime();
    const out: Condition[] = [];
    const backupFailed = remember(context, events, 'backup_failed');
    if (backupFailed !== undefined && (lastOk === undefined || backupFailed > lastOk)) {
      out.push({
        key: 'backup.failed',
        title: 'Backup failed',
        detail: `The backup script reported a failure at ${new Date(backupFailed).toISOString()}.`,
      });
    }
    const restoreFailed = remember(context, events, 'restore_failed');
    const restoreOk = remember(context, events, 'restore_ok');
    if (restoreFailed !== undefined && (restoreOk === undefined || restoreFailed > restoreOk)) {
      out.push({
        key: 'backup.restore',
        title: 'Restore test failed',
        detail: `The restore test reported a failure at ${new Date(restoreFailed).toISOString()}.`,
      });
    }
    if (lastOk === undefined || now.getTime() - lastOk > ALERT_THRESHOLDS.backupMissingMs) {
      out.push({
        key: 'backup.missing',
        title: 'No recent backup',
        detail:
          lastOk === undefined
            ? 'No backup_ok event has been received.'
            : `The last backup_ok is from ${new Date(lastOk).toISOString()}.`,
      });
    }
    return out;
  },
};

interface Lane {
  likeRate: number;
  rated: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `for_you` and `maybe` lanes of one lanes object, or `undefined` when the shape differs. */
function lanePair(lanes: unknown): { forYou: Lane; maybe: Lane } | undefined {
  if (!isRecord(lanes)) return undefined;
  const lane = (value: unknown): Lane | undefined => {
    if (!isRecord(value)) return undefined;
    const { likeRate, rated } = value;
    return typeof likeRate === 'number' && typeof rated === 'number'
      ? { likeRate, rated }
      : undefined;
  };
  const forYou = lane(lanes['for_you']);
  const maybe = lane(lanes['maybe']);
  return forYou === undefined || maybe === undefined ? undefined : { forYou, maybe };
}

/**
 * The lanes a daily snapshot is judged on: the trailing 7-day window when the snapshot has one (a
 * day alone rarely holds 30 ratings per lane), else the day's own `lanes`.
 */
function lanesOf(snapshot: unknown): { forYou: Lane; maybe: Lane } | undefined {
  if (!isRecord(snapshot)) return undefined;
  const windows = snapshot['windows'];
  const d7 = isRecord(windows) && isRecord(windows['d7']) ? windows['d7'] : undefined;
  return lanePair(d7?.['lanes']) ?? lanePair(snapshot['lanes']);
}

const Z95 = 1.959964;

/** The Wilson score interval of a proportion `p` out of `n`. */
function wilson(p: number, n: number): [number, number] {
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Upper bound of the 95 % Newcombe-Wilson interval of `forYou - maybe` (hybrid score interval of a
 * difference of two proportions). Below 0 means For You is below Maybe beyond sampling noise.
 */
export function forYouMinusMaybeUpper(forYou: Lane, maybe: Lane): number {
  const [, u1] = wilson(forYou.likeRate, forYou.rated);
  const [l2] = wilson(maybe.likeRate, maybe.rated);
  return (
    forYou.likeRate -
    maybe.likeRate +
    Math.sqrt((u1 - forYou.likeRate) ** 2 + (maybe.likeRate - l2) ** 2)
  );
}

/**
 * For You like-rate below Maybe on 3 consecutive daily snapshots, each with 30+ rated per lane and
 * a 95 % Newcombe-Wilson interval of the difference entirely below 0 (spec 10 §7).
 */
const metricsRule: AlertRule = {
  id: 'metrics',
  async evaluate({ deps, now }) {
    const today = utcDay(now);
    const snapshots = (await latestMetricsSnapshots(deps.db, ALERT_THRESHOLDS.metricsDays + 2))
      .filter(([day]) => day <= today)
      .slice(0, ALERT_THRESHOLDS.metricsDays);
    if (snapshots.length < ALERT_THRESHOLDS.metricsDays) return [];
    const days = snapshots.map(([day]) => Date.parse(day));
    const consecutive = days.every((day, i) => i === 0 || days[i - 1]! - day === 24 * HOUR);
    if (!consecutive) return [];
    for (const [, value] of snapshots) {
      const lanes = lanesOf(value);
      if (lanes === undefined) return [];
      const { forYou, maybe } = lanes;
      if (
        forYou.rated < ALERT_THRESHOLDS.metricsMinRated ||
        maybe.rated < ALERT_THRESHOLDS.metricsMinRated
      )
        return [];
      if (!(forYouMinusMaybeUpper(forYou, maybe) < 0)) return [];
    }
    return [
      {
        key: 'metrics.lanes',
        title: 'For You is not beating Maybe',
        detail: `The For You like-rate was below Maybe's, with a 95 % interval excluding 0, on each of the last ${ALERT_THRESHOLDS.metricsDays} days (${snapshots.map(([day]) => day).join(', ')}).`,
      },
    ];
  },
};

/** Terminal pg-boss failures in the last hour clearly above the trailing 24 h mean (spec 11 §6.1). */
const failuresRule: AlertRule = {
  id: 'failures',
  async evaluate({ deps, now }) {
    const { lastHour, previous24h } = await terminalFailureCounts(deps.db, now);
    // lastHour >= factor * (previous24h / 24), in integers.
    if (
      lastHour < ALERT_THRESHOLDS.failuresMin ||
      lastHour * 24 < ALERT_THRESHOLDS.failuresFactor * previous24h
    )
      return [];
    return [
      {
        key: 'failures.rising',
        title: 'Rising terminal job failures',
        detail: `${lastHour} jobs failed for good in the last hour; the previous 24 hours averaged ${(previous24h / 24).toFixed(1)} per hour.`,
      },
    ];
  },
};

/**
 * Clients waiting for a worker database connection on 3 consecutive runs (spec 11 §6.1 "exhausted
 * DB pool"). The streak lives in the `alerts.state` memo; a run at the same time counts once and a
 * run without waiting clients resets it. Without any fresh pool statistics nothing changes.
 */
const poolRule: AlertRule = {
  id: 'pool',
  async evaluate(context) {
    const { now, memo } = context;
    const heartbeats = (await read(context, 'worker.heartbeat')) ?? {};
    const stats = Object.values(heartbeats).filter(
      (entry) =>
        entry.pool !== undefined &&
        now.getTime() - Date.parse(entry.at) < ALERT_THRESHOLDS.heartbeatStaleMs,
    );
    if (stats.length === 0) return [];
    const waiting = stats.some((entry) => (entry.pool?.waiting ?? 0) > 0);
    const previous = memo.poolStreak;
    if (previous === undefined || previous.at.getTime() !== now.getTime()) {
      memo.poolStreak = { at: now, count: waiting ? (previous?.count ?? 0) + 1 : 0 };
    }
    const count = memo.poolStreak?.count ?? 0;
    if (count < ALERT_THRESHOLDS.poolStreak) return [];
    const waitingNow = Math.max(0, ...stats.map((entry) => entry.pool?.waiting ?? 0));
    return [
      {
        key: 'pool.waiting',
        title: 'Database pool exhausted',
        detail: `Clients have waited for a worker database connection on ${count} consecutive checks (${waitingNow} waiting now).`,
      },
    ];
  },
};

/** Repeated restarts or an OOM kill of a compose container, from the `host_health` reports (spec 11 §6.1). */
const containersRule: AlertRule = {
  id: 'containers',
  async evaluate(context) {
    const { now } = context;
    type Containers = NonNullable<ReturnType<typeof HostHealthDetailSchema.parse>['containers']>;
    const reports: Array<{ at: number; containers: Containers }> = [];
    for (const event of await readOpsEvents(context)) {
      if (event.kind !== 'host_health') continue;
      const at = Date.parse(event.at);
      try {
        const detail = HostHealthDetailSchema.parse(JSON.parse(event.detail));
        if (detail.containers !== undefined) reports.push({ at, containers: detail.containers });
      } catch {
        // A malformed report is the disk rule's concern.
      }
    }
    const newest = reports.reduce<(typeof reports)[number] | undefined>(
      (best, report) => (best === undefined || report.at > best.at ? report : best),
      undefined,
    );
    if (newest === undefined || now.getTime() - newest.at > ALERT_THRESHOLDS.hostHealthStaleMs) {
      return [];
    }
    const recent = reports.filter(
      (report) =>
        report.at <= now.getTime() &&
        now.getTime() - report.at <= ALERT_THRESHOLDS.restartsWindowMs,
    );
    const out: Condition[] = [];
    for (const [service, state] of Object.entries(newest.containers)) {
      const name = safeText(service, 64);
      const earlier = Math.min(
        state.restarts,
        ...recent.flatMap((report) => {
          const entry = report.containers[service];
          return entry === undefined ? [] : [entry.restarts];
        }),
      );
      if (state.restarts - earlier >= ALERT_THRESHOLDS.restartsMin) {
        out.push({
          key: `containers.restarts:${name}`,
          title: `Container ${name} keeps restarting`,
          detail: `${name} restarted ${state.restarts - earlier} times within the last hour (${state.restarts} in total).`,
        });
      }
      if (state.oomKilled) {
        out.push({
          key: `containers.oom:${name}`,
          title: `Container ${name} was OOM-killed`,
          detail: `The last host report shows ${name} killed for running out of memory.`,
        });
      }
    }
    return out;
  },
};

/** Every rule of `house.alerts` in evaluation order (spec 11 §6.1). */
export const ALERT_RULES: readonly AlertRule[] = [
  breakerRule,
  mismatchRule,
  budgetRule,
  backlogRule,
  serviceRule,
  erasureRule,
  degradedRule,
  feedsRule,
  diskRule,
  backupsRule,
  metricsRule,
  failuresRule,
  poolRule,
  containersRule,
];
