import type { Database, MigrationJournal } from '@bantoozi/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { healthRoutes } from '../src/routes/health.js';

const queries = vi.hoisted(() => ({ queues: vi.fn(), migrations: vi.fn() }));
vi.mock('@bantoozi/db', () => ({
  missingReadinessQueues: queries.queues,
  migrationStatus: queries.migrations,
}));

let app: FastifyInstance;
const logLines: string[] = [];
const probe = () => app.inject({ method: 'GET', url: '/readyz' });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  queries.queues.mockReset().mockResolvedValue([]);
  queries.migrations.mockReset().mockResolvedValue({ ready: true });
  logLines.length = 0;
  app = Fastify({
    logger: {
      level: 'warn',
      stream: {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await healthRoutes(app, { db: {} as Database, journal: {} as MigrationJournal });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

describe('readiness queue query cache', () => {
  it('shares one in-flight query across concurrent probes', async () => {
    let complete!: (missing: string[]) => void;
    queries.queues.mockReturnValue(
      new Promise<string[]>((resolve) => {
        complete = resolve;
      }),
    );
    const probes = Array.from({ length: 12 }, () => probe());
    const responses = Promise.all(probes);
    await vi.waitFor(() => expect(queries.queues).toHaveBeenCalled());
    complete([]);
    expect((await responses).every((response) => response.statusCode === 200)).toBe(true);
    expect(queries.queues).toHaveBeenCalledTimes(1);
  });

  it('caches a positive result for exactly 60 seconds', async () => {
    expect((await probe()).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 59_999);
    expect((await probe()).statusCode).toBe(200);
    expect(queries.queues).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    expect((await probe()).statusCode).toBe(200);
    expect(queries.queues).toHaveBeenCalledTimes(2);
    expect(queries.migrations).toHaveBeenCalledTimes(3);
  });

  it('does not cache a miss, so the next probe sees recovery', async () => {
    queries.queues.mockResolvedValueOnce(['user.estimate']);
    expect((await probe()).json()).toMatchObject({
      checks: { queues: 'pending' },
      missingQueueCount: 1,
    });
    expect((await probe()).statusCode).toBe(200);
    expect(queries.queues).toHaveBeenCalledTimes(2);
  });

  it('returns only a missing count to an unauthenticated caller', async () => {
    queries.queues.mockResolvedValue(['house.alerts', '__pgboss__send-it']);
    const response = await probe();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ missingQueueCount: 2 });
    expect(response.body).not.toContain('house.alerts');
    expect(response.body).not.toContain('__pgboss__send-it');
    expect(response.json()).not.toHaveProperty('missingQueues');
  });

  it('does not cache errors or reuse an expired success after an error', async () => {
    expect((await probe()).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 60_000);
    queries.queues.mockRejectedValueOnce(new Error('unreadable'));
    expect((await probe()).json()).toMatchObject({ checks: { queues: 'unreachable' } });
    expect((await probe()).statusCode).toBe(200);
    expect(queries.queues).toHaveBeenCalledTimes(3);
  });
});

it('reports queue readiness as unknown when the database cannot be reached', async () => {
  queries.migrations.mockRejectedValue(new Error('connection refused'));
  const response = await probe();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    status: 'not_ready',
    checks: { database: 'unreachable', migrations: 'pending', queues: 'unknown' },
    missingQueueCount: 0,
  });
  expect(queries.queues).not.toHaveBeenCalled();
});

it('logs missing names once per change of the missing set, including recovery and recurrence', async () => {
  const missingLogs = () =>
    logLines
      .map((line) => JSON.parse(line) as { msg: string; missingQueues?: string[] })
      .filter((entry) => entry.msg === 'readiness: queues missing; run the migrate job');
  queries.queues.mockResolvedValue(['house.alerts', 'user.estimate']);
  await Promise.all(Array.from({ length: 6 }, () => probe()));
  await probe();
  queries.queues.mockResolvedValue(['user.estimate', 'house.alerts']);
  await probe();
  expect(missingLogs()).toHaveLength(1);
  expect(missingLogs()[0]?.missingQueues).toEqual(['house.alerts', 'user.estimate']);
  queries.queues.mockResolvedValue(['house.alerts']);
  await probe();
  expect(missingLogs()).toHaveLength(2);
  queries.queues.mockResolvedValue([]);
  await probe();
  vi.setSystemTime(Date.now() + 60_000);
  queries.queues.mockResolvedValue(['house.alerts']);
  await probe();
  await probe();
  expect(missingLogs()).toHaveLength(3);
});
