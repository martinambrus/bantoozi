-- Hand-written (S19, S18 findings Q3; spec 08 §5.1 "Outdated scores"): whether a full rank of the
-- caller is already on its way. Every list or counts call that finds ranking pending used to write
-- a catch-up intent although the relay keeps at most one pending full-rank job per user; with one
-- already queued the extra intent is outbox churn that sits behind the job. The API role can read
-- neither `job_outbox` nor `pgboss`, so this tenant-scoped function answers for the caller only: an
-- undelivered full-rank intent without a cursor, or a created/retry `rank-full:<user>` job.
CREATE FUNCTION full_rank_covered() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := active_tenant();
BEGIN
  RETURN EXISTS (
           SELECT 1 FROM job_outbox o
            WHERE o.queue = 'user.rank' AND o.delivered_at IS NULL
              AND o.payload->>'userId' = v_user::text
              AND o.payload->>'full' = 'true' AND NOT (o.payload ? 'cursor'))
         OR EXISTS (
           SELECT 1 FROM pgboss.job j
            WHERE j.name = 'user.rank' AND j.singleton_key = 'rank-full:' || v_user::text
              AND j.state IN ('created', 'retry'));
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION full_rank_covered() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION full_rank_covered() TO bantoozi_app;
