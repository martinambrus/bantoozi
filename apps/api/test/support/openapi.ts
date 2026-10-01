import { createDatabase, createPool } from '@bantoozi/db';
import type { FastifyInstance } from 'fastify';
import type { OpenAPIV3 } from 'openapi-types';

import { buildServer } from '../../src/server.js';
import { createCapturingMailer, testConfig } from './harness.js';

/**
 * Builds the API server for its OpenAPI document only (spec 08 §12 "Operation list"): the pool
 * points at an unreachable address and is never queried, so no database is needed.
 */
export async function buildOfflineServer(): Promise<{
  server: FastifyInstance;
  close: () => Promise<void>;
}> {
  const pool = createPool({ connectionString: 'postgres://unused@127.0.0.1:9/unused', max: 1 });
  const server = await buildServer({
    db: createDatabase(pool),
    config: testConfig(),
    mailer: createCapturingMailer(),
    libreTranslate: null,
    discoverDeps: {
      fetch: () => Promise.reject(new Error('offline')),
      parse: () => Promise.reject(new Error('offline')),
      decode: () => {
        throw new Error('offline');
      },
    },
  });
  await server.ready();
  return {
    server,
    close: async () => {
      await server.close();
      await pool.end();
    },
  };
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** One operation of the OpenAPI document, in Fastify `:param` style relative to `/api/v1`. */
export interface Operation {
  method: Uppercase<(typeof METHODS)[number]>;
  /** `/cards/:id` (no API prefix). */
  path: string;
  /** The OpenAPI path (`/api/v1/cards/{id}`). */
  openApiPath: string;
  operation: OpenAPIV3.OperationObject;
}

/** Every operation of the document, sorted by `METHOD /path`. */
export function listOperations(doc: OpenAPIV3.Document): Operation[] {
  const ops: Operation[] = [];
  for (const [openApiPath, item] of Object.entries(doc.paths)) {
    if (item === undefined) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      const path = openApiPath.replace(/^\/api\/v1/, '').replace(/\{(\w+)\}/g, ':$1');
      ops.push({
        method: method.toUpperCase() as Operation['method'],
        path: path === '' ? '/' : path,
        openApiPath,
        operation,
      });
    }
  }
  return ops.sort((a, b) => operationKey(a).localeCompare(operationKey(b)));
}

/** `METHOD /path`. */
export function operationKey(op: Pick<Operation, 'method' | 'path'>): string {
  return `${op.method} ${op.path}`;
}
