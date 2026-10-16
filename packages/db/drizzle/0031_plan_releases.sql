-- D-257: reader releases, timezone transitions and durable subscription grace.
ALTER TABLE "plans" DROP CONSTRAINT "plans_release_interval_check";--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "release_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "release_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "release_hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "release_hold_plan_revision" integer;--> statement-breakpoint
ALTER TABLE "user_feed_preferences" ADD COLUMN "first_subscribed_at" timestamp with time zone;--> statement-breakpoint
-- Activate untouched seeds only. An edited null may be an explicit immediate setting;
-- P0 did not store per-field edit provenance, so preserve all such edited plans conservatively.
UPDATE plans p SET release_interval_s = cadence.seconds, version = version + 1, updated_at = now()
FROM (VALUES ('beta', 900), ('admin', 300), ('free', 21600), ('basic', 3600),
             ('plus', 1800), ('pro', 600), ('max', 300), ('premium', 60)) AS cadence(key, seconds)
WHERE p.key = cadence.key AND p.release_interval_s IS NULL AND p.version = 1;
--> statement-breakpoint
-- Normalize old custom values before enforcing the supported timezone-window range.
UPDATE plans SET release_interval_s = greatest(60, least(86400, release_interval_s)),
                 version = version + 1, updated_at = now()
WHERE release_interval_s <> 0 AND release_interval_s NOT BETWEEN 60 AND 86400;
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_release_revision_check" CHECK (release_revision >= 0);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_release_interval_check" CHECK (release_interval_s IS NULL OR release_interval_s = 0 OR release_interval_s BETWEEN 60 AND 86400);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_release_hold_check" CHECK ((release_hold_at IS NULL AND release_hold_until IS NULL AND release_hold_plan_revision IS NULL)
        OR (release_hold_at IS NOT NULL AND release_hold_until IS NOT NULL
          AND release_hold_plan_revision IS NOT NULL AND release_hold_plan_revision >= 0
          AND release_hold_until >= release_hold_at));
--> statement-breakpoint
-- Discard timezone holds permanently on reassignment, even when returning to the old plan.
CREATE FUNCTION users_clear_release_hold() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan THEN
    NEW.release_hold_at := NULL;
    NEW.release_hold_until := NULL;
    NEW.release_hold_plan_revision := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION users_clear_release_hold() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER users_clear_release_hold BEFORE UPDATE OF plan ON users
FOR EACH ROW EXECUTE FUNCTION users_clear_release_hold();
--> statement-breakpoint
-- Cadence edits get a monotonic identity. Returning to the same seconds cannot revive an old hold.
-- This updates only NEW: no user-row fanout or plan/user lock-order inversion.
CREATE FUNCTION plans_advance_release_revision() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.release_interval_s IS DISTINCT FROM OLD.release_interval_s THEN
    NEW.release_revision := OLD.release_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION plans_advance_release_revision() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER plans_advance_release_revision BEFORE UPDATE OF release_interval_s ON plans
FOR EACH ROW EXECUTE FUNCTION plans_advance_release_revision();

--> statement-breakpoint
-- Existing live subscriptions keep their introduction start. A remembered unsubscribed source has
-- no recoverable creation timestamp. Keep its grace cutoff older than the longest supported
-- window (one day, including DST), rather than preserving waiting arrivals through migration time.
UPDATE user_feed_preferences p SET first_subscribed_at = coalesce(
  (SELECT s.created_at FROM subscriptions s WHERE s.user_id = p.user_id AND s.feed_id = p.feed_id),
  least(p.updated_at, now() - interval '2 days'));
