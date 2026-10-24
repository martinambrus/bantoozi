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
const probe = () => app.inject({ method: 'GET', url: '/readyz' });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  queries.queues.mockReset().mockResolvedValue([]);
  queries.migrations.mockReset().mockResolvedValue({ ready: true });
  app = Fastify();
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
      missingQueues: ['user.estimate'],
    });
    expect((await probe()).statusCode).toBe(200);
    expect(queries.queues).toHaveBeenCalledTimes(2);
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
    missingQueues: [],
  });
  expect(queries.queues).not.toHaveBeenCalled();
});
