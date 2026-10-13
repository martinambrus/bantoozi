import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { OpenAPIV3 } from 'openapi-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildOfflineServer, listOperations, operationKey } from './support/openapi.js';

/** M8b-T2: the OpenAPI document and the operations list describe the runtime settings fields. */

const RUNTIME_KEYS = [
  'engine.typesafe_model',
  'engine.typesafe_base_url',
  'engine.typesafe_price_per_mtok_usd',
  'engine.concurrency',
  'engine.llm_fallback_enabled',
  'engine.ollama_models',
  'engine.ollama_base_url',
  'engine.ollama_max_concurrency',
  'engine.prefilter_min_cards',
  'ingest.max_age_days',
  'fetch.limits',
  'api.rate_limits_enabled',
  'translate.libretranslate_url',
];

let server: Awaited<ReturnType<typeof buildOfflineServer>>;
let doc: OpenAPIV3.Document;

beforeAll(async () => {
  server = await buildOfflineServer();
  const res = await server.server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  doc = res.json();
});
afterAll(async () => {
  await server.close();
});

/** Follows `$ref`s and collects every property name reachable from a schema. */
function propertyNames(schema: unknown, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === 'string') {
      if (seen.has(ref)) return;
      seen.add(ref);
      let target: unknown = doc;
      for (const part of ref.replace(/^#\//, '').split('/')) {
        target = (target as Record<string, unknown> | undefined)?.[part];
      }
      walk(target);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'properties' && v !== null && typeof v === 'object') {
        for (const name of Object.keys(v)) names.add(name);
      }
      walk(v);
    }
  };
  walk(schema);
  return names;
}

describe('M8b-T2 OpenAPI', () => {
  it('GET /admin/settings documents the runtime values, sources and defaults', () => {
    const op = listOperations(doc).find((o) => operationKey(o) === 'GET /admin/settings')!;
    const names = propertyNames(op.operation.responses['200']);
    for (const name of ['values', 'stored', 'sources', 'defaults', ...RUNTIME_KEYS]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('PATCH /admin/settings documents the runtime keys and acknowledge', () => {
    const op = listOperations(doc).find((o) => operationKey(o) === 'PATCH /admin/settings')!;
    const names = propertyNames(op.operation.requestBody);
    for (const name of ['acknowledge', ...RUNTIME_KEYS]) {
      expect(names.has(name), name).toBe(true);
    }
    const result = propertyNames(op.operation.responses['200']);
    for (const name of ['changed', 'sources', 'defaults'])
      expect(result.has(name), name).toBe(true);
  });

  it('expected-operations.txt lists the settings operations and are unchanged', () => {
    const file = readFileSync(
      fileURLToPath(new URL('./expected-operations.txt', import.meta.url)),
      'utf8',
    );
    const expected = file.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(expected).toContain('GET /admin/settings');
    expect(expected).toContain('PATCH /admin/settings');
    const actual = listOperations(server.server.swagger() as OpenAPIV3.Document).map(operationKey);
    expect(actual).toContain('GET /admin/settings');
    expect(actual).toContain('PATCH /admin/settings');
    // No operation is added or removed by T2 (the full equality lives in api-operations.test.ts).
    expect(actual.filter((op) => op.includes('/admin/settings'))).toEqual(
      expected.filter((op) => op.includes('/admin/settings')),
    );
  });
});
