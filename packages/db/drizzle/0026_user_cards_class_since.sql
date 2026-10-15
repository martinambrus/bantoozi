-- Hand-written (D-244): when a holding entered its current class (Never or not Never). The
-- learning status judges ratings against this moment, not against the holding's creation. Existing
-- holdings are backfilled to their creation time; the application sets it on insert and whenever a
-- write moves a holding between Never and the other strengths. RLS, grants and triggers on
-- user_cards are table-level and unchanged.
ALTER TABLE "user_cards" ADD COLUMN "class_since" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
UPDATE "user_cards" SET "class_since" = "created_at";
