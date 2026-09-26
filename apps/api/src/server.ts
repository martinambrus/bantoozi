import { MIGRATIONS_FOLDER, readMigrationJournal, type Database } from '@bantoozi/db';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { registerErrorHandlers } from './plugins/errors.js';
import { healthRoutes } from './routes/health.js';

export const API_PREFIX = '/api/v1';
/** JSON bodies are limited to 1 MiB (spec 08 §1). */
export const BODY_LIMIT_BYTES = 1024 * 1024;

export interface BuildServerOptions {
  /** Drizzle over the `bantoozi_app` pool (RLS enforced). */
  db: Database;
  /** A pino logger; omitted in tests. */
  logger?: FastifyBaseLogger;
  /** The bundled migrations whose newest entry `/readyz` expects (default: packages/db/drizzle). */
  migrationsFolder?: string;
}

/** Registers plugins and routes; never listens (spec 01 §2). */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    ...(options.logger === undefined ? { logger: false } : { loggerInstance: options.logger }),
  });
  registerErrorHandlers(app);
  await app.register(healthRoutes, {
    prefix: API_PREFIX,
    db: options.db,
    journal: readMigrationJournal(options.migrationsFolder ?? MIGRATIONS_FOLDER),
  });
  return app;
}
