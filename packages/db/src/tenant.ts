import { UuidSchema } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Database, Transaction } from './client.js';

declare const TENANT: unique symbol;

/**
 * A transaction whose first statement set `app.user_id` (spec 02 §5). Repositories for per-user
 * tables accept only this type, so a missing tenant context is a compile error, and RLS makes a
 * missing repository filter return no rows instead of another tenant's.
 */
export type TenantTx = Transaction & { readonly [TENANT]: true };

const tenants = new WeakMap<object, string>();

/**
 * Run `fn` in a READ COMMITTED transaction bound to `userId` (the verified session's user, never a
 * request value). The setting is transaction-local, so a reused pool connection fails closed.
 */
export async function withTenant<T>(
  db: Database,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const tenant = UuidSchema.parse(userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${tenant}, true)`);
    const tenantTx = tx as TenantTx;
    tenants.set(tenantTx, tenant);
    return fn(tenantTx);
  });
}

/** The user a {@link TenantTx} is bound to. */
export function tenantUserId(tx: TenantTx): string {
  const tenant = tenants.get(tx);
  if (tenant === undefined) throw new Error('not a withTenant transaction');
  return tenant;
}
