import { readFileSync } from 'node:fs';

import { ENV_VARS } from '@bantoozi/shared/server';
import { describe, expect, it } from 'vitest';

// Turborepo runs tasks in strict env mode: a variable missing from globalPassThroughEnv never
// reaches `pnpm dev`, `pnpm test:int` or CI tasks, so the list must follow spec 01 §3 exactly.
describe('turbo.json', () => {
  it('passes every registered environment variable through to tasks', () => {
    const turbo = JSON.parse(
      readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8'),
    ) as { globalPassThroughEnv?: string[] };
    expect([...(turbo.globalPassThroughEnv ?? [])].sort()).toEqual(
      ENV_VARS.map((v) => v.name).sort(),
    );
  });
});
