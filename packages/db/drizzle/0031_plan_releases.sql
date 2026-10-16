-- D-257: reader releases and timezone transition guard.
ALTER TABLE "plans" DROP CONSTRAINT "plans_release_interval_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "release_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "release_hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "release_hold_interval_s" integer;--> statement-breakpoint
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
ALTER TABLE "plans" ADD CONSTRAINT "plans_release_interval_check" CHECK (release_interval_s IS NULL OR release_interval_s = 0 OR release_interval_s BETWEEN 60 AND 86400);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_release_hold_check" CHECK ((release_hold_at IS NULL AND release_hold_until IS NULL AND release_hold_interval_s IS NULL)
        OR (release_hold_at IS NOT NULL AND release_hold_until IS NOT NULL
          AND release_hold_interval_s IS NOT NULL AND release_hold_interval_s BETWEEN 60 AND 86400
          AND release_hold_until >= release_hold_at));
