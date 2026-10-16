-- Hand-written additions (D-255, docs/design/plan-velocity.md §6): plans and their allowances move from
-- the `PLANS` constant into the database, so Admin → Plans can edit them live. `users.plan` references
-- `plans(key)`: a plan in use cannot be deleted (it is retired instead); the key never changes. Seeded with
-- the values of the former constant (`beta`, `admin`) and the tiers of the plan-velocity design §4, whose
-- other limits equal beta's. `beta` is the default plan of a new user. `release_interval_s` is reserved for
-- the plan-tiered release cadence and unused for now. Grants like `settings` (control-plane table, no
-- tenant RLS): the API role reads and writes it from the admin routes only, the worker role reads it by
-- default privileges.
CREATE TABLE "plans" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"label_sk" text,
	"max_feeds" integer NOT NULL,
	"max_cards" integer NOT NULL,
	"max_labels" integer NOT NULL,
	"max_forks" integer NOT NULL,
	"max_rules" integer NOT NULL,
	"opml_max_feeds" integer NOT NULL,
	"min_fetch_interval_s" integer NOT NULL,
	"release_interval_s" integer,
	"backfill_days" integer NOT NULL,
	"invites_on_signup" integer NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_check" CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
	CONSTRAINT "plans_label_check" CHECK (length(btrim(label)) > 0),
	CONSTRAINT "plans_limits_check" CHECK (max_feeds >= 0 AND max_cards >= 0 AND max_labels >= 0 AND max_forks >= 0 AND max_rules >= 0 AND opml_max_feeds >= 0 AND backfill_days >= 0 AND invites_on_signup >= 0),
	CONSTRAINT "plans_min_fetch_interval_check" CHECK (min_fetch_interval_s BETWEEN 60 AND 86400),
	CONSTRAINT "plans_release_interval_check" CHECK (release_interval_s IS NULL OR release_interval_s >= 0),
	CONSTRAINT "plans_default_active_check" CHECK (NOT (is_default AND retired_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plans_default_idx" ON "plans" USING btree ("is_default") WHERE is_default;
--> statement-breakpoint
INSERT INTO "plans" ("key", "label", "label_sk", "max_feeds", "max_cards", "max_labels", "max_forks", "max_rules",
  "opml_max_feeds", "min_fetch_interval_s", "release_interval_s", "backfill_days", "invites_on_signup", "sort_order", "is_default")
VALUES
  ('beta',    'Beta',    'Beta',    200,  150, 20,  20,  200,  300,  900,   NULL, 7,  3,  10,  true),
  ('admin',   'Admin',   'Admin',   2000, 500, 200, 200, 2000, 2000, 300,   NULL, 14, 50, 20,  false),
  ('free',    'Free',    'Zadarmo', 200,  150, 20,  20,  200,  300,  21600, NULL, 7,  3,  100, false),
  ('basic',   'Basic',   'Základný', 200, 150, 20,  20,  200,  300,  3600,  NULL, 7,  3,  110, false),
  ('plus',    'Plus',    'Plus',    200,  150, 20,  20,  200,  300,  1800,  NULL, 7,  3,  120, false),
  ('pro',     'Pro',     'Pro',     200,  150, 20,  20,  200,  300,  600,   NULL, 7,  3,  130, false),
  ('max',     'Max',     'Max',     200,  150, 20,  20,  200,  300,  300,   NULL, 7,  3,  140, false),
  ('premium', 'Premium', 'Premium', 200,  150, 20,  20,  200,  300,  60,    NULL, 7,  3,  150, false);
--> statement-breakpoint
-- A user on a plan the constant never knew (the constant fell back to the default plan for it) joins beta,
-- so the foreign key can be added without changing what that user was allowed.
UPDATE "users" SET "plan" = 'beta' WHERE "plan" NOT IN (SELECT "key" FROM "plans");
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_plans_key_fk" FOREIGN KEY ("plan") REFERENCES "public"."plans"("key") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "plans" TO bantoozi_app;
--> statement-breakpoint
-- The fetch interval floor of a feed comes from the stored plans of its subscribers: the fastest plan
-- wins, a feed without subscribers (or a subscriber on no plan) gets 900 seconds. The jsonb overload and
-- its map built from the constant are dropped.
DROP FUNCTION refresh_feed_subscribers(bigint[], jsonb);
--> statement-breakpoint
CREATE FUNCTION refresh_feed_subscribers(p_feed_ids bigint[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM f.id FROM feeds f WHERE f.id = ANY(p_feed_ids) ORDER BY f.id FOR NO KEY UPDATE;
  UPDATE feeds f
     SET subscriber_count = coalesce(x.cnt, 0),
         unsubscribed_at  = CASE WHEN coalesce(x.cnt, 0) = 0 THEN coalesce(f.unsubscribed_at, now()) END,
         min_interval_s   = coalesce(x.min_iv, 900),
         updated_at       = now()
    FROM (SELECT DISTINCT unnest(p_feed_ids) AS feed_id) ids
    LEFT JOIN (
      SELECT s.feed_id, count(*) AS cnt, min(coalesce(p.min_fetch_interval_s, 900)) AS min_iv
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
      LEFT JOIN plans p ON p.key = u.plan
      WHERE s.feed_id = ANY(p_feed_ids)
      GROUP BY s.feed_id) x ON x.feed_id = ids.feed_id
   WHERE f.id = ids.feed_id;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION refresh_feed_subscribers(bigint[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION refresh_feed_subscribers(bigint[]) TO bantoozi_app, bantoozi_worker;
--> statement-breakpoint
-- Recompute these feeds after a plan edit or a user's plan change: `refresh_feed_subscribers`, then, for a
-- feed whose floor dropped, `next_fetch_at` is pulled forward to the last fetch plus the new floor (never
-- later, and a feed whose floor did not drop keeps its adaptive schedule). Internal: no EXECUTE grant.
CREATE FUNCTION refresh_feed_intervals(p_feed_ids bigint[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ids bigint[];
  v_old int[];
BEGIN
  PERFORM f.id FROM feeds f WHERE f.id = ANY(p_feed_ids) ORDER BY f.id FOR NO KEY UPDATE;
  SELECT coalesce(array_agg(f.id ORDER BY f.id), '{}'), coalesce(array_agg(f.min_interval_s ORDER BY f.id), '{}')
    INTO v_ids, v_old
    FROM feeds f WHERE f.id = ANY(p_feed_ids);
  PERFORM refresh_feed_subscribers(v_ids);
  UPDATE feeds f
     SET next_fetch_at = least(f.next_fetch_at, coalesce(f.last_fetch_at, now()) + f.min_interval_s * interval '1 second')
    FROM unnest(v_ids, v_old) AS o(id, old_iv)
   WHERE f.id = o.id AND f.min_interval_s < o.old_iv;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION refresh_feed_intervals(bigint[]) FROM PUBLIC;
--> statement-breakpoint
-- Admin plan edit: only the feeds with a live subscriber on the plan.
CREATE FUNCTION refresh_plan_feeds(p_plan text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT admin_context_allowed() THEN
    RAISE EXCEPTION 'administrator required' USING ERRCODE = '42501';
  END IF;
  PERFORM refresh_feed_intervals(ARRAY(
    SELECT DISTINCT s.feed_id FROM subscriptions s
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
     WHERE u.plan = p_plan ORDER BY s.feed_id));
END;
$$;
--> statement-breakpoint
-- Admin change of one user's plan: only that user's feeds.
CREATE FUNCTION refresh_user_feeds(p_user_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT admin_context_allowed() THEN
    RAISE EXCEPTION 'administrator required' USING ERRCODE = '42501';
  END IF;
  PERFORM refresh_feed_intervals(ARRAY(
    SELECT DISTINCT s.feed_id FROM subscriptions s WHERE s.user_id = p_user_id ORDER BY s.feed_id));
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION refresh_plan_feeds(text), refresh_user_feeds(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION refresh_plan_feeds(text), refresh_user_feeds(uuid) TO bantoozi_app;
