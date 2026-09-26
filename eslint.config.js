import path from 'node:path';
import { fileURLToPath } from 'node:url';

import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const rootPath = path.dirname(fileURLToPath(import.meta.url));

/** Workspace library packages; each is one boundaries element (spec 01 §2). */
const LIBS = ['shared', 'db', 'feeds', 'engine', 'questions', 'translate', 'ranker', 'testing'];

/** Modules that perform I/O; `packages/ranker` is pure (spec 01 §2). */
const IO_MODULES = [
  'node:fs',
  'node:fs/*',
  'node:net',
  'node:http',
  'node:https',
  'node:child_process',
  'node:dgram',
  'node:dns',
  'node:dns/*',
  'fs',
  'net',
  'http',
  'https',
  'child_process',
  'pg',
  'pg-boss',
  'undici',
  'drizzle-orm',
  'drizzle-orm/*',
];

const localOnly = (types) => ({ element: { types: { anyOf: types } } });

/**
 * Spec 01 §2 dependency rules. Default: disallow. Policies are evaluated in order and later
 * matching policies win, so specific disallows come after the general allows.
 */
const boundaryPolicies = [
  // Every element may use npm packages and Node built-ins (files inside one element are not checked).
  { allow: { to: { module: { origin: ['external', 'core'] } } } },
  // apps/* may import any packages/* (never another app).
  { from: { element: { type: 'app' } }, allow: { to: localOnly(LIBS) } },
  // packages/db imports only shared; its migrate job may also use pg-boss (below) and the rest of db.
  { from: { element: { type: 'db' } }, allow: { to: localOnly(['shared', 'db-migrate']) } },
  { from: { element: { type: 'db-migrate' } }, allow: { to: localOnly(['shared', 'db']) } },
  // feeds, translate and questions import only shared.
  {
    from: { element: { types: { anyOf: ['feeds', 'translate', 'questions'] } } },
    allow: { to: localOnly(['shared']) },
  },
  // engine and ranker import shared, and questions for types only.
  {
    from: { element: { types: { anyOf: ['engine', 'ranker'] } } },
    allow: { to: localOnly(['shared']) },
  },
  {
    from: { element: { types: { anyOf: ['engine', 'ranker'] } } },
    allow: { to: localOnly(['questions']), dependency: { kind: 'type' } },
  },
  // packages/testing may import any package (it is only used by tests).
  {
    from: { element: { type: 'testing' } },
    allow: { to: localOnly(LIBS.filter((l) => l !== 'testing').concat('db-migrate')) },
  },
  // A workspace package that is not a declared dependency cannot be resolved to its sources and is
  // classified as external: never allow it.
  { disallow: { to: { module: { origin: 'external', source: '@bantoozi/*' } } } },
  // No pg-boss in packages/db outside the migrate job (spec 01 §2 exception).
  {
    from: { element: { type: 'db' } },
    disallow: { to: { module: { origin: 'external', source: 'pg-boss' } } },
  },
  // packages/ranker is pure: no I/O, no database access.
  {
    from: { element: { type: 'ranker' } },
    disallow: { to: { module: { origin: ['external', 'core'], source: IO_MODULES } } },
  },
];

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/node_modules/**',
    'docs/**',
    'apps/web/dev-dist/**',
    'apps/web/src/routeTree.gen.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  comments.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // `any` needs an eslint-disable-next-line comment with a reason (spec 01 §1).
      '@typescript-eslint/no-explicit-any': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/*.config.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // Credential crypto and every other Node-only shared module stay out of the web bundle
      // (spec 01 §3, "Credential code boundary").
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@bantoozi/shared/server', '@bantoozi/shared/server/*'],
              message: 'Node-only @bantoozi/shared/server modules must not enter the web bundle.',
            },
            {
              group: ['node:*'],
              message: 'Node built-ins are not available in the web client.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': rootPath,
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*', capture: ['app'] },
        { type: 'db-migrate', pattern: 'packages/db/src/migrate' },
        ...LIBS.map((name) => ({ type: name, pattern: `packages/${name}` })),
      ],
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          // Resolve workspace packages to their sources, so a clean checkout lints before any build.
          conditionNames: ['bantoozi-source', 'types', 'import', 'node', 'default'],
          project: [path.join(rootPath, 'tsconfig.base.json')],
        },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        { default: 'disallow', checkAllOrigins: true, policies: boundaryPolicies },
      ],
    },
  },
);
