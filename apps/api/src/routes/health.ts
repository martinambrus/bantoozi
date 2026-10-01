import { migrationStatus, type Database, type MigrationJournal } from '@bantoozi/db';
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
  checks: z.object({ database: ReadyCheckSchema, migrations: ReadyCheckSchema }),
});

/**
 * Liveness and readiness (spec 08 §10, spec 01 §4). Readiness checks only this process's own
 * prerequisites — the database is reachable and its newest applied migration is the newest bundled
 * one — never provider uptime. Neither response contains secrets.
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
        summary: 'Readiness: database reachable and migrations current',
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (request, reply) => {
      let database: ReadyCheck = 'ok';
      let migrations: ReadyCheck = 'pending';
      try {
        const status = await migrationStatus(options.db, options.journal);
        migrations = status.ready ? 'ok' : 'pending';
      } catch (error) {
        request.log.warn({ err: error }, 'readiness: database check failed');
        database = 'unreachable';
      }
      const ready = database === 'ok' && migrations === 'ok';
      await reply
        .code(ready ? 200 : 503)
        .header('cache-control', 'no-store')
        .send({ status: ready ? 'ready' : 'not_ready', checks: { database, migrations } });
    },
  );
}
