import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { PG_BOSS_CRON_QUEUE } from '@bantoozi/db';

import { fingerprintCounters } from './learn/fingerprints.js';

/** A heartbeat older than this makes `/healthz` answer 503 (spec 11 §2). */
export const HEALTH_MAX_HEARTBEAT_AGE_MS = 2 * 60 * 1000;

/**
 * Worker Postgres pool sizes: spec 11 §2 caps a worker at 24 connections including its feed locks
 * (pg-boss's own pool is counted separately). The 16 feed.fetch consumers share 14 lock
 * connections; a consumer without one waits on the lock pool only, never on the query pool.
 */
export const WORKER_POOL_LIMITS = { query: 10, feedLocks: 14 } as const;

export interface HealthServerOptions {
  host: string;
  port: number;
  token: string | undefined;
  queues: readonly string[];
  /** Current missing queues from queue readiness, re-read on each scrape. */
  missingQueues?: () => readonly string[];
  /** When this worker's last heartbeat write landed; undefined when none; may reject. */
  readHeartbeatAt: () => Promise<Date | undefined>;
  startedAt?: Date;
  now?: () => Date;
}

export interface HealthServer {
  server: Server;
  close(): Promise<void>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Listen with `GET /healthz` (200 while the last heartbeat write is at most two minutes old, else
 * 503) and `GET /metrics` (plain text, `METRICS_TOKEN` bearer; 401 without it).
 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const now = options.now ?? (() => new Date());
  const startedAt = options.startedAt ?? now();
  async function heartbeatAgeMs(): Promise<number | undefined> {
    try {
      const at = await options.readHeartbeatAt();
      return at === undefined ? undefined : now().getTime() - at.getTime();
    } catch {
      return undefined;
    }
  }
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'GET' || (path !== '/healthz' && path !== '/metrics')) {
      send(404, 'text/plain', 'not found\n');
      return;
    }
    if (
      path === '/metrics' &&
      (options.token === undefined || !tokenMatches(req.headers.authorization, options.token))
    ) {
      send(401, 'text/plain', 'unauthorized\n');
      return;
    }
    heartbeatAgeMs().then(
      (age) => {
        if (path === '/healthz') {
          const ok = age !== undefined && age <= HEALTH_MAX_HEARTBEAT_AGE_MS;
          send(ok ? 200 : 503, 'application/json', JSON.stringify({ ok }));
          return;
        }
        const missing = new Set(options.missingQueues?.() ?? []);
        const lines = [
          '# TYPE bantoozi_worker_uptime_seconds gauge',
          `bantoozi_worker_uptime_seconds ${Math.floor((now().getTime() - startedAt.getTime()) / 1000)}`,
          '# TYPE bantoozi_worker_heartbeat_age_seconds gauge',
          ...(age === undefined
            ? []
            : [`bantoozi_worker_heartbeat_age_seconds ${Math.floor(age / 1000)}`]),
          '# TYPE bantoozi_worker_queue_missing gauge',
          ...[...new Set([...options.queues, PG_BOSS_CRON_QUEUE, ...missing])].map(
            (q) => `bantoozi_worker_queue_missing{queue="${q}"} ${missing.has(q) ? 1 : 0}`,
          ),
          '# TYPE bantoozi_worker_queue_consumed gauge',
          ...options.queues.map(
            (q) => `bantoozi_worker_queue_consumed{queue="${q}"} ${missing.has(q) ? 0 : 1}`,
          ),
          '# TYPE bantoozi_worker_rating_fingerprint_evicted_total counter',
          `bantoozi_worker_rating_fingerprint_evicted_total ${fingerprintCounters.evicted}`,
          '# TYPE bantoozi_worker_rating_fingerprint_registration_failed_total counter',
          `bantoozi_worker_rating_fingerprint_registration_failed_total ${fingerprintCounters.failed}`,
        ];
        send(200, 'text/plain; version=0.0.4', `${lines.join('\n')}\n`);
      },
      () => send(500, 'text/plain', 'error\n'),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
