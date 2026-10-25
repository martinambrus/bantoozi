import { HostHealthDetailSchema } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHeartbeat, type HeartbeatOptions } from '../src/eval-mode.js';
import { ClassifyHarness } from './support/classify.js';
import {
  ADMIN,
  AlertsWorld,
  DAY,
  HEALTHY_FS,
  HOUR,
  MINUTE,
  RecordingMailer,
  hostHealth,
  iso,
  opsEvent,
  utcDay,
  type OpsEvent,
} from './support/alerts-world.js';

/**
 * S17 (spec 10 §7 "Alert on For You below Maybe only with ≥30 rated items in each lane and an
 * uncertainty-supported gap persisting for three daily runs"; spec 11 §6.1 "rising terminal
 * failures", "exhausted DB pool", "repeated OOM/restarts"). Same fake clock and fixtures as
 * `house-alerts.int.test.ts`; every source is written in plain SQL relative to `NOW`.
 *
 * Rules these tests fix (all listed in the S17 report for DECISIONS):
 *  - metrics: per daily snapshot the Newcombe-Wilson 95 % interval of (For You - Maybe) like-rate,
 *    from `likeRate` and `rated` of `lanes.for_you`/`lanes.maybe`, must lie entirely below 0.
 *  - failures: pg-boss jobs in state `failed` with `completed_on` in the last hour >= 20 and >= 3 times
 *    the hourly mean of the 24 hours before that hour (`at - 25 h` to `at - 1 h`).
 *  - pool: a fresh worker heartbeat entry `pool.waiting > 0` on 3 consecutive `house.alerts` runs
 *    (runs at the same `now` count once; a run without waiting clients resets the streak).
 *  - containers: the newest `host_health` event's `containers.<service>.{restarts, oomKilled}`; alert
 *    when one container's `restarts` in the newest report minus its smallest value among the reports
 *    of the last 60 minutes is >= 3, or when any container of the newest report has `oomKilled`.
 */

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 12));
const before = (ms: number, from: Date = NOW): Date => new Date(from.getTime() - ms);
const after = (ms: number, from: Date = NOW): Date => new Date(from.getTime() + ms);

let h: ClassifyHarness;
let w: AlertsWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new AlertsWorld(h);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

/** The quiet world; also forgets any `alerts.*` memory a streak based rule keeps besides `alerts.state`. */
async function fresh(at: Date = NOW): Promise<void> {
  await w.baseline(at);
  await w.owner.query("DELETE FROM settings WHERE key LIKE 'alerts.%'");
}

/** Reset to the quiet world, apply `mutate`, run once at NOW and count the emails to the admin. */
async function emails(mutate: (() => Promise<void>) | undefined): Promise<number> {
  await fresh();
  await mutate?.();
  const mailer = new RecordingMailer();
  await w.run(NOW, { mailer });
  return mailer.to(ADMIN).length;
}

// ── B: the For You versus Maybe metrics alert ─────────────────────────────────────────────────

describe('S17 B: For You below Maybe needs ≥30 per lane, a supported gap and 3 consecutive days', () => {
  type Day = [daysAgo: number, forYou: number, maybe: number, rated: number];
  const days = (rows: Day[]) => async () => {
    for (const [daysAgo, forYou, maybe, rated] of rows) {
      await w.snapshot(
        utcDay(before(daysAgo * DAY)),
        { likeRate: forYou, rated },
        { likeRate: maybe, rated },
      );
    }
  };

  it('fires on a 0.40 versus 0.60 gap with 200 rated per lane and not on the same gap with 30 per lane (interval crosses 0)', async () => {
    expect(
      await emails(
        days([
          [0, 0.4, 0.6, 200],
          [1, 0.4, 0.6, 200],
          [2, 0.4, 0.6, 200],
        ]),
      ),
      'three supported days, n = 200',
    ).toBe(1);
    expect(
      await emails(
        days([
          [0, 0.4, 0.6, 30],
          [1, 0.4, 0.6, 30],
          [2, 0.4, 0.6, 30],
        ]),
      ),
      'three days, n = 30: the 95 % interval of the difference contains 0',
    ).toBe(0);
  });

  it('does not fire on two supported days, nor when the third day is unsupported', async () => {
    expect(
      await emails(
        days([
          [0, 0.4, 0.6, 200],
          [1, 0.4, 0.6, 200],
        ]),
      ),
      'two days only',
    ).toBe(0);
    expect(
      await emails(
        days([
          [0, 0.4, 0.6, 200],
          [1, 0.4, 0.6, 200],
          [2, 0.4, 0.6, 30],
        ]),
      ),
      'two supported days and an older day with n = 30',
    ).toBe(0);
  });

  it('does not fire when one of three days has a point gap whose interval contains 0', async () => {
    expect(
      await emails(
        days([
          [0, 0.4, 0.6, 200],
          [1, 0.48, 0.5, 200],
          [2, 0.4, 0.6, 200],
        ]),
      ),
      'the middle day: 0.48 versus 0.50, n = 200',
    ).toBe(0);
    expect(
      await emails(
        days([
          [0, 0.4, 0.6, 200],
          [1, 0.4, 0.6, 200],
          [2, 0.4, 0.6, 200],
        ]),
      ),
      'control: the same world with a supported middle day fires',
    ).toBe(1);
  });
});

// ── C: the original alert rows ────────────────────────────────────────────────────────────────

/** `count` failed pg-boss jobs spread evenly over (`from`, `to`]. */
async function failedJobs(count: number, from: Date, to: Date): Promise<void> {
  if (count === 0) return;
  await w.owner.query(
    `INSERT INTO pgboss.job (name, state, start_after, created_on, completed_on)
     SELECT 'article.extract', 'failed'::pgboss.job_state, $1::timestamptz, $1::timestamptz,
            $1::timestamptz + (($2::timestamptz - $1::timestamptz) * (g::float8 / $3::int))
       FROM generate_series(1, $3::int) g`,
    [from, to, count],
  );
}

/** `lastHour` terminal failures in the hour before `at`, `previous` in the 24 hours before that. */
async function failures(at: Date, lastHour: number, previous: number): Promise<void> {
  await w.owner.query("DELETE FROM pgboss.job WHERE state = 'failed'");
  await failedJobs(lastHour, before(HOUR - MINUTE, at), at);
  await failedJobs(previous, before(25 * HOUR - MINUTE, at), before(HOUR + MINUTE, at));
}

describe('S17 C1: rising terminal failures (pg-boss failed jobs)', () => {
  it('fires at >= 20 failed in the last hour and >= 3 times the previous 24 hours hourly mean', async () => {
    const case_ = (lastHour: number, previous: number) => () => failures(NOW, lastHour, previous);
    expect(await emails(case_(20, 0)), '20 in the hour, none before').toBe(1);
    expect(await emails(case_(25, 24)), '25 against a mean of 1 per hour').toBe(1);
    expect(await emails(case_(30, 240)), '30 against a mean of 10: exactly 3 times').toBe(1);
  });

  it('does not fire on a steady low rate, a steady high rate or fewer than 20 failures', async () => {
    const case_ = (lastHour: number, previous: number) => () => failures(NOW, lastHour, previous);
    expect(await emails(case_(25, 24)), 'control: 25 against a mean of 1 fires').toBe(1);
    expect(await emails(case_(19, 0)), '19 in the hour, none before').toBe(0);
    expect(await emails(case_(2, 48)), 'steady 2 per hour').toBe(0);
    expect(await emails(case_(30, 720)), 'steady 30 per hour').toBe(0);
    expect(await emails(case_(29, 240)), '29 against a mean of 10: below 3 times').toBe(0);
    expect(
      await emails(async () => {
        await failures(NOW, 19, 0);
        await failedJobs(500, before(31 * HOUR), before(29 * HOUR));
      }),
      'a burst more than a day old counts in neither window',
    ).toBe(0);
  });
});

/** The worker heartbeat of the quiet world, with the pool statistics of `S17`. */
async function poolHeartbeat(at: Date, waiting: number): Promise<void> {
  await w.setting('worker.heartbeat', {
    'worker-1': {
      at: iso(before(10_000, at)),
      queues: ['house.alerts'],
      evalIngestOnly: false,
      envCredentials: [],
      pool: { total: 10, idle: waiting > 0 ? 0 : 6, waiting },
    },
  });
}

/** Run `house.alerts` at `at` in the quiet world of `at` plus the pool statistics. */
async function poolRun(at: Date, waiting: number, mailer: RecordingMailer): Promise<void> {
  await w.liveness(at);
  await w.events([opsEvent('backup_ok', before(HOUR, at)), hostHealth(before(MINUTE, at))]);
  await poolHeartbeat(at, waiting);
  await w.run(at, { mailer });
}

describe('S17 C2: exhausted DB pool (worker heartbeat pool.waiting)', () => {
  it('fires on the third consecutive run that reports waiting clients, not before', async () => {
    const mailer = new RecordingMailer();
    await fresh();
    await poolRun(NOW, 2, mailer);
    expect(mailer.to(ADMIN), 'first sample').toHaveLength(0);
    await poolRun(after(5 * MINUTE), 2, mailer);
    expect(mailer.to(ADMIN), 'second sample').toHaveLength(0);
    await poolRun(after(10 * MINUTE), 2, mailer);
    expect(mailer.to(ADMIN), 'third consecutive sample').toHaveLength(1);
  });

  it('resets the streak when a run reports no waiting clients, and counts runs at the same time once', async () => {
    const mailer = new RecordingMailer();
    await fresh();
    await poolRun(NOW, 1, mailer);
    await poolRun(after(5 * MINUTE), 1, mailer);
    await poolRun(after(10 * MINUTE), 0, mailer);
    await poolRun(after(15 * MINUTE), 1, mailer);
    await poolRun(after(20 * MINUTE), 1, mailer);
    expect(mailer.to(ADMIN), 'streak broken by a healthy run').toHaveLength(0);
    // Repeated runs at one instant are one sample (the job may be retried).
    await poolRun(after(20 * MINUTE), 1, mailer);
    await poolRun(after(20 * MINUTE), 1, mailer);
    expect(mailer.to(ADMIN), 'same now runs do not advance the streak').toHaveLength(0);
    await poolRun(after(25 * MINUTE), 1, mailer);
    expect(mailer.to(ADMIN), 'third consecutive sample after the reset').toHaveLength(1);
  });

  it('does not fire while no heartbeat reports pool statistics at all', async () => {
    const mailer = new RecordingMailer();
    await fresh();
    for (const minutes of [0, 5, 10, 15]) {
      await w.liveness(after(minutes * MINUTE));
      await w.events([
        opsEvent('backup_ok', before(HOUR, after(minutes * MINUTE))),
        hostHealth(before(MINUTE, after(minutes * MINUTE))),
      ]);
      await w.run(after(minutes * MINUTE), { mailer });
    }
    expect(mailer.to(ADMIN), 'no statistics, no alert').toHaveLength(0);
    for (const minutes of [20, 25, 30]) await poolRun(after(minutes * MINUTE), 3, mailer);
    expect(mailer.to(ADMIN), 'control: statistics with waiting clients fire').toHaveLength(1);
  });

  it('records the pool statistics in the worker heartbeat entry', async () => {
    const silent = { warn: () => undefined, error: () => undefined };
    const options: HeartbeatOptions & {
      poolStats: () => { total: number; idle: number; waiting: number };
    } = {
      db: h.deps.db,
      processId: 'pool-test:1',
      queues: ['house.alerts'],
      evalIngestOnly: false,
      envCredentials: [],
      logger: silent,
      onGoldenDatabase: () => undefined,
      intervalMs: 3_600_000,
      poolStats: () => ({ total: 10, idle: 0, waiting: 3 }),
    };
    const heartbeat = await startHeartbeat(options);
    try {
      const row = await w.owner.query<{ pool: unknown }>(
        "SELECT value->'pool-test:1'->'pool' AS pool FROM settings WHERE key = 'worker.heartbeat'",
      );
      expect(row.rows[0]?.pool).toEqual({ total: 10, idle: 0, waiting: 3 });
    } finally {
      await heartbeat.stop();
    }
  });
});

type Containers = Record<string, { restarts: number; oomKilled: boolean }>;
const container = (restarts: number, oomKilled = false) => ({ restarts, oomKilled });

/** A `host_health` event of `at` carrying the container states. */
const report = (at: Date, containers: Containers): OpsEvent =>
  opsEvent(
    'host_health',
    at,
    JSON.stringify({
      host: 'prod',
      checkedAt: iso(at),
      filesystems: [{ ...HEALTHY_FS, future: true }],
      containers: Object.fromEntries(
        Object.entries(containers).map(([name, value]) => [name, { ...value, future: true }]),
      ),
      future: true,
    }),
  );

/** Reports `minutesAgo` before `at`, oldest first, with the same container each time. */
const reports = (at: Date, rows: Array<[minutesAgo: number, containers: Containers]>): OpsEvent[] =>
  rows.map(([minutes, containers]) => report(before(minutes * MINUTE, at), containers));

describe('S17 C3: repeated OOM or restarts (host_health containers)', () => {
  const emailsFor = (rows: Array<[number, Containers]>) =>
    emails(() => w.events([opsEvent('backup_ok', before(HOUR)), ...reports(NOW, rows)]));
  const api = (n: number, oom = false): Containers => ({
    api: container(n, oom),
    worker: container(0),
  });

  it('accepts the containers field in a host_health detail', () => {
    const detail = {
      host: 'prod',
      checkedAt: iso(NOW),
      filesystems: [HEALTHY_FS],
      containers: { api: { restarts: 2, oomKilled: false } },
    };
    expect(HostHealthDetailSchema.safeParse(detail).success).toBe(true);
  });

  it('fires when one container restarted three or more times within the hour', async () => {
    expect(
      await emailsFor([
        [55, api(1)],
        [40, api(2)],
        [25, api(3)],
        [10, api(4)],
      ]),
      'api 1 -> 4 within 45 minutes',
    ).toBe(1);
    expect(
      await emailsFor([
        [50, { api: container(0), worker: container(5) }],
        [10, { api: container(0), worker: container(8) }],
      ]),
      'worker 5 -> 8',
    ).toBe(1);
  });

  it('does not fire on two restarts, a steady high count, a slow climb or restarts split over containers', async () => {
    expect(
      await emailsFor([
        [55, api(1)],
        [40, api(2)],
        [25, api(3)],
        [10, api(4)],
      ]),
      'control: three restarts fire',
    ).toBe(1);
    expect(
      await emailsFor([
        [55, api(1)],
        [40, api(1)],
        [25, api(2)],
        [10, api(3)],
      ]),
      'two restarts',
    ).toBe(0);
    expect(
      await emailsFor([
        [55, api(9)],
        [40, api(9)],
        [25, api(9)],
        [10, api(9)],
      ]),
      'steady at 9',
    ).toBe(0);
    expect(
      await emailsFor([
        [170, api(1)],
        [110, api(2)],
        [55, api(3)],
        [10, api(4)],
      ]),
      'three restarts over three hours',
    ).toBe(0);
    expect(
      await emailsFor([
        [50, { api: container(1), worker: container(1) }],
        [10, { api: container(3), worker: container(3) }],
      ]),
      'two and two on different containers',
    ).toBe(0);
  });

  it('fires on any OOM kill in the newest report and not when only an older report shows one', async () => {
    expect(
      await emailsFor([
        [40, api(0)],
        [10, api(0, true)],
      ]),
      'oomKilled now',
    ).toBe(1);
    expect(
      await emailsFor([
        [40, api(0, true)],
        [10, api(0, false)],
      ]),
      'oomKilled only earlier',
    ).toBe(0);
    expect(await emailsFor([[10, api(0, false)]]), 'no OOM').toBe(0);
  });
});

// ── De-duplication, recovery and re-arming for the three new alerts ───────────────────────────

interface Source {
  /** Write the world in which the alert condition holds at `at` (after the quiet prelude). */
  firing(at: Date): Promise<void>;
  /** Write the world in which it no longer holds at `at`. */
  resolved(at: Date): Promise<void>;
  /** Consecutive runs the condition needs before the first email. */
  runsToFire: number;
}

const quiet = async (at: Date): Promise<void> => {
  await w.liveness(at);
  await w.events([opsEvent('backup_ok', before(HOUR, at)), hostHealth(before(MINUTE, at))]);
};

const SOURCES: Record<string, Source> = {
  'rising terminal failures': {
    runsToFire: 1,
    firing: (at) => failures(at, 40, 24),
    resolved: (at) => failures(at, 1, 24),
  },
  'exhausted DB pool': {
    runsToFire: 3,
    firing: (at) => poolHeartbeat(at, 4),
    resolved: (at) => poolHeartbeat(at, 0),
  },
  'repeated restarts': {
    runsToFire: 1,
    firing: (at) =>
      w.events([
        opsEvent('backup_ok', before(HOUR, at)),
        ...reports(at, [
          [55, { api: container(1) }],
          [40, { api: container(2) }],
          [25, { api: container(3) }],
          [10, { api: container(4) }],
        ]),
      ]),
    resolved: (at) =>
      w.events([
        opsEvent('backup_ok', before(HOUR, at)),
        ...reports(at, [
          [55, { api: container(4) }],
          [40, { api: container(4) }],
          [10, { api: container(4) }],
        ]),
      ]),
  },
  'OOM kill': {
    runsToFire: 1,
    firing: (at) =>
      w.events([
        opsEvent('backup_ok', before(HOUR, at)),
        report(before(MINUTE, at), { api: container(1, true) }),
      ]),
    resolved: (at) =>
      w.events([
        opsEvent('backup_ok', before(HOUR, at)),
        report(before(MINUTE, at), { api: container(1, false) }),
      ]),
  },
};

describe.each(Object.entries(SOURCES))('S17 de-duplication and re-arming: %s', (_name, source) => {
  async function tick(
    at: Date,
    mode: 'firing' | 'resolved',
    mailer: RecordingMailer,
  ): Promise<void> {
    await quiet(at);
    await source[mode](at);
    await w.run(at, { mailer });
  }

  it('sends once, repeats only after 6 hours, sends one recovery and sends again when it returns', async () => {
    const mailer = new RecordingMailer();
    await fresh();
    const minutes = (m: number): Date => after(m * MINUTE);
    // Warm-up runs of streak based conditions, then the first email.
    const first = (source.runsToFire - 1) * 5;
    for (let run = 0; run < source.runsToFire; run += 1) {
      expect(mailer.to(ADMIN), `before the run at +${run * 5} min`).toHaveLength(0);
      await tick(minutes(run * 5), 'firing', mailer);
    }
    expect(mailer.to(ADMIN), 'first email').toHaveLength(1);
    expect((await w.activeEntries()).length, 'one open incident').toBeGreaterThan(0);

    for (const m of [first + 5, first + 60, first + 180, first + 359]) {
      await tick(minutes(m), 'firing', mailer);
      expect(mailer.to(ADMIN), `still firing at +${m} min`).toHaveLength(1);
    }
    await tick(minutes(first + 6 * 60 + 1), 'firing', mailer);
    expect(mailer.to(ADMIN), '6 h 1 min after the first email').toHaveLength(2);

    const healed = first + 6 * 60 + 10;
    await tick(minutes(healed), 'resolved', mailer);
    expect(mailer.to(ADMIN), 'one recovery email').toHaveLength(3);
    expect(await w.activeEntries(), 'incident closed').toHaveLength(0);
    await tick(minutes(healed + 5), 'resolved', mailer);
    await tick(minutes(healed + 60), 'resolved', mailer);
    expect(mailer.to(ADMIN), 'nothing while healthy').toHaveLength(3);

    // It returns inside the old 6 h window: a new incident, a new email.
    for (let run = 0; run < source.runsToFire; run += 1) {
      await tick(minutes(healed + 65 + run * 5), 'firing', mailer);
    }
    expect(mailer.to(ADMIN), 're-armed: the returning condition sends again').toHaveLength(4);
  });
});
