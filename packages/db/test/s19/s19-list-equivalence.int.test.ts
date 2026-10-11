import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildGoldenWorld,
  captureUser,
  type Golden,
  type GoldenWorld,
  type UserKey,
} from '../support/s19-golden-world.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * S19 equivalence ruler: the reader view functions (`listArticlePage` with every cursor page,
 * `countArticles`, `countSubscriptionUnread`, `readerLaneMix`, `calibrationArticles`,
 * `articleViewIds` and `articleContexts`) return exactly the outputs captured from the code before
 * the projection rewrite (`fixtures/s19-golden.json`, produced by `s19/generate-golden.int.test.ts`
 * from `support/s19-golden-world.ts`). Rows, order, display feeds, eligibility, arrivals, clusters,
 * keyset cursors, `datasetVersion` digests and `rankingPending` must all be identical.
 */

const golden = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 's19-golden.json'),
    'utf8',
  ),
) as Golden;

let ctx: DbTestContext;
let world: GoldenWorld;

beforeAll(async () => {
  ctx = await setupDbTest();
  world = await buildGoldenWorld(ctx.owner);
});

afterAll(async () => {
  await ctx.close();
});

describe('reader views are identical to the golden outputs', () => {
  it.each(['A', 'B', 'C'] as const)('reader %s', async (key: UserKey) => {
    const expected = golden.users[key];
    const actual = await captureUser(ctx.app, world, key);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    const different = Object.keys(expected).filter(
      (name) => JSON.stringify(actual[name]) !== JSON.stringify(expected[name]),
    );
    if (different.length > 0) {
      const first = different[0]!;
      console.error(
        `S19 ${key}: ${different.length} of ${Object.keys(expected).length} views differ; first ${first}\n` +
          `expected ${JSON.stringify(expected[first]).slice(0, 1200)}\n` +
          `actual   ${JSON.stringify(actual[first]).slice(0, 1200)}`,
      );
    }
    expect(different).toEqual([]);
  });

  it('the golden pins a rich world', () => {
    for (const key of ['A', 'B', 'C'] as const) {
      expect(Object.keys(golden.users[key]).length).toBeGreaterThan(200);
    }
    const text = JSON.stringify(golden);
    expect(text).toContain('"rankingPending":true');
    expect(text.length).toBeGreaterThan(300_000);
  });
});
