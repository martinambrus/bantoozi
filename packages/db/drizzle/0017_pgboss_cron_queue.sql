-- Hand-written (D-142; spec 02 §1.2): pg-boss's internal cron queue. A started pg-boss sends every
-- due `boss.schedule` cron through `__pgboss__send-it` and creates that queue itself at start, but
-- the worker role cannot create partitions in the pgboss schema (only bantoozi_owner can), so the
-- creation failed silently, every cron insert was dropped and no schedule (`feed.schedule`, the
-- `house.*` jobs) ever fired. Created here as bantoozi_owner with pg-boss's defaults, exactly as
-- its timekeeper would; `create_queue` is a no-op when the queue already exists.
SELECT pgboss.create_queue('__pgboss__send-it', '{"policy":"standard"}'::json);
