/**
 * `@bantoozi/db` — Drizzle schema, migrations, RLS helpers and repositories (spec 02). Per-user
 * repositories take a {@link TenantTx}; worker repositories take a worker-role transaction.
 */
export const PACKAGE_NAME = '@bantoozi/db';

export * from './client.js';
export * from './errors.js';
export * from './migrate/migrate.js';
export * from './outbox.js';
export * from './readiness.js';
export * from './schema/index.js';
export * from './settings.js';
export * from './tenant.js';
