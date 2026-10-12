import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  ADMIN,
  AlertsWorld,
  DAY,
  HOUR,
  MINUTE,
  RecordingMailer,
  hostHealth,
  iso,
  opsEvent,
  utcDay,
  type Filesystem,
  type OpsEvent,
  type RunOptions,
} from './support/alerts-world.js';

/**
 * M8-T3 (PLAN §14, spec 11 §6, §6.1): `house.alerts` through the registered handler against a
 * migrated database. The clock is a fake `NOW` (noon UTC, 100 days after the real date), every
 * source is placed relative to it, so a handler that reads the database clock sees a different
 * world. `baseline()` writes a world in which no rule fires; each rule test changes one source and
 * counts the emails the recording mailer accepted. Subjects and texts are not asserted (the spec
 * fixes none); recipients, counts and the `alerts.state` fields `firstAt`, `lastSentAt`, `active`
 * are. The state key names are the handler's own, so tests look at entries, never at keys.
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

/** Reset to the quiet world, apply `mutate`, run once at NOW and return the mailer. */
async function scenario(
  mutate: (() => Promise<void>) | undefined,
  options: Partial<RunOptions> = {},
): Promise<RecordingMailer> {
  await w.baseline(NOW);
  await mutate?.();
  const mailer = new RecordingMailer();
  await w.run(NOW, { mailer, ...options });
  return mailer;
}

/** The number of emails to the admin, for a labelled case. */
async function emails(
  mutate: (() => Promise<void>) | undefined,
  options: Partial<RunOptions> = {},
): Promise<number> {
  return (await scenario(mutate, options)).to(ADMIN).length;
}

const fs = (overrides: Partial<Filesystem>): Filesystem => ({
  mount: '/var/lib/postgresql',
  usedPct: 50,
  freeBytes: 200e9,
  inodesUsedPct: 10,
  ...overrides,
});

describe('house.alerts rules (spec 11 §6.1)', () => {
  it('sends nothing in a healthy world', async () => {
    const mailer = await scenario(undefined);
    expect(mailer.sent).toHaveLength(0);
    expect(await w.activeEntries()).toHaveLength(0);
  });

  it('sends one email to every ADMIN_EMAILS address when a rule fires', async () => {
    const mailer = await scenario(() => w.breaker('auth'), {
      adminEmails: ['first-admin@example.test', 'second-admin@example.test'],
    });
    expect(mailer.to('first-admin@example.test')).toHaveLength(1);
    expect(mailer.to('second-admin@example.test')).toHaveLength(1);
    expect(mailer.to(ADMIN)).toHaveLength(0);
  });

  it('engine breaker: open for more than 30 minutes fires, 29 minutes does not', async () => {
    const open = (ageMs: number) => () => w.breaker('open', before(ageMs), NOW);
    expect(await emails(open(31 * MINUTE)), 'open 31 min').toBe(1);
    expect(await emails(open(29 * MINUTE)), 'open 29 min').toBe(0);
    expect(await emails(() => w.breaker('closed')), 'closed').toBe(0);
  });

  it('engine breaker: auth fires immediately', async () => {
    expect(await emails(() => w.breaker('auth', before(MINUTE), NOW)), 'auth 1 min').toBe(1);
    expect(await emails(() => w.breaker('auth')), 'auth without openedAt').toBe(1);
  });

  it("budget: today's p80 or p100 fires, yesterday's does not", async () => {
    const today = utcDay(NOW);
    const yesterday = utcDay(before(DAY));
    const alerts = (value: unknown) => () => w.setting('engine.budget_alerts', value);
    expect(await emails(alerts({ day: today, p80At: iso(before(HOUR)) })), 'p80 today').toBe(1);
    expect(await emails(alerts({ day: today, p100At: iso(before(HOUR)) })), 'p100 today').toBe(1);
    expect(
      await emails(alerts({ day: yesterday, p80At: iso(before(20 * HOUR)) })),
      'p80 yesterday',
    ).toBe(0);
    expect(
      await emails(alerts({ day: yesterday, p100At: iso(before(20 * HOUR)) })),
      'p100 yesterday',
    ).toBe(0);
    expect(await emails(alerts({ day: today })), 'today without a threshold').toBe(0);
  });

  it('backlog: more than 5,000 due jobs in one queue fires, 5,000 does not', async () => {
    const due = (count: number, queue = 'article.extract') =>
      w.jobs({ queue, count, startAfter: before(MINUTE) });
    expect(await emails(() => due(5_001)), '5,001 due').toBe(1);
    expect(await emails(() => due(5_000)), '5,000 due').toBe(0);
    // The limit is per queue: 3,000 in each of two queues is no backlog.
    expect(
      await emails(async () => {
        await due(3_000, 'article.extract');
        await due(3_000, 'article.translate');
      }),
      '3,000 + 3,000 in two queues',
    ).toBe(0);
    // Intentional future cooldown jobs are not due waiting jobs.
    expect(
      await emails(() =>
        w.jobs({ count: 5_001, startAfter: after(HOUR), createdOn: before(2 * HOUR) }),
      ),
      '5,001 scheduled for later',
    ).toBe(0);
  });

  it('backlog: the oldest due job older than 30 minutes fires, a younger one does not', async () => {
    const oldest = (ageMs: number, state: 'created' | 'retry' = 'created') =>
      w.jobs({ state, startAfter: before(ageMs) });
    expect(await emails(() => oldest(31 * MINUTE)), 'created 31 min').toBe(1);
    expect(await emails(() => oldest(31 * MINUTE, 'retry')), 'retry 31 min').toBe(1);
    expect(await emails(() => oldest(29 * MINUTE)), 'created 29 min').toBe(0);
    // A job created long ago but scheduled for the future is a cooldown, not a backlog.
    expect(
      await emails(() => w.jobs({ startAfter: after(HOUR), createdOn: before(3 * HOUR) })),
      'scheduled for later',
    ).toBe(0);
    // Jobs that are running or finished are not waiting.
    expect(
      await emails(() => w.jobs({ state: 'active', startAfter: before(2 * HOUR) })),
      'active for 2 h',
    ).toBe(0);
    expect(
      await emails(() => w.jobs({ state: 'completed', startAfter: before(2 * HOUR) })),
      'completed',
    ).toBe(0);
  });

  it('backlog: a pending outbox intent older than 5 minutes fires, a younger or future one does not', async () => {
    expect(await emails(() => w.outbox({ createdAt: before(6 * MINUTE) })), 'due 6 min').toBe(1);
    expect(await emails(() => w.outbox({ createdAt: before(4 * MINUTE) })), 'due 4 min').toBe(0);
    expect(
      await emails(() => w.outbox({ createdAt: before(HOUR), availableAt: after(30 * MINUTE) })),
      'cooldown intent available later',
    ).toBe(0);
    expect(
      await emails(async () => {
        await w.outbox({ createdAt: before(HOUR) });
        await h.owner.query('UPDATE job_outbox SET delivered_at = $1', [before(50 * MINUTE)]);
      }),
      'delivered intent',
    ).toBe(0);
  });

  it('service health: a stale or missing worker heartbeat fires, a fresh one does not', async () => {
    const heartbeat = (at: Date | undefined) => () =>
      w.setting(
        'worker.heartbeat',
        at === undefined
          ? {}
          : {
              'worker-1': {
                at: iso(at),
                queues: ['house.alerts'],
                evalIngestOnly: false,
                envCredentials: [],
              },
            },
      );
    expect(await emails(heartbeat(before(30 * MINUTE))), 'heartbeat 30 min old').toBe(1);
    expect(await emails(heartbeat(undefined)), 'no heartbeat').toBe(1);
    expect(await emails(heartbeat(before(10_000))), 'heartbeat 10 s old').toBe(0);
  });

  it('service health: a housekeeping job overdue by house.progress fires, a recent one does not', async () => {
    const progress = (job: string, at: Date) => async () => {
      const current = (
        await h.owner.query<{ value: Record<string, unknown> }>(
          "SELECT value FROM settings WHERE key = 'house.progress'",
        )
      ).rows[0]!.value;
      await w.setting('house.progress', {
        ...current,
        [job]: { updatedAt: iso(at), completedAt: iso(at), version: 1 },
      });
    };
    // house.reconcile runs every 10 minutes, house.expire-rules every hour.
    expect(await emails(progress('house.reconcile', before(3 * HOUR))), 'reconcile 3 h').toBe(1);
    expect(await emails(progress('house.expire-rules', before(10 * HOUR))), 'expire 10 h').toBe(1);
    expect(await emails(progress('house.reconcile', before(5 * MINUTE))), 'reconcile 5 min').toBe(
      0,
    );
    expect(await emails(progress('house.expire-rules', before(30 * MINUTE))), 'expire 30 min').toBe(
      0,
    );
  });

  it('erasure disabled: a purge-users run that found due users and no ledger fires, a clean one does not (R2)', async () => {
    const purgeUsers = (cursor: unknown) => async () => {
      const current = (
        await h.owner.query<{ value: Record<string, unknown> }>(
          "SELECT value FROM settings WHERE key = 'house.progress'",
        )
      ).rows[0]!.value;
      const at = iso(before(MINUTE));
      await w.setting('house.progress', {
        ...current,
        'house.purge-users': {
          updatedAt: at,
          version: 1,
          ...(cursor === undefined ? { completedAt: at } : { cursor }),
        },
      });
    };
    expect(await emails(purgeUsers({ disabled: 'ledger_unconfigured' })), 'disabled').toBe(1);
    expect(await emails(purgeUsers(undefined)), 'completed').toBe(0);
  });

  it('service health: LibreTranslate unreachable fires only while a language is translated or card text is english', async () => {
    const down = (): Promise<boolean> => Promise.resolve(false);
    const up = (): Promise<boolean> => Promise.resolve(true);
    const translateSk = () =>
      w.setting('language_modes', { en: 'native', sk: 'translate', cs: 'native' });
    const english = () => w.setting('card_text_mode', 'english');

    expect(await emails(translateSk, { probe: down }), 'sk translate, probe down').toBe(1);
    expect(await emails(english, { probe: down }), 'cards english, probe down').toBe(1);
    expect(await emails(translateSk, { probe: up }), 'sk translate, probe up').toBe(0);
    expect(await emails(english, { probe: up }), 'cards english, probe up').toBe(0);
    expect(await emails(undefined, { probe: down }), 'all native, as_written, probe down').toBe(0);
  });

  it("degraded share: more than 20 % of the last hour's new articles fires", async () => {
    const articles = (total: number, degraded: number) => () =>
      w.articles(total, degraded, before(30 * MINUTE));
    expect(await emails(articles(50, 11)), '22 %').toBe(1);
    expect(await emails(articles(50, 10)), 'exactly 20 %').toBe(0);
    expect(await emails(articles(50, 0)), '0 %').toBe(0);
    // Articles older than an hour do not count, however degraded.
    expect(
      await emails(async () => {
        await w.articles(50, 5, before(30 * MINUTE));
        await w.articles(200, 200, before(3 * HOUR));
      }),
      'old degraded articles',
    ).toBe(0);
  });

  it('feed failures: more than 10 % of active subscribed feeds errored in 24 h fires', async () => {
    expect(await emails(() => w.feeds(20, 3, before(2 * HOUR))), '3 of 20 (15 %)').toBe(1);
    expect(await emails(() => w.feeds(20, 2, before(2 * HOUR))), '2 of 20 (10 %)').toBe(0);
    expect(await emails(() => w.feeds(20, 0, before(2 * HOUR))), 'none errored').toBe(0);
    expect(await emails(() => w.feeds(20, 10, before(25 * HOUR))), '10 errored 25 h ago').toBe(0);
  });

  it('disk: usage above 80 %, under 10 GB free or exhausted inodes fires on the latest host_health', async () => {
    const health = (fsEntry: Filesystem) => () =>
      w.events([opsEvent('backup_ok', before(HOUR)), hostHealth(before(MINUTE), [fsEntry])]);
    expect(await emails(health(fs({ usedPct: 81 }))), '81 % used').toBe(1);
    expect(await emails(health(fs({ usedPct: 80 }))), '80 % used').toBe(0);
    expect(await emails(health(fs({ freeBytes: 5e9 }))), '5 GB free').toBe(1);
    expect(await emails(health(fs({ freeBytes: 50e9 }))), '50 GB free').toBe(0);
    expect(await emails(health(fs({ inodesUsedPct: 100 }))), 'inodes exhausted').toBe(1);
    expect(await emails(health(fs({ inodesUsedPct: 50 }))), 'inodes 50 %').toBe(0);
    // A second filesystem counts too.
    expect(
      await emails(() =>
        w.events([
          opsEvent('backup_ok', before(HOUR)),
          hostHealth(before(MINUTE), [fs({}), fs({ mount: '/backup', usedPct: 95 })]),
        ]),
      ),
      'backup staging 95 %',
    ).toBe(1);
    // Only the latest report counts: an old bad one that was followed by a good one is resolved.
    expect(
      await emails(() =>
        w.events([
          opsEvent('backup_ok', before(HOUR)),
          hostHealth(before(30 * MINUTE), [fs({ usedPct: 95 })]),
          hostHealth(before(MINUTE), [fs({})]),
        ]),
      ),
      'old bad report, latest good',
    ).toBe(0);
  });

  it('backups: a failure newer than the matching ok fires, an older one does not', async () => {
    const events = (list: OpsEvent[]) => () =>
      w.events([...list, hostHealth(before(MINUTE))].sort((a, b) => a.at.localeCompare(b.at)));
    expect(
      await emails(
        events([opsEvent('backup_ok', before(5 * HOUR)), opsEvent('backup_failed', before(HOUR))]),
      ),
      'backup_failed after backup_ok',
    ).toBe(1);
    expect(
      await emails(
        events([opsEvent('backup_failed', before(5 * HOUR)), opsEvent('backup_ok', before(HOUR))]),
      ),
      'backup_ok after backup_failed',
    ).toBe(0);
    const backup = opsEvent('backup_ok', before(HOUR));
    expect(
      await emails(
        events([
          backup,
          opsEvent('restore_ok', before(5 * HOUR)),
          opsEvent('restore_failed', before(2 * HOUR)),
        ]),
      ),
      'restore_failed after restore_ok',
    ).toBe(1);
    expect(
      await emails(
        events([
          backup,
          opsEvent('restore_failed', before(5 * HOUR)),
          opsEvent('restore_ok', before(2 * HOUR)),
        ]),
      ),
      'restore_ok after restore_failed',
    ).toBe(0);
    expect(
      await emails(events([backup, opsEvent('restore_failed', before(2 * HOUR))])),
      'restore_failed with no restore_ok',
    ).toBe(1);
  });

  it('backups: no backup_ok in 26 hours fires, one 25 hours ago does not', async () => {
    const only = (age: number) => () =>
      w.events([opsEvent('backup_ok', before(age)), hostHealth(before(MINUTE))]);
    expect(await emails(only(27 * HOUR)), 'backup_ok 27 h ago').toBe(1);
    expect(await emails(only(25 * HOUR)), 'backup_ok 25 h ago').toBe(0);
    expect(await emails(only(2 * HOUR)), 'backup_ok 2 h ago').toBe(0);
  });

  it('backups: remembers a backup_ok that 50 newer host_health events pushed out of ops.events', async () => {
    // Run 1 sees the backup_ok.
    const mailer = new RecordingMailer();
    await w.baseline(NOW);
    await w.run(NOW, { mailer });
    expect(mailer.sent).toHaveLength(0);

    // 24 h later the 50 retained events are all host_health: the backup_ok (25 h old) is gone from
    // ops.events but not from the job's memory, so it is still within 26 h.
    const later = after(24 * HOUR);
    const flood = (end: Date): OpsEvent[] =>
      Array.from({ length: 50 }, (_, i) => hostHealth(before(((50 - i) * MINUTE) / 2, end)));
    await w.liveness(later);
    await w.events(flood(later));
    await w.run(later, { mailer });
    expect(mailer.sent, 'backup_ok remembered at +24 h').toHaveLength(0);

    // 28 h after run 1 the remembered backup_ok is 29 h old: the alert fires.
    const muchLater = after(28 * HOUR);
    await w.liveness(muchLater);
    await w.events(flood(muchLater));
    await w.run(muchLater, { mailer });
    expect(mailer.to(ADMIN), 'no backup_ok for 29 h').toHaveLength(1);
  });

  it('metrics: For You like-rate below Maybe for 3 consecutive daily snapshots fires', async () => {
    const lanes = (days: Array<[number, number, number]>) => async () => {
      for (const [daysAgo, forYou, rated] of days) {
        await w.snapshot(
          utcDay(before(daysAgo * DAY)),
          { likeRate: forYou, rated },
          { likeRate: 0.6, rated },
        );
      }
    };
    // Four snapshots (today and the three days before), whichever three the job takes as latest.
    expect(
      await emails(
        lanes([
          [0, 0.3, 100],
          [1, 0.3, 100],
          [2, 0.3, 100],
          [3, 0.3, 100],
        ]),
      ),
      'four bad days',
    ).toBe(1);
    expect(
      await emails(
        lanes([
          [0, 0.3, 100],
          [1, 0.3, 100],
          [2, 0.7, 100],
          [3, 0.3, 100],
        ]),
      ),
      'bad, bad, good, bad',
    ).toBe(0);
    expect(
      await emails(
        lanes([
          [0, 0.7, 100],
          [1, 0.7, 100],
          [2, 0.7, 100],
          [3, 0.7, 100],
        ]),
      ),
      'For You above Maybe',
    ).toBe(0);
    // Spec 10 §7: only with at least 30 rated items in each lane.
    expect(
      await emails(
        lanes([
          [0, 0.3, 10],
          [1, 0.3, 10],
          [2, 0.3, 10],
          [3, 0.3, 10],
        ]),
      ),
      '10 rated items per lane',
    ).toBe(0);
    expect(
      await emails(
        lanes([
          [0, 0.3, 100],
          [1, 0.3, 100],
        ]),
      ),
      'only two snapshots',
    ).toBe(0);
  });
});

describe('house.alerts de-duplication, recovery and delivery (spec 11 §6.1)', () => {
  const T0 = NOW;

  /** Keep the sources of the quiet world fresh at `at` (the breaker is the incident under test). */
  async function tick(at: Date, mailer: RecordingMailer): Promise<void> {
    await w.liveness(at);
    await w.events([opsEvent('backup_ok', before(HOUR, at)), hostHealth(before(MINUTE, at))]);
    await w.run(at, { mailer });
  }

  it('sends the same condition at most once per 6 hours, then again after 6 hours', async () => {
    const mailer = new RecordingMailer();
    await w.baseline(T0);
    await w.breaker('auth');
    await tick(T0, mailer);
    expect(mailer.to(ADMIN)).toHaveLength(1);
    const entry = (await w.activeEntries())[0]!;
    expect(entry.active).toBe(true);
    expect(Date.parse(entry.firstAt)).toBe(T0.getTime());
    expect(Date.parse(entry.lastSentAt ?? '')).toBe(T0.getTime());

    for (const minutes of [5, 60, 180, 359]) {
      await tick(after(minutes * MINUTE, T0), mailer);
      expect(mailer.to(ADMIN), `still ${minutes} min after the first email`).toHaveLength(1);
    }

    const resend = after(6 * HOUR + MINUTE, T0);
    await tick(resend, mailer);
    expect(mailer.to(ADMIN), '6 h 1 min after the first email').toHaveLength(2);
    const again = (await w.activeEntries())[0]!;
    expect(again.active).toBe(true);
    expect(Date.parse(again.firstAt), 'firstAt stays the incident start').toBe(T0.getTime());
    expect(Date.parse(again.lastSentAt ?? '')).toBe(resend.getTime());

    await tick(after(6 * HOUR + 10 * MINUTE, T0), mailer);
    expect(mailer.to(ADMIN), 'the 6 h window restarts at the second email').toHaveLength(2);
  });

  it('sends one recovery email when the condition resolves and re-arms the alert', async () => {
    const mailer = new RecordingMailer();
    await w.baseline(T0);
    await w.breaker('auth');
    await tick(T0, mailer);
    expect(mailer.to(ADMIN)).toHaveLength(1);

    await w.breaker('closed');
    const healed = after(10 * MINUTE, T0);
    await tick(healed, mailer);
    expect(mailer.to(ADMIN), 'one recovery email').toHaveLength(2);
    expect(await w.activeEntries(), 'incident closed').toHaveLength(0);
    const [alertMail, recoveryMail] = mailer.sent;
    expect(
      `${recoveryMail?.subject}\n${recoveryMail?.text}`,
      'the recovery email is not the alert email again',
    ).not.toBe(`${alertMail?.subject}\n${alertMail?.text}`);

    await tick(after(20 * MINUTE, T0), mailer);
    await tick(after(8 * HOUR, T0), mailer);
    expect(mailer.to(ADMIN), 'no further mail while healthy').toHaveLength(2);

    // Re-triggered inside the old 6 h window: a new incident, a new email.
    await w.breaker('auth');
    const retrigger = after(30 * MINUTE, T0);
    await tick(retrigger, mailer);
    expect(mailer.to(ADMIN), 'the re-triggered alert sends again').toHaveLength(3);
    const entry = (await w.activeEntries())[0]!;
    expect(entry.active).toBe(true);
    expect(Date.parse(entry.firstAt), 'a new incident starts a new firstAt').toBe(
      retrigger.getTime(),
    );
    expect(Date.parse(entry.lastSentAt ?? '')).toBe(retrigger.getTime());
  });

  it('does not set lastSentAt when the mailer throws, and sends on the next run', async () => {
    const mailer = new RecordingMailer();
    mailer.failing = true;
    await w.baseline(T0);
    await w.breaker('auth');
    // A transport failure may be absorbed or surface as a job error (queue retry); both are fine.
    await tick(T0, mailer).catch(() => undefined);
    expect(mailer.attempts, 'a send was attempted').toBeGreaterThan(0);
    expect(mailer.sent).toHaveLength(0);
    const pending = Object.values(await w.state());
    expect(
      pending.every((entry) => entry.lastSentAt === null),
      'lastSentAt stays null after a failed send',
    ).toBe(true);

    mailer.failing = false;
    const next = after(5 * MINUTE, T0);
    await tick(next, mailer);
    expect(mailer.to(ADMIN), 'next run sends').toHaveLength(1);
    const entry = (await w.activeEntries())[0]!;
    expect(Date.parse(entry.lastSentAt ?? '')).toBe(next.getTime());
    await tick(after(10 * MINUTE, T0), mailer);
    expect(mailer.to(ADMIN), 'and then it is de-duplicated').toHaveLength(1);
  });

  it('keeps a recovery notification pending when the mailer throws and sends it once later', async () => {
    const mailer = new RecordingMailer();
    await w.baseline(T0);
    await w.breaker('auth');
    await tick(T0, mailer);
    expect(mailer.to(ADMIN)).toHaveLength(1);

    await w.breaker('closed');
    mailer.failing = true;
    await tick(after(10 * MINUTE, T0), mailer).catch(() => undefined);
    expect(mailer.sent, 'the failed recovery was not recorded as sent').toHaveLength(1);

    mailer.failing = false;
    await tick(after(15 * MINUTE, T0), mailer);
    expect(mailer.to(ADMIN), 'recovery delivered on the next run').toHaveLength(2);
    expect(await w.activeEntries()).toHaveLength(0);
    await tick(after(20 * MINUTE, T0), mailer);
    expect(mailer.to(ADMIN), 'recovery is sent once').toHaveLength(2);
  });

  it('is idempotent at the same now', async () => {
    const mailer = new RecordingMailer();
    await w.baseline(T0);
    await w.breaker('auth');
    await w.run(T0, { mailer });
    await w.run(T0, { mailer });
    await w.run(T0, { mailer });
    expect(mailer.to(ADMIN)).toHaveLength(1);
    expect(await w.activeEntries()).toHaveLength(1);

    await w.breaker('closed');
    const healed = after(10 * MINUTE, T0);
    await w.run(healed, { mailer });
    await w.run(healed, { mailer });
    expect(mailer.to(ADMIN), 'one recovery email for two runs at the same time').toHaveLength(2);
  });
});
