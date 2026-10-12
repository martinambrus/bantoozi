/**
 * Advisory lock key serializing the deletion-ledger append + hard delete of `house.purge-users`
 * (held per user for the whole purge, session level) against the backup's dump + ledger copy
 * (`infra/scripts/backup.sh`, held from before `pg_dump` until the ledger copy is shipped), so a
 * backup never holds a tombstone without the matching user state or the reverse (spec 11 §4, §5.1).
 * `infra/scripts/backup.sh` uses the same literal (`ERASURE_BACKUP_LOCK_KEY=...`); a test compares them.
 */
export const ERASURE_BACKUP_LOCK_KEY = 7_340_026_011;

/**
 * Prefix of the per-user erasure/restore advisory lock (spec 11 §5.1). The key is the bigint
 * `hashtextextended(USER_ERASURE_LOCK_PREFIX || user_id, 0)`: `house.purge-users` holds it as a
 * session lock for a whole purge (tombstone, every predelete batch, final delete) and an account
 * restore takes it with `pg_advisory_xact_lock` before it reads or clears `users.deleted_at`, so
 * the two never interleave between the purge's separate transactions.
 */
export const USER_ERASURE_LOCK_PREFIX = 'erasure:';
