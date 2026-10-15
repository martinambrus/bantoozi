-- Hand-written additions (D-251, spec 02): the per-feed daily cap on automatic analysis. The generated
-- part adds `feed_items.over_cap_limit` (NULL = admitted, else the cap in force when the arrival was
-- skipped; no backfill, every existing row stays admitted) and the worker-only counter table
-- `feed_auto_admissions`. The worker holds its table privileges from the default privileges; the API
-- role has none and claims a slot (a rating of a capped article, D-238) through `claim_auto_admission`.
CREATE TABLE "feed_auto_admissions" (
	"feed_id" bigint NOT NULL,
	"day" date NOT NULL,
	"admitted" integer NOT NULL,
	CONSTRAINT "feed_auto_admissions_pkey" PRIMARY KEY("feed_id","day")
);
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "over_cap_limit" integer;--> statement-breakpoint
ALTER TABLE "feed_auto_admissions" ADD CONSTRAINT "feed_auto_admissions_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION claim_auto_admission(p_feed_id bigint, p_day date, p_allowance integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_admitted integer;
BEGIN
  IF p_allowance <= 0 THEN RETURN false; END IF;
  IF v_user IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM subscriptions s
        WHERE s.user_id = v_user AND s.feed_id = p_feed_id AND s.inference_mode = 'active') THEN
    RETURN false;
  END IF;
  INSERT INTO feed_auto_admissions AS a (feed_id, day, admitted) VALUES (p_feed_id, p_day, 1)
  ON CONFLICT (feed_id, day) DO UPDATE SET admitted = a.admitted + 1 WHERE a.admitted < p_allowance
  RETURNING a.admitted INTO v_admitted;
  RETURN v_admitted IS NOT NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION claim_auto_admission(bigint, date, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_auto_admission(bigint, date, integer) TO bantoozi_app, bantoozi_worker;
