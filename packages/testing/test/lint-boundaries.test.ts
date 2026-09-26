import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Repository-wide check of the spec 01 §2 dependency rules configured in eslint.config.js.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: repoRoot });
});

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

describe('eslint dependency boundaries (spec 01 §2)', () => {
  it('reports packages/ranker importing packages/db', async () => {
    const ids = await ruleIds(
      'packages/ranker/src/probe.ts',
      "import { PACKAGE_NAME } from '@bantoozi/db';\nexport const x = PACKAGE_NAME;\n",
    );
    expect(ids).toContain('boundaries/dependencies');
  });

  it('allows packages/ranker to import shared, and questions for types only', async () => {
    expect(
      await ruleIds(
        'packages/ranker/src/probe.ts',
        "import { PACKAGE_NAME } from '@bantoozi/shared';\nexport const x = PACKAGE_NAME;\n",
      ),
    ).toEqual([]);
    expect(
      await ruleIds(
        'packages/ranker/src/probe.ts',
        "import type { PACKAGE_NAME } from '@bantoozi/questions';\nexport type X = typeof PACKAGE_NAME;\n",
      ),
    ).toEqual([]);
    expect(
      await ruleIds(
        'packages/ranker/src/probe.ts',
        "import { PACKAGE_NAME } from '@bantoozi/questions';\nexport const x = PACKAGE_NAME;\n",
      ),
    ).toContain('boundaries/dependencies');
  });

  it('keeps packages/ranker pure (no I/O modules)', async () => {
    expect(
      await ruleIds(
        'packages/ranker/src/probe.ts',
        "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
      ),
    ).toContain('boundaries/dependencies');
  });

  it('reports packages/shared importing any internal package', async () => {
    expect(
      await ruleIds(
        'packages/shared/src/probe.ts',
        "import { PACKAGE_NAME } from '@bantoozi/db';\nexport const x = PACKAGE_NAME;\n",
      ),
    ).toContain('boundaries/dependencies');
  });

  it('allows pg-boss in packages/db only inside the migrate job', async () => {
    const code = "import PgBoss from 'pg-boss';\nexport const x = PgBoss;\n";
    expect(await ruleIds('packages/db/src/probe.ts', code)).toContain('boundaries/dependencies');
    expect(await ruleIds('packages/db/src/migrate/probe.ts', code)).toEqual([]);
  });

  it('lets apps import packages but never another app', async () => {
    expect(
      await ruleIds(
        'apps/api/src/probe.ts',
        "import { PACKAGE_NAME } from '@bantoozi/db';\nexport const x = PACKAGE_NAME;\n",
      ),
    ).toEqual([]);
    expect(
      await ruleIds(
        'apps/api/src/probe.ts',
        "import { PACKAGE_NAME } from '../../worker/src/index.js';\nexport const x = PACKAGE_NAME;\n",
      ),
    ).toContain('boundaries/dependencies');
  });

  it('forbids Node-only shared server modules in the web client', async () => {
    expect(
      await ruleIds(
        'apps/web/src/probe.ts',
        "import * as crypto from '@bantoozi/shared/server/credential-crypto';\nexport const x = crypto;\n",
      ),
    ).toContain('no-restricted-imports');
  });
});
