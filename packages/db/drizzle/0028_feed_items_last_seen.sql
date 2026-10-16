-- Hand-written addition (D-253, spec 02): `feed_items.last_seen_at`, the last fetch whose feed listed the item.
-- It is the clock of the purge rules (an item still listed is not a stale arrival and is not re-ingested as
-- new once purged). Existing rows start at their feed's last successful fetch (else their first sighting): we
-- do not know which items that fetch still listed, and assuming "listed" only delays a purge once, whereas
-- assuming "not listed" could purge an item a 304-only feed still carries and re-ingest it as new later. The
-- first 200 after deploy re-stamps exactly the listed items. No index: the purge reads it per article
-- through feed_items_article_idx, and the keyset scan walks articles by id as before.
ALTER TABLE "feed_items" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "feed_items" AS fi SET "last_seen_at" = greatest(fi."first_seen_at", coalesce(f."last_success_at", fi."first_seen_at"))
  FROM "feeds" AS f WHERE f."id" = fi."feed_id";
