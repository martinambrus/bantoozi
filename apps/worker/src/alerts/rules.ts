import {
  degradedShareLastHour,
  dueJobBacklog,
  feedErrorShare24h,
  latestMetricsSnapshots,
  oldestPendingOutboxAgeSeconds,
  readStoredSetting,
} from '@bantoozi/db';
import {
  HOUSE_CRON_SCHEDULES,
  HostHealthDetailSchema,
  readSetting,
  utcDay,
  type SettingKey,
} from '@bantoozi/shared';
import { safeText, type AlertRule, type Condition, type RuleContext } from './types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Alert thresholds (spec 11 §6.1, spec 10 §7). */
export const ALERT_THRESHOLDS = {
  breakerOpenMs: 30 * MINUTE,
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
} as const;

const read = async <K extends SettingKey>(context: RuleContext, key: K) =>
  readSetting(key, await readStoredSetting(context.deps.db, key), context.deps.settingsEnv);

/** `engine.circuit.typesafe` open for more than 30 minutes, or `auth` (spec 11 §6.1 "Engine breaker open"). */
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
    if (breaker.state !== 'open' || breaker.openedAt === undefined) return [];
    const openedMs = context.now.getTime() - Date.parse(breaker.openedAt);
    if (openedMs <= ALERT_THRESHOLDS.breakerOpenMs) return [];
    return [
      {
        key: 'engine.breaker',
        title: 'Engine breaker open',
        detail: `The decision engine breaker has been open for ${Math.round(openedMs / MINUTE)} minutes (since ${safeText(breaker.openedAt)}).`,
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
      if (updatedAt === undefined) continue;
      const age = now.getTime() - Date.parse(updatedAt);
      if (age > ALERT_THRESHOLDS.houseOverduePeriods * schedule.everyMs) {
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
    const backupFailed = latest(events, 'backup_failed');
    if (backupFailed !== undefined && (lastOk === undefined || backupFailed > lastOk)) {
      out.push({
        key: 'backup.failed',
        title: 'Backup failed',
        detail: `The backup script reported a failure at ${new Date(backupFailed).toISOString()}.`,
      });
    }
    const restoreFailed = latest(events, 'restore_failed');
    const restoreOk = latest(events, 'restore_ok');
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

/** The `for_you` and `maybe` lanes of a daily snapshot, or `undefined` when the shape differs. */
function lanesOf(snapshot: unknown): { forYou: Lane; maybe: Lane } | undefined {
  const lanes = isRecord(snapshot) ? snapshot['lanes'] : undefined;
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

/** For You like-rate below Maybe for 3 consecutive daily snapshots, 30+ rated per lane (spec 10 §7). */
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
      if (!(forYou.likeRate < maybe.likeRate)) return [];
    }
    return [
      {
        key: 'metrics.lanes',
        title: 'For You is not beating Maybe',
        detail: `The For You like-rate was below Maybe's on each of the last ${ALERT_THRESHOLDS.metricsDays} days (${snapshots.map(([day]) => day).join(', ')}).`,
      },
    ];
  },
};

/** Every rule of `house.alerts` in evaluation order (spec 11 §6.1). */
export const ALERT_RULES: readonly AlertRule[] = [
  breakerRule,
  budgetRule,
  backlogRule,
  serviceRule,
  degradedRule,
  feedsRule,
  diskRule,
  backupsRule,
  metricsRule,
];
