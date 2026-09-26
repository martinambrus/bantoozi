import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
/** A Drizzle transaction on {@link Database}. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run a statement: the pool-backed database or an open transaction. */
export type Executor = Database | Transaction;

export interface CreatePoolOptions {
  /** `DATABASE_URL` (api, `bantoozi_app`) or `DATABASE_URL_WORKER` (worker/eval). */
  connectionString: string;
  /** Explicit per-process limit (spec 01 §4); keep the total under `max_connections`. */
  max?: number;
  applicationName?: string;
  idleTimeoutMillis?: number;
}

export function createPool(options: CreatePoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  });
}

/** Drizzle over a pool, with the full schema for relational queries. */
export function createDatabase(pool: pg.Pool): Database {
  return drizzle({ client: pool, schema });
}
