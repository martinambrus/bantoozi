import { quotaUsage, readOwnUser, type TenantTx } from '@bantoozi/db';
import {
  QUOTA_LIMIT_NAMES,
  planLimits,
  readUserPreferences,
  type Me,
  type QuotaLimits,
} from '@bantoozi/shared';

/** The `Me` DTO (spec 08 §3) of the transaction's tenant: user row, preferences and quotas. */
export async function loadMe(tx: TenantTx): Promise<Me> {
  const user = await readOwnUser(tx);
  const used = await quotaUsage(tx);
  const plan = planLimits(user.plan);
  const limits = Object.fromEntries(
    QUOTA_LIMIT_NAMES.map((name) => [name, plan[name]]),
  ) as QuotaLimits;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale,
    timezone: user.timezone,
    role: user.role,
    plan: user.plan,
    invitesLeft: user.invitesLeft,
    preferences: readUserPreferences(user.preferences),
    quotas: { used, limits },
  };
}
