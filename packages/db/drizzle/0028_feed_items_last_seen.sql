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
--> statement-breakpoint
-- `article_engagement` (D-253, Codex r2): the first time anybody engaged with the article. It outlives the
-- 365-day retention of `feedback_events`, so an engagement the reader later cleared keeps the 90-day rule for
-- good. A table of its own, not a column of `articles`: reader actions hold `FOR SHARE` on the article row,
-- and an UPDATE of that row from the trigger needs a stronger lock, so two first engagements on one article
-- could deadlock. The insert below takes only KEY SHARE on the article (the foreign key check). Set by the
-- trigger below on every engagement event; backfilled here from the events and the current reader state that
-- exist today. Like `feed_auto_admissions`, the worker holds its privileges from the default privileges and
-- the API role has none: it writes only through the definer trigger.
CREATE TABLE "article_engagement" (
	"article_id" bigint PRIMARY KEY NOT NULL,
	"engaged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_engagement" ADD CONSTRAINT "article_engagement_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "article_engagement" ("article_id", "engaged_at")
SELECT a.id, coalesce(
    (SELECT min(fe.created_at) FROM feedback_events fe
      WHERE fe.article_id = a.id
        AND fe.kind IN ('rate', 'prompt_answer', 'open', 'read', 'dwell', 'bookmark', 'label', 'hide')),
    (SELECT min(coalesce(ua.opened_at, ua.rated_at, ua.bookmarked_at)) FROM user_article ua
      WHERE ua.article_id = a.id),
    now())
  FROM articles a
 WHERE EXISTS (SELECT 1 FROM feedback_events fe
                WHERE fe.article_id = a.id
                  AND fe.kind IN ('rate', 'prompt_answer', 'open', 'read', 'dwell', 'bookmark', 'label', 'hide'))
    OR EXISTS (SELECT 1 FROM user_article ua
                WHERE ua.article_id = a.id
                  AND (ua.opened_at IS NOT NULL OR ua.rating IS NOT NULL OR ua.bookmarked_at IS NOT NULL
                       OR cardinality(ua.label_ids) > 0));--> statement-breakpoint
-- Engagement kinds: every event except `mark_read` (a bulk read is not engagement), `undo` (it may undo a
-- bulk read) and the un-* kinds (`unrate`, `unread`, `unbookmark`, `unlabel`, `unhide`). SECURITY DEFINER with a
-- pinned search path: the API role may insert events but has no write access to `article_engagement`.
CREATE FUNCTION feedback_events_mark_engaged() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind IN ('rate', 'prompt_answer', 'open', 'read', 'dwell', 'bookmark', 'label', 'hide') THEN
    INSERT INTO article_engagement (article_id) VALUES (NEW.article_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION feedback_events_mark_engaged() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER feedback_events_mark_engaged AFTER INSERT ON feedback_events
  FOR EACH ROW EXECUTE FUNCTION feedback_events_mark_engaged();
