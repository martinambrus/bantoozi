import {
  migrationStatus,
  missingReadinessQueues,
  type Database,
  type MigrationJournal,
} from '@bantoozi/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface HealthRoutesOptions {
  db: Database;
  journal: MigrationJournal;
}

type ReadyCheck = 'ok' | 'pending' | 'unreachable';

const TAGS = ['health'];
const HealthResponseSchema = z.object({ status: z.literal('ok') });
const ReadyCheckSchema = z.enum(['ok', 'pending', 'unreachable']);
const ReadyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: ReadyCheckSchema,
    migrations: ReadyCheckSchema,
    queues: ReadyCheckSchema,
  }),
  missingQueues: z.array(z.string()),
});

/**
 * Liveness and readiness (spec 08 §10, spec 01 §4). Readiness checks only this process's own
 * prerequisites — the database is reachable, bundled migrations are applied and required queues
 * exist — never provider uptime. Neither response contains secrets.
 */
export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions,
): Promise<void> {
  app.get(
    '/healthz',
    {
      config: { auth: 'public', healthProbe: true },
      schema: { tags: TAGS, summary: 'Liveness', response: { 200: HealthResponseSchema } },
    },
    async (_request, reply) => {
      await reply.header('cache-control', 'no-store').send({ status: 'ok' });
    },
  );

  app.get(
    '/readyz',
    {
      config: { auth: 'public', healthProbe: true },
      schema: {
        tags: TAGS,
        summary: 'Readiness: database reachable, migrations current and queues present',
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (request, reply) => {
      let database: ReadyCheck = 'ok';
      let migrations: ReadyCheck = 'pending';
      let queues: ReadyCheck = 'pending';
      let missingQueues: string[] = [];
      try {
        const status = await migrationStatus(options.db, options.journal);
        migrations = status.ready ? 'ok' : 'pending';
      } catch (error) {
        request.log.warn({ err: error }, 'readiness: database check failed');
        database = 'unreachable';
      }
      if (database === 'ok') {
        try {
          missingQueues = await missingReadinessQueues(options.db);
          queues = missingQueues.length === 0 ? 'ok' : 'pending';
        } catch (error) {
          request.log.warn({ err: error }, 'readiness: queue check failed');
          queues = 'unreachable';
        }
      }
      const ready = database === 'ok' && migrations === 'ok' && queues === 'ok';
      await reply
        .code(ready ? 200 : 503)
        .header('cache-control', 'no-store')
        .send({
          status: ready ? 'ready' : 'not_ready',
          checks: { database, migrations, queues },
          missingQueues,
        });
    },
  );
}
