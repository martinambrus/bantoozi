-- Hand-written (spec 02 §1.2): pg-boss privileges. The migrate job (src/migrate) has already executed
-- the construction/migration plans of the pinned pg-boss version as bantoozi_owner before these Drizzle
-- migrations, and creates every queue from packages/shared jobs.ts after them, so the per-queue
-- partitions are owner-created and covered by the default privileges below.
GRANT USAGE ON SCHEMA pgboss TO bantoozi_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO bantoozi_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO bantoozi_worker;
-- The pg-boss functions predate 0000's default revoke; nobody else needs them.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO bantoozi_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE bantoozi_owner IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bantoozi_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE bantoozi_owner IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO bantoozi_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE bantoozi_owner IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO bantoozi_worker;

-- Readiness/backlog: queue names and aggregate state counts only, against the pinned pg-boss 10
-- catalog (job states created, retry, active, completed, cancelled, failed). No payload leaves it.
CREATE FUNCTION queue_state_counts()
RETURNS TABLE (queue text, created bigint, retry bigint, active bigint, completed bigint,
               cancelled bigint, failed bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT q.name,
         count(j.id) FILTER (WHERE j.state = 'created'),
         count(j.id) FILTER (WHERE j.state = 'retry'),
         count(j.id) FILTER (WHERE j.state = 'active'),
         count(j.id) FILTER (WHERE j.state = 'completed'),
         count(j.id) FILTER (WHERE j.state = 'cancelled'),
         count(j.id) FILTER (WHERE j.state = 'failed')
    FROM pgboss.queue q
    LEFT JOIN pgboss.job j ON j.name = q.name
   GROUP BY q.name
   ORDER BY q.name;
$$;
REVOKE EXECUTE ON FUNCTION queue_state_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_state_counts() TO bantoozi_app, bantoozi_worker;
