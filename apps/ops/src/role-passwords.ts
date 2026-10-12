import type pg from 'pg';

/** The three application roles and the environment variable that holds each one's password. */
export const ROLE_PASSWORD_ENV: ReadonlyArray<readonly [role: string, env: string]> = [
  ['bantoozi_owner', 'BANTOOZI_OWNER_PASSWORD'],
  ['bantoozi_app', 'BANTOOZI_APP_PASSWORD'],
  ['bantoozi_worker', 'BANTOOZI_WORKER_PASSWORD'],
];

/**
 * `recovery:role-passwords` (spec 11 §4 step 3): the globals dump is taken with
 * `--no-role-passwords`, so a restored cluster has the three roles without passwords. Connected as
 * the superuser, sets each one from the deployment secrets in the environment (never argv). All or
 * nothing: a missing value or a missing role changes nothing. Statements are never logged.
 */
export async function setRolePasswords(
  pool: pg.Pool,
  env: Record<string, string | undefined>,
  roles: ReadonlyArray<readonly [role: string, env: string]> = ROLE_PASSWORD_ENV,
): Promise<number> {
  const missing = roles.filter(([, name]) => !env[name]).map(([, name]) => name);
  if (missing.length > 0) throw new Error(`missing role passwords: ${missing.join(', ')}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL log_statement = 'none'");
    await client.query("SET LOCAL log_min_error_statement = 'panic'");
    for (const [role, name] of roles) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount !== 1) throw new Error(`role ${role} does not exist`);
      const statement = await client.query<{ sql: string }>(
        "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
        [role, env[name]],
      );
      await client.query(statement.rows[0]?.sql ?? '');
    }
    await client.query('COMMIT');
    return roles.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function formatRolePasswords(set: number): string {
  return `ROLE_PASSWORDS set=${set}`;
}
