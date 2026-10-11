-- Hand-written (S22, owner decision 2026-10-11; spec 06 §7, spec 08 §5.1/§5.3):
-- 1. Reader actions make the rows they affect due (`next_rank_at`) instead of recording a full
--    rank, so the API role may write that one ranking column: on an existing row (UPDATE) and on a
--    placeholder row for a cluster member that has none yet (INSERT). RLS keeps it to the caller's
--    own rows; nothing else of the ranking cache becomes writable.
-- 2. The list catch-up is now an incremental rank, so "a rank is already on its way" covers every
--    undelivered `user.rank` intent without a cursor (full or not) and a created/retry
--    `rank:<user>` or `rank-full:<user>` job. `rank_covered()` replaces `full_rank_covered()` (same
--    tenant-scoped SECURITY DEFINER pattern, migration 0020); the API role can read neither
--    `job_outbox` nor `pgboss`.
GRANT INSERT (next_rank_at) ON user_article TO bantoozi_app;--> statement-breakpoint
GRANT UPDATE (next_rank_at) ON user_article TO bantoozi_app;--> statement-breakpoint
DROP FUNCTION full_rank_covered();--> statement-breakpoint
CREATE FUNCTION rank_covered() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := active_tenant();
BEGIN
  RETURN EXISTS (
           SELECT 1 FROM job_outbox o
            WHERE o.queue = 'user.rank' AND o.delivered_at IS NULL
              AND o.payload->>'userId' = v_user::text
              AND NOT (o.payload ? 'cursor'))
         OR EXISTS (
           SELECT 1 FROM pgboss.job j
            WHERE j.name = 'user.rank'
              AND j.singleton_key IN ('rank:' || v_user::text, 'rank-full:' || v_user::text)
              AND j.state IN ('created', 'retry'));
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION rank_covered() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rank_covered() TO bantoozi_app;
