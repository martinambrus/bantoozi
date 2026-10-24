import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HEALTH_MAX_HEARTBEAT_AGE_MS,
  WORKER_POOL_LIMITS,
  startHealthServer,
  type HealthServer,
} from '../src/health-server.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
let server: HealthServer | undefined;

async function start(
  heartbeatAt: Date | undefined | Error,
  missingQueues?: () => string[],
): Promise<string> {
  server = await startHealthServer({
    host: '127.0.0.1',
    port: 0,
    token: 'secret-token',
    queues: ['feed.fetch', 'house.alerts'],
    ...(missingQueues === undefined ? {} : { missingQueues }),
    now: () => NOW,
    startedAt: new Date(NOW.getTime() - 5000),
    readHeartbeatAt: async () => {
      if (heartbeatAt instanceof Error) throw heartbeatAt;
      return heartbeatAt;
    },
  });
  return `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('worker health server', () => {
  it('reports missing queues as unconsumed and reflects recovery on the next scrape', async () => {
    let missing = ['house.alerts'];
    const base = await start(NOW, () => missing);
    const scrape = async () =>
      (
        await fetch(`${base}/metrics`, {
          headers: { authorization: 'Bearer secret-token' },
        })
      ).text();
    const initial = await scrape();
    expect(initial).toContain('bantoozi_worker_queue_consumed{queue="feed.fetch"} 1');
    expect(initial).toContain('bantoozi_worker_queue_consumed{queue="house.alerts"} 0');
    missing = [];
    expect(await scrape()).toContain('bantoozi_worker_queue_consumed{queue="house.alerts"} 1');
  });

  it('exposes missing alert and cron queues independently of the alert consumer', async () => {
    const base = await start(NOW, () => ['house.alerts', '__pgboss__send-it']);
    const response = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    const metrics = await response.text();
    expect(metrics).toContain('bantoozi_worker_queue_missing{queue="house.alerts"} 1');
    expect(metrics).toContain('bantoozi_worker_queue_missing{queue="__pgboss__send-it"} 1');
  });

  it('answers /healthz 200 with a fresh heartbeat', async () => {
    const base = await start(new Date(NOW.getTime() - 30_000));
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers /healthz 503 with a stale, missing or unreadable heartbeat', async () => {
    for (const hb of [
      new Date(NOW.getTime() - HEALTH_MAX_HEARTBEAT_AGE_MS - 1000),
      undefined,
      new Error('db down'),
    ]) {
      const base = await start(hb);
      expect((await fetch(`${base}/healthz`)).status).toBe(503);
      await server?.close();
      server = undefined;
    }
  });

  it('requires the bearer token on /metrics', async () => {
    const base = await start(new Date(NOW.getTime() - 10_000));
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    const ok = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).toContain('bantoozi_worker_uptime_seconds 5');
    expect(text).toContain('bantoozi_worker_heartbeat_age_seconds 10');
    expect(text).toContain('bantoozi_worker_queue_consumed{queue="feed.fetch"} 1');
  });

  it('answers 404 elsewhere and closes cleanly', async () => {
    const base = await start(NOW);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    await server?.close();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    server = undefined;
  });
});

describe('worker pool limits', () => {
  it('fit the 24-connection cap of spec 11 §2', () => {
    expect(WORKER_POOL_LIMITS.query + WORKER_POOL_LIMITS.feedLocks).toBeLessThanOrEqual(24);
  });
});
