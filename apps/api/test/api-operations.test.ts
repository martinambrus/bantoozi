import { readFileSync } from 'node:fs';

import type { OpenAPIV3 } from 'openapi-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildOfflineServer, listOperations, operationKey } from './support/openapi.js';

/**
 * M4-T11 operation list (spec 08 §12): the OpenAPI document contains exactly the operations of
 * `expected-operations.txt`, which is written by hand from spec 08 §2–§10 (one `METHOD /path` per
 * line, Fastify `:param` style, relative to `/api/v1`). A route missing from the server, a renamed
 * path and an undocumented extra route all fail. The server is built without a database.
 */

const expected = readFileSync(new URL('./expected-operations.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

let doc: OpenAPIV3.Document;
let close: () => Promise<void>;

beforeAll(async () => {
  const built = await buildOfflineServer();
  close = built.close;
  doc = built.server.swagger() as OpenAPIV3.Document;
});

afterAll(async () => {
  await close();
});

describe('OpenAPI operations (spec 08 §12)', () => {
  it('the hand-written list is well-formed: sorted, unique, METHOD /path', () => {
    for (const line of expected) expect(line).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/[\w:/-]*$/);
    expect(new Set(expected).size).toBe(expected.length);
    expect([...expected].sort()).toEqual(expected);
  });

  it('equals expected-operations.txt: nothing missing, nothing undocumented', () => {
    const actual = listOperations(doc).map(operationKey);
    const missing = expected.filter((op) => !actual.includes(op));
    const undocumented = actual.filter((op) => !expected.includes(op));
    expect({ missing, undocumented }).toEqual({ missing: [], undocumented: [] });
    expect(actual).toEqual(expected);
  });

  it('every operation declares a summary, tags and a success response', () => {
    for (const op of listOperations(doc)) {
      expect(op.operation.summary, operationKey(op)).toBeTruthy();
      expect(op.operation.tags?.length ?? 0, operationKey(op)).toBeGreaterThan(0);
      const success = Object.keys(op.operation.responses).filter((code) => code.startsWith('2'));
      expect(success.length, operationKey(op)).toBeGreaterThan(0);
    }
  });
});
