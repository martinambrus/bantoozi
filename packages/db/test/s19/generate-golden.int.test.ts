import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGoldenWorld, captureGolden, type GoldenWorld } from '../support/s19-golden-world.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * The generator of `test/fixtures/s19-golden.json` (a vitest entry point so the source resolve
 * condition and the test database apply). It does nothing unless S19_WRITE_GOLDEN=1:
 *
 *   S19_WRITE_GOLDEN=1 pnpm --filter @bantoozi/db exec vitest run \
 *     --config vitest.int.config.ts test/s19/generate-golden.int.test.ts
 *
 * Run it only on the code the fixture is meant to pin (the code BEFORE the S19 projection rewrite).
 * A rewrite must reproduce the committed file; it must never regenerate it.
 */

const write = process.env['S19_WRITE_GOLDEN'] === '1';
const target = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  's19-golden.json',
);

let ctx: DbTestContext;
let world: GoldenWorld;

beforeAll(async () => {
  if (!write) return;
  ctx = await setupDbTest();
  world = await buildGoldenWorld(ctx.owner);
});
afterAll(async () => {
  if (write) await ctx.close();
});

describe.skipIf(!write)('S19 golden generator', () => {
  it('writes the golden fixture', async () => {
    const golden = await captureGolden(ctx.app, world);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(golden, null, 1)}\n`);
    expect(Object.keys(golden.users.A).length).toBeGreaterThan(100);
  });
});
