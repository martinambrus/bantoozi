import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildOfflineServer } from './support/openapi.js';

/**
 * M4-T11 OpenAPI snapshot (spec 08 §12 "Snapshots"): the document served at
 * `GET /api/v1/openapi.json` is compared with the committed `__snapshots__/openapi.json`, so a
 * breaking API change fails CI unless the snapshot is updated in the same commit
 * (`pnpm --filter @bantoozi/api test -u`). Two renders are identical (stable output).
 */

let server: Awaited<ReturnType<typeof buildOfflineServer>>;

beforeAll(async () => {
  server = await buildOfflineServer();
});

afterAll(async () => {
  await server.close();
});

async function render(): Promise<string> {
  const res = await server.server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  return `${JSON.stringify(res.json(), null, 2)}\n`;
}

describe('GET /api/v1/openapi.json', () => {
  it('matches the committed snapshot and is stable across renders', async () => {
    const first = await render();
    expect(await render()).toBe(first);
    await expect(first).toMatchFileSnapshot('./__snapshots__/openapi.json');
  });
});
