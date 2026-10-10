import { randomUUID } from 'node:crypto';

import { HOUSE_CRON_SCHEDULES, parseJobPayload } from '@bantoozi/shared';
import type { EmailMessage, Mailer } from '@bantoozi/shared/server';
import { createFeed, createSubscription, createUser } from '@bantoozi/testing';
import type pg from 'pg';

import type { WorkerDeps } from '../../src/handlers/deps.js';
import { createHandlers, dispatch } from '../../src/handlers/index.js';
import { DAY, HOUR, MINUTE, type ClassifyHarness } from './classify.js';

export { DAY, HOUR, MINUTE };

export const ADMIN = 'ops-admin@example.test';

/** The recipient addresses of a recorded message (the `to` field may list several). */
export const recipients = (message: EmailMessage): string[] =>
  message.to
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter((address) => address !== '');

/** An in-memory {@link Mailer}: records accepted messages, and throws while `failing`. */
export class RecordingMailer implements Mailer {
  readonly transport = 'log' as const;
  /** Accepted (acknowledged) messages only. */
  readonly sent: EmailMessage[] = [];
  /** Every attempt, accepted or not. */
  attempts = 0;
  failing = false;

  send(message: EmailMessage): Promise<void> {
    this.attempts += 1;
    if (this.failing) return Promise.reject(new Error('smtp unavailable'));
    this.sent.push({ ...message });
    return Promise.resolve();
  }

  lastEmail(): EmailMessage | undefined {
    return this.sent.at(-1);
  }

  close(): void {
    return undefined;
  }

  /** Messages that reached `address`. */
  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => recipients(message).includes(address.toLowerCase()));
  }
}

/** The `WorkerDeps` additions of `house.alerts` (M8-T3). */
export interface AlertsDepsExtra {
  mailer: Mailer;
  adminEmails: string[];
  libreTranslateProbe?: () => Promise<boolean>;
}

export interface RunOptions {
  mailer: RecordingMailer;
  adminEmails?: string[];
  probe?: (() => Promise<boolean>) | undefined;
}

export interface AlertEntry {
  firstAt: string;
  lastSentAt: string | null;
  active: boolean;
}

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
export const iso = (at: Date): string => at.toISOString();

export interface OpsEvent {
  kind: string;
  detail: string;
  at: string;
}

export const opsEvent = (kind: string, at: Date, detail = ''): OpsEvent => ({
  kind,
  detail,
  at: iso(at),
});

export interface Filesystem {
  mount: string;
  usedPct: number;
  freeBytes: number;
  inodesUsedPct?: number;
}

export const HEALTHY_FS: Filesystem = {
  mount: '/var/lib/postgresql',
  usedPct: 50,
  freeBytes: 200e9,
  inodesUsedPct: 10,
};

export const hostHealth = (at: Date, filesystems: Filesystem[] = [HEALTHY_FS]): OpsEvent =>
  opsEvent('host_health', at, JSON.stringify({ host: 'prod', checkedAt: iso(at), filesystems }));

/**
 * Fixtures of the `house.alerts` tests (spec 11 §6.1): every source is written in plain SQL, the
 * handler runs through the registered map with a fake clock, mail goes to a recording mailer.
 * `baseline()` writes a world in which no rule fires, so each test changes exactly one source.
 */
export class AlertsWorld {
  private userId: string | undefined;

  constructor(readonly h: ClassifyHarness) {}

  get owner(): pg.Pool {
    return this.h.owner;
  }

  async run(now: Date, options: RunOptions): Promise<void> {
    const extra: AlertsDepsExtra = {
      mailer: options.mailer,
      adminEmails: options.adminEmails ?? [ADMIN],
      ...(options.probe === undefined ? {} : { libreTranslateProbe: options.probe }),
    };
    const deps = { ...this.h.deps, ...extra, now: () => now } as unknown as WorkerDeps;
    const handlers = createHandlers(deps);
    await dispatch(handlers, 'house.alerts', parseJobPayload('house.alerts', {}), {
      queue: 'house.alerts',
      jobId: 'direct',
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────────

  async setting(key: string, value: unknown): Promise<void> {
    await this.owner.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async clearSetting(key: string): Promise<void> {
    await this.owner.query('DELETE FROM settings WHERE key = $1', [key]);
  }

  async state(): Promise<Record<string, AlertEntry & Record<string, unknown>>> {
    const result = await this.owner.query<{ value: Record<string, AlertEntry> }>(
      "SELECT value FROM settings WHERE key = 'alerts.state'",
    );
    return (result.rows[0]?.value ?? {}) as Record<string, AlertEntry & Record<string, unknown>>;
  }

  /** The entries of `alerts.state` whose incident is open. */
  async activeEntries(): Promise<AlertEntry[]> {
    return Object.values(await this.state()).filter((entry) => entry.active);
  }

  // ── Worlds ────────────────────────────────────────────────────────────────────────────────

  /** Fresh worker heartbeat and fresh `house.progress` for every scheduled housekeeping job. */
  async liveness(now: Date): Promise<void> {
    await this.setting('worker.heartbeat', {
      'worker-1': {
        at: iso(new Date(now.getTime() - 10_000)),
        queues: ['house.alerts'],
        evalIngestOnly: false,
        envCredentials: [],
      },
    });
    const at = iso(new Date(now.getTime() - MINUTE));
    const progress: Record<string, unknown> = {};
    for (const queue of Object.keys(HOUSE_CRON_SCHEDULES)) {
      progress[queue] = { updatedAt: at, completedAt: at, version: 1 };
    }
    await this.setting('house.progress', progress);
  }

  async events(events: OpsEvent[]): Promise<void> {
    await this.setting('ops.events', events.slice(-50));
  }

  /** Remove everything a previous test left behind and write the quiet world at `now`. */
  async baseline(now: Date): Promise<void> {
    await this.owner.query('TRUNCATE job_outbox');
    await this.owner.query('DELETE FROM pgboss.job');
    await this.owner.query('DELETE FROM subscriptions');
    await this.owner.query('DELETE FROM feed_items');
    await this.owner.query('DELETE FROM articles');
    await this.owner.query('DELETE FROM feeds');
    await this.owner.query(
      `DELETE FROM settings WHERE key IN ('alerts.state', 'engine.circuit', 'engine.budget_alerts',
                                          'engine.laya') OR key LIKE 'metrics.daily.%'`,
    );
    await this.setting('language_modes', { en: 'native', sk: 'native', cs: 'native' });
    await this.setting('card_text_mode', 'as_written');
    await this.liveness(now);
    await this.events([
      opsEvent('backup_ok', new Date(now.getTime() - HOUR)),
      hostHealth(new Date(now.getTime() - MINUTE)),
    ]);
  }

  // ── Sources ───────────────────────────────────────────────────────────────────────────────

  async breaker(
    state: 'open' | 'auth' | 'closed' | 'half_open',
    openedAt?: Date,
    now?: Date,
  ): Promise<void> {
    const typesafe: Record<string, unknown> = { state, reopenCount: 0 };
    if (openedAt !== undefined) {
      typesafe['openedAt'] = iso(openedAt);
      typesafe['openUntil'] = iso(new Date((now ?? openedAt).getTime() + HOUR));
    }
    await this.setting('engine.circuit', {
      typesafe,
      llm: { state: 'closed', reopenCount: 0 },
      resetRequested: {},
    });
  }

  /** Insert `count` pg-boss jobs of `queue` in `state`, due (or not) from `startAfter`. */
  async jobs(options: {
    queue?: string;
    state?: 'created' | 'retry' | 'active' | 'failed' | 'completed';
    count?: number;
    startAfter: Date;
    createdOn?: Date;
  }): Promise<void> {
    await this.owner.query(
      `INSERT INTO pgboss.job (name, state, start_after, created_on)
       SELECT $1, $2::pgboss.job_state, $3, $4 FROM generate_series(1, $5)`,
      [
        options.queue ?? 'article.extract',
        options.state ?? 'created',
        options.startAfter,
        options.createdOn ?? options.startAfter,
        options.count ?? 1,
      ],
    );
  }

  async outbox(options: { createdAt: Date; availableAt?: Date }): Promise<void> {
    await this.owner.query(
      `INSERT INTO job_outbox (queue, payload, created_at, available_at)
       VALUES ('article.extract', '{}'::jsonb, $1, $2)`,
      [options.createdAt, options.availableAt ?? options.createdAt],
    );
  }

  /** `total` articles first seen at `firstSeenAt`, of which `degraded` are in state `degraded`. */
  async articles(total: number, degraded: number, firstSeenAt: Date): Promise<void> {
    const run = randomUUID();
    await this.owner.query(
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, first_seen_at,
                             content_hash, content_revision, pipeline_state)
       SELECT 'https://alerts.example.test/' || $1 || '/' || g,
              'https://alerts.example.test/' || $1 || '/' || g,
              'alerts.example.test/' || $1 || '/' || g,
              'Alert ' || g, 'alert ' || g, 'x', $2, md5($1 || g::text), 1,
              CASE WHEN g <= $3 THEN 'degraded' ELSE 'enriched' END
         FROM generate_series(1, $4) g`,
      [run, firstSeenAt, degraded, total],
    );
  }

  /** `total` actively subscribed feeds, `errored` of them with their last error at `errorAt`. */
  async feeds(total: number, errored: number, errorAt: Date): Promise<void> {
    this.userId ??= (await createUser(this.owner, { plan: 'beta' })).id;
    for (let i = 0; i < total; i += 1) {
      const feed = await createFeed(this.owner, { status: 'active' });
      await createSubscription(this.owner, {
        userId: this.userId,
        feedId: feed.id,
        mode: 'active',
      });
      await this.owner.query(
        `UPDATE feeds SET subscriber_count = 1, last_error_at = $2,
                          last_error_code = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE 'http_500' END
          WHERE id = $1`,
        [feed.id, i < errored ? errorAt : null],
      );
    }
  }

  /**
   * One `metrics.daily.<date>` snapshot (spec 10 §7). `house.metrics` (M8-T4) did not exist when
   * this was written, so the shape is the minimal one the brief fixed:
   * `{lanes: {for_you: {likeRate, rated}, maybe: {likeRate, rated}}}`.
   */
  async snapshot(
    day: string,
    forYou: { likeRate: number; rated: number },
    maybe: { likeRate: number; rated: number },
  ): Promise<void> {
    await this.setting(`metrics.daily.${day}`, { lanes: { for_you: forYou, maybe } });
  }
}
