import { createDatabase, createPool } from '@bantoozi/db';
import { createLogger } from '@bantoozi/shared/server';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import { testConfig } from './support/harness.js';

/** Spec 11 §7 "Logs": no raw URL query in API request logs. */

const pool = createPool({ connectionString: 'postgres://unused@127.0.0.1:9/unused', max: 1 });
afterAll(async () => {
  await pool.end();
});

describe('API request logging', () => {
  it('logs the request path without its query string', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });
    const server = await buildServer({
      db: createDatabase(pool),
      config: testConfig(),
      libreTranslate: null,
      logger,
    });
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/healthz?q=secret@example.com&token=abc',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await server.close();
    }
    const out = lines.join('');
    expect(out).toContain('/api/v1/healthz');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('token=abc');
    expect(out).not.toContain('?');
  });
});
